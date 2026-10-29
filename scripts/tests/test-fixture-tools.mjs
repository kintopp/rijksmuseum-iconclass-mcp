/**
 * Tool-level tests over the fixture DB (build-fixture-db.mjs): every tool via a
 * real tools/call on dist/index.js, with no data/ and no embedding model, so
 * they run in CI. Expected values are worked out by hand from the seed rows.
 *
 * Run:  node scripts/tests/test-fixture-tools.mjs   (needs npm run build)
 *
 * Failure modes guarded:
 *  - the server silently opens data/ instead of the fixture (every later check
 *    would then test the wrong DB); guarded by the testmuseum collection.
 *  - a tool description's first sentence runs past 120 code points, so
 *    claude.ai's roster truncates it mid-thought.
 *  - an unknown argument is stripped instead of rejected.
 *  - a page-size maximum drifts up past what fits a host's per-result ceiling.
 *  - browse flags a complete subtree as capped (the cap itself needs more rows
 *    than the fixture has; test-tools.mjs §4 covers it on the real DB).
 *  - search ranks by notation instead of collection coverage, then BM25.
 *  - a key variant outranks a base notation in its coverage tier because its
 *    label is shorter, so one concept's variants fill the page; or, the other
 *    way, a variant that matched only on its key (its base didn't match) is
 *    pushed behind weaker base matches.
 *  - totalBaseNotations counts base rows instead of distinct bases (a variant
 *    whose base didn't match must still count it), or ignores the filters.
 *  - collectionId / onlyWithArtworks / parentNotation leak results from outside
 *    the filter, or parentNotation treats LIKE wildcards as wildcards.
 *  - the phrase → AND-terms fallback doesn't run, or depends on word order, or
 *    is skipped because phrase hits existed that the collection filter removed.
 *  - semanticQuery without embeddings errors with anything but the fixed hint.
 *  - semantic offset + maxResults goes past 500 (the KNN pool then grows with
 *    the client's offset), the cap leaks into keyword search, or an over-long
 *    semanticQuery reaches the model.
 *  - a `(...)` name template is missing from its parent's children, so browse
 *    and resolve show the parent (73D82, 12A27) as a leaf.
 *  - browse loses path labels, depth levels, resolved/unresolved cross-refs,
 *    or key-variant paging; lang falls back in the wrong order.
 *  - resolve drops a miss instead of naming it in notFound.
 *  - expand_keys accepts a key-expanded input or miscounts variants.
 *  - search_prefix loses notation punctuation, mis-orders, or mis-pages; baseOnly
 *    leaks variants, or is dropped on the collection path or before paging.
 *  - browse childOffset doesn't shift the children, stops grandchildren from
 *    expanding, or is silent past the end (the "More children" hint needs a
 *    branch wider than 25: test-tools.mjs §4).
 *  - find_artworks mis-sorts collections, mis-encodes the link-out URL, or drops
 *    unknown notations.
 *  - totalNotations counts rows for notations missing from the main DB.
 *  - model-facing text lines change shape (path joins, collection suffix).
 */
import { assert, assertEq, section, report } from "./_assert.mjs";
import { connectFixtureClient } from "./fixture-client.mjs";

const client = await connectFixtureClient("tools");

const sc = (r) => r.structuredContent;
const txt = (r) => r.content?.[0]?.text ?? "";
const lines = (r) => txt(r).split("\n");
const call = (name, args) => client.callTool({ name, arguments: args });
const ok = (r, what) => {
  const good = !r.isError && r.structuredContent != null;
  return assert(good, good ? `${what}: no error` : `${what}: no error (got: ${txt(r).slice(0, 80)})`);
};
const eqList = (actual, expected, msg) => assertEq(JSON.stringify(actual), JSON.stringify(expected), msg);
const notations = (rows) => rows.map((e) => e.notation);

const KEYS_25F23 = [
  "(+0)", "(+1)", "(+11)", "(+12)", "(+13)", "(+14)", "(+15)", "(+151)", "(+152)", "(+153)",
  "(+154)", "(+2)", "(+21)", "(+22)", "(+23)", "(+24)", "(+3)", "(+31)", "(+32)", "(+321)",
  "(+3211)", "(+3212)", "(+322)", "(+323)", "(+33)", "(+331)", "(+332)", "(+333)", "(+4)", "(+46)",
].map((k) => `25F23${k}`);

// ══════════════════════════════════════════════════════════════════
section("0. The server is on the fixture");

