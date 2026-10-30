/**
 * Unit tests for critical paths that sit between the pure-function tests and
 * the DB-backed integration suite: UsageStats persistence, ensureDb
 * download/validate/swap (single-file and chunked), and the in-memory two-pass
 * KNN (VectorIndex).
 *
 * VectorIndex failure modes: results not in descending true-cosine order (on
 * either the small exact path or the two-pass path); `candidates` ignored so
 * filtered-out rows leak in; k > candidates padding or duplicating rows; empty
 * candidates / k = 0 throwing; the full-vector rescore skipped, leaving the
 * prefix order; similarity not equal to the true cosine.
 *
 * EmbeddingModel failure modes (offline: an empty cache with remote fetches off
 * makes every load fail fast): a failed load cached until restart, so a later
 * query never retries; a retry on every call instead of after a pause; a
 * query that waits on the retry instead of answering at once; unbounded
 * retries (each failed session leaks native RSS);
 * EMBEDDING_THREADS "" or junk passed to onnxruntime (0 = all cores, NaN throws)
 * instead of falling back to 2 with a warning.
 *
 * withResponseTimeout failure modes (through the SDK's toNodeHandler over real
 * HTTP, since its unconditional writeHead is the hazard): a stuck call never
 * answered; the 504 written twice or crashing the adapter; a late response's
 * SSE body left unread, so its keep-alive runs forever (#427); a late rejection
 * going unhandled, which kills the process; a stream cut because it outlived
 * the timeout; a handler throw hidden behind the 504.
 *
 * Skill bundles failure mode: SKILL.md edited without rebuilding, so the committed
 * bundles users download are stale (no behaviour can show this; it ships silently),
 * or its version falling behind package.json.
 *
 * UsageStats concurrency: processes sharing one stats file renaming each
 * other's temp file away (ENOENT, logged as "usage stats flush failed").
 *
 * ensureDb stall failure modes: a stalled refresh holding up startup although a
 * valid local copy can serve; a stalled first part read as "no chunks", so the
 * single-file fallback spends a second full timeout.
 *
 * cachedFor failure modes: every /debug/memory call re-reading smaps; a snapshot
 * that never refreshes.
 *
 * Run:  node scripts/tests/test-units.mjs
 * Requires: npm run build (imports from dist/)
 *
 * No framework — same conventions as test-pure-functions.mjs. All fixtures go
 * under a mkdtempSync dir, cleaned in a finally. No real DB / network / model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import Database from "better-sqlite3";

import { UsageStats } from "../../dist/utils/UsageStats.js";
import { ensureDb } from "../../dist/utils/db.js";
import { cachedFor } from "../../dist/utils/MemoryStats.js";
import { VectorIndex } from "../../dist/api/VectorIndex.js";
import { embeddingsCountConsistent } from "../../dist/api/IconclassDb.js";
import { EmbeddingModel } from "../../dist/api/EmbeddingModel.js";
import { withResponseTimeout } from "../../dist/utils/responseTimeout.js";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { env as hfEnv } from "@huggingface/transformers";
import { spawn, spawnSync } from "node:child_process";
import { assert, assertEq, section, atest, report } from "./_assert.mjs";

// ── Test helpers ─────────────────────────────────────────────────

/** Deterministic int8 rows from a seeded LCG. */
function int8Rows(n, dims, seed, fill) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) * 200 - 100;
  return Array.from({ length: n }, (_, i) =>
    Buffer.from(Int8Array.from({ length: dims }, (_, j) => fill ? fill(i, j, rnd) : Math.round(rnd())).buffer));
}

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let j = 0; j < a.length; j++) { d += a[j] * b[j]; x += a[j] * a[j]; y += b[j] * b[j]; }
  return d / Math.sqrt(x * y);
}

/** Exact cosine top-k over rows (optionally only `allowed` indices), as notation names. */
function bruteTopK(rows, q, k, allowed) {
  const idx = allowed ?? rows.map((_, i) => i);
  return idx
    .map((i) => ({ i, s: cosine(new Int8Array(rows[i].buffer, rows[i].byteOffset, q.length), q) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ i }) => `n${i}`);
}

