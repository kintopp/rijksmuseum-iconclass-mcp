/**
 * Unit tests for critical paths that sit between the pure-function tests and
 * the DB-backed integration suite: UsageStats persistence, ensureDb
 * download/validate/swap, and MRL vector truncation.
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
import { mrlTruncate } from "../../dist/api/EmbeddingModel.js";
import { assert, assertEq, section, atest, report } from "./_assert.mjs";

// ── Test helpers ─────────────────────────────────────────────────

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
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

/** Start an HTTP server that serves `body` for the main URL and 404s any
 *  `.part-*` chunk request (so tryChunkedDownload falls through to single-file). */
function startServer(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.includes(".part-")) {
        res.statusCode = 404;
        res.end("no chunk");
        return;
      }
      res.statusCode = 200;
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
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
    s.record("search", 100, true);
    s.record("search", 100, true);
    s.record("search", 50, false);
    const t = s.toJSON().tools.search;
    assertEq(t.calls, 3, "record: calls counted");
    assertEq(t.errors, 1, "record: errors counted");
    assertEq(t.totalMs, 250, "record: totalMs summed");
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
    const server = await startServer(validBuf);
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
    const server = await startServer(zlib.gzipSync(validBuf));
    try {
      const dbPath = setupEnsureDb("c4", serverUrl(server, "/db.gz"));
      await callEnsureDb("t4");
      assert(fs.existsSync(dbPath), "case 4: file downloaded");
      assert(dbValidates(dbPath), "case 4: gunzipped file validates");
      assert(!fs.existsSync(dbPath + ".tmp.gz"), "case 4: no .tmp.gz left behind");
    } finally {
      server.close();
    }
  });

  await atest("corrupt download + refreshOnStartup → local file preserved", async () => {
    const server = await startServer(Buffer.from("this is not a sqlite database at all"));
    try {
      const dbPath = setupEnsureDb("c5", serverUrl(server, "/db"));
      writeValidDb(dbPath);
      const hashBefore = sha256(fs.readFileSync(dbPath));
      await callEnsureDb("t5", { refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), hashBefore, "case 5: local file unchanged after bad refresh");
      assert(dbValidates(dbPath), "case 5: local file still valid");
      assert(!fs.existsSync(dbPath + ".tmp"), "case 5: no .tmp left behind");
      assert(!fs.existsSync(dbPath + ".tmp.gz"), "case 5: no .tmp.gz left behind");
    } finally {
      server.close();
    }
  });

  await atest("existing INVALID DB + URL → replaced with valid download", async () => {
    const server = await startServer(validBuf);
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

  // ════════════════════════════════════════════════════════════════
  section("mrlTruncate");

  {
    // 1. targetDim = 0 → no-op, same values, full length.
    const v = Float32Array.from([1, 2, 3, 4]);
    const out = mrlTruncate(v, 0);
    assertEq(out.length, 4, "case 1: length unchanged when targetDim=0");
    assert(out[0] === 1 && out[3] === 4, "case 1: values unchanged when targetDim=0");
  }

  {
    // 2. vec.length === targetDim → no-op.
    const v = Float32Array.from([1, 2, 3, 4]);
    const out = mrlTruncate(v, 4);
    assertEq(out.length, 4, "case 2: length unchanged when length===targetDim");
    assert(out[0] === 1 && out[3] === 4, "case 2: values unchanged when length===targetDim");
  }

  {
    // 3. 768 → 384: truncated length and unit L2 norm.
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = ((i * 31) % 97) + 1;
    const out = mrlTruncate(v, 384);
    assertEq(out.length, 384, "case 3: truncated to targetDim length");
    assert(Math.abs(l2(out) - 1) < 1e-5, "case 3: re-normalized to unit length");
  }

  {
    // 4. all-zeros vector → epsilon guard avoids NaN.
    const v = new Float32Array(768); // all zeros
    const out = mrlTruncate(v, 384);
    assertEq(out.length, 384, "case 4: truncated length");
    assert(!Array.from(out).some(Number.isNaN), "case 4: no NaNs from divide-by-zero guard");
  }

  {
    // 5. direction preserved: component ratios survive normalization.
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = ((i * 31) % 97) + 1;
    const ratioIn = v[10] / v[20];
    const out = mrlTruncate(v, 384);
    const ratioOut = out[10] / out[20];
    assert(Math.abs(ratioIn - ratioOut) < 1e-4, "case 5: component ratio preserved (uniform scaling)");
  }

  // ── Summary ───────────────────────────────────────────────────
  report();
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