const r0 = await call("search_prefix", { notation: "73D", maxResults: 1 });
// Every later check assumes the fixture; on the real DB they would mislead, so stop.
if (!ok(r0, "search_prefix 73D") || !assert(sc(r0).collections.some((c) => c.collectionId === "testmuseum"), "the fixture-only collection is loaded")) {
  await client.close();
  report();
  process.exit(1);
}
// totalNotations: seeded rows that JOIN to a notation; the "99X" row in each collection must not count.
eqList(sc(r0).collections, [
  { collectionId: "rijksmuseum", label: "Rijksmuseum, Amsterdam", countsAsOf: "2026-06-13", totalNotations: 39, searchUrlTemplate: null },
  { collectionId: "testmuseum", label: "Test Museum", countsAsOf: "2026-01-01", totalNotations: 4, searchUrlTemplate: "https://collection.example.org/search?iconclass={notation}" },
], "collections are the fixture's two, with totalNotations excluding unknown notations");

// ══════════════════════════════════════════════════════════════════
section("1. Tool listing");

const { tools } = await client.listTools();
eqList(tools.map((t) => t.name).sort(), ["browse", "expand_keys", "find_artworks", "resolve", "search", "search_prefix"], "six tools");

for (const t of tools) {
  // claude.ai shows the first 120 code points of a description.
  const first = t.description.split(/(?<=\.)\s/)[0];
  const cps = [...first].length;
  assert(first.endsWith(".") && cps <= 120, `${t.name}: first sentence ends by code point 120 (${cps})`);
  assert(t.outputSchema != null && !JSON.stringify(t.outputSchema).includes('"$ref"'), `${t.name}: outputSchema present, no $ref`);
  // All six are pure reads. An omitted destructiveHint defaults to true per spec.
  for (const [hint, want] of Object.entries({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })) {
    assertEq(t.annotations?.[hint], want, `${t.name}: ${hint}=${want}`);
  }
}

const VALID_ARGS = {
  search: { query: "crucifixion" }, browse: { notation: "73D6" }, resolve: { notation: "73D6" },
  expand_keys: { notation: "25F23" }, search_prefix: { notation: "73D6" }, find_artworks: { notation: "73D6" },
};
for (const [name, args] of Object.entries(VALID_ARGS)) {
  const r = await call(name, { ...args, bogus: 1 });
  assertEq(txt(r), `Input validation error: Invalid arguments for tool ${name}: Unrecognized key: "bogus"`, `${name} rejects an unknown key`);
}

// Page-size maxima keep the structuredContent copy under host per-result ceilings
// (claude.ai ~150K chars). Accept the max, reject max + 1 with the field named.
const MAXIMA = [
  ["search_prefix", { notation: "73D" }, "maxResults", 50],
  ["browse", { notation: "25F23", includeKeys: true }, "maxKeyVariants", 100],
  ["expand_keys", { notation: "25F23" }, "maxResults", 100],
];
for (const [name, args, field, max] of MAXIMA) {
  ok(await call(name, { ...args, [field]: max }), `${name} ${field}=${max}`);
  assertEq(txt(await call(name, { ...args, [field]: max + 1 })),
    `Input validation error: Invalid arguments for tool ${name}: ${field}: Too big: expected number to be <=${max}`,
    `${name} rejects ${field}=${max + 1}`);
}

// ══════════════════════════════════════════════════════════════════
section("2. search — ranking and filters");

// "crucifixion" matches six notations. Coverage tiers: 73D6 is in both collections;
// 31E2356, 73D67, 73D5 in one; 73D6712, 73D671 in none. Within a tier BM25 favours
// the shorter text (4 < 13 < 28 tokens; 6 < 9), which alphabetical order would
// reverse for 73D5/73D67 and 73D671/73D6712.
const r2 = await call("search", { query: "crucifixion" });
if (ok(r2, "crucifixion")) {
  assertEq(sc(r2).totalResults, 6, "six matches");
  assertEq(sc(r2).totalBaseNotations, 6, "six base notations: no variants among them");
  eqList(notations(sc(r2).results), ["73D6", "31E2356", "73D67", "73D5", "73D6712", "73D671"],
    "ordered by coverage tier, then BM25");
  assertEq(lines(r2)[0], '6 of 6 matches (6 base notations) for "crucifixion"', "header line");
  assertEq(lines(r2)[2], '2. 31E2356 (rijksmuseum) "violent death by crucifixion" [3 > 31 > 31E > 31E2 > 31E23 > 31E235]',
    "result line: rank, notation, collections, label, path");
  assertEq(lines(r2)[5], '5. 73D6712 "loin-cloth ~ particularities of crucifixion scenes" [7 > 73 > 73D > 73D6 > 73D67 > 73D671]',
    "result line without collections has no empty parentheses");
  // Collection order within an entry is not a contract; the ", " join is.
  assert(/^1\. 73D6 \((rijksmuseum, testmuseum|testmuseum, rijksmuseum)\) "the crucifixion of Christ: /.test(lines(r2)[1]),
    `two collections are comma-joined (got: ${lines(r2)[1].slice(0, 60)})`);
}
const r2root = await call("search", { query: "Bible" });
if (ok(r2root, "Bible")) assertEq(lines(r2root)[1], '1. 7 (rijksmuseum) "Bible"', "a root notation's line has no path suffix");

