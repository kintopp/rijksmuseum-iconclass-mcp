/**
 * Integration tests for all 6 Iconclass MCP tools via stdio transport.
 *
 * Run:  node scripts/tests/test-tools.mjs
 * Requires: npm run build, data/iconclass.db present, and the embedding model
 * (semantic sections FAIL, not skip, when it is unavailable).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assert, assertEq, section, report } from "./_assert.mjs";
import { bootHttpServer } from "./_server.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Test helpers ─────────────────────────────────────────────────

/** Extract structured content from tool result. */
function sc(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

/** Extract text content from tool result. */
function txt(result) {
  return result.content?.[0]?.text ?? "";
}

// ── Connect ──────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-tools", version: "0.1" });
await client.connect(transport);
console.log("Connected to Iconclass MCP server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. Tool listing
// ══════════════════════════════════════════════════════════════════

section("1. Tool listing");

const tools = await client.listTools();
const toolNames = tools.tools.map(t => t.name).sort();

assertEq(toolNames.length, 6, `6 tools registered`);
assert(toolNames.includes("search"), "search tool present");
assert(toolNames.includes("browse"), "browse tool present");
assert(toolNames.includes("resolve"), "resolve tool present");
assert(toolNames.includes("expand_keys"), "expand_keys tool present");
assert(toolNames.includes("search_prefix"), "search_prefix tool present");
assert(toolNames.includes("find_artworks"), "find_artworks tool present");

// Verify all tools have outputSchema (structuredContent enabled)
for (const tool of tools.tools) {
  assert(tool.outputSchema != null, `${tool.name} has outputSchema`);
  // Verify no $ref pointers (claude.ai can't resolve them)
  const schema = JSON.stringify(tool.outputSchema);
  assert(!schema.includes('"$ref"'), `${tool.name} outputSchema has no $ref`);
}

// Unknown params are rejected, not silently stripped: a renamed or misspelt
// filter must not turn into an unfiltered query.
const VALID_ARGS = {
  search: { query: "crucifixion" },
  browse: { notation: "73D6" },
  resolve: { notation: "73D6" },
  expand_keys: { notation: "25F23" },
  search_prefix: { notation: "73D6" },
  find_artworks: { notation: "73D6" },
};
assertEq(Object.keys(VALID_ARGS).sort().join(","), toolNames.join(","), "unknown-key check covers every registered tool");
for (const [name, args] of Object.entries(VALID_ARGS)) {
  const r = await client.callTool({ name, arguments: { ...args, bogus: 1 } });
  assertEq(txt(r), `Input validation error: Invalid arguments for tool ${name}: Unrecognized key: "bogus"`,
    `${name} rejects an unknown key`);
}

// Verify all tools advertise MCP behavioural annotations.
// All current Iconclass tools are pure SQLite reads → identical profile.
// If a future tool needs different hints (e.g. an open-world or mutating
// tool), update this assertion to match — but it must not be silently
// missing, since omitted destructiveHint defaults to true per spec.
for (const tool of tools.tools) {
  const a = tool.annotations;
  assert(a != null, `${tool.name} has annotations object`);
  if (!a) continue;
  assertEq(a.readOnlyHint, true, `${tool.name} readOnlyHint=true`);
  assertEq(a.destructiveHint, false, `${tool.name} destructiveHint=false`);
  assertEq(a.idempotentHint, true, `${tool.name} idempotentHint=true`);
  assertEq(a.openWorldHint, false, `${tool.name} openWorldHint=false`);
}

// ══════════════════════════════════════════════════════════════════
//  2. search — FTS mode
// ══════════════════════════════════════════════════════════════════

section("2. search — FTS mode");

const r2 = await client.callTool({
  name: "search",
  arguments: { query: "crucifixion", maxResults: 5 },
});

assert(!r2.isError, "no error");
const s2 = sc(r2);
assertEq(s2.query, "crucifixion", "query echoed back");
assert(s2.totalResults > 50, `totalResults > 50 (got ${s2.totalResults})`);
assertEq(s2.results.length, 5, "5 results returned");
assert(s2.results[0].collections.length > 0, "top result has collection presence");
assert(s2.results[0].path.length > 0, "has path");
assert(s2.results[0].keywords.length > 0, "has keywords");
assert(Array.isArray(s2.collections), "collections array present");

// Pagination
const r2b = await client.callTool({
  name: "search",
  arguments: { query: "crucifixion", maxResults: 3, offset: 3 },
});
const s2b = sc(r2b);
assertEq(s2b.results.length, 3, "pagination: 3 results at offset 3");
assert(s2b.results[0].notation !== s2.results[0].notation, "pagination: different first result");

// Collection filter
const r2c = await client.callTool({
  name: "search",
  arguments: { query: "crucifixion", collectionId: "rijksmuseum", maxResults: 5 },
});
const s2c = sc(r2c);
assert(s2c.results.length > 0, `collectionId filter returns results (got ${s2c.results.length})`);
for (const entry of s2c.results) {
  assert(entry.collections.includes("rijksmuseum"), `collectionId filter: ${entry.notation} has rijksmuseum presence`);
}

// parentNotation scope should be pushed into the FTS statements, while still
// returning only subtree results through the public tool contract.
const r2scope = await client.callTool({
  name: "search",
  arguments: { query: "Jerome", parentNotation: "11H", maxResults: 25 },
});
const s2scope = sc(r2scope);
assert(s2scope.results.length > 0, `parentNotation FTS returns results (got ${s2scope.results.length})`);
assert(s2scope.results.every(r => r.notation.startsWith("11H")), "parentNotation FTS results stay in subtree");

// No match
const r2d = await client.callTool({
  name: "search",
  arguments: { query: "xyznonexistent12345" },
});
const s2d = sc(r2d);
assertEq(s2d.totalResults, 0, "nonexistent query returns 0");

// A control character must never reach FTS5 as syntax; NUL acts as a word break.
const r2nul = await client.callTool({ name: "search", arguments: { query: "angel\u0000trumpet", maxResults: 50 } });
const r2sp = await client.callTool({ name: "search", arguments: { query: "angel trumpet", maxResults: 50 } });
if (assert(!r2nul.isError, `NUL in query is not an error (got: ${txt(r2nul).slice(0, 80)})`))
  assertEq(sc(r2nul).totalResults, sc(r2sp).totalResults, "NUL-separated query finds what the space-separated one does");

// ══════════════════════════════════════════════════════════════════
//  3. search — semantic mode
// ══════════════════════════════════════════════════════════════════

section("3. search — semantic mode");

const r3 = await client.callTool({
  name: "search",
  arguments: { semanticQuery: "domestic animals", maxResults: 5 },
});

if (assert(!r3.isError, `semantic search available (got: ${txt(r3).slice(0, 80)})`)) {
  const s3 = sc(r3);
  assertEq(s3.query, "domestic animals", "query echoed back");
  assertEq(s3.results.length, 5, "5 results returned");
  assert(s3.results[0].similarity > 0.7, `top similarity > 0.7 (got ${s3.results[0].similarity})`);
  assert(s3.results.every(r => typeof r.similarity === "number"), "all results have similarity");

  // onlyWithArtworks filter
  const r3b = await client.callTool({
    name: "search",
    arguments: { semanticQuery: "domestic animals", maxResults: 5, onlyWithArtworks: true },
  });
  if (assert(!r3b.isError, "onlyWithArtworks: no error")) {
    const s3b = sc(r3b);
    assert(s3b.results.length > 0, `onlyWithArtworks returns results (got ${s3b.results.length})`);
    for (const entry of s3b.results) {
      assert(entry.collections.length > 0, `onlyWithArtworks: ${entry.notation} has artworks (${entry.collections.length})`);
    }
  }

  // Pagination: offset should return different results
  const r3p = await client.callTool({
    name: "search",
    arguments: { semanticQuery: "domestic animals", maxResults: 3, offset: 3 },
  });
  if (assert(!r3p.isError, "semantic pagination: no error")) {
    const s3p = sc(r3p);
    assertEq(s3p.results.length, 3, "semantic pagination: 3 results at offset 3");
    assert(s3p.results[0].notation !== s3.results[0].notation,
      `semantic pagination: offset 3 differs from offset 0 (${s3p.results[0].notation} vs ${s3.results[0].notation})`);
  }
}

// Error: both query and semanticQuery
const r3c = await client.callTool({
  name: "search",
  arguments: { query: "test", semanticQuery: "test" },
});
assert(r3c.isError === true, "error when both query and semanticQuery provided");
assertEq(txt(r3c), "Provide exactly one of: query or semanticQuery — not both.", "both-modes error wording");

// Error: neither
const r3d = await client.callTool({
  name: "search",
  arguments: {},
});
assert(r3d.isError === true, "error when neither query nor semanticQuery provided");
assertEq(txt(r3d), "Provide exactly one of: query or semanticQuery.", "neither-mode error wording");

// ══════════════════════════════════════════════════════════════════
//  4. browse
// ══════════════════════════════════════════════════════════════════

section("4. browse");

const r4 = await client.callTool({
  name: "browse",
  arguments: { notation: "73D" },
});

assert(!r4.isError, "no error");
const s4 = sc(r4);
assertEq(s4.notation, "73D", "notation echoed");
assertEq(s4.entry.notation, "73D", "entry.notation is 73D");
assertEq(s4.entry.text, "Passion of Christ", "correct text");
assert(s4.entry.path.length === 2, `path has 2 ancestors (got ${s4.entry.path.length})`);
assertEq(s4.entry.path[0].notation, "7", "path[0] is 7 (Bible)");
assertEq(s4.entry.path[1].notation, "73", "path[1] is 73 (New Testament)");
assertEq(s4.subtree.length, 9, "9 children (73D1–73D9)");
assertEq(s4.subtree[0].notation, "73D1", "first child is 73D1");
assertEq(s4.subtree[8].notation, "73D9", "last child is 73D9");

// Browse with includeKeys (default page size 25)
const r4b = await client.callTool({
  name: "browse",
  arguments: { notation: "25F23", includeKeys: true },
});
const s4b = sc(r4b);
assertEq(s4b.keyVariants.length, 25, "key variants paginated to default 25");
assert(s4b.totalKeyVariants > 100, `totalKeyVariants > 100 (got ${s4b.totalKeyVariants})`);
assert(s4b.keyVariants[0].notation.includes("(+"), "key variants have (+) format");
assert(s4b.keyVariants[0].isKeyExpanded === true, "key variants marked as key-expanded");

// Browse with includeKeys + pagination
const r4b2 = await client.callTool({
  name: "browse",
  arguments: { notation: "25F23", includeKeys: true, maxKeyVariants: 5, keyOffset: 10 },
});
const s4b2 = sc(r4b2);
assertEq(s4b2.keyVariants.length, 5, "key variants page size respected");
assert(s4b2.keyVariants[0].notation !== s4b.keyVariants[0].notation, "keyOffset produces different first variant");

// Browse nonexistent
const r4c = await client.callTool({
  name: "browse",
  arguments: { notation: "ZZZZZ" },
});
assert(r4c.isError === true, "error for nonexistent notation");
assertEq(txt(r4c), 'Notation "ZZZZZ" not found in Iconclass.', "browse not-found wording");

// ══════════════════════════════════════════════════════════════════
//  5. resolve
// ══════════════════════════════════════════════════════════════════

section("5. resolve");

// Single notation
const r5 = await client.callTool({
  name: "resolve",
  arguments: { notation: "73D6" },
});
assert(!r5.isError, "no error");
const s5 = sc(r5);
assertEq(s5.notations.length, 1, "1 entry resolved");
assertEq(s5.notations[0].notation, "73D6", "notation is 73D6");
assert(s5.notations[0].keywords.length > 0, "has keywords");
assert(Array.isArray(s5.notFound), "notFound present on success");
assertEq(s5.notFound.length, 0, "notFound empty when all resolved");

// Batch resolve
const r5b = await client.callTool({
  name: "resolve",
  arguments: { notation: ["73D6", "31A33", "25F23(+46)", "NONEXISTENT"] },
});
const s5b = sc(r5b);
assertEq(s5b.notations.length, 3, "3 of 4 resolved (1 nonexistent)");
assertEq(s5b.notations[0].notation, "73D6", "first is 73D6");
assertEq(s5b.notations[2].notation, "25F23(+46)", "third is key-expanded");
assert(s5b.notations[2].isKeyExpanded === true, "key-expanded flag set");
assertEq(s5b.notations[2].baseNotation, "25F23", "base notation correct");
assertEq(s5b.notations[2].keyId, "+46", "key ID correct");
assertEq(s5b.notFound.length, 1, "partial miss reported in notFound");
assertEq(s5b.notFound[0], "NONEXISTENT", "notFound names the missing code");
assert(
  r5b.content[0].text.includes("not found"),
  "partial miss surfaced in text content, not just structured",
);

// All nonexistent
const r5c = await client.callTool({
  name: "resolve",
  arguments: { notation: ["ZZZZZ", "YYYYY"] },
});
assert(r5c.isError === true, "error when all notations nonexistent");
assertEq(txt(r5c), "None of the requested notations were found: ZZZZZ, YYYYY", "resolve all-missing wording names every code");

// ══════════════════════════════════════════════════════════════════
//  6. expand_keys
// ══════════════════════════════════════════════════════════════════

section("6. expand_keys");

const r6 = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "25F23" },
});