/** assertEq for arrays (assertEq compares with ===). */
function assertList(actual, expected, msg) {
  return assertEq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Write a valid SQLite DB (table t + row) at path. */
function writeValidDb(p) {
  const db = new Database(p);
  db.exec("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
  db.close();
}

/** The bytes of a valid SQLite file (table t with one row). */
function makeValidDbBuffer(dir, name) {
  const p = path.join(dir, name);
  writeValidDb(p);
  const buf = fs.readFileSync(p);
  fs.unlinkSync(p);
  return buf;
}

/** Write a SQLite DB that opens but FAILS `SELECT 1 FROM t` (no table t). */
function writeInvalidDb(p) {
  const db = new Database(p);
  db.exec("CREATE TABLE other (id INTEGER);");
  db.close();
}

const VALIDATION_QUERY = "SELECT 1 FROM t LIMIT 1";

function assertNoTempFiles(dbPath, label) {
  const left = [".tmp", ".tmp.gz"].filter((ext) => fs.existsSync(dbPath + ext));
  assert(left.length === 0, `${label}: no temp files left behind${left.length ? ` (found ${left.join(", ")})` : ""}`);
}

/** Start an HTTP server that serves exactly `routes` (path → Buffer) and 404s
 *  everything else, so with no `.part-*` routes ensureDb falls through to the
 *  single-file download. */
function startRouteServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url];
      if (typeof body === "number") { res.statusCode = body; res.end(); return; } // a bare status
      res.statusCode = body ? 200 : 404;
      res.end(body ?? "not found");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Split `buf` into `n` roughly equal parts named like `split -b` output
 *  (`<base>.part-aa`, `.part-ab`, …). */
function splitParts(base, buf, n) {
  const size = Math.ceil(buf.length / n);
  const routes = {};
  for (let i = 0; i < n; i++) {
    routes[`${base}.part-a${String.fromCharCode(97 + i)}`] = buf.subarray(i * size, (i + 1) * size);
  }
  return routes;
}

function serverUrl(server, suffix = "/db") {
  const { port } = server.address();
  return `http://127.0.0.1:${port}${suffix}`;
}

/** True iff the file at `p` passes VALIDATION_QUERY; false on any open/query
 *  failure (mirrors how ensureDb itself treats a validation error). */
function dbValidates(p) {
  const db = new Database(p, { readonly: true });
  try {
    return !!db.prepare(VALIDATION_QUERY).get();
  } catch {
    return false;
  } finally {
    db.close();
  }
}

// One shared env-var pair is enough: the ensureDb cases run sequentially, so a
// fresh temp dir per case is all the isolation they need.
const ENV_PATH = "TEST_DB_PATH";
const ENV_URL = "TEST_DB_URL";

/** Make a fresh temp dir + dbPath under `tmpRoot` and point ensureDb's env vars
 *  at it. Sets TEST_DB_URL to `url` when given, clears it otherwise. */
function setupEnsureDb(tag, url) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${tag}-`));
  const dbPath = path.join(dir, "db.sqlite");
  process.env[ENV_PATH] = dbPath;
  if (url) process.env[ENV_URL] = url;
  else delete process.env[ENV_URL];
  return dbPath;
}

/** Invoke the real ensureDb against the shared env-var pair. */
function callEnsureDb(name, extra = {}) {
  return ensureDb({ name, pathEnvVar: ENV_PATH, urlEnvVar: ENV_URL, defaultFile: "x.db", validationQuery: VALIDATION_QUERY, ...extra });
}

// ── Main ─────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iconclass-test-"));

try {
  // ════════════════════════════════════════════════════════════════
  section("UsageStats");

  {
    // 1. fresh instance, non-existent path → empty tools/daily, ISO since.
    const fp = path.join(tmpRoot, "stats-1.json");
    const s = new UsageStats(fp);
    const j = s.toJSON();
    assertEq(Object.keys(j.tools).length, 0, "fresh: empty tools");
    assertEq(Object.keys(j.daily).length, 0, "fresh: empty daily");
    assert(typeof j.since === "string" && !Number.isNaN(Date.parse(j.since)), "fresh: since is ISO string");
  }

  {
    // 2. record aggregates calls/errors/totalMs/maxMs correctly.
    const fp = path.join(tmpRoot, "stats-2.json");
    const s = new UsageStats(fp);
    // Peak in the middle: a first-value or last-value maxMs would both fail.
    s.record("search", 10, true);
    s.record("search", 100, true);
    s.record("search", 50, false);
    const t = s.toJSON().tools.search;
    assertEq(t.calls, 3, "record: calls counted");
    assertEq(t.errors, 1, "record: errors counted");
    assertEq(t.totalMs, 160, "record: totalMs summed");
    assertEq(t.maxMs, 100, "record: maxMs is the peak");
  }

  {
    // 3. flush writes the file and leaves no .tmp behind.
    const fp = path.join(tmpRoot, "stats-3.json");
    const s = new UsageStats(fp);
    s.record("browse", 10, true);
    s.flush();
    assert(fs.existsSync(fp), "flush: file exists");
    assert(!fs.existsSync(fp + ".tmp"), "flush: no .tmp left behind");
    const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
    assertEq(parsed.tools.browse.calls, 1, "flush: file holds the recorded data");
  }

  {
    // 4. round-trip: a new instance on the flushed path loads the same counts.
    const fp = path.join(tmpRoot, "stats-4.json");
    const a = new UsageStats(fp);
    a.record("resolve", 42, true);
    a.record("resolve", 8, false);
    a.flush();
    const b = new UsageStats(fp);
    const t = b.toJSON().tools.resolve;
    assertEq(t.calls, 2, "round-trip: calls loaded");
    assertEq(t.errors, 1, "round-trip: errors loaded");
    assertEq(t.totalMs, 50, "round-trip: totalMs loaded");
    assertEq(t.maxMs, 42, "round-trip: maxMs loaded");
    const today = new Date().toISOString().slice(0, 10);
    assertEq(b.toJSON().daily[today]?.calls, 2, "round-trip: daily bucket loaded");
    b.record("resolve", 99, true);
    assertEq(b.toJSON().tools.resolve.calls, 3, "round-trip: loaded counts keep accumulating");
  }

  {
    // 5. corrupt file → starts fresh instead of throwing.
    const fp = path.join(tmpRoot, "stats-5.json");
    fs.writeFileSync(fp, "not json{");
    let threw = false;
    let s;
    try { s = new UsageStats(fp); } catch { threw = true; }
    assert(!threw, "corrupt: constructor does not throw");
    assertEq(Object.keys(s.toJSON().tools).length, 0, "corrupt: starts with empty tools");
  }

  {
    // 6. record updates the right daily bucket (key = today's date slice).
    const fp = path.join(tmpRoot, "stats-6.json");
    const s = new UsageStats(fp);
    s.record("search", 5, true);
    s.record("search", 5, false);
    const today = new Date().toISOString().slice(0, 10);
    const d = s.toJSON().daily[today];
    assert(!!d, "daily: today's bucket exists");
    assertEq(d.calls, 2, "daily: calls counted in today's bucket");
    assertEq(d.errors, 1, "daily: errors counted in today's bucket");
  }

  // ════════════════════════════════════════════════════════════════
  section("ensureDb");

  const validBuf = makeValidDbBuffer(tmpRoot, "fixture-src.db");

  await atest("existing valid DB + no URL → no re-download (mtime unchanged)", async () => {
    const dbPath = setupEnsureDb("c1");
    writeValidDb(dbPath);
    const before = fs.statSync(dbPath).mtimeMs;
    await callEnsureDb("t1");
    const after = fs.statSync(dbPath).mtimeMs;
    assertEq(after, before, "case 1: mtime unchanged (no re-download)");
    assert(dbValidates(dbPath), "case 1: file still valid");
  });

  await atest("no local file + no URL → no file created, no throw", async () => {
    const dbPath = setupEnsureDb("c2");
    await callEnsureDb("t2");
    assert(!fs.existsSync(dbPath), "case 2: no file created");
  });

  await atest("no local file + URL (uncompressed) → downloaded + valid", async () => {
    const server = await startRouteServer({ "/db": validBuf });
    try {
      const dbPath = setupEnsureDb("c3", serverUrl(server, "/db"));
      await callEnsureDb("t3");
      assert(fs.existsSync(dbPath), "case 3: file downloaded");
      assert(dbValidates(dbPath), "case 3: downloaded file validates");
    } finally {
      server.close();
    }
  });

  await atest("no local file + .gz URL → decompressed + valid", async () => {
    const server = await startRouteServer({ "/db.gz": zlib.gzipSync(validBuf) });
    try {
      const dbPath = setupEnsureDb("c4", serverUrl(server, "/db.gz"));
      await callEnsureDb("t4");
      assert(fs.existsSync(dbPath), "case 4: file downloaded");
      assert(dbValidates(dbPath), "case 4: gunzipped file validates");
      assertNoTempFiles(dbPath, "case 4");
    } finally {
      server.close();
    }
  });

  await atest("corrupt download + refreshOnStartup → local file preserved", async () => {
    const server = await startRouteServer({ "/db": Buffer.from("this is not a sqlite database at all") });
    try {
      const dbPath = setupEnsureDb("c5", serverUrl(server, "/db"));
      writeValidDb(dbPath);
      const hashBefore = sha256(fs.readFileSync(dbPath));
      await callEnsureDb("t5", { refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), hashBefore, "case 5: local file unchanged after bad refresh");
      assert(dbValidates(dbPath), "case 5: local file still valid");
      assertNoTempFiles(dbPath, "case 5");
    } finally {
      server.close();
    }
  });

  await atest("existing INVALID DB + URL → replaced with valid download", async () => {
    const server = await startRouteServer({ "/db": validBuf });
    try {
      const dbPath = setupEnsureDb("c6", serverUrl(server, "/db"));
      writeInvalidDb(dbPath);
      assert(!dbValidates(dbPath), "case 6: precondition — local file fails validation");
      await callEnsureDb("t6");
      assert(dbValidates(dbPath), "case 6: file replaced and now validates");
    } finally {
      server.close();
    }
  });

  // Chunked release assets (split-for-release.sh) — the path production uses.
  // Failure modes: parts reassembled out of order or one dropped; chunks
  // ignored in favour of the single-file URL; reading past the first missing
  // part; a stale orphan part from an older, larger build corrupting the file.
  // The base URL serves garbage throughout, so only a correct reassembly of the
  // parts can produce a DB that validates.
  const GARBAGE = Buffer.from("single-file asset must not be used when parts exist");

  await atest("chunked .gz parts → reassembled in order, decompressed, valid", async () => {
    const gz = zlib.gzipSync(validBuf);
    const server = await startRouteServer({ "/db.gz": GARBAGE, ...splitParts("/db.gz", gz, 3) });
    try {
      const dbPath = setupEnsureDb("c7", serverUrl(server, "/db.gz"));
      await callEnsureDb("t7");
      assert(dbValidates(dbPath), "case 7: reassembled gzip DB validates");
      assertEq(sha256(fs.readFileSync(dbPath)), sha256(validBuf), "case 7: bytes identical to the source DB");
      assertNoTempFiles(dbPath, "case 7");
    } finally {
      server.close();
    }
  });

  await atest("chunked uncompressed parts → reassembled, valid", async () => {
    const server = await startRouteServer({ "/db": GARBAGE, ...splitParts("/db", validBuf, 3) });
    try {
      const dbPath = setupEnsureDb("c8", serverUrl(server, "/db"));
      await callEnsureDb("t8");
      assertEq(sha256(fs.readFileSync(dbPath)), sha256(validBuf), "case 8: bytes identical to the source DB");
      assertNoTempFiles(dbPath, "case 8");
    } finally {
      server.close();
    }
  });

  await atest("gap in the part sequence → parts after the gap are not used", async () => {
    // aa + ab are a complete DB; ad sits after a missing ac and is garbage.
    const parts = splitParts("/db", validBuf, 2);
    const server = await startRouteServer({ "/db": GARBAGE, ...parts, "/db.part-ad": GARBAGE });
    try {
      const dbPath = setupEnsureDb("c9", serverUrl(server, "/db"));
      await callEnsureDb("t9");
      assertEq(sha256(fs.readFileSync(dbPath)), sha256(validBuf), "case 9: reassembly stops at the first missing part");
    } finally {
      server.close();
    }
  });

  await atest("orphan part from an older build → download rejected, local DB preserved", async () => {
    // Fresh build = aa + ab; ac is the tail of an older, larger build that the
    // release runbook's prune step would have deleted.
    const fresh = splitParts("/db.gz", zlib.gzipSync(validBuf), 2);
    const older = zlib.gzipSync(Buffer.concat([validBuf, crypto.randomBytes(4096)]));
    const server = await startRouteServer({ ...fresh, "/db.gz.part-ac": older.subarray(older.length / 2) });
    try {
      // Invalid local copy: a valid one takes the refresh path, which never reads parts.
      const dbPath = setupEnsureDb("c10", serverUrl(server, "/db.gz"));
      writeInvalidDb(dbPath);
      const hashBefore = sha256(fs.readFileSync(dbPath));
      await callEnsureDb("t10", { refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), hashBefore, "case 10: local file unchanged after a corrupt reassembly");
      assertNoTempFiles(dbPath, "case 10");
    } finally {
      server.close();
    }
  });

  await atest("5xx mid-sequence → download rejected, local DB preserved", async () => {
    // Uncompressed, so no gzip trailer check catches the truncation; SQLite's
    // own page-count check makes the installed prefix fail validation.
    const parts = splitParts("/db", validBuf, 3);
    const server = await startRouteServer({ "/db": GARBAGE, ...parts, "/db.part-ab": 503 });
    try {
      const dbPath = setupEnsureDb("c11", serverUrl(server, "/db"));
      writeInvalidDb(dbPath);
      const hashBefore = sha256(fs.readFileSync(dbPath));
      await callEnsureDb("t11", { refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), hashBefore, "case 11: local file unchanged after a failed part");
      assertNoTempFiles(dbPath, "case 11");
    } finally {
      server.close();
    }
  });

  // Stalls: a server that accepts a request and never answers. Bounds are far
  // below the 330 s default, so reaching them means the configured timeout ran.
  const startStallServer = (routes = {}) => new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      if (routes[req.url]) res.end(routes[req.url]);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
  });

  await atest("refresh with a valid local copy and a stalled URL → one short try, local DB kept", async () => {
    const { server, requests } = await startStallServer();
    try {
      const dbPath = setupEnsureDb("c12", serverUrl(server, "/db"));
      writeValidDb(dbPath);
      const hashBefore = sha256(fs.readFileSync(dbPath));
      const t0 = Date.now();
      await callEnsureDb("t12", { refreshOnStartup: true, refreshTimeoutMs: 150 });
      assert(Date.now() - t0 < 5_000, `case 12: bounded by refreshTimeoutMs (took ${Date.now() - t0} ms)`);
      assertList(requests, ["/db"], "case 12: one single-file request, no .part probe");
      assertEq(sha256(fs.readFileSync(dbPath)), hashBefore, "case 12: local file unchanged");
      assertNoTempFiles(dbPath, "case 12");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  await atest("refresh with a valid local copy → the new file replaces it", async () => {
    const server = await startRouteServer({ "/db": validBuf });
    try {
      const dbPath = setupEnsureDb("c13", serverUrl(server, "/db"));
      writeValidDb(dbPath);
      const older = new Database(dbPath);
      older.exec("INSERT INTO t VALUES (2)");
      older.close();
      assert(sha256(fs.readFileSync(dbPath)) !== sha256(validBuf), "case 13: precondition — the local file differs");
      await callEnsureDb("t13", { refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), sha256(validBuf), "case 13: refreshed file installed");
    } finally {
      server.close();
    }
  });

  await atest("no local copy and a stalled first part → gives up, no second timeout on the base URL", async () => {
    const { server, requests } = await startStallServer();
    try {
      const dbPath = setupEnsureDb("c14", serverUrl(server, "/db"));
      await callEnsureDb("t14", { downloadTimeoutMs: 150 });
      assertList(requests, ["/db.part-aa"], "case 14: the stall is not read as 'no chunks'");
      assert(!fs.existsSync(dbPath), "case 14: nothing installed");
      assertNoTempFiles(dbPath, "case 14");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  await atest("no local copy and no chunks → full download still falls back to the single file", async () => {
    const server = await startRouteServer({ "/db": validBuf });
    try {
      const dbPath = setupEnsureDb("c15", serverUrl(server, "/db"));
      await callEnsureDb("t15", { refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), sha256(validBuf), "case 15: single file installed");
    } finally {
      server.close();
    }
  });

  // ════════════════════════════════════════════════════════════════
  section("cachedFor");

  {
    let reads = 0;
    const read = cachedFor(150, () => ++reads);
    assertEq(read(), 1, "cachedFor: first call reads");
    assertEq(read(), 1, "cachedFor: a call inside the TTL reuses the value");
    await new Promise((r) => setTimeout(r, 200));
    assertEq(read(), 2, "cachedFor: a call after the TTL reads again");
  }

  // ════════════════════════════════════════════════════════════════
  section("VectorIndex — two-pass KNN");

  {
    // Small set (exact path): matches brute-force cosine, in order, with true similarities.
    const rows = int8Rows(300, 16, 7);
    const names = rows.map((_, i) => `n${i}`);
    const index = new VectorIndex(names, rows, 16, 8);
    const q = Int8Array.from(int8Rows(1, 16, 99)[0]);
    const hits = index.search(q, 10);
    assertList(hits.map((h) => h.notation), bruteTopK(rows, q, 10), "exact path: top-10 equals brute-force cosine order");
    const i0 = Number(hits[0].notation.slice(1));
    assert(Math.abs(hits[0].similarity - cosine(new Int8Array(rows[i0].buffer, rows[i0].byteOffset, 16), q)) < 1e-6,
      "exact path: similarity is the true cosine");
  }

  {
    // Two-pass path (n > 2000): prefix scores tie inside a 100-row group whose
    // prefix equals the query's, so only the full-vector rescore can order it.
    const dims = 8, coarse = 4, n = 3000;
    const q = Int8Array.from([50, 40, 30, 20, 10, -10, 20, -30]);
    const rows = int8Rows(n, dims, 11, (i, j, rnd) => {
      if (i < 100) return j < coarse ? q[j] : Math.round(rnd());          // tied prefix, varied tail
      return j < coarse ? (j % 2 ? 60 : -60) * (j < 2 ? 1 : -1) : Math.round(rnd()); // prefix far from q
    });
    const index = new VectorIndex(rows.map((_, i) => `n${i}`), rows, dims, coarse);
    assertList(index.search(q, 10).map((h) => h.notation), bruteTopK(rows, q, 10),
      "two-pass path: rescore orders by full cosine, not by the tied prefix");
  }

  {
    // Candidates restrict the result set, on both paths.
    const rows = int8Rows(2500, 16, 3);
    const index = new VectorIndex(rows.map((_, i) => `n${i}`), rows, 16, 8);
    const q = Int8Array.from(int8Rows(1, 16, 5)[0]);
    const big = Int32Array.from({ length: 2100 }, (_, i) => i + 400); // rows 400..2499
    const bigSet = new Set(Array.from(big, (i) => `n${i}`));
    const bigHits = index.search(q, 20, big);
    assert(bigHits.length === 20 && bigHits.every((h) => bigSet.has(h.notation)), "two-pass path: only candidate rows returned");
    const small = Int32Array.from([5, 900, 1700, 2400]);
    const smallHits = index.search(q, 10, small);
    assertList(smallHits.map((h) => h.notation), bruteTopK(rows, q, 10, Array.from(small)),
      "k > candidates: exactly the candidates, best first, no padding");
    assertList(index.search(q, 10, new Int32Array(0)), [], "empty candidates → []");
    assertList(index.search(q, 0), [], "k = 0 → []");
  }
  {
    // A mis-sized blob must fail the build, not read past it or rank on a prefix.
    const rows = int8Rows(3, 16, 7);
    for (const [bad, label] of [[Buffer.alloc(8), "short"], [Buffer.alloc(32), "long"], [null, "NULL"]]) {
      let msg = "";
      try { new VectorIndex(["a", "b", "c"], [rows[0], bad, rows[2]], 16, 8); } catch (e) { msg = e.message; }
      assertEq(msg, `Embedding for b is ${bad?.length ?? "NULL"} bytes, expected 16`, `${label} blob → build throws, naming the row`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  section("embeddingsCountConsistent — partial-table guard");
  assert(embeddingsCountConsistent(null, 0) === true, "null expected → trust (older DB)");
  assert(embeddingsCountConsistent(NaN, 100) === true, "NaN expected → trust (unparseable)");
  assert(embeddingsCountConsistent(39802, 39802) === true, "match → trust");
  assert(embeddingsCountConsistent(39802, 12000) === false, "fewer than expected → distrust (partial)");
  assert(embeddingsCountConsistent(39802, 39803) === false, "more than expected → distrust (drift)");

  // ════════════════════════════════════════════════════════════════
  section("EmbeddingModel — failed load and thread config");
  {
    const saved = { cacheDir: hfEnv.cacheDir, remote: hfEnv.allowRemoteModels,
      threads: process.env.EMBEDDING_THREADS, hfHome: process.env.HF_HOME, now: Date.now, err: console.error };
    const lines = [];
    console.error = (l) => { lines.push(String(l)); };
    try {
      delete process.env.HF_HOME;   // init() would otherwise point cacheDir back at it
      hfEnv.cacheDir = fs.mkdtempSync(path.join(tmpRoot, "hf-empty-"));
      hfEnv.allowRemoteModels = false;
      const failures = () => lines.filter((l) => l.includes("Failed to load embedding model")).length;
      const threadWarnings = () => lines.filter((l) => l.includes("EMBEDDING_THREADS")).map((l) => JSON.parse(l).message);

      process.env.EMBEDDING_THREADS = "abc";
      const m = new EmbeddingModel();
      await m.whenReady();
      assert(!m.available && failures() === 1, "load against an empty offline cache fails once");
      assertList(threadWarnings(), ['EMBEDDING_THREADS="abc" is not a positive integer — using 2'], "junk EMBEDDING_THREADS → warning, default 2");

      // Retries run in the background; an offline load fails in ~10 ms. Waiting
      // for a load that must NOT happen uses the short limit.
      const settled = async (n, ms = 2000) => {
        for (let t = 0; t < ms && failures() < n; t += 20) await new Promise((r) => setTimeout(r, 20));
      };

      await m.whenReady();
      await settled(2, 250);
      assertEq(failures(), 1, "a second query right after the failure does not reload");

      const t = Date.now();
      Date.now = () => t + 61_000;
      process.env.EMBEDDING_THREADS = "";
      await m.whenReady();
      assertEq(failures(), 1, "a query after the pause answers before the retry it starts has finished");
      await settled(2);
      assertEq(failures(), 2, "a query 61 s after the failure retries the load");
      assertEq(threadWarnings()[1], 'EMBEDDING_THREADS="" is not a positive integer — using 2', "empty EMBEDDING_THREADS → warning, not 0 threads");

      process.env.EMBEDDING_THREADS = "3";
      Date.now = () => t + 122_000;
      await m.whenReady();
      await settled(3);
      assert(failures() === 3 && threadWarnings().length === 2, "valid EMBEDDING_THREADS → no warning");

      Date.now = () => t + 183_000;
      await m.whenReady();
      await settled(4, 250);
      assertEq(failures(), 3, "no fourth load: retries stop after 3 loads in all");
    } finally {
      console.error = saved.err;
      Date.now = saved.now;
      hfEnv.cacheDir = saved.cacheDir;
      hfEnv.allowRemoteModels = saved.remote;
      if (saved.threads === undefined) delete process.env.EMBEDDING_THREADS; else process.env.EMBEDDING_THREADS = saved.threads;
      if (saved.hfHome !== undefined) process.env.HF_HOME = saved.hfHome;
    }
  }

  // ════════════════════════════════════════════════════════════════
  section("UsageStats — concurrent writers");
  await atest("4 processes flushing one file → no failed rename", async () => {
    const file = path.join(tmpRoot, "shared-usage.json");
    const mod = new URL("../../dist/utils/UsageStats.js", import.meta.url).href;
    const child = `import { UsageStats } from ${JSON.stringify(mod)};
      const s = new UsageStats(${JSON.stringify(file)});
      for (let i = 0; i < 50; i++) { s.record("search", 1, true); s.flush(); }`;
    const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      c.stderr.on("data", (d) => { err += d; });
      c.on("exit", (code) => resolve({ code, err }));
    }));
    const results = await Promise.all(runs);
    assert(results.every((r) => r.code === 0), "all writers exit 0");
    assertEq(results.filter((r) => r.err.includes("usage stats flush failed")).length, 0, "no writer logs a failed flush");
  });

  // ════════════════════════════════════════════════════════════════
  section("withResponseTimeout — through toNodeHandler");
  {
    const TIMEOUT_MS = 50;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    /** Serve one stubbed fetch over real HTTP; the adapter's errors are collected. */
    const serve = async (fetchStub) => {
      const adapterErrors = [];
      const handle = toNodeHandler(withResponseTimeout({ fetch: fetchStub }, TIMEOUT_MS), {
        onerror: (e) => adapterErrors.push(e.message),
      });
      const rejections = [];
      const server = http.createServer((req, res) => {
        handle(req, res).catch((e) => { rejections.push(e.message); res.destroy(); });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${server.address().port}/mcp`;
      return { url, adapterErrors, rejections, close: () => { server.closeAllConnections(); server.close(); } };
    };
    const post = (url) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    await atest("a stuck call is answered 504 once, and its late SSE body is cancelled", async () => {
      let cancelled = false;
      const late = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(": keepalive\n\n")); },
        cancel() { cancelled = true; },
      });
      const s = await serve(async () => {
        await sleep(TIMEOUT_MS * 3);
        return new Response(late, { headers: { "content-type": "text/event-stream" } });
      });
      try {
        const r = await post(s.url);
        assertEq(r.status, 504, "the stuck call is answered 504");
        assertEq(await r.text(), '{"error":"Request timeout"}', "the 504 body names the timeout");
        await sleep(TIMEOUT_MS * 4);
        assert(cancelled, "the late response's body is cancelled");
        assertEq(s.rejections.length, 0, "the adapter doesn't throw (no ERR_HTTP_HEADERS_SENT)");
      } finally { s.close(); }
    });

    await atest("a client that leaves during a stuck call doesn't break the 504 path", async () => {
      const s = await serve(async () => { await sleep(TIMEOUT_MS * 3); return new Response("late"); });
      try {
        const ac = new AbortController();
        const pending = fetch(s.url, { method: "POST", body: "{}", signal: ac.signal }).catch((e) => e.name);
        await sleep(TIMEOUT_MS / 5);
        ac.abort();
        assertEq(await pending, "AbortError", "the client aborted");
        await sleep(TIMEOUT_MS * 4);
        assertEq(s.rejections.length, 0, "the adapter survives writing to the closed response");
      } finally { s.close(); }
    });

    await atest("a rejection after the timeout stays handled", async () => {
      const s = await serve(async () => { await sleep(TIMEOUT_MS * 2); throw new Error("late failure"); });
      try {
        assertEq((await post(s.url)).status, 504, "the stuck call is answered 504");
        await sleep(TIMEOUT_MS * 3);
        assertEq(unhandled.length, 0, "no unhandled rejection");
      } finally { s.close(); }
    });

    await atest("a stream that outlives the timeout is not cut", async () => {
      const s = await serve(async () => new Response(new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode("first,"));
          await sleep(TIMEOUT_MS * 3);
          c.enqueue(new TextEncoder().encode("last"));
          c.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }));
      try {
        const r = await post(s.url);
        assertEq(r.status, 200, "the stream keeps its status");
        assertEq(await r.text(), "first,last", "the stream runs to its end, past the timeout");
      } finally { s.close(); }
    });

    await atest("a response in time passes through unchanged", async () => {
      const s = await serve(async () => new Response("ok", { status: 201, headers: { "x-test": "1" } }));
      try {
        const r = await post(s.url);
        assertEq(r.status, 201, "status passes through");
        assertEq(r.headers.get("x-test"), "1", "headers pass through");
        assertEq(await r.text(), "ok", "body passes through");
      } finally { s.close(); }
    });

    await atest("a handler throw reaches the adapter's 500, not the 504", async () => {
      const s = await serve(async () => { throw new Error("boom"); });
      try {
        const r = await post(s.url);
        assertEq(r.status, 500, "the throw becomes the adapter's 500");
        assertEq((await r.json()).error?.message, "Internal server error", "the 500 is the adapter's JSON-RPC error");
        assertEq(s.adapterErrors.join(), "boom", "the adapter's onerror sees the cause");
      } finally { s.close(); }
    });

    process.off("unhandledRejection", onUnhandled);
  }

  // ════════════════════════════════════════════════════════════════
  section("Skill bundles");
  {
    const dir = path.join(import.meta.dirname, "..", "..", "docs", "skills");
    const source = fs.readFileSync(path.join(dir, "rijksmuseum-iconclass-mcp", "SKILL.md"));
    const zip = path.join(dir, "rijksmuseum-iconclass-mcp.skill.zip");
    const unzipped = spawnSync("unzip", ["-p", zip, "SKILL.md"]);
    assertEq(unzipped.status, 0, "the zip bundle contains SKILL.md");
    assert(Buffer.compare(unzipped.stdout, source) === 0, "the zip bundle matches SKILL.md (run npm run build:skill)");
    assert(Buffer.compare(fs.readFileSync(zip), fs.readFileSync(path.join(dir, "rijksmuseum-iconclass-mcp.skill"))) === 0, "the two bundles are identical");
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "..", "..", "package.json"), "utf-8"));
    assertEq(source.toString().match(/^ {2}version: "(.+)"$/m)?.[1], pkg.version, "SKILL.md's version matches package.json");
  }

  // ── Summary ───────────────────────────────────────────────────
  report();
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