const r2p = await call("search", { query: "crucifixion", maxResults: 2, offset: 2 });
if (ok(r2p, "paged")) {
  eqList(notations(sc(r2p).results), ["73D67", "73D5"], "offset 2, page of 2");
  assertEq(sc(r2p).totalResults, 6, "totalResults is the full count, not the page");
  assertEq(sc(r2p).totalBaseNotations, 6, "totalBaseNotations is the full count, not the page");
}

// "Jewish law" (no stemming, so "laws" in 12A27 doesn't match) hits three rows.
// 12A27(Deut. 21:22-23) is in testmuseum; the other two have no coverage. In that
// tier the variant 12A27(Deut. 21:22-23)(+0) has 9 tokens to 12A27(Deut. 25:2-3)'s
// 10, so BM25 alone would put the variant first.
const r2k = await call("search", { query: "Jewish law" });
if (ok(r2k, "Jewish law")) {
  eqList(notations(sc(r2k).results), ["12A27(Deut. 21:22-23)", "12A27(Deut. 25:2-3)", "12A27(Deut. 21:22-23)(+0)"],
    "a base notation outranks a shorter key variant in the same coverage tier");
  assertEq(sc(r2k).totalResults, 3, "totalResults counts the variant row");
  assertEq(sc(r2k).totalBaseNotations, 2, "totalBaseNotations counts the variant as its base");
  assertEq(lines(r2k)[0], '3 of 3 matches (2 base notations) for "Jewish law"', "header gives both counts");
}
const r2kw = await call("search", { query: "Jewish law", onlyWithArtworks: true });
if (ok(r2kw, "Jewish law, onlyWithArtworks"))
  assertEq(sc(r2kw).totalBaseNotations, 1, "totalBaseNotations counts only rows that pass the filter");
// Every 25F23 label starts "beasts of prey, predatory animals": the base and its 30 variants.
const r2kv = await call("search", { query: "predatory" });
if (ok(r2kv, "predatory")) {
  assertEq(sc(r2kv).totalResults, 31, "31 rows: 25F23 and its 30 variants");
  assertEq(sc(r2kv).totalBaseNotations, 1, "one base notation");
  assertEq(lines(r2kv)[0], '25 of 31 matches (1 base notation) for "predatory"', "header: singular for one base notation");
}

// "sleeping" matches 25F23(+46) (8 tokens, testmuseum) on its key, not via its base
// 25F23, and 71F1544 (13 tokens, rijksmuseum): same coverage tier, BM25 decides.
const r2sl = await call("search", { query: "sleeping" });
if (ok(r2sl, "sleeping"))
  eqList(notations(sc(r2sl).results), ["25F23(+46)", "71F1544"],
    "a variant whose base didn't match keeps its BM25 place ahead of a longer base");

const r2r = await call("search", { query: "crucifixion", collectionId: "rijksmuseum" });
if (ok(r2r, "collectionId rijksmuseum"))
  eqList(notations(sc(r2r).results).sort(), ["31E2356", "73D5", "73D6", "73D67"], "collectionId keeps only notations in that collection");
const r2t = await call("search", { query: "crucifixion", collectionId: "testmuseum" });
if (ok(r2t, "collectionId testmuseum")) eqList(notations(sc(r2t).results), ["73D6"], "collectionId testmuseum → 73D6 only");
const r2w = await call("search", { query: "crucifixion", onlyWithArtworks: true });
if (ok(r2w, "onlyWithArtworks")) eqList(notations(sc(r2w).results).sort(), ["31E2356", "73D5", "73D6", "73D67"], "onlyWithArtworks drops the no-collection tier");
const r2u = await call("search", { query: "crucifixion", collectionId: "nomuseum" });
if (ok(r2u, "unknown collectionId")) assertEq(sc(r2u).totalResults, 0, "unknown collectionId matches nothing");

const r2s = await call("search", { query: "crucifixion", parentNotation: "73D" });
if (ok(r2s, "parentNotation 73D"))
  eqList(notations(sc(r2s).results), ["73D6", "73D67", "73D5", "73D6712", "73D671"], "parentNotation drops 31E2356, keeps the order");
const r2like = await call("search", { query: "crucifixion", parentNotation: "7_D" });
if (ok(r2like, "parentNotation 7_D")) assertEq(sc(r2like).totalResults, 0, "'_' in parentNotation is literal, not a LIKE wildcard");

