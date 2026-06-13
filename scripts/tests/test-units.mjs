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

// ── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

/** Run an async test body; a throw becomes a failure rather than aborting the suite. */
async function atest(msg, fn) {
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push(`${msg} — threw: ${err.message}`);
    console.log(`  ✗ ${msg} (threw: ${err.message})`);
  }
}

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** A valid SQLite file (table t with one row) as a byte buffer. */
function makeValidDbBuffer(dir, name) {
  const p = path.join(dir, name);
  const db = new Database(p);
  db.exec("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
  db.close();
  const buf = fs.readFileSync(p);
  fs.unlinkSync(p);
  return buf;
}

/** Write a valid SQLite DB (table t + row) at path. */
function writeValidDb(p) {
  const db = new Database(p);
  db.exec("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
  db.close();
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

function dbValidates(p) {
  const db = new Database(p, { readonly: true });
  try {
    return !!db.prepare(VALIDATION_QUERY).get();
  } finally {
    db.close();
  }
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
    const dir = fs.mkdtempSync(path.join(tmpRoot, "c1-"));
    const dbPath = path.join(dir, "db.sqlite");
    writeValidDb(dbPath);
    process.env.TEST_DB_PATH_1 = dbPath;
    delete process.env.TEST_DB_URL_1;
    const before = fs.statSync(dbPath).mtimeMs;
    await ensureDb({ name: "t1", pathEnvVar: "TEST_DB_PATH_1", urlEnvVar: "TEST_DB_URL_1", defaultFile: "x.db", validationQuery: VALIDATION_QUERY });
    const after = fs.statSync(dbPath).mtimeMs;
    assertEq(after, before, "case 1: mtime unchanged (no re-download)");
    assert(dbValidates(dbPath), "case 1: file still valid");
  });

  await atest("no local file + no URL → no file created, no throw", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "c2-"));
    const dbPath = path.join(dir, "db.sqlite");
    process.env.TEST_DB_PATH_2 = dbPath;
    delete process.env.TEST_DB_URL_2;
    await ensureDb({ name: "t2", pathEnvVar: "TEST_DB_PATH_2", urlEnvVar: "TEST_DB_URL_2", defaultFile: "x.db", validationQuery: VALIDATION_QUERY });
    assert(!fs.existsSync(dbPath), "case 2: no file created");
  });

  await atest("no local file + URL (uncompressed) → downloaded + valid", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "c3-"));
    const dbPath = path.join(dir, "db.sqlite");
    const server = await startServer(validBuf);
    try {
      process.env.TEST_DB_PATH_3 = dbPath;
      process.env.TEST_DB_URL_3 = serverUrl(server, "/db");
      await ensureDb({ name: "t3", pathEnvVar: "TEST_DB_PATH_3", urlEnvVar: "TEST_DB_URL_3", defaultFile: "x.db", validationQuery: VALIDATION_QUERY });
      assert(fs.existsSync(dbPath), "case 3: file downloaded");
      assert(dbValidates(dbPath), "case 3: downloaded file validates");
    } finally {
      server.close();
    }
  });

  await atest("no local file + .gz URL → decompressed + valid", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "c4-"));
    const dbPath = path.join(dir, "db.sqlite");
    const server = await startServer(zlib.gzipSync(validBuf));
    try {
      process.env.TEST_DB_PATH_4 = dbPath;
      process.env.TEST_DB_URL_4 = serverUrl(server, "/db.gz");
      await ensureDb({ name: "t4", pathEnvVar: "TEST_DB_PATH_4", urlEnvVar: "TEST_DB_URL_4", defaultFile: "x.db", validationQuery: VALIDATION_QUERY });
      assert(fs.existsSync(dbPath), "case 4: file downloaded");
      assert(dbValidates(dbPath), "case 4: gunzipped file validates");
      assert(!fs.existsSync(dbPath + ".tmp.gz"), "case 4: no .tmp.gz left behind");
    } finally {
      server.close();
    }
  });

  await atest("corrupt download + refreshOnStartup → local file preserved", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "c5-"));
    const dbPath = path.join(dir, "db.sqlite");
    writeValidDb(dbPath);
    const hashBefore = sha256(fs.readFileSync(dbPath));
    const server = await startServer(Buffer.from("this is not a sqlite database at all"));
    try {
      process.env.TEST_DB_PATH_5 = dbPath;
      process.env.TEST_DB_URL_5 = serverUrl(server, "/db");
      await ensureDb({ name: "t5", pathEnvVar: "TEST_DB_PATH_5", urlEnvVar: "TEST_DB_URL_5", defaultFile: "x.db", validationQuery: VALIDATION_QUERY, refreshOnStartup: true });
      assertEq(sha256(fs.readFileSync(dbPath)), hashBefore, "case 5: local file unchanged after bad refresh");
      assert(dbValidates(dbPath), "case 5: local file still valid");
      assert(!fs.existsSync(dbPath + ".tmp"), "case 5: no .tmp left behind");
      assert(!fs.existsSync(dbPath + ".tmp.gz"), "case 5: no .tmp.gz left behind");
    } finally {
      server.close();
    }
  });

  await atest("existing INVALID DB + URL → replaced with valid download", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "c6-"));
    const dbPath = path.join(dir, "db.sqlite");
    writeInvalidDb(dbPath);
    assert(!(() => { try { return dbValidates(dbPath); } catch { return false; } })(), "case 6: precondition — local file fails validation");
    const server = await startServer(validBuf);
    try {
      process.env.TEST_DB_PATH_6 = dbPath;
      process.env.TEST_DB_URL_6 = serverUrl(server, "/db");
      await ensureDb({ name: "t6", pathEnvVar: "TEST_DB_PATH_6", urlEnvVar: "TEST_DB_URL_6", defaultFile: "x.db", validationQuery: VALIDATION_QUERY });
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
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(60)}`);

  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