assert(!r6.isError, "no error");
const s6 = sc(r6);
assertEq(s6.notation, "25F23", "notation echoed");
assertEq(s6.baseEntry.notation, "25F23", "base entry present");
assertEq(s6.keyVariants.length, 25, "key variants paginated to default 25");
assert(s6.totalKeyVariants > 100, `totalKeyVariants > 100 (got ${s6.totalKeyVariants})`);

// Pagination
const r6p = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "25F23", maxResults: 5, offset: 50 },
});
const s6p = sc(r6p);
assertEq(s6p.keyVariants.length, 5, "expand_keys page size respected");
assert(s6p.keyVariants[0].notation !== s6.keyVariants[0].notation, "offset produces different first variant");
assertEq(s6p.totalKeyVariants, s6.totalKeyVariants, "totalKeyVariants consistent across pages");

// Verify key variants have correct structure
const first = s6.keyVariants[0];
assert(first.notation.startsWith("25F23(+"), "variant starts with 25F23(+");
assert(first.isKeyExpanded === true, "marked as key-expanded");
assertEq(first.baseNotation, "25F23", "base notation back-ref");
assert(first.keyId?.startsWith("+"), "keyId starts with +");
assert(first.text.includes("beasts of prey"), "composed text includes base text");
assert(first.text.includes("(+"), "composed text includes key portion");