const r2de = await call("search", { query: "Kreuzigung" });
if (ok(r2de, "German query")) eqList(notations(sc(r2de).results), ["73D6"], "German keyword/text finds 73D6");
const r2lang = await call("search", { query: "crucifixion", lang: "de", maxResults: 1 });
if (ok(r2lang, "lang de")) assertEq(sc(r2lang).results[0]?.text,
  "die Kreuzigung Christi: der Kreuzestod; Golgatha (Matthäus 27:45-58; Markus 15:33-45; Lukas 23:44-52; Johannes 19:25-38)", "lang picks the label language");

const r2none = await call("search", { query: "xyznonexistent12345" });
if (ok(r2none, "no match")) assertEq(txt(r2none), '0 of 0 matches (0 base notations) for "xyznonexistent12345"', "a miss is an empty result, not an error");

// ══════════════════════════════════════════════════════════════════
section("3. search — phrase fallback, control characters, mode errors");

// No seeded text holds "angel trumpet" or "trumpet angel" as a phrase; only
// 11H(VINCENT FERRER)(+3) holds both words. Both orders must reach it via AND-terms.
const r3a = await call("search", { query: "angel trumpet" });
const r3b = await call("search", { query: "trumpet angel" });
if (ok(r3a, "angel trumpet") && ok(r3b, "trumpet angel")) {
  eqList(notations(sc(r3a).results), ["11H(VINCENT FERRER)(+3)"], "phrase miss falls back to AND-terms");
  // The base 11H(VINCENT FERRER) is not a result (nor seeded), but the variant still counts as it.
  assertEq(sc(r3a).totalBaseNotations, 1, "a variant whose base didn't match still counts one base notation");
  eqList(notations(sc(r3b).results), ["11H(VINCENT FERRER)(+3)"], "fallback is independent of word order");
}
// The phrase "27 58" is only in 73D7 ("Matthew 27:58-66", rijksmuseum only); 73D6
// ("Matthew 27:45-58", testmuseum) has both words apart. A phrase hit that the
// collection filter removes must not block the AND-terms fallback.
const r3f = await call("search", { query: "27 58", collectionId: "testmuseum" });
if (ok(r3f, "27 58 in testmuseum")) eqList(notations(sc(r3f).results), ["73D6"], "fallback runs when the filter empties the phrase hits");
const r3fu = await call("search", { query: "27 58" });
if (ok(r3fu, "27 58 unfiltered")) eqList(notations(sc(r3fu).results), ["73D7"], "an unfiltered phrase hit still wins over the fallback");
const r3nul = await call("search", { query: "angel\u0000trumpet" });
if (ok(r3nul, "NUL in query")) eqList(notations(sc(r3nul).results), ["11H(VINCENT FERRER)(+3)"], "NUL acts as a word break");
const r3one = await call("search", { query: "trumpetangel" });
if (ok(r3one, "single word")) assertEq(sc(r3one).totalResults, 0, "a single-word miss has no fallback");

assertEq(txt(await call("search", {})), "Provide exactly one of: query or semanticQuery.", "neither mode: error wording");
assertEq(txt(await call("search", { query: "a", semanticQuery: "b" })), "Provide exactly one of: query or semanticQuery — not both.", "both modes: error wording");
const r3sem = await call("search", { semanticQuery: "grief" });
assert(r3sem.isError === true, "semanticQuery without embeddings is an error");
assertEq(txt(r3sem), "Semantic search requires embeddings and an embedding model (not available). Use query (keyword search) instead.",
  "semanticQuery without embeddings: error points to query");
const r3deep = await call("search", { semanticQuery: "grief", offset: 480, maxResults: 25 });
assert(r3deep.isError === true, "semantic offset + maxResults past 500 is an error");
assertEq(txt(r3deep), "Semantic search ranks at most 500 neighbours, but offset + maxResults is 505. " +
  "Matches that deep are weak; refine semanticQuery or add parentNotation instead.", "semantic depth cap: error wording");
assertEq(txt(await call("search", { semanticQuery: "grief", offset: 475, maxResults: 25 })),
  "Semantic search requires embeddings and an embedding model (not available). Use query (keyword search) instead.",
  "semantic depth of exactly 500 passes the cap");
const r3kwDeep = await call("search", { query: "trumpet", offset: 600 });
if (ok(r3kwDeep, "keyword offset 600")) assertEq(sc(r3kwDeep).results.length, 0, "the depth cap does not apply to keyword search");
const r3long = await call("search", { semanticQuery: "x".repeat(1001) });
assert(r3long.isError === true && txt(r3long).includes("semanticQuery") && txt(r3long).includes("1000"),
  `semanticQuery over 1000 characters is rejected by the schema (got: ${txt(r3long).slice(0, 120)})`);

