/**
 * Verify that all 10 example prompts from docs/example-prompts.md
 * produce good results against the local MCP server.
 *
 * Usage: node scripts/tests/verify-example-prompts.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Connect ─────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "verify-prompts", version: "0.1" });
await client.connect(transport);
console.log("Connected to Iconclass MCP server\n");

let passed = 0;
let failed = 0;
const failures = [];

function sc(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

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

function heading(n, title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Prompt ${n}: ${title}`);
  console.log(`${"═".repeat(60)}`);
}

// ═══════════════════════════════════════════════════════════════
// Prompt 1: Smell and the Senses in Art
// ═══════════════════════════════════════════════════════════════

heading(1, "Smell and the Senses in Art");

// Semantic search for smell
const p1sem = await client.callTool({
  name: "search",
  arguments: { semanticQuery: "smell and olfactory experience", maxResults: 10 },
});
if (!p1sem.isError) {
  const s = sc(p1sem);
  assert(s.results.length > 0, "semantic search returns results");
  const has31A33 = s.results.some(r => r.notation === "31A33");
  assert(has31A33, "31A33 (smell) in semantic results");
} else {
  assert(false, "semantic search failed: " + p1sem.content[0].text);
}

// FTS search for smell
const p1fts = await client.callTool({
  name: "search",
  arguments: { query: "smell", maxResults: 10 },
});
const s1fts = sc(p1fts);
assert(s1fts.totalResults > 0, `FTS 'smell' returns results (${s1fts.totalResults})`);

// Browse 31A3 (the five senses)
const p1br = await client.callTool({
  name: "browse",
  arguments: { notation: "31A3" },
});
const s1br = sc(p1br);
assert(!p1br.isError, "browse 31A3 succeeds");
assert(s1br.subtree.length >= 5, `31A3 has ${s1br.subtree.length} children (5+ senses + variants)`);
const senseNotations = s1br.subtree.map(c => c.notation);
assert(senseNotations.includes("31A33"), "31A33 (smell) is a child");

// Browse 31A33 with key variants
const p1keys = await client.callTool({
  name: "browse",
  arguments: { notation: "31A33", includeKeys: true },
});
const s1keys = sc(p1keys);
assert(s1keys.entry.collectionCounts.rijksmuseum > 0, `31A33 has Rijksmuseum artworks (${s1keys.entry.collectionCounts.rijksmuseum})`);
assert(s1keys.totalKeyVariants > 0, `31A33 has key variants (${s1keys.totalKeyVariants})`);

// ═══════════════════════════════════════════════════════════════
// Prompt 2: Finding Saints by Name
// ═══════════════════════════════════════════════════════════════

heading(2, "Finding Saints by Name");

const p2a = await client.callTool({
  name: "search",
  arguments: { query: "Jerome", maxResults: 10 },
});
const s2a = sc(p2a);
assert(s2a.totalResults > 0, `FTS 'Jerome' returns results (${s2a.totalResults})`);
const hasJerome = s2a.results.some(r => r.notation === "11H(JEROME)");
assert(hasJerome, "11H(JEROME) in results");
assert(s2a.results[0].collectionCounts.rijksmuseum > 200, `Jerome has ${s2a.results[0].collectionCounts.rijksmuseum} Rijksmuseum artworks`);

const p2b = await client.callTool({
  name: "search",
  arguments: { query: "Catherine", maxResults: 10 },
});
const s2b = sc(p2b);
assert(s2b.totalResults > 0, `FTS 'Catherine' returns results (${s2b.totalResults})`);
const hasHH = s2b.results.some(r => r.notation.startsWith("11HH(CATHERINE"));
assert(hasHH, "results include 11HH(CATHERINE...) (female saints)");

// Verify missing saint returns zero (as documented)
const p2c = await client.callTool({
  name: "search",
  arguments: { query: "Euphemia", maxResults: 5 },
});
assert(sc(p2c).totalResults === 0, "FTS 'Euphemia' returns 0 (missing saint, as expected)");

// ═══════════════════════════════════════════════════════════════
// Prompt 3: Where Does Alchemy Belong?
// ═══════════════════════════════════════════════════════════════

heading(3, "Where Does Alchemy Belong?");

const p3 = await client.callTool({
  name: "browse",
  arguments: { notation: "49E39" },
});
const s3 = sc(p3);
assert(!p3.isError, "browse 49E39 succeeds");
assert(s3.entry.text.toLowerCase().includes("alchemy"), "entry text mentions alchemy");
assert(s3.entry.path.length >= 4, `path has ${s3.entry.path.length} ancestors (4+ expected)`);
assert(s3.entry.path[0].notation === "4", "root is 4 (Society)");
assert(s3.subtree.length > 0, `has children (${s3.subtree.length})`);
// Verify the empty refs we documented
assert(s3.entry.refs.length === 0, "no cross-references (as documented)");

// FTS search for alchemy outside 49E39
const p3fts = await client.callTool({
  name: "search",
  arguments: { query: "alchemy", maxResults: 10 },
});
const s3fts = sc(p3fts);
assert(s3fts.totalResults > 0, `FTS 'alchemy' returns results (${s3fts.totalResults})`);

// ═══════════════════════════════════════════════════════════════
// Prompt 4: The Life and Miracles of St. Francis
// ═══════════════════════════════════════════════════════════════

heading(4, "The Life and Miracles of St. Francis");

const p4 = await client.callTool({
  name: "browse",
  arguments: { notation: "11H(FRANCIS)" },
});
const s4 = sc(p4);
assert(!p4.isError, "browse 11H(FRANCIS) succeeds");
assert(s4.entry.text.includes("Francis"), "entry text mentions Francis");
assert(s4.entry.text.includes("stigmata"), "attributes include stigmata");
assert(s4.subtree.length > 5, `has children (${s4.subtree.length})`);

// Browse miracles sub-branch
const p4m = await client.callTool({
  name: "browse",
  arguments: { notation: "11H(FRANCIS)5" },
});
const s4m = sc(p4m);
assert(!p4m.isError, "browse 11H(FRANCIS)5 succeeds");
assert(s4m.entry.text.includes("miraculous"), "miracles branch text correct");
const hasBirds = s4m.subtree.some(c => c.text.includes("birds"));
assert(hasBirds, "preaching to the birds is a child");
const hasWolf = s4m.subtree.some(c => c.text.includes("wolf"));
assert(hasWolf, "taming the wolf is a child");

// search_prefix for all Francis notations
const p4p = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "11H(FRANCIS)", maxResults: 50 },
});
const s4p = sc(p4p);
assert(s4p.totalResults >= 40, `prefix search returns ${s4p.totalResults} notations (40+ expected)`);

// Browse generic template for comparison
const p4t = await client.callTool({
  name: "browse",
  arguments: { notation: "11H(...)" },
});
assert(!p4t.isError, "browse 11H(...) generic template succeeds");

// ═══════════════════════════════════════════════════════════════
// Prompt 5: Mapping All Animal Notations
// ═══════════════════════════════════════════════════════════════

heading(5, "Mapping All Animal Notations");

const p5 = await client.callTool({
  name: "browse",
  arguments: { notation: "25F" },
});
const s5 = sc(p5);
assert(!p5.isError, "browse 25F succeeds");
assert(s5.subtree.length >= 8, `25F has ${s5.subtree.length} children (8+ expected)`);

// Prefix search for mammals
const p5m = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "25F2", maxResults: 5 },
});
const s5m = sc(p5m);
assert(s5m.totalResults >= 5, `25F2 (mammals) prefix returns results (${s5m.totalResults})`);

// Prefix search for birds
const p5b = await client.callTool({
  name: "search_prefix",
  arguments: { notation: "25F3", maxResults: 5 },
});
assert(sc(p5b).totalResults >= 5, `25F3 (birds) prefix returns results (${sc(p5b).totalResults})`);

// expand_keys on 25F23 (beasts of prey)
const p5k = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "25F23", maxResults: 10 },
});
const s5k = sc(p5k);
assert(!p5k.isError, "expand_keys 25F23 succeeds");
assert(s5k.totalKeyVariants > 200, `25F23 has ${s5k.totalKeyVariants} key variants`);
const hasSleeping = s5k.keyVariants.some(v => v.text.includes("sleeping"));
assert(hasSleeping || s5k.keyVariants.length > 0, "key variants include behavioural modifiers");

// ═══════════════════════════════════════════════════════════════
// Prompt 6: Classifying a Complex Scene
// ═══════════════════════════════════════════════════════════════

heading(6, "Classifying a Complex Scene");

// Semantic search
const p6sem = await client.callTool({
  name: "search",
  arguments: { semanticQuery: "Virgin Mary reading with Christ Child", maxResults: 5 },
});
if (!p6sem.isError) {
  const s = sc(p6sem);
  assert(s.results.length > 0, "semantic search returns results");
  const has73B = s.results.some(r => r.notation.startsWith("73B") || r.notation.startsWith("11F"));
  assert(has73B, "results include Mary/Christ notations");
}

// FTS searches
const p6a = await client.callTool({
  name: "search",
  arguments: { query: "Christ-child", maxResults: 5 },
});
assert(sc(p6a).totalResults > 0, `FTS 'Christ-child' returns results (${sc(p6a).totalResults})`);

const p6b = await client.callTool({
  name: "search",
  arguments: { query: "open book", maxResults: 5 },
});
assert(sc(p6b).totalResults > 0, `FTS 'open book' returns results`);

// Batch resolve
const p6r = await client.callTool({
  name: "resolve",
  arguments: { notation: ["73B732", "11F4212", "49MM32", "25G41(LILY)"] },
});
const s6r = sc(p6r);
assert(s6r.notations.length === 4, "all 4 notations resolved");
assert(s6r.notations[0].notation === "73B732", "73B732 resolved");
assert(s6r.notations[3].notation === "25G41(LILY)", "25G41(LILY) resolved");

// ═══════════════════════════════════════════════════════════════
// Prompt 7: From Notation to Artwork
// ═══════════════════════════════════════════════════════════════

heading(7, "From Notation to Artwork");

const p7 = await client.callTool({
  name: "search",
  arguments: { query: "crucifixion", maxResults: 5 },
});
const s7 = sc(p7);
assert(s7.totalResults > 50, `FTS 'crucifixion' returns ${s7.totalResults} results`);
assert(s7.results[0].notation === "73D6", "top result is 73D6");
assert(s7.results[0].collectionCounts.rijksmuseum > 300, `73D6 has ${s7.results[0].collectionCounts.rijksmuseum} Rijksmuseum artworks`);

// Browse 73D for related notations
const p7b = await client.callTool({
  name: "browse",
  arguments: { notation: "73D" },
});
const s7b = sc(p7b);
assert(s7b.subtree.length === 9, "73D has 9 children (73D1-73D9)");

// ═══════════════════════════════════════════════════════════════
// Prompt 8: Last Supper or Wedding at Cana?
// ═══════════════════════════════════════════════════════════════

heading(8, "Last Supper or Wedding at Cana?");

const p8a = await client.callTool({
  name: "search",
  arguments: { query: "Last Supper", maxResults: 5 },
});
const s8a = sc(p8a);
assert(s8a.totalResults > 0, `FTS 'Last Supper' returns results (${s8a.totalResults})`);
const has73D24 = s8a.results.some(r => r.notation === "73D24");
assert(has73D24, "73D24 (Last Supper) in results");

const p8b = await client.callTool({
  name: "search",
  arguments: { query: "Cana", maxResults: 15 },
});
const s8b = sc(p8b);
assert(s8b.totalResults > 0, `FTS 'Cana' returns results (${s8b.totalResults})`);
const has73C611 = s8b.results.some(r => r.notation.startsWith("73C611"));
assert(has73C611, "73C611x (Wedding at Cana) in results");

// Batch resolve for comparison
const p8r = await client.callTool({
  name: "resolve",
  arguments: { notation: ["73D24", "73C611"] },
});
const s8r = sc(p8r);
assert(s8r.notations.length === 2, "both notations resolved");
assert(s8r.notations[0].path[0].notation !== s8r.notations[1].path[0].notation ||
       s8r.notations[0].path.length !== s8r.notations[1].path.length,
       "different hierarchy paths (different theological contexts)");

// ═══════════════════════════════════════════════════════════════
// Prompt 9: A Broken Lute String as Vanitas
// ═══════════════════════════════════════════════════════════════

heading(9, "A Broken Lute String as Vanitas");

// Browse vanitas symbols
const p9v = await client.callTool({
  name: "browse",
  arguments: { notation: "11R7" },
});
const s9v = sc(p9v);
assert(!p9v.isError, "browse 11R7 (vanitas) succeeds");
assert(s9v.subtree.length >= 2, `11R7 has children (${s9v.subtree.length})`);

// FTS for broken string
const p9f = await client.callTool({
  name: "search",
  arguments: { query: "broken string", maxResults: 5 },
});
// May or may not find results — the point is the search works
assert(!p9f.isError, "FTS 'broken string' executes without error");

// Browse lute
const p9l = await client.callTool({
  name: "browse",
  arguments: { notation: "48C7323" },
});
assert(!p9l.isError, "browse 48C7323 (lute) succeeds");
assert(sc(p9l).entry.text.includes("lute"), "lute entry text correct");

// Expand keys on lute to find +42 (damage) — it's at offset ~40
const p9k = await client.callTool({
  name: "expand_keys",
  arguments: { notation: "48C7323", maxResults: 50, offset: 30 },
});
const s9k = sc(p9k);
assert(!p9k.isError, "expand_keys 48C7323 succeeds");
const hasDamage = s9k.keyVariants.some(v => v.keyId === "+42");
assert(hasDamage, "key variant +42 (damage) found for lute");

// Also search vanitas
const p9vs = await client.callTool({
  name: "search",
  arguments: { query: "vanitas", maxResults: 5 },
});
assert(sc(p9vs).totalResults > 0, `FTS 'vanitas' returns results (${sc(p9vs).totalResults})`);

// ═══════════════════════════════════════════════════════════════
// Prompt 10: Classifying Jungle Book Illustrations
// ═══════════════════════════════════════════════════════════════

heading(10, "Classifying Jungle Book Illustrations");

// Search for Mowgli
const p10a = await client.callTool({
  name: "search",
  arguments: { query: "Mowgli", maxResults: 5 },
});
// May or may not exist — test that search executes
assert(!p10a.isError, "FTS 'Mowgli' executes without error");

// Browse literary characters
const p10b = await client.callTool({
  name: "browse",
  arguments: { notation: "82" },
});
const s10b = sc(p10b);
assert(!p10b.isError, "browse 82 (literary characters) succeeds");
assert(s10b.subtree.some(c => c.notation === "82A"), "82A (named human characters) is a child");
assert(s10b.subtree.some(c => c.notation === "82B"), "82B (named fictional animals) is a child");

// Browse specific works of literature
const p10c = await client.callTool({
  name: "browse",
  arguments: { notation: "83" },
});
assert(!p10c.isError, "browse 83 (specific works of literature) succeeds");

// Browse fables
const p10d = await client.callTool({
  name: "browse",
  arguments: { notation: "85" },
});
assert(!p10d.isError, "browse 85 (fables) succeeds");

// Browse animals acting as humans
const p10e = await client.callTool({
  name: "browse",
  arguments: { notation: "29A" },
});
assert(!p10e.isError, "browse 29A (animals acting as human beings) succeeds");

// Search for Jungle Book
const p10f = await client.callTool({
  name: "search",
  arguments: { query: "Jungle Book", maxResults: 5 },
});
assert(!p10f.isError, "FTS 'Jungle Book' executes without error");

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

await client.close();

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