// Nonexistent
const r6b = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "ZZZZZ" },
});
assert(r6b.isError === true, "error for nonexistent notation");
assertEq(txt(r6b), 'Notation "ZZZZZ" not found in Iconclass.', "expand_keys not-found wording");

// ══════════════════════════════════════════════════════════════════
//  7. search_prefix
// ══════════════════════════════════════════════════════════════════

section("7. search_prefix");

const r7 = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "73D8", maxResults: 10 },
});

assert(!r7.isError, "no error");
const s7 = sc(r7);
assertEq(s7.prefix, "73D8", "prefix echoed");
assert(s7.totalResults > 0, `totalResults > 0 (got ${s7.totalResults})`);
assert(s7.results.every(r => r.notation.startsWith("73D8")), "all results start with prefix");
assertEq(s7.results[0].notation, "73D8", "first is the prefix itself");

// With collection filter
const r7b = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "73D8", collectionId: "rijksmuseum", maxResults: 10 },
});
const s7b = sc(r7b);
assert(s7b.results.length > 0, `prefix+collection returns results (got ${s7b.results.length})`);
for (const entry of s7b.results) {
  assert(entry.collections.includes("rijksmuseum"), `prefix+collection: ${entry.notation} has rijksmuseum`);
}

// Broad prefix
const r7c = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "7", maxResults: 5 },
});
const s7c = sc(r7c);
assertEq(s7c.results.length, 5, "broad prefix returns maxResults");
assert(s7c.totalResults >= 5, `broad prefix totalResults >= maxResults (got ${s7c.totalResults})`);