// ══════════════════════════════════════════════════════════════════
section("4. browse");

const r4 = await call("browse", { notation: "73D" });
if (ok(r4, "browse 73D")) {
  const s = sc(r4);
  eqList(s.entry.path, [{ notation: "7", text: "Bible" }, { notation: "73", text: "New Testament" }], "path with labels");
  eqList(notations(s.subtree), ["73D1", "73D2", "73D3", "73D4", "73D5", "73D6", "73D7", "73D8", "73D9"], "depth 1: the nine children");
  assertEq(lines(r4)[0], '7 "Bible" > 73 "New Testament" > 73D "Passion of Christ" (rijksmuseum)', "first line: labelled path, entry, collections");
  assertEq(lines(r4)[1], "Keywords: Christ, Passion of Christ", "keywords line");
  assertEq(lines(r4)[2], "Children (9):", "children header");
  assertEq(lines(r4)[3], '  73D1 "prelude to Christ\'s Passion"', "child line without collections");
}

const r4co = await call("browse", { notation: "73D", childOffset: 5 });
if (ok(r4co, "browse 73D childOffset 5")) {
  eqList(notations(sc(r4co).subtree), ["73D6", "73D7", "73D8", "73D9"], "childOffset skips the first five children");
  assertEq(sc(r4co).entry.children.length, 9, "entry.children still lists every child");
  assertEq(lines(r4co)[2], "Children (6–9 of 9, 4 total entries):", "childOffset header gives the range");
  assert(!txt(r4co).includes("More children"), "no 'more' hint on the last page");
}
const r4co2 = await call("browse", { notation: "73D", childOffset: 7, depth: 2 });
if (ok(r4co2, "browse 73D childOffset 7 depth 2")) {
  eqList(notations(sc(r4co2).subtree), ["73D8", "73D81", "73D82", "73D83", "73D9"], "grandchildren still expand under an offset");
}
const r4coPast = await call("browse", { notation: "73D", childOffset: 9 });
if (ok(r4coPast, "browse 73D childOffset 9")) {
  eqList(sc(r4coPast).subtree, [], "childOffset past the end: empty subtree");
  assertEq(lines(r4coPast).at(-1), "Children: none at childOffset 9 (9 in total).", "childOffset past the end is said, not silent");
}

const r4d2 = await call("browse", { notation: "73D", depth: 2 });
if (ok(r4d2, "browse 73D depth 2")) {
  const s = sc(r4d2);
  eqList(notations(s.subtree), ["73D1", "73D2", "73D24", "73D3", "73D4", "73D5", "73D6", "73D64", "73D67", "73D7", "73D8", "73D81", "73D82", "73D83", "73D9"],
    "depth 2: grandchildren follow their parent");
  assertEq(s.subtree.map((e) => e.depth).join(""), "112111122112221", "depth values per entry");
  assert(lines(r4d2).includes('    73D24 (rijksmuseum) "Last Supper (in general) (Matthew 26:21-35; Mark 14:18-31; Luke 22:3, 22:15-23; John 13:21-38)"'),
    "a depth-2 line is indented two levels");
}
const r4d3 = await call("browse", { notation: "73D", depth: 3 });
if (ok(r4d3, "browse 73D depth 3")) {
  eqList(notations(sc(r4d3).subtree), ["73D1", "73D2", "73D24", "73D3", "73D4", "73D5", "73D6", "73D64", "73D67", "73D671", "73D7", "73D8", "73D81", "73D82", "73D82(...)", "73D83", "73D9"],
    "depth 3 adds 73D671 and the 73D82(...) template");
  assertEq(sc(r4d3).subtreeCapped, false, "a complete subtree is not flagged as capped");
}

const r4t = await call("browse", { notation: "73D82" });
if (ok(r4t, "browse 73D82")) {
  eqList(notations(sc(r4t).subtree), ["73D82(...)"], "the name template is the parent's child");
  const L = lines(r4t);
  const i = L.indexOf("Children (1):");
  assert(i !== -1, "children header counts the template");
  assertEq(L[i + 1], '  73D82(...) "single instruments of the Passion (with NAME)"', "template child line");
}
const r4t2 = await call("browse", { notation: "73D8", depth: 2 });
if (ok(r4t2, "browse 73D8 depth 2")) {
  const e = sc(r4t2).subtree.find((c) => c.notation === "73D82");
  assertEq(e?.totalChildren, 1, "the template counts towards totalChildren");
}
const r4t3 = await call("browse", { notation: "73D82(...)" });
if (ok(r4t3, "browse 73D82(...)")) eqList(notations(sc(r4t3).subtree), ["73D82(CROSS)", "73D82(NAILS)"], "a template has no template child of its own");

