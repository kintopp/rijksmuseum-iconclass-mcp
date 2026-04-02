#!/usr/bin/env node
/**
 * Benchmark: old iconclass.db (e5-small 384d, 40K) vs new (e5-base 768d, 1.3M)
 *
 * Compares:
 *   - Semantic search quality (same queries, side-by-side top-5)
 *   - FTS query times
 *   - Semantic query times
 *   - Browse/prefix times
 *
 * Usage:
 *   node scripts/tests/benchmark-old-vs-new.mjs
 */

import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);

// ─── Paths ──────────────────────────────────────────────────────────

const OLD_DB = process.env.OLD_DB || "../rijksmuseum-mcp-plus/data/iconclass.db";
const NEW_DB = process.env.NEW_DB || "data/iconclass.db";
const OLD_MODEL = "Xenova/multilingual-e5-small";
const NEW_MODEL = "Xenova/multilingual-e5-base";

// ─── Queries ────────────────────────────────────────────────────────

const SEMANTIC_QUERIES = [
  "domestic animals",
  "crucifixion of Christ",
  "flowers and plants",
  "ships and naval vessels",
  "portrait of a woman",
  "musical instruments",
  "landscape with mountains",
  "mythological creatures",
  "battle scene",
  "mother and child",
  "still life with fruit",
  "death and mourning",
];

const FTS_QUERIES = [
  "crucifixion",
  "sleeping",
  "portrait",
  "landscape",
  "horse",
  "angel",
  "flower",
  "battle",
  "dog",
  "ship",
  "musical",
  "death",
];

const BROWSE_NOTATIONS = ["73D", "25F23", "11", "31A", "48C73", "34B"];
const PREFIX_QUERIES = ["73D8", "25F2", "11A", "48C", "31B", "92D"];

// ─── DB helpers ─────────────────────────────────────────────────────

function openDb(path, label) {
  try {
    const db = new Database(path, { readonly: true });
    db.pragma("mmap_size = 1073741824");
    const count = db.prepare("SELECT COUNT(*) as n FROM notations").get().n;
    console.log(`  ${label}: ${count.toLocaleString()} notations`);

    // Check embeddings
    let hasEmb = false;
    let embCount = 0;
    let embDim = 0;
    try {
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(db);
      embCount = db.prepare("SELECT COUNT(*) as n FROM iconclass_embeddings").get().n;
      // Detect dimensions from version_info or first row
      try {
        const dimRow = db.prepare("SELECT value FROM version_info WHERE key = 'embedding_dimensions'").get();
        embDim = dimRow ? parseInt(dimRow.value) : 0;
      } catch {}
      if (!embDim) {
        const row = db.prepare("SELECT embedding FROM iconclass_embeddings LIMIT 1").get();
        if (row) embDim = row.embedding.length; // int8: 1 byte per dim
      }
      hasEmb = embCount > 0;
      console.log(`  ${label}: ${embCount.toLocaleString()} embeddings (${embDim}d)`);
    } catch {
      console.log(`  ${label}: no embeddings`);
    }

    return { db, hasEmb, embDim, count };
  } catch (err) {
    console.error(`  ${label}: FAILED to open — ${err.message}`);
    return null;
  }
}