// Notation punctuation (., :, -, spaces) is part of the prefix, not noise.
const r7d = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "12A27(Deut. 21:22-23)", maxResults: 10 },
});
const s7d = sc(r7d);
assert(
  s7d.totalResults >= 1,
  `prefix with .,:- preserves punctuation (got ${s7d.totalResults})`
);
assert(
  s7d.results.every(r => r.notation.startsWith("12A27(Deut. 21:22-23)")),
  "all results start with the punctuation-bearing prefix"
);

// ══════════════════════════════════════════════════════════════════
//  8. Language support
// ══════════════════════════════════════════════════════════════════

section("8. Language support");

const r8de = await client.callTool({
  name: "browse",
  arguments: { notation: "73D6", lang: "de" },
});
const s8de = sc(r8de);
assert(s8de.entry.text !== "the crucifixion of Christ", "German text differs from English");
assert(s8de.entry.text.length > 0, `German text present: "${s8de.entry.text.slice(0, 50)}"`);

const r8fr = await client.callTool({
  name: "browse",
  arguments: { notation: "73D6", lang: "fr" },
});
const s8fr = sc(r8fr);
assert(s8fr.entry.text !== s8de.entry.text, "French text differs from German");
assert(s8fr.entry.text.length > 0, `French text present: "${s8fr.entry.text.slice(0, 50)}"`);