const r4ref = await call("browse", { notation: "73D6" });
if (ok(r4ref, "browse 73D6")) {
  const L = lines(r4ref);
  const i = L.indexOf("Cross-references (1):");
  assert(i !== -1, "cross-reference header");
  assertEq(L[i + 1], '  11D35 (rijksmuseum) "specific types of crucified Christ (in non-narrative context)"', "a resolvable ref is labelled");
}
const r4unres = await call("browse", { notation: "73D24" });
if (ok(r4unres, "browse 73D24")) {
  const L = lines(r4unres);
  const i = L.indexOf("Cross-references (1):");
  assertEq(L[i + 1], "  11D3341", "an unresolvable ref is listed bare");
}

const r4k = await call("browse", { notation: "25F23", includeKeys: true });
if (ok(r4k, "browse 25F23 includeKeys")) {
  eqList(notations(sc(r4k).keyVariants), KEYS_25F23.slice(0, 25), "first 25 key variants in notation order");
  assertEq(sc(r4k).totalKeyVariants, 30, "totalKeyVariants");
  assert(lines(r4k).includes("Key variants (1–25 of 30):"), "key-variant header names the range");
}
const r4k2 = await call("browse", { notation: "25F23", includeKeys: true, keyOffset: 25 });
if (ok(r4k2, "browse 25F23 keyOffset 25")) {
  eqList(notations(sc(r4k2).keyVariants), KEYS_25F23.slice(25), "keyOffset 25: the last five");
  assert(lines(r4k2).includes("Key variants (26–30 of 30):"), "range header on the last page");
}
const r4kx = await call("browse", { notation: "25F23(+46)", includeKeys: true });
if (ok(r4kx, "browse key-expanded")) {
  assertEq(sc(r4kx).keyVariants.length, 0, "a key-expanded notation has no key variants of its own");
  eqList(notations(sc(r4kx).entry.path), ["2", "25", "25F", "25F2", "25F23", "25F23(+4)"], "key-expanded path runs through its key parent");
}

const r4nf = await call("browse", { notation: "ZZZZZ" });
assert(r4nf.isError === true, "unknown notation is an error");
assertEq(txt(r4nf), 'Notation "ZZZZZ" not found in Iconclass.', "browse not-found wording");

// lang: requested language, then en, then nl, then any.
const r4de = await call("browse", { notation: "73D6", lang: "de" });
if (ok(r4de, "browse 73D6 de")) {
  const s = sc(r4de);
  assertEq(s.entry.text, "die Kreuzigung Christi: der Kreuzestod; Golgatha (Matthäus 27:45-58; Markus 15:33-45; Lukas 23:44-52; Johannes 19:25-38)", "German label");
  eqList(s.entry.path.map((p) => p.text), ["Bible", "New Testament", "die Passion Christi"], "path labels fall back per entry");
  eqList(s.entry.keywords, ["Golgatha", "Johannes 19", "Kalvarienberg", "Kreuzigung", "Lukas 23", "Markus 15", "Matthaeus 27", "Tod", "letzte Stunden"], "German keywords");
}
const r4nl = await call("browse", { notation: "73D6", lang: "nl" });
if (ok(r4nl, "browse 73D6 nl")) assertEq(sc(r4nl).entry.text, "kruisdood", "Dutch label");
const r4fr = await call("browse", { notation: "73D6", lang: "fr" });
if (ok(r4fr, "browse 73D6 fr"))
  eqList(sc(r4fr).entry.keywords, ["Calvary", "Golgotha", "John 19", "Luke 23", "Mark 15", "Matthew 27", "crucifixion", "death", "last hours"], "no French keywords → English ones");
const r4it = await call("browse", { notation: "73D1", lang: "it" });
if (ok(r4it, "browse 73D1 it")) assertEq(sc(r4it).entry.text, "prelude to Christ's Passion", "no Italian label → English");

// ══════════════════════════════════════════════════════════════════
section("5. resolve");

