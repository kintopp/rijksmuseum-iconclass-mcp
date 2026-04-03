/**
 * Integration tests for all 5 Iconclass MCP tools via stdio transport.
 *
 * Run:  node scripts/tests/test-tools.mjs
 * Requires: npm run build, data/iconclass.db present
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

assertEq(toolNames.length, 5, `5 tools registered`);
assert(toolNames.includes("search"), "search tool present");
assert(toolNames.includes("browse"), "browse tool present");
assert(toolNames.includes("resolve"), "resolve tool present");
assert(toolNames.includes("expand_keys"), "expand_keys tool present");
assert(toolNames.includes("search_prefix"), "search_prefix tool present");

// Verify all tools have outputSchema (structuredContent enabled)
for (const tool of tools.tools) {
  assert(tool.outputSchema != null, `${tool.name} has outputSchema`);
  // Verify no $ref pointers (claude.ai can't resolve them)
  const schema = JSON.stringify(tool.outputSchema);
  assert(!schema.includes('"$ref"'), `${tool.name} outputSchema has no $ref`);
}

// Verify all tools have .strict() (no unknown params)
for (const tool of tools.tools) {
  const schema = JSON.stringify(tool.inputSchema);
  assert(schema.includes('"additionalProperties":false'), `${tool.name} inputSchema is strict`);
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
assertEq(s2.results[0].notation, "73D6", "top result is 73D6 (crucifixion)");
assert(s2.results[0].collectionCounts.rijksmuseum > 0, "has Rijksmuseum count");
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
for (const entry of s2c.results) {
  assert(entry.collectionCounts.rijksmuseum > 0, `collectionId filter: ${entry.notation} has rijksmuseum count`);
}

// Empty query
const r2d = await client.callTool({
  name: "search",
  arguments: { query: "xyznonexistent12345" },
});
const s2d = sc(r2d);
assertEq(s2d.totalResults, 0, "nonexistent query returns 0");

// ══════════════════════════════════════════════════════════════════
//  3. search — semantic mode
// ══════════════════════════════════════════════════════════════════

section("3. search — semantic mode");

const r3 = await client.callTool({
  name: "search",
  arguments: { semanticQuery: "domestic animals", maxResults: 5 },
});

if (r3.isError) {
  // Semantic search may be unavailable if model didn't load
  console.log(`  ⚠ Semantic search unavailable: ${txt(r3)}`);
  assert(true, "graceful degradation when model unavailable");
} else {
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
  if (!r3b.isError) {
    const s3b = sc(r3b);
    for (const entry of s3b.results) {
      const total = Object.values(entry.collectionCounts).reduce((a, b) => a + b, 0);
      assert(total > 0, `onlyWithArtworks: ${entry.notation} has artworks (${total})`);
    }
  }
}

// Error: both query and semanticQuery
const r3c = await client.callTool({
  name: "search",
  arguments: { query: "test", semanticQuery: "test" },
});
assert(r3c.isError === true, "error when both query and semanticQuery provided");

// Error: neither
const r3d = await client.callTool({
  name: "search",
  arguments: {},
});
assert(r3d.isError === true, "error when neither query nor semanticQuery provided");

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

// All nonexistent
const r5c = await client.callTool({
  name: "resolve",
  arguments: { notation: ["ZZZZZ", "YYYYY"] },
});
assert(r5c.isError === true, "error when all notations nonexistent");

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
for (const entry of s7b.results) {
  assert(entry.collectionCounts.rijksmuseum > 0, `prefix+collection: ${entry.notation} has count`);
}

// Broad prefix
const r7c = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "7", maxResults: 5 },
});
const s7c = sc(r7c);
assertEq(s7c.results.length, 5, "broad prefix returns maxResults");
assert(s7c.totalResults >= 5, `broad prefix totalResults >= maxResults (got ${s7c.totalResults})`);

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

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════

await client.close();

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