// An unsupported lang is rejected, not silently coerced to 'en'.
const rBadLang = await client.callTool({
  name: "resolve",
  arguments: { notation: "73D6", lang: "xx" },
});
assert(rBadLang.isError === true, "invalid lang 'xx' is rejected");
assert(txt(rBadLang).startsWith("Input validation error: Invalid arguments for tool resolve: lang: Invalid option"),
  `invalid lang error names the lang parameter (got: ${txt(rBadLang).slice(0, 90)})`);

// ══════════════════════════════════════════════════════════════════
//  9. Regression: search_prefix pagination with collection filter
// ══════════════════════════════════════════════════════════════════

section("9. search_prefix pagination with collection filter");

// Broad prefix "7" with collectionId reports the full filtered count, not the page window.
const r9a = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "7", collectionId: "rijksmuseum", maxResults: 10 },
});
const s9a = sc(r9a);
assert(s9a.totalResults > 100, `prefix "7" + rijksmuseum: totalResults should be large (got ${s9a.totalResults})`);
assertEq(s9a.results.length, 10, "page returns maxResults items");

// Paginating beyond offset 20 should still return results
const r9b = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "7", collectionId: "rijksmuseum", maxResults: 10, offset: 20 },
});
const s9b = sc(r9b);
assert(s9b.results.length > 0, `offset 20 still returns results (got ${s9b.results.length})`);
assertEq(s9b.totalResults, s9a.totalResults, "totalResults consistent across pages");

// Results must be ascending by notation (SQL ORDER BY n.notation).
const ordered = [...s9a.results].map(r => r.notation);
const sortedCopy = [...ordered].sort();
assert(JSON.stringify(ordered) === JSON.stringify(sortedCopy),
  "prefix+collection results are ascending by notation");

// Without collectionId, totalResults should also be accurate
const r9c = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "7", maxResults: 5 },
});
const s9c = sc(r9c);
assert(s9c.totalResults > 1000, `prefix "7" unfiltered: totalResults large (got ${s9c.totalResults})`);

// ══════════════════════════════════════════════════════════════════
//  10. Regression: semantic search collection underfill (P1)
// ══════════════════════════════════════════════════════════════════

section("10. semantic search: collectionId still fills the page");

const r10 = await client.callTool({
  name: "search",
  arguments: { semanticQuery: "religious suffering", collectionId: "rijksmuseum", maxResults: 5 },
});
assert(!r10.isError, `no error (got: ${txt(r10).slice(0, 80)})`);
const s10 = sc(r10);
assert(s10.results.length >= 3, `collection-scoped semantic: should fill page (got ${s10.results.length})`);
for (const entry of s10.results) {
  assert(entry.collections.includes("rijksmuseum"), `semantic+collection: ${entry.notation} has rijksmuseum`);
}

// ══════════════════════════════════════════════════════════════════
//  11. Regression: semantic parentNotation subtree underfill (P1)
// ══════════════════════════════════════════════════════════════════

section("11. semantic search: parentNotation fills the page from the subtree");

// A subtree absent from the global top-k must still fill the page.

const r11sub = await client.callTool({
  name: "search",
  arguments: { semanticQuery: "religious suffering", parentNotation: "73D", maxResults: 5 },
});
if (assert(!r11sub.isError, `parentNotation 73D: no error (got: ${txt(r11sub).slice(0, 80)})`)) {
  const s11sub = sc(r11sub);
  assert(s11sub.results.length >= 3, `parentNotation 73D: should fill page (got ${s11sub.results.length})`);
  assert(s11sub.results.every(r => r.notation.startsWith("73D")), "all results in 73D subtree");
  assert(s11sub.results.every(r => typeof r.similarity === "number"), "all results have similarity scores");

  // A broader subtree should also work — "11" (Christian iconography) is large
  const r11broad = await client.callTool({
    name: "search",
    arguments: { semanticQuery: "mother and child", parentNotation: "11F", maxResults: 5 },
  });
  if (assert(!r11broad.isError, "parentNotation 11F: no error")) {
    const s11broad = sc(r11broad);
    assert(s11broad.results.length >= 3, `parentNotation 11F: should fill page (got ${s11broad.results.length})`);
    assert(s11broad.results.every(r => r.notation.startsWith("11F")), "all results in 11F subtree");
  }

  // A narrow subtree (73D64 has 7 base notations) still returns in-subtree results.
  const r11narrow = await client.callTool({
    name: "search",
    arguments: { semanticQuery: "angels", parentNotation: "73D64", maxResults: 5 },
  });
  assert(!r11narrow.isError, "narrow parentNotation does not error");
  const s11narrow = sc(r11narrow);
  assert(s11narrow.results.length > 0, `narrow subtree returns results (got ${s11narrow.results.length})`);
  assert(s11narrow.results.every(r => r.notation.startsWith("73D64")), "narrow subtree results all match prefix");
}

