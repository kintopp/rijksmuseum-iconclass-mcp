/**
 * Benchmark paging constants: latency and payload size at various page sizes.
 *
 * Measures actual DB queries (not MCP overhead) to isolate the data layer.
 * Reports both wall-clock latency and JSON payload sizes to inform
 * defaults vs. max tradeoffs — especially where pagination round-trips
 * cost the user wallclock time via LLM reasoning overhead.
 *
 * Usage: node scripts/tests/benchmark-paging.mjs
 */

import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ─── Open DB (mirrors IconclassDb constructor) ─────────────────────

const db = new Database(path.join(ROOT, "data/iconclass.db"), { readonly: true });
db.pragma("mmap_size = 4294967296");

const countsPath = path.join(ROOT, "data/iconclass-counts.db");
db.exec(`ATTACH DATABASE '${countsPath}' AS counts`);

const sqliteVec = require("sqlite-vec");
sqliteVec.load(db);

// ─── Prepared statements (same as IconclassDb) ────────────────────

const stmtTextFts = db.prepare(
  `SELECT DISTINCT t.notation FROM texts t
   WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
);
const stmtKwFts = db.prepare(
  `SELECT DISTINCT k.notation FROM keywords k
   WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
);
const stmtGetNotation = db.prepare(
  "SELECT notation, path, children, refs, base_notation, key_id, is_key_expanded FROM notations WHERE notation = ?"
);
const stmtGetText = db.prepare("SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1");
const stmtGetKeywords = db.prepare("SELECT keyword FROM keywords WHERE notation = ? AND lang = ? LIMIT 20");
const stmtKeyVariantsPage = db.prepare(
  "SELECT notation FROM notations WHERE base_notation = ? ORDER BY notation LIMIT ? OFFSET ?"
);
const stmtKeyVariantsCount = db.prepare("SELECT COUNT(*) as n FROM notations WHERE base_notation = ?");
const stmtPrefixSearch = db.prepare(
  "SELECT notation FROM notations WHERE notation LIKE ? ORDER BY notation LIMIT ? OFFSET ?"
);
const stmtGetCounts = db.prepare(
  "SELECT collection_id, count FROM counts.collection_counts WHERE notation = ?"
);

// ─── Resolve helper (mirrors IconclassDb.resolveEntry) ────────────

function resolveEntry(notation) {
  const row = stmtGetNotation.get(notation);
  if (!row) return null;

  const pathNotations = JSON.parse(row.path);
  const pathEntries = pathNotations.map(n => {
    const t = stmtGetText.get(n, "en");
    return { notation: n, text: t?.text ?? n };
  });

  const text = stmtGetText.get(notation, "en");
  const keywords = stmtGetKeywords.all(notation, "en").map(r => r.keyword);
  const countRows = stmtGetCounts.all(notation);
  const collectionCounts = {};
  for (const cr of countRows) collectionCounts[cr.collection_id] = cr.count;

  return {
    notation: row.notation,
    text: text?.text ?? row.notation,
    path: pathEntries,
    children: JSON.parse(row.children),
    refs: JSON.parse(row.refs),
    keywords,
    isKeyExpanded: row.is_key_expanded === 1,
    baseNotation: row.base_notation,
    keyId: row.key_id,
    collectionCounts,
  };
}

// ─── Batch resolve with count fetching (mirrors server) ───────────

function batchResolve(notations) {
  // Batch count fetch via temp table
  db.exec("CREATE TEMP TABLE IF NOT EXISTS _bench_notations (notation TEXT PRIMARY KEY)");
  db.exec("DELETE FROM _bench_notations");
  const insert = db.prepare("INSERT OR IGNORE INTO _bench_notations VALUES (?)");
  const insertAll = db.transaction(ns => { for (const n of ns) insert.run(n); });
  insertAll(notations);

  const countRows = db.prepare(`
    SELECT cc.notation, cc.collection_id, cc.count
    FROM counts.collection_counts cc
    INNER JOIN _bench_notations bn ON cc.notation = bn.notation
  `).all();

  const countsCache = new Map();
  for (const cr of countRows) {
    let c = countsCache.get(cr.notation);
    if (!c) { c = {}; countsCache.set(cr.notation, c); }
    c[cr.collection_id] = cr.count;
  }

  return notations.map(n => {
    const entry = resolveEntry(n);
    if (entry && countsCache.has(n)) entry.collectionCounts = countsCache.get(n);
    return entry;
  }).filter(Boolean);
}

