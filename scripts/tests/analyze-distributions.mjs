/**
 * Comprehensive distribution analysis for Iconclass MCP server.
 * Informs paging defaults by examining data shapes across the DB.
 *
 * Usage: node scripts/tests/analyze-distributions.mjs
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = new Database(path.join(ROOT, "data/iconclass.db"), { readonly: true });
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -64000"); // 64 MB

const countsDbPath = path.join(ROOT, "data/iconclass-counts.db");
db.exec(`ATTACH DATABASE '${countsDbPath}' AS counts`);

// ─── Utility ────────────────────────────────────────────────────────

function percentiles(sorted, ps) {
  const n = sorted.length;
  if (n === 0) return Object.fromEntries(ps.map(p => [p, null]));
  return Object.fromEntries(ps.map(p => {
    const idx = Math.min(Math.floor(p / 100 * n), n - 1);
    return [`p${p}`, sorted[idx]];
  }));
}

function stats(values) {
  if (values.length === 0) return { count: 0 };
  values.sort((a, b) => a - b);
  const sum = values.reduce((s, v) => s + v, 0);
  return {
    count: values.length,
    min: values[0],
    ...percentiles(values, [25, 50, 75, 90, 95, 99]),
    max: values[values.length - 1],
    mean: +(sum / values.length).toFixed(2),
  };
}

function heading(title) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

function table(obj) {
  const maxKey = Math.max(...Object.keys(obj).map(k => k.length));
  for (const [k, v] of Object.entries(obj)) {
    console.log(`  ${k.padEnd(maxKey + 2)}${typeof v === "number" ? v.toLocaleString() : v}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Children per notation
// ═══════════════════════════════════════════════════════════════════════
heading("1. Children per notation");

{
  const rows = db.prepare(`
    SELECT notation, children, is_key_expanded
    FROM notations
  `).all();

  const allCounts = [];
  const baseCounts = [];
  const keyCounts = [];

  for (const r of rows) {
    const arr = JSON.parse(r.children);
    const n = arr.length;
    allCounts.push(n);
    if (r.is_key_expanded) keyCounts.push(n);
    else baseCounts.push(n);
  }

  console.log("\n  All notations:");
  table(stats(allCounts));
  console.log("\n  Base notations only:");
  table(stats(baseCounts));
  console.log("\n  Key-expanded notations only:");
  table(stats(keyCounts));
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Key variants per base notation
// ═══════════════════════════════════════════════════════════════════════
heading("2. Key variants per base notation");

{
  // Count key-expanded notations per base_notation
  const variantCounts = db.prepare(`
    SELECT base_notation, COUNT(*) as cnt
    FROM notations
    WHERE is_key_expanded = 1 AND base_notation IS NOT NULL
    GROUP BY base_notation
  `).all();

  const variantMap = new Map(variantCounts.map(r => [r.base_notation, r.cnt]));

  // All base notations
  const baseNotations = db.prepare(`
    SELECT notation FROM notations WHERE is_key_expanded = 0
  `).pluck().all();

  const counts = baseNotations.map(n => variantMap.get(n) || 0);

  console.log("\n  Distribution of key variants per base notation:");
  table(stats(counts));

  // Bucket breakdown
  const buckets = { "0": 0, "1-25": 0, "26-50": 0, "51-100": 0, "101-200": 0, "201+": 0 };
  for (const c of counts) {
    if (c === 0) buckets["0"]++;
    else if (c <= 25) buckets["1-25"]++;
    else if (c <= 50) buckets["26-50"]++;
    else if (c <= 100) buckets["51-100"]++;
    else if (c <= 200) buckets["101-200"]++;
    else buckets["201+"]++;
  }
  console.log("\n  Bucket breakdown:");
  for (const [bucket, count] of Object.entries(buckets)) {
    const pct = (count / counts.length * 100).toFixed(1);
    console.log(`    ${bucket.padEnd(10)} ${count.toLocaleString().padStart(8)}  (${pct}%)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Keywords per notation
// ═══════════════════════════════════════════════════════════════════════
heading("3. Keywords per notation");

{
  const kwCounts = db.prepare(`
    SELECT notation, lang, COUNT(*) as cnt
    FROM keywords
    GROUP BY notation, lang
  `).all();

  const allCounts = kwCounts.map(r => r.cnt);
  const enCounts = kwCounts.filter(r => r.lang === "en").map(r => r.cnt);

  console.log("\n  All (notation, lang) pairs:");
  table(stats(allCounts));
  console.log("\n  English keywords only:");
  table(stats(enCounts));

  // What % are fully captured by LIMIT 20?
  const within20all = allCounts.filter(c => c <= 20).length;
  const within20en = enCounts.filter(c => c <= 20).length;
  console.log(`\n  Captured by LIMIT 20:`);
  console.log(`    All langs: ${within20all.toLocaleString()} / ${allCounts.length.toLocaleString()} (${(within20all / allCounts.length * 100).toFixed(1)}%)`);
  console.log(`    English:   ${within20en.toLocaleString()} / ${enCounts.length.toLocaleString()} (${(within20en / enCounts.length * 100).toFixed(1)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Subtree sizes for prefix search
// ═══════════════════════════════════════════════════════════════════════
heading("4. Subtree sizes for prefix search");

{
  for (const prefixLen of [1, 2, 3]) {
    const rows = db.prepare(`
      SELECT SUBSTR(notation, 1, ?) as prefix, COUNT(*) as cnt
      FROM notations
      GROUP BY SUBSTR(notation, 1, ?)
    `).all(prefixLen, prefixLen);

    const counts = rows.map(r => r.cnt);
    console.log(`\n  ${prefixLen}-char prefix subtrees (${rows.length} distinct prefixes):`);
    table(stats(counts));

    // Show top 5 largest
    rows.sort((a, b) => b.cnt - a.cnt);
    console.log(`    Top 5: ${rows.slice(0, 5).map(r => `${r.prefix}=${r.cnt.toLocaleString()}`).join(", ")}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. FTS result set sizes
// ═══════════════════════════════════════════════════════════════════════
heading("5. FTS result set sizes");

{
  const queries = [
    "crucifixion", "horse", "portrait", "landscape", "dog", "angel",
    "flower", "death", "sleeping", "battle", "musical", "ship",
    "woman", "child", "tree", "church", "king", "sword", "bridge", "cat"
  ];

  // Use rowid-based FTS matching (same pattern as the server) — much faster
  const stmtTextFts = db.prepare(
    `SELECT DISTINCT t.notation FROM texts t WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
  );
  const stmtKwFts = db.prepare(
    `SELECT DISTINCT k.notation FROM keywords k WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
  );

  console.log("\n  Query                texts_fts    keywords_fts    combined (unique notations)");
  console.log("  " + "─".repeat(66));

  for (const q of queries) {
    const escaped = `"${q}"`;
    const textNotations = stmtTextFts.all(escaped);
    const kwNotations = stmtKwFts.all(escaped);

    // Deduplicate for combined count
    const combined = new Set([
      ...textNotations.map(r => r.notation),
      ...kwNotations.map(r => r.notation),
    ]);

    console.log(`  ${q.padEnd(18)} ${textNotations.length.toLocaleString().padStart(8)}    ${kwNotations.length.toLocaleString().padStart(8)}        ${combined.size.toLocaleString().padStart(8)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. Response size estimation
// ═══════════════════════════════════════════════════════════════════════
heading("6. Response size estimation");

{
  // Sample 50 base and 50 key-expanded notations
  const baseSample = db.prepare(`
    SELECT notation FROM notations WHERE is_key_expanded = 0 ORDER BY RANDOM() LIMIT 50
  `).pluck().all();
  const keySample = db.prepare(`
    SELECT notation FROM notations WHERE is_key_expanded = 1 ORDER BY RANDOM() LIMIT 50
  `).pluck().all();

  const sample = [...baseSample, ...keySample];
  const sizes = [];

  // Prepare statements
  const getNotation = db.prepare(`SELECT * FROM notations WHERE notation = ?`);
  const getTexts = db.prepare(`SELECT lang, text FROM texts WHERE notation = ?`);
  const getKeywords = db.prepare(`SELECT lang, keyword FROM keywords WHERE notation = ?`);
  const getCount = db.prepare(`SELECT collection_id, count FROM counts.collection_counts WHERE notation = ?`);

  for (const notation of sample) {
    const n = getNotation.get(notation);
    const texts = getTexts.all(notation);
    const keywords = getKeywords.all(notation);
    const counts = getCount.all(notation);

    // Build a response object similar to what the server returns
    const entry = {
      notation: n.notation,
      text: texts.find(t => t.lang === "en")?.text || texts[0]?.text || "",
      path: JSON.parse(n.path),
      children: JSON.parse(n.children),
      refs: JSON.parse(n.refs),
      keywords: keywords.filter(k => k.lang === "en").map(k => k.keyword),
      isKeyExpanded: !!n.is_key_expanded,
      baseNotation: n.base_notation,
      keyId: n.key_id,
      collectionCounts: Object.fromEntries(counts.map(c => [c.collection_id, c.count])),
    };

    sizes.push(Buffer.byteLength(JSON.stringify(entry), "utf8"));
  }

  console.log("\n  JSON byte size per entry (100-sample):");
  table(stats(sizes));

  // Estimate response sizes at different page sizes
  sizes.sort((a, b) => a - b);
  const p50size = sizes[Math.floor(sizes.length * 0.5)];
  const p95size = sizes[Math.floor(sizes.length * 0.95)];

  console.log("\n  Estimated total response sizes:");
  console.log("  Page size    p50 response    p95 response");
  console.log("  " + "─".repeat(46));
  for (const ps of [10, 25, 50]) {
    const p50total = (p50size * ps / 1024).toFixed(1);
    const p95total = (p95size * ps / 1024).toFixed(1);
    console.log(`  ${String(ps).padEnd(12)} ${p50total.padStart(8)} KB      ${p95total.padStart(8)} KB`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Collection count coverage
// ═══════════════════════════════════════════════════════════════════════
heading("7. Collection count coverage");

{
  const totalNotations = db.prepare(`SELECT COUNT(*) as cnt FROM notations`).get().cnt;
  const withCounts = db.prepare(`
    SELECT COUNT(DISTINCT notation) as cnt FROM counts.collection_counts WHERE count > 0
  `).get().cnt;

  console.log(`\n  Total notations:           ${totalNotations.toLocaleString()}`);
  console.log(`  Notations with count > 0:  ${withCounts.toLocaleString()}`);
  console.log(`  Coverage:                  ${(withCounts / totalNotations * 100).toFixed(2)}%`);

  // Load the set of notations that have counts, for fast in-memory lookup
  const notationsWithCounts = new Set(
    db.prepare(`SELECT DISTINCT notation FROM counts.collection_counts WHERE count > 0`).pluck().all()
  );

  // For a few representative FTS queries, what fraction of results have counts?
  const queries = ["horse", "portrait", "landscape", "death", "flower"];
  console.log("\n  Fraction of FTS results with collection counts:");
  console.log("  Query            results    with counts    fraction");
  console.log("  " + "─".repeat(54));

  const stmtTextFts7 = db.prepare(
    `SELECT DISTINCT t.notation FROM texts t WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
  );
  const stmtKwFts7 = db.prepare(
    `SELECT DISTINCT k.notation FROM keywords k WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
  );

  for (const q of queries) {
    const escaped = `"${q}"`;
    const combined = new Set([
      ...stmtTextFts7.all(escaped).map(r => r.notation),
      ...stmtKwFts7.all(escaped).map(r => r.notation),
    ]);

    let withC = 0;
    for (const n of combined) {
      if (notationsWithCounts.has(n)) withC++;
    }

    const frac = combined.size > 0 ? (withC / combined.size * 100).toFixed(1) : "N/A";
    console.log(`  ${q.padEnd(18)} ${combined.size.toLocaleString().padStart(6)}    ${withC.toLocaleString().padStart(8)}       ${frac}%`);
  }

  // Also check prefix results
  console.log("\n  Fraction of prefix results with collection counts:");
  console.log("  Prefix    results    with counts    fraction");
  console.log("  " + "─".repeat(48));

  for (const prefix of ["1", "25", "31", "71", "9"]) {
    const resultNotations = db.prepare(`
      SELECT notation FROM notations WHERE notation LIKE ? || '%'
    `).pluck().all(prefix);

    let withC = 0;
    for (const n of resultNotations) {
      if (notationsWithCounts.has(n)) withC++;
    }

    const frac = resultNotations.length > 0 ? (withC / resultNotations.length * 100).toFixed(1) : "N/A";
    console.log(`  ${prefix.padEnd(10)} ${resultNotations.length.toLocaleString().padStart(6)}    ${withC.toLocaleString().padStart(8)}       ${frac}%`);
  }
}

db.close();
console.log("\n✓ Analysis complete.\n");