// ══════════════════════════════════════════════════════════════════
//  12. Regression: FTS search ranks by relevance, not alphabetically
// ══════════════════════════════════════════════════════════════════

section("12. FTS relevance ranking");

// Within a coverage tier, results rank by BM25 relevance, not alphabetically:
// the exact subjects must surface on the first page of a large hit set.
const r11rel = await client.callTool({
  name: "search",
  arguments: { query: "crucifixion", maxResults: 25 },
});
const s11rel = sc(r11rel);
const notations11 = s11rel.results.map(r => r.notation);

const idx73D6 = notations11.indexOf("73D6");
assert(idx73D6 !== -1, `73D6 in top 25 for "crucifixion" (position ${idx73D6 + 1})`);

// Coverage is the primary sort key: results with collection presence precede
// those without. "unicorn" is pinned because its first page holds both groups.
const rCov = await client.callTool({ name: "search", arguments: { query: "unicorn", maxResults: 25 } });
const covFlags = sc(rCov).results.map(r => r.collections.length > 0);
const firstWithout = covFlags.indexOf(false);
const lastWith = covFlags.lastIndexOf(true);
if (assert(firstWithout !== -1 && lastWith !== -1,
  `fixture: "unicorn" page mixes present and absent results (present=${covFlags.filter(Boolean).length}/${covFlags.length})`)) {
  assert(lastWith < firstWithout, `collection-present results precede absent ones (last-with: ${lastWith}, first-without: ${firstWithout})`);
}

// Second query: "Last Supper" should surface 73D24 in the top results
const r11b = await client.callTool({
  name: "search",
  arguments: { query: "Last Supper", maxResults: 10 },
});
const s11b = sc(r11b);
const notations11b = s11b.results.map(r => r.notation);
assert(notations11b.includes("73D24"), `73D24 (Last Supper) in top 10 for "Last Supper"`);

// Third query: "Passion" should surface 73D (Passion of Christ) in top results
const r11c = await client.callTool({
  name: "search",
  arguments: { query: "Passion", maxResults: 10 },
});
const s11c = sc(r11c);
const notations11c = s11c.results.map(r => r.notation);
assert(notations11c.includes("73D"), `73D (Passion of Christ) in top 10 for "Passion"`);

// ══════════════════════════════════════════════════════════════════
//  13. Regression: expand_keys rejects key-expanded input (P2)
// ══════════════════════════════════════════════════════════════════

section("13. expand_keys input validation");

const r12a = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "25F23(+46)" },
});
assert(r12a.isError === true, "expand_keys rejects key-expanded (+) notation");
assertEq(txt(r12a), '"25F23(+46)" is a key-expanded notation — expand_keys requires a base notation (e.g. "25F23").',
  "key-expanded rejection wording names the base notation to use");

// Named variants like 73D82(CROSS) are NOT key-expanded — they should be accepted
const r12b = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "73D82(CROSS)" },
});
assert(r12b.isError !== true, `expand_keys accepts named variant 73D82(CROSS) (got: ${txt(r12b).slice(0, 80)})`);
assertEq(sc(r12b).baseEntry?.notation, "73D82(CROSS)", "named variant is expanded as its own base");

// ══════════════════════════════════════════════════════════════════
//  14. Regression: totalNotations is non-zero (P2)
// ══════════════════════════════════════════════════════════════════

section("14. totalNotations is non-zero");

// Every tool response includes collections[]. Check that totalNotations > 0.
const r13a = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "11H", maxResults: 1 },
});
const s13a = sc(r13a);
assert(s13a.collections.length > 0, "collections array present");
const rij13 = s13a.collections.find(c => c.collectionId === "rijksmuseum");
assert(rij13 !== undefined, "rijksmuseum collection present");
assert(rij13.totalNotations > 0, `totalNotations > 0 (got ${rij13?.totalNotations})`);