const r5 = await call("resolve", { notation: ["25F23(+46)", "NONEXISTENT", "73D82(CROSS)"] });
if (ok(r5, "resolve batch")) {
  const s = sc(r5);
  eqList(notations(s.notations), ["25F23(+46)", "73D82(CROSS)"], "found entries in input order");
  eqList(s.notFound, ["NONEXISTENT"], "the miss is named in notFound");
  const k = s.notations[0];
  eqList([k.isKeyExpanded, k.baseNotation, k.keyId], [true, "25F23", "+46"], "key-expanded fields");
  assertEq(lines(r5)[0], '25F23(+46) (testmuseum) "beasts of prey, predatory animals (+ sleeping animal(s))" [2 > 25 > 25F > 25F2 > 25F23 > 25F23(+4)]', "entry line");
  assertEq(lines(r5).at(-1), "not found (1): NONEXISTENT", "the miss is in the text too");
}
const r5t = await call("resolve", { notation: ["12A27"] });
if (ok(r5t, "resolve 12A27")) eqList(sc(r5t).notations[0].children, ["12A27(...)"], "resolve lists the name template as a child");
const r5none = await call("resolve", { notation: ["ZZZZZ", "YYYYY"] });
assert(r5none.isError === true, "all misses is an error");
assertEq(txt(r5none), "None of the requested notations were found: ZZZZZ, YYYYY", "all-miss wording names every code");
const r5lang = await call("resolve", { notation: "73D6", lang: "xx" });
assert(txt(r5lang).startsWith("Input validation error: Invalid arguments for tool resolve: lang: Invalid option"), "an unsupported lang is rejected");

// ══════════════════════════════════════════════════════════════════
section("6. expand_keys");

const r6 = await call("expand_keys", { notation: "25F23" });
if (ok(r6, "expand_keys 25F23")) {
  assertEq(sc(r6).totalKeyVariants, 30, "totalKeyVariants");
  eqList(notations(sc(r6).keyVariants), KEYS_25F23.slice(0, 25), "default page of 25");
  assertEq(lines(r6)[0], '25F23 "beasts of prey, predatory animals" (rijksmuseum) — 30 key variants (1–25 of 30)', "header line");
  assertEq(lines(r6)[1], '  25F23(+0) (+0) "beasts of prey, predatory animals (+ variant)"', "variant line with key id");
}
const r6p = await call("expand_keys", { notation: "25F23", offset: 28 });
if (ok(r6p, "expand_keys offset 28")) {
  eqList(notations(sc(r6p).keyVariants), ["25F23(+4)", "25F23(+46)"], "offset 28: the last two");
  assert(lines(r6p)[0].endsWith("— 30 key variants (29–30 of 30)"), "range in header");
}
const r6x = await call("expand_keys", { notation: "25F23(+46)" });
assertEq(txt(r6x), '"25F23(+46)" is a key-expanded notation — expand_keys requires a base notation (e.g. "25F23").', "a key-expanded input is rejected, naming the base");
const r6n = await call("expand_keys", { notation: "73D82(CROSS)" });
if (ok(r6n, "expand_keys named variant")) {
  assertEq(sc(r6n).baseEntry.notation, "73D82(CROSS)", "a named variant is its own base");
  assertEq(sc(r6n).totalKeyVariants, 0, "with no key variants");
}
assertEq(txt(await call("expand_keys", { notation: "ZZZZZ" })), 'Notation "ZZZZZ" not found in Iconclass.', "expand_keys not-found wording");

// ══════════════════════════════════════════════════════════════════
section("7. search_prefix");

// Binary order: "73D82" < "73D82(...)" < "73D82(CROSS)" < "73D82(NAILS)" < "73D83".
const PREFIX_73D8 = ["73D8", "73D81", "73D82", "73D82(...)", "73D82(CROSS)", "73D82(NAILS)", "73D83"];
const r7 = await call("search_prefix", { notation: "73D8" });
if (ok(r7, "prefix 73D8")) {
  eqList(notations(sc(r7).results), PREFIX_73D8, "the subtree in notation order");
  assertEq(lines(r7)[0], '7 of 7 notations under "73D8"', "header line");
  assertEq(lines(r7)[4], '  73D82(...) "single instruments of the Passion (with NAME)"', "entry line");
}
const r7p = await call("search_prefix", { notation: "73D8", maxResults: 3, offset: 3 });
if (ok(r7p, "prefix paged")) {
  eqList(notations(sc(r7p).results), PREFIX_73D8.slice(3, 6), "offset 3, page of 3");
  assertEq(sc(r7p).totalResults, 7, "totalResults is the full count");
}
const r7c = await call("search_prefix", { notation: "73D8", collectionId: "rijksmuseum", maxResults: 2, offset: 2 });
if (ok(r7c, "prefix + collection paged")) {
  eqList(notations(sc(r7c).results), ["73D82", "73D82(CROSS)"], "collection filter applies before paging");
  assertEq(sc(r7c).totalResults, 6, "filtered totalResults (73D82(...) has no artworks)");
}
const r7t = await call("search_prefix", { notation: "73D", collectionId: "testmuseum" });
if (ok(r7t, "prefix + testmuseum")) eqList(notations(sc(r7t).results), ["73D6", "73D82(CROSS)"], "testmuseum subtree");