function escapeFts5(value) {
  const cleaned = value.replace(/[.*^():{}[\]\\]/g, "").replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

function ftsSearch(db, query, limit = 25) {
  const fts = escapeFts5(query);
  if (!fts) return [];

  const textHits = db.prepare(
    `SELECT DISTINCT t.notation FROM texts t
     WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
  ).all(fts);

  const kwHits = db.prepare(
    `SELECT DISTINCT k.notation FROM keywords k
     WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
  ).all(fts);

  const notations = new Set();
  for (const r of textHits) notations.add(r.notation);
  for (const r of kwHits) notations.add(r.notation);

  // Resolve text labels for top results
  const stmtText = db.prepare("SELECT text FROM texts WHERE notation = ? AND lang = 'en' LIMIT 1");
  const results = [];
  for (const n of notations) {
    const row = stmtText.get(n);
    results.push({ notation: n, text: row?.text || n });
    if (results.length >= limit) break;
  }
  return { total: notations.size, results };
}

function semanticSearch(db, queryVec, dim, limit = 5) {
  const stmtQ = db.prepare("SELECT vec_quantize_int8(vec_normalize(?), 'unit') as v");
  const quantized = stmtQ.get(queryVec);

  const rows = db.prepare(`
    SELECT notation, distance FROM vec_iconclass
    WHERE embedding MATCH vec_int8(?) AND k = ?
    ORDER BY distance
  `).all(quantized.v, limit);

  const stmtText = db.prepare("SELECT text FROM texts WHERE notation = ? AND lang = 'en' LIMIT 1");
  return rows.map(r => {
    const text = stmtText.get(r.notation);
    return {
      notation: r.notation,
      similarity: Math.round((1 - r.distance) * 1000) / 1000,
      text: text?.text || r.notation,
    };
  });
}

function browseNotation(db, notation) {
  const row = db.prepare("SELECT notation, path, children, refs FROM notations WHERE notation = ?").get(notation);
  if (!row) return null;
  const children = JSON.parse(row.children);
  return { notation, childCount: children.length };
}

function prefixSearch(db, prefix, limit = 25) {
  const rows = db.prepare(
    "SELECT notation FROM notations WHERE notation LIKE ? ORDER BY notation LIMIT ?"
  ).all(`${prefix}%`, limit);
  return rows.length;
}

// ─── Timing helper ──────────────────────────────────────────────────

function timeIt(fn, iterations = 1) {
  // Warmup
  fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { avg, min, max };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Iconclass DB Benchmark: Old (e5-small) vs New (e5-base)");
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("Opening databases...");
  const old = openDb(OLD_DB, "OLD");
  const nw = openDb(NEW_DB, "NEW");
  if (!old || !nw) {
    console.error("Failed to open one or both databases.");
    process.exit(1);
  }
  console.log();

  // ── Load embedding models ─────────────────────────────────────
  console.log("Loading embedding models...");
  const { pipeline } = await import("@huggingface/transformers");

  const t0m = performance.now();
  const pipeOld = await pipeline("feature-extraction", OLD_MODEL, { dtype: "q8" });
  const oldModelMs = Math.round(performance.now() - t0m);
  console.log(`  OLD model (${OLD_MODEL}): loaded in ${oldModelMs}ms`);

  const t1m = performance.now();
  const pipeNew = await pipeline("feature-extraction", NEW_MODEL, { dtype: "q8" });
  const newModelMs = Math.round(performance.now() - t1m);
  console.log(`  NEW model (${NEW_MODEL}): loaded in ${newModelMs}ms`);
  console.log();

  async function embed(pipe, text) {
    const output = await pipe("query: " + text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  // ══════════════════════════════════════════════════════════════
  // 1. SEMANTIC SEARCH COMPARISON
  // ══════════════════════════════════════════════════════════════

  console.log("══════════════════════════════════════════════════════");
  console.log("  1. SEMANTIC SEARCH — Quality Comparison (top 5)");
  console.log("══════════════════════════════════════════════════════\n");

  const semanticTimes = { old: [], new: [] };

  for (const query of SEMANTIC_QUERIES) {
    console.log(`  Query: "${query}"`);
    console.log("  " + "─".repeat(56));

    // Old DB
    const vecOld = await embed(pipeOld, query);
    let t0 = performance.now();
    const oldResults = semanticSearch(old.db, vecOld, old.embDim, 5);
    const oldMs = performance.now() - t0;
    semanticTimes.old.push(oldMs);

    // New DB
    const vecNew = await embed(pipeNew, query);
    t0 = performance.now();
    const newResults = semanticSearch(nw.db, vecNew, nw.embDim, 5);
    const newMs = performance.now() - t0;
    semanticTimes.new.push(newMs);

    // Print side by side
    console.log(`  OLD (384d, ${oldMs.toFixed(1)}ms):`);
    for (const r of oldResults) {
      console.log(`    [${r.similarity}] ${r.notation} — ${r.text.slice(0, 70)}`);
    }
    console.log(`  NEW (768d, ${newMs.toFixed(1)}ms):`);
    for (const r of newResults) {
      console.log(`    [${r.similarity}] ${r.notation} — ${r.text.slice(0, 70)}`);
    }

    // Overlap
    const oldSet = new Set(oldResults.map(r => r.notation));
    const newSet = new Set(newResults.map(r => r.notation));
    const overlap = [...oldSet].filter(n => newSet.has(n)).length;
    const topMatch = oldResults[0]?.notation === newResults[0]?.notation ? "✓" : "✗";
    console.log(`  Overlap: ${overlap}/5 | Top-1 match: ${topMatch}`);
    console.log();
  }

  // ══════════════════════════════════════════════════════════════
  // 2. FTS SEARCH TIMING
  // ══════════════════════════════════════════════════════════════

  console.log("══════════════════════════════════════════════════════");
  console.log("  2. FTS SEARCH — Timing & Result Counts");
  console.log("══════════════════════════════════════════════════════\n");

  console.log("  " + "Query".padEnd(14) + "OLD results".padEnd(14) + "OLD ms".padEnd(10) + "NEW results".padEnd(14) + "NEW ms".padEnd(10) + "Ratio");
  console.log("  " + "─".repeat(72));

  const ftsTimes = { old: [], new: [] };

  for (const query of FTS_QUERIES) {
    const { avg: oldMs } = timeIt(() => ftsSearch(old.db, query), 3);
    const { avg: newMs } = timeIt(() => ftsSearch(nw.db, query), 3);
    const oldR = ftsSearch(old.db, query);
    const newR = ftsSearch(nw.db, query);
    ftsTimes.old.push(oldMs);
    ftsTimes.new.push(newMs);

    const ratio = (newR.total / Math.max(oldR.total, 1)).toFixed(1) + "x";
    console.log(
      "  " +
      query.padEnd(14) +
      String(oldR.total).padEnd(14) +
      oldMs.toFixed(1).padStart(6).padEnd(10) +
      String(newR.total).padEnd(14) +
      newMs.toFixed(1).padStart(6).padEnd(10) +
      ratio
    );
  }

  // ══════════════════════════════════════════════════════════════
  // 3. BROWSE TIMING
  // ══════════════════════════════════════════════════════════════

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  3. BROWSE — Timing");
  console.log("══════════════════════════════════════════════════════\n");

  console.log("  " + "Notation".padEnd(12) + "OLD ms".padEnd(10) + "NEW ms".padEnd(10));
  console.log("  " + "─".repeat(32));

  for (const notation of BROWSE_NOTATIONS) {
    const { avg: oldMs } = timeIt(() => browseNotation(old.db, notation), 5);
    const { avg: newMs } = timeIt(() => browseNotation(nw.db, notation), 5);
    console.log(
      "  " +
      notation.padEnd(12) +
      oldMs.toFixed(2).padStart(6).padEnd(10) +
      newMs.toFixed(2).padStart(6).padEnd(10)
    );
  }

  // ══════════════════════════════════════════════════════════════
  // 4. PREFIX SEARCH TIMING
  // ══════════════════════════════════════════════════════════════

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  4. PREFIX SEARCH — Timing & Result Counts");
  console.log("══════════════════════════════════════════════════════\n");

  console.log("  " + "Prefix".padEnd(10) + "OLD results".padEnd(14) + "OLD ms".padEnd(10) + "NEW results".padEnd(14) + "NEW ms".padEnd(10));
  console.log("  " + "─".repeat(58));

  for (const prefix of PREFIX_QUERIES) {
    const { avg: oldMs } = timeIt(() => prefixSearch(old.db, prefix, 100), 5);
    const { avg: newMs } = timeIt(() => prefixSearch(nw.db, prefix, 100), 5);
    const oldC = prefixSearch(old.db, prefix, 100);
    const newC = prefixSearch(nw.db, prefix, 100);
    console.log(
      "  " +
      prefix.padEnd(10) +
      String(oldC).padEnd(14) +
      oldMs.toFixed(2).padStart(6).padEnd(10) +
      String(newC).padEnd(14) +
      newMs.toFixed(2).padStart(6).padEnd(10)
    );
  }

  // ══════════════════════════════════════════════════════════════
  // 5. EMBEDDING TIME
  // ══════════════════════════════════════════════════════════════

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  5. QUERY EMBEDDING TIME (single query)");
  console.log("══════════════════════════════════════════════════════\n");

  const embedQueries = ["domestic animals", "crucifixion of Christ", "landscape with mountains"];
  for (const q of embedQueries) {
    const times384 = [];
    const times768 = [];
    for (let i = 0; i < 5; i++) {
      let t = performance.now();
      await embed(pipeOld, q);
      times384.push(performance.now() - t);
      t = performance.now();
      await embed(pipeNew, q);
      times768.push(performance.now() - t);
    }
    const avg384 = times384.reduce((a, b) => a + b) / times384.length;
    const avg768 = times768.reduce((a, b) => a + b) / times768.length;
    console.log(`  "${q}"`);
    console.log(`    e5-small (384d): ${avg384.toFixed(1)}ms avg`);
    console.log(`    e5-base  (768d): ${avg768.toFixed(1)}ms avg`);
    console.log();
  }

  // ══════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════

  console.log("══════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("══════════════════════════════════════════════════════\n");

  const avgOldSem = semanticTimes.old.reduce((a, b) => a + b) / semanticTimes.old.length;
  const avgNewSem = semanticTimes.new.reduce((a, b) => a + b) / semanticTimes.new.length;
  const avgOldFts = ftsTimes.old.reduce((a, b) => a + b) / ftsTimes.old.length;
  const avgNewFts = ftsTimes.new.reduce((a, b) => a + b) / ftsTimes.new.length;

  console.log(`  OLD DB: ${old.count.toLocaleString()} notations, ${old.embDim}d embeddings`);
  console.log(`  NEW DB: ${nw.count.toLocaleString()} notations, ${nw.embDim}d embeddings`);
  console.log();
  console.log(`  Avg semantic search: OLD ${avgOldSem.toFixed(1)}ms → NEW ${avgNewSem.toFixed(1)}ms`);
  console.log(`  Avg FTS search:      OLD ${avgOldFts.toFixed(1)}ms → NEW ${avgNewFts.toFixed(1)}ms`);
  console.log();

  old.db.close();
  nw.db.close();
}

main().catch(console.error);