// ══════════════════════════════════════════════════════════════════
//  15. find_artworks
// ══════════════════════════════════════════════════════════════════

section("15. find_artworks");

// Single notation — 73D6 (crucifixion, known to be in Rijksmuseum)
const r14a = await client.callTool({
  name: "find_artworks",
  arguments: { notation: "73D6" },
});
assert(!r14a.isError, "no error");
const s14a = sc(r14a);
assertEq(s14a.notations.length, 1, "1 notation returned");
assertEq(s14a.notations[0].notation, "73D6", "notation echoed");
assert(s14a.notations[0].text.length > 0, "text present");
assert(s14a.notations[0].collections.length > 0, `has collections (got ${s14a.notations[0].collections.length})`);

// Rijksmuseum entry present with count and no URL
const rijEntry14 = s14a.notations[0].collections.find(a => a.collectionId === "rijksmuseum");
assert(rijEntry14, "rijksmuseum collection present");
assert(rijEntry14.url === null, "rijksmuseum has no URL");
assert(typeof rijEntry14.count === "number" && rijEntry14.count > 0, `rijksmuseum has count > 0 (got ${rijEntry14?.count})`);

// Rijksmuseum is one of the collections returned (other dev-side collections
// like a local RKD harvest may also be present — we don't assert exact count
// here so the test stays robust to the loaded sidecar's exact shape).
assert(s14a.notations[0].collections.length >= 1,
  `at least 1 collection (got ${s14a.notations[0].collections.length})`);

// Collections metadata present and Rijksmuseum is loaded
assert(s14a.collections.length >= 1,
  `at least 1 collection loaded (got ${s14a.collections.length})`);
const rijCol14 = s14a.collections.find(c => c.collectionId === "rijksmuseum");
assert(rijCol14?.searchUrlTemplate === null, "rijksmuseum searchUrlTemplate is null");

assert(typeof s14a.notations[0].artResearchUrl === "string"
  && s14a.notations[0].artResearchUrl.startsWith("https://artresearch.net/resource/?uri="),
  "find_artworks returns an artResearchUrl");
assert(s14a.notations[0].artResearchUrl.includes("73D6"),
  "artResearchUrl contains the notation");

// Batch notations — mix of found and not-found
const r14b = await client.callTool({
  name: "find_artworks",
  arguments: { notation: ["73D6", "25F23(+46)", "NONEXISTENT_ZZZZZ"] },
});
const s14b = sc(r14b);
assertEq(s14b.notations.length, 3, "3 notations returned");
assertEq(s14b.notations[0].notation, "73D6", "first is 73D6");
assertEq(s14b.notations[2].notation, "NONEXISTENT_ZZZZZ", "third is nonexistent");
assertEq(s14b.notations[2].collections.length, 0, "nonexistent has 0 collections");
assertEq(s14b.notations[1].notation, "25F23(+46)", "key-expanded notation kept in input order");

// ══════════════════════════════════════════════════════════════════
//  16. Regression: FTS phrase→terms auto-fallback
// ══════════════════════════════════════════════════════════════════

section("16. FTS phrase→terms auto-fallback");

// Fixture pinned by the offline raw-FTS gate (run 2026-06-30):
//   texts_fts    MATCH '"angel trumpet"'  -> 0
//   keywords_fts MATCH '"angel trumpet"'  -> 0
//   texts_fts    MATCH '"trumpet angel"'  -> 0
//   keywords_fts MATCH '"trumpet angel"'  -> 0   (both orderings phrase-empty)
//   texts_fts    MATCH '"angel" AND "trumpet"' -> 38   (fallback finds these)
// If a future corpus gives either ordering a phrase hit, re-pin the fixture.
const r16a = await client.callTool({
  name: "search", arguments: { query: "angel trumpet", maxResults: 50 },
});
const r16b = await client.callTool({
  name: "search", arguments: { query: "trumpet angel", maxResults: 50 },
});
assert(!r16a.isError && !r16b.isError, "fallback queries: no error");
const t16a = sc(r16a).totalResults, t16b = sc(r16b).totalResults;
// Commutative AND-terms fallback: both orderings must agree AND be non-empty.
// A phrase hit on either ordering would skip the fallback and break this.
assert(t16a > 0, `phrase-empty query falls back to AND-terms hits (got ${t16a})`);
assertEq(t16b, t16a,
  "both word orders return the identical AND-terms result set (commutative fallback ran)");