const r7punct = await call("search_prefix", { notation: "12A27(Deut. 21:22-23)" });
if (ok(r7punct, "prefix with punctuation"))
  eqList(notations(sc(r7punct).results), ["12A27(Deut. 21:22-23)", "12A27(Deut. 21:22-23)(+0)"], "punctuation is part of the prefix");
const r7wild = await call("search_prefix", { notation: "12A2_" });
if (ok(r7wild, "prefix 12A2_")) assertEq(sc(r7wild).totalResults, 0, "'_' is literal, not a LIKE wildcard");
const r7pct = await call("search_prefix", { notation: "7%" });
if (ok(r7pct, "prefix 7%")) assertEq(sc(r7pct).totalResults, 0, "'%' is literal, not a LIKE wildcard");
const r7all = await call("search_prefix", { notation: "2", maxResults: 1 });
if (ok(r7all, "prefix 2")) assertEq(sc(r7all).totalResults, 35, "a prefix counts key-expanded notations too (5 + 30)");
const r7base = await call("search_prefix", { notation: "2", baseOnly: true });
if (ok(r7base, "prefix 2 baseOnly")) {
  eqList(notations(sc(r7base).results), ["2", "25", "25F", "25F2", "25F23"], "baseOnly drops the 30 key variants");
  assertEq(sc(r7base).totalResults, 5, "baseOnly totalResults counts bases only");
}
const r7baseP = await call("search_prefix", { notation: "2", baseOnly: true, maxResults: 2, offset: 2 });
if (ok(r7baseP, "prefix 2 baseOnly paged")) eqList(notations(sc(r7baseP).results), ["25F", "25F2"], "baseOnly pages over bases");
const r7baseR = await call("search_prefix", { notation: "2", baseOnly: true, collectionId: "rijksmuseum" });
if (ok(r7baseR, "prefix 2 baseOnly + rijksmuseum")) {
  assertEq(sc(r7baseR).totalResults, 5, "baseOnly + collection: 8 rows with artworks less 3 variants");
}
const r7baseT = await call("search_prefix", { notation: "25F23", collectionId: "testmuseum" });
const r7baseT2 = await call("search_prefix", { notation: "25F23", collectionId: "testmuseum", baseOnly: true });
if (ok(r7baseT, "prefix 25F23 + testmuseum") && ok(r7baseT2, "prefix 25F23 + testmuseum baseOnly")) {
  eqList([sc(r7baseT).totalResults, sc(r7baseT2).totalResults], [1, 0], "testmuseum's only 25F23 row is a variant, which baseOnly drops");
}

// ══════════════════════════════════════════════════════════════════
section("8. find_artworks");

const r8 = await call("find_artworks", { notation: ["73D6", "NONEXISTENT_ZZZZZ", "12A27(Deut. 21:22-23)"] });
if (ok(r8, "find_artworks batch")) {
  const [a, b, c] = sc(r8).notations;
  eqList(sc(r8).notations.map((n) => n.notation), ["73D6", "NONEXISTENT_ZZZZZ", "12A27(Deut. 21:22-23)"], "one row per input, in input order");
  eqList(a.collections, [
    { collectionId: "testmuseum", label: "Test Museum", count: 500, url: "https://collection.example.org/search?iconclass=73D6" },
    { collectionId: "rijksmuseum", label: "Rijksmuseum, Amsterdam", count: 379, url: null },
  ], "collections sorted by count, URL only where a template exists");
  assertEq(a.artResearchUrl, "https://artresearch.net/resource/?uri=http%3A%2F%2Ficonclass.org%2F73D6", "ArtResearch link");
  eqList([b.text, b.collections], ["NONEXISTENT_ZZZZZ", []], "an unknown notation is echoed with its code as label");
  assertEq(c.collections[0]?.url, "https://collection.example.org/search?iconclass=12A27(Deut.%2021%3A22-23)", "the notation is URL-encoded into the template");
  assertEq(txt(r8).split("\n\n")[0], [
    '73D6 "the crucifixion of Christ: Christ\'s death on the cross; Golgotha (Matthew 27:45-58; Mark 15:33-45; Luke 23:44-52; John 19:25-38)"',
    "  Test Museum: 500 artworks → https://collection.example.org/search?iconclass=73D6",
    "  Rijksmuseum, Amsterdam: 379 artworks",
    "  ArtResearch (all collections + descendants): https://artresearch.net/resource/?uri=http%3A%2F%2Ficonclass.org%2F73D6",
  ].join("\n"), "text block for a notation with artworks");
  assertEq(txt(r8).split("\n\n")[1].split("\n")[0], 'NONEXISTENT_ZZZZZ "NONEXISTENT_ZZZZZ" — no loaded collection has artworks', "text line for a notation without artworks");
}

await client.close();
report();