// ─── Timing helper ────────────────────────────────────────────────

function timeMs(fn, warmup = 1, runs = 5) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    min: times[0],
    median: times[Math.floor(times.length / 2)],
    p95: times[Math.floor(times.length * 0.95)],
    max: times[times.length - 1],
  };
}

function fmtMs(v) { return v.toFixed(1).padStart(7) + " ms"; }
function fmtKB(v) { return (v / 1024).toFixed(1).padStart(7) + " KB"; }

function heading(title) {
  console.log(`\n${"═".repeat(74)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(74)}`);
}

// ═══════════════════════════════════════════════════════════════════
// 1. FTS SEARCH — latency & payload at page sizes 10, 25, 50
// ═══════════════════════════════════════════════════════════════════

heading("1. FTS search — latency & payload vs. page size");

{
  const queries = [
    { term: "crucifixion", label: "narrow (844)" },
    { term: "horse",       label: "medium (8.5K)" },
    { term: "portrait",    label: "broad (28.7K)" },
    { term: "death",       label: "very broad (30.3K)" },
    { term: "cat",         label: "narrow (837)" },
    { term: "landscape",   label: "medium (2K)" },
  ];
  const pageSizes = [10, 25, 50];

  console.log("\n  Query              Page   Latency (median)   Payload    Entries");
  console.log("  " + "─".repeat(68));

  for (const { term, label } of queries) {
    const fts = `"${term}"`;

    for (const ps of pageSizes) {
      let result;
      const t = timeMs(() => {
        const textHits = stmtTextFts.all(fts);
        const kwHits = stmtKwFts.all(fts);
        const notationSet = new Set();
        for (const r of textHits) notationSet.add(r.notation);
        for (const r of kwHits) notationSet.add(r.notation);

        // Batch count fetch + sort (mirrors server hot path)
        const notations = [...notationSet];
        const entries = batchResolve(notations.slice(0, ps));
        result = { totalResults: notations.length, results: entries, collections: [] };
      });

      const payload = Buffer.byteLength(JSON.stringify(result), "utf8");
      const lbl = pageSizes.indexOf(ps) === 0 ? `${term} (${label})` : "";
      console.log(
        `  ${lbl.padEnd(32).slice(0, 32)} ${String(ps).padStart(4)}  ${fmtMs(t.median)}       ${fmtKB(payload)}  ${result.results.length}`
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2. RESOLVE — latency & payload at batch sizes 5, 10, 15, 25
// ═══════════════════════════════════════════════════════════════════

heading("2. Resolve — latency & payload vs. batch size");

{
  // Pick notations with diverse characteristics
  const heavyNotations = db.prepare(`
    SELECT n.notation, COUNT(k.keyword) as kw_count
    FROM notations n
    LEFT JOIN keywords k ON k.notation = n.notation AND k.lang = 'en'
    WHERE n.is_key_expanded = 0
    GROUP BY n.notation
    ORDER BY kw_count DESC
    LIMIT 25
  `).all().map(r => r.notation);

  const typicalNotations = db.prepare(`
    SELECT notation FROM notations WHERE is_key_expanded = 0 ORDER BY RANDOM() LIMIT 25
  `).pluck().all();

  const keyExpandedNotations = db.prepare(`
    SELECT notation FROM notations WHERE is_key_expanded = 1 ORDER BY RANDOM() LIMIT 25
  `).pluck().all();

  const batchSizes = [5, 10, 15, 25];

  console.log("\n  Scenario                  Batch   Latency (median)   Payload");
  console.log("  " + "─".repeat(62));

  for (const [label, pool] of [
    ["heavy (most keywords)", heavyNotations],
    ["typical (random base)", typicalNotations],
    ["key-expanded (random)", keyExpandedNotations],
  ]) {
    for (const bs of batchSizes) {
      const batch = pool.slice(0, bs);
      let result;
      const t = timeMs(() => {
        result = batchResolve(batch);
      });
      const payload = Buffer.byteLength(JSON.stringify({ notations: result, collections: [] }), "utf8");
      const lbl = batchSizes.indexOf(bs) === 0 ? label : "";
      console.log(
        `  ${lbl.padEnd(28).slice(0, 28)} ${String(bs).padStart(4)}  ${fmtMs(t.median)}       ${fmtKB(payload)}`
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. EXPAND_KEYS — latency & payload at various page sizes
//    Focus: cost of pagination vs. returning everything
// ═══════════════════════════════════════════════════════════════════

heading("3. Expand keys — latency & payload vs. page size");

{
  // Pick base notations with different variant counts
  const targets = db.prepare(`
    SELECT base_notation, COUNT(*) as cnt
    FROM notations
    WHERE is_key_expanded = 1 AND base_notation IS NOT NULL
    GROUP BY base_notation
    ORDER BY cnt DESC
  `).all();

  // Select specimens at different variant counts
  const specimens = [
    targets.find(r => r.cnt >= 330),       // max tier (335)
    targets.find(r => r.cnt >= 200 && r.cnt <= 210),  // ~200
    targets.find(r => r.cnt >= 100 && r.cnt <= 110),  // ~100
    targets.find(r => r.cnt >= 20 && r.cnt <= 30),    // ~25
    targets.find(r => r.cnt >= 5 && r.cnt <= 10),     // small
  ].filter(Boolean);

  const pageSizes = [25, 50, 100, 200, 335];

  console.log("\n  Notation (variants)         Page   Latency (median)   Payload    Pages needed");
  console.log("  " + "─".repeat(74));

  for (const { base_notation, cnt } of specimens) {
    for (const ps of pageSizes) {
      const effective = Math.min(ps, cnt);
      let result;
      const t = timeMs(() => {
        const keyRows = stmtKeyVariantsPage.all(base_notation, ps, 0);
        result = keyRows.map(r => resolveEntry(r.notation)).filter(Boolean);
      });
      const payload = Buffer.byteLength(JSON.stringify({
        notation: base_notation,
        baseEntry: resolveEntry(base_notation),
        keyVariants: result,
        totalKeyVariants: cnt,
        collections: [],
      }), "utf8");
      const pages = Math.ceil(cnt / ps);
      const lbl = pageSizes.indexOf(ps) === 0 ? `${base_notation} (${cnt} variants)` : "";
      console.log(
        `  ${lbl.padEnd(30).slice(0, 30)} ${String(ps).padStart(4)}  ${fmtMs(t.median)}       ${fmtKB(payload)}  ${pages === 1 ? "1 (complete)" : pages + " pages"}`
      );
    }
  }

  // Summary: how many base notations need >1 page at each max
  console.log("\n  Pagination elimination at different max values:");
  console.log("  Max      Single-page    Needs pagination    % complete in 1 call");
  console.log("  " + "─".repeat(62));
  for (const max of [25, 50, 100, 200, 335]) {
    const single = targets.filter(r => r.cnt <= max).length;
    const multi = targets.filter(r => r.cnt > max).length;
    const pct = (single / targets.length * 100).toFixed(1);
    console.log(`  ${String(max).padEnd(8)} ${single.toLocaleString().padStart(8)}          ${multi.toLocaleString().padStart(8)}             ${pct}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4. BROWSE — children + key variants latency
// ═══════════════════════════════════════════════════════════════════

heading("4. Browse — latency with includeKeys at various page sizes");

{
  // Pick notations with many children and/or key variants
  const browseTargets = [
    { notation: "73D", label: "73D (9 children, 0 keys)" },
    { notation: "25F23", label: "25F23 (8 children, 204 keys)" },
    { notation: "31A", label: "31A (6 children, 98 keys)" },
    { notation: "48C73", label: "48C73 (7 children, 43 keys)" },
    { notation: "11H", label: "11H (2 children, 335 keys)" },
  ];
  const keyPageSizes = [25, 50, 100, 200, 335];

  console.log("\n  Notation                       Keys page   Latency (median)   Payload");
  console.log("  " + "─".repeat(70));

  for (const { notation, label } of browseTargets) {
    // First: without keys
    let result;
    const tNoKeys = timeMs(() => {
      const entry = resolveEntry(notation);
      const children = entry ? JSON.parse(stmtGetNotation.get(notation).children) : [];
      const subtree = children.map(n => resolveEntry(n)).filter(Boolean);
      result = { notation, entry, subtree, keyVariants: [], totalKeyVariants: 0, collections: [] };
    });
    const payloadNoKeys = Buffer.byteLength(JSON.stringify(result), "utf8");
    console.log(
      `  ${label.padEnd(33).slice(0, 33)} no keys  ${fmtMs(tNoKeys.median)}       ${fmtKB(payloadNoKeys)}`
    );

    // With keys at various page sizes
    const totalKeys = stmtKeyVariantsCount.get(notation)?.n ?? 0;
    if (totalKeys > 0) {
      for (const ps of keyPageSizes) {
        let kvResult;
        const t = timeMs(() => {
          const entry = resolveEntry(notation);
          const children = entry ? JSON.parse(stmtGetNotation.get(notation).children) : [];
          const subtree = children.map(n => resolveEntry(n)).filter(Boolean);
          const keyRows = stmtKeyVariantsPage.all(notation, ps, 0);
          const keyVariants = keyRows.map(r => resolveEntry(r.notation)).filter(Boolean);
          kvResult = { notation, entry, subtree, keyVariants, totalKeyVariants: totalKeys, collections: [] };
        });
        const payload = Buffer.byteLength(JSON.stringify(kvResult), "utf8");
        const pages = Math.ceil(totalKeys / ps);
        console.log(
          `  ${"".padEnd(33)} ${String(ps).padStart(7)}  ${fmtMs(t.median)}       ${fmtKB(payload)}  ${pages === 1 ? "(complete)" : `(${pages} pages)`}`
        );
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. PREFIX SEARCH — latency & payload at page sizes
// ═══════════════════════════════════════════════════════════════════

heading("5. Prefix search — latency & payload vs. page size");

{
  const prefixes = [
    { prefix: "73D8", label: "73D8 (narrow, ~10)" },
    { prefix: "25F2", label: "25F2 (medium, ~42K)" },
    { prefix: "31A3", label: "31A3 (medium, ~22K)" },
    { prefix: "73",   label: "73 (broad, ~97K)" },
    { prefix: "4",    label: "4 (very broad, ~571K)" },
  ];
  const pageSizes = [25, 50, 100];

  console.log("\n  Prefix                     Page   Latency (median)   Payload    Total results");
  console.log("  " + "─".repeat(74));

  for (const { prefix, label } of prefixes) {
    for (const ps of pageSizes) {
      let result;
      const t = timeMs(() => {
        const rows = stmtPrefixSearch.all(`${prefix}%`, ps, 0);
        const entries = rows.map(r => resolveEntry(r.notation)).filter(Boolean);
        // Get total count
        const total = db.prepare("SELECT COUNT(*) as n FROM notations WHERE notation LIKE ?").get(`${prefix}%`).n;
        result = { prefix, totalResults: total, results: entries, collections: [] };
      });
      const payload = Buffer.byteLength(JSON.stringify(result), "utf8");
      const lbl = pageSizes.indexOf(ps) === 0 ? `${label}` : "";
      console.log(
        `  ${lbl.padEnd(29).slice(0, 29)} ${String(ps).padStart(4)}  ${fmtMs(t.median)}       ${fmtKB(payload)}  ${result.totalResults.toLocaleString()}`
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 6. TOKEN ESTIMATION — approximate LLM context cost
// ═══════════════════════════════════════════════════════════════════

heading("6. Token estimation — LLM context cost per response");

{
  // Rough token estimate: 1 token ≈ 4 bytes for JSON (conservative)
  // Claude's actual tokenizer averages ~3.5 bytes/token for English JSON
  const BYTES_PER_TOKEN = 3.5;

  // Sample responses at key page sizes
  const scenarios = [
    { label: "search (25 results, FTS 'horse')", fn: () => {
      const fts = '"horse"';
      const textHits = stmtTextFts.all(fts);
      const kwHits = stmtKwFts.all(fts);
      const s = new Set(); for (const r of textHits) s.add(r.notation); for (const r of kwHits) s.add(r.notation);
      return { totalResults: s.size, results: batchResolve([...s].slice(0, 25)), collections: [] };
    }},
    { label: "search (50 results, FTS 'horse')", fn: () => {
      const fts = '"horse"';
      const textHits = stmtTextFts.all(fts);
      const kwHits = stmtKwFts.all(fts);
      const s = new Set(); for (const r of textHits) s.add(r.notation); for (const r of kwHits) s.add(r.notation);
      return { totalResults: s.size, results: batchResolve([...s].slice(0, 50)), collections: [] };
    }},
    { label: "resolve (10 notations)", fn: () => {
      const ns = db.prepare("SELECT notation FROM notations WHERE is_key_expanded = 0 ORDER BY RANDOM() LIMIT 10").pluck().all();
      return { notations: batchResolve(ns), collections: [] };
    }},
    { label: "resolve (15 notations)", fn: () => {
      const ns = db.prepare("SELECT notation FROM notations WHERE is_key_expanded = 0 ORDER BY RANDOM() LIMIT 15").pluck().all();
      return { notations: batchResolve(ns), collections: [] };
    }},
    { label: "resolve (25 notations)", fn: () => {
      const ns = db.prepare("SELECT notation FROM notations WHERE is_key_expanded = 0 ORDER BY RANDOM() LIMIT 25").pluck().all();
      return { notations: batchResolve(ns), collections: [] };
    }},
    { label: "expand_keys (200 variants)", fn: () => {
      const base = "11H";
      const rows = stmtKeyVariantsPage.all(base, 200, 0);
      return { notation: base, baseEntry: resolveEntry(base), keyVariants: rows.map(r => resolveEntry(r.notation)).filter(Boolean), totalKeyVariants: 335, collections: [] };
    }},
    { label: "expand_keys (335 variants)", fn: () => {
      const base = "11H";
      const rows = stmtKeyVariantsPage.all(base, 335, 0);
      return { notation: base, baseEntry: resolveEntry(base), keyVariants: rows.map(r => resolveEntry(r.notation)).filter(Boolean), totalKeyVariants: 335, collections: [] };
    }},
    { label: "browse 25F23 + 25 keys", fn: () => {
      const entry = resolveEntry("25F23");
      const children = JSON.parse(stmtGetNotation.get("25F23").children);
      const subtree = children.map(n => resolveEntry(n)).filter(Boolean);
      const kv = stmtKeyVariantsPage.all("25F23", 25, 0).map(r => resolveEntry(r.notation)).filter(Boolean);
      return { notation: "25F23", entry, subtree, keyVariants: kv, totalKeyVariants: 204, collections: [] };
    }},
    { label: "browse 25F23 + 200 keys", fn: () => {
      const entry = resolveEntry("25F23");
      const children = JSON.parse(stmtGetNotation.get("25F23").children);
      const subtree = children.map(n => resolveEntry(n)).filter(Boolean);
      const kv = stmtKeyVariantsPage.all("25F23", 200, 0).map(r => resolveEntry(r.notation)).filter(Boolean);
      return { notation: "25F23", entry, subtree, keyVariants: kv, totalKeyVariants: 204, collections: [] };
    }},
  ];

  console.log("\n  Scenario                            Bytes       ~Tokens   % of 200K context");
  console.log("  " + "─".repeat(72));

  for (const { label, fn } of scenarios) {
    const data = fn();
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
    const pctContext = (tokens / 200_000 * 100).toFixed(2);
    console.log(
      `  ${label.padEnd(38).slice(0, 38)} ${bytes.toLocaleString().padStart(8)}    ${tokens.toLocaleString().padStart(8)}          ${pctContext}%`
    );
  }

  console.log("\n  Note: 200K context = Claude Sonnet/Opus working context.");
  console.log("  Rule of thumb: tool responses >5% of context start to crowd out reasoning.");
}

db.close();
console.log("\n✓ Benchmark complete.\n");