// Single-word queries must NOT use the fallback (escapeFts5Terms returns null
// for <2 words) — a one-word miss stays a clean zero, not an error.
const r16c = await client.callTool({
  name: "search", arguments: { query: "zzzqqxnonsenseword" },
});
assert(!r16c.isError, "single-word miss: no error");
assertEq(sc(r16c).totalResults, 0, "single-word miss returns 0 (no fallback)");

// ══════════════════════════════════════════════════════════════════
//  17. Regression: semantic parentNotation + collectionId combined
// ══════════════════════════════════════════════════════════════════

section("17. semantic parentNotation + collectionId combined");

const Q17 = "ships on a stormy sea";   // pinned via the control call below
const SUB = "41";

// CONTROL: a GLOBAL semantic search (no filters) must carry ZERO in-subtree
// notations in its top-25. This is what makes the fixture discriminating — it
// proves the query's global neighbourhood excludes SUB, so the only way the
// filtered calls below can fill is the prefix-filtered KNN branch actually
// searching within SUB (a global+post-filter regression would return 0).
const r17ctl = await client.callTool({
  name: "search", arguments: { semanticQuery: Q17, maxResults: 25 },
});
if (assert(!r17ctl.isError, `control call: no error (got: ${txt(r17ctl).slice(0, 80)})`)) {
  const ctlInSub = sc(r17ctl).results.filter(e => e.notation.startsWith(SUB)).length;
  assert(ctlInSub === 0,
    `control: global top-25 carries no ${SUB} notations (got ${ctlInSub}) — fixture is discriminating`);

  // PREFIX-ONLY: parentNotation set, no collection. Takes the prefix-filtered KNN
  // branch (overfetch ×5). Because the control proved the global neighbourhood has
  // no SUB content, filling the page here can ONLY come from the prefix branch.
  const r17pre = await client.callTool({
    name: "search", arguments: { semanticQuery: Q17, parentNotation: SUB, maxResults: 5 },
  });
  assert(!r17pre.isError, "prefix-filtered semantic: no error");
  const s17pre = sc(r17pre);
  assert(s17pre.results.length >= 3,
    `prefix-filtered branch fills the page from within ${SUB} (got ${s17pre.results.length})`);
  assert(s17pre.results.every(e => e.notation.startsWith(SUB)),
    `all prefix-filtered results are in the ${SUB} subtree`);

  // COMBINED: parentNotation + collectionId. Same prefix-filtered KNN branch (×5)
  // AND the collection post-filter. Every result must satisfy BOTH constraints.
  const r17 = await client.callTool({
    name: "search",
    arguments: { semanticQuery: Q17, parentNotation: SUB, collectionId: "rijksmuseum", maxResults: 5 },
  });
  assert(!r17.isError, "combined semantic filters: no error");
  const s17 = sc(r17);
  // The collection post-filter may legitimately thin the page; the prefix-only call
  // above already pinned the ×5 branch's fill, so a floor of 1 is enough here.
  assert(s17.results.length >= 1,
    `combined filters still return at least one result (got ${s17.results.length})`);
  for (const e of s17.results) {
    assert(e.notation.startsWith(SUB), `combined: ${e.notation} is in the ${SUB} subtree`);
    assert(e.collections.includes("rijksmuseum"), `combined: ${e.notation} has rijksmuseum presence`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  18. Semantic search over HTTP
// ══════════════════════════════════════════════════════════════════

section("18. semantic search over HTTP");

// HTTP mode loads the model in the background after it starts serving (stdio,
// above, loads before serving). Whether this call actually waits on that load
// depends on timing, so it pins only that semantic search works in HTTP mode.
await client.close();
const http = await bootHttpServer({ port: process.env.TEST_PORT ?? "31339" });
try {
  const httpClient = new Client({ name: "test-tools-http", version: "0.1" });
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  const r18 = await httpClient.callTool({ name: "search", arguments: { semanticQuery: "ships on a stormy sea", maxResults: 3 } });
  if (assert(!r18.isError, `semantic search over HTTP: no error (got: ${txt(r18).slice(0, 80)})`))
    assertEq(sc(r18).results.length, 3, "semantic search over HTTP fills the page");
  await httpClient.close();
} finally {
  await http.stop();
}

report();
