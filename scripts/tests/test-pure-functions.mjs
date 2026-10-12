/**
 * Unit tests for exported pure functions.
 *
 * Run:  node scripts/tests/test-pure-functions.mjs
 * Requires: npm run build (imports from dist/)
 *
 * FTS escaping failure modes (what the escapers exist to prevent):
 *   - user text reaches FTS5 as query syntax and throws (operators, quotes,
 *     parens, control characters such as NUL)
 *   - stripping removes so much that a real phrase no longer matches
 *   - the phrase form matches scattered words (phrase semantics lost)
 *   - the terms form drops a word, so the AND-fallback over-matches
 *   - nothing searchable is left, but the caller still gets a query (must be null)
 * Checked against a real in-memory FTS5 table rather than by output string.
 */
import Database from "better-sqlite3";
import { escapeFts5, escapeFts5Terms, artResearchUrl } from "../../dist/utils/db.js";
import { formatCollections, formatEntryLine } from "../../dist/registration.js";
import { assert, assertEq, section, report } from "./_assert.mjs";

const fts = new Database(":memory:");
fts.exec("CREATE VIRTUAL TABLE f USING fts5(t)");
const DOCS = [
  "the crucifixion of Christ",
  "beasts of prey sleeping",
  "prey of beasts",
  "angel blowing a trumpet",
  "say hello world",
  "mother-child relationship",
];
const ins = fts.prepare("INSERT INTO f(rowid, t) VALUES (?, ?)");
DOCS.forEach((t, i) => ins.run(i + 1, t));
const matchStmt = fts.prepare("SELECT t FROM f WHERE f MATCH ? ORDER BY rowid");

/** Run an FTS5 MATCH; returns the matched docs, or the error message if FTS5 rejects the query. */
function match(q) {
  try {
    return { docs: matchStmt.all(q).map(r => r.t) };
  } catch (err) {
    return { error: err.message };
  }
}

const ADVERSARIAL = [
  'say "hello"', '"', '""', "dog*", "AND OR NOT", "NEAR(a b)", "a - b", "- -", "+ +",
  "x + y", "col:val", "^start", "a/b c", "{a} [b]", "a\\b", "sleeping animal(s)",
  "angel\u0000trumpet", "crucifixion\u0000", "tab\there", "line\nbreak", "😀 angel",
];

// ── escapeFts5 ──────────────────────────────────────────────────

section("escapeFts5");

for (const input of ADVERSARIAL) {
  const q = escapeFts5(input);
  const r = q === null ? {} : match(q);
  assert(!r.error, `phrase: ${JSON.stringify(input)} never reaches FTS5 as invalid syntax${r.error ? ` (${r.error})` : ""}`);
}

assertEq(match(escapeFts5("crucifixion")).docs?.join("|"), "the crucifixion of Christ", "single word matches");
assertEq(match(escapeFts5("dog*")).docs?.length, 0, "wildcard stripped, not honoured (dog* does not prefix-match)");
assertEq(match(escapeFts5("crucifixion*")).docs?.join("|"), "the crucifixion of Christ", "stripping an operator keeps the word searchable");
assertEq(match(escapeFts5("beasts of prey")).docs?.join("|"), "beasts of prey sleeping", "multi-word input is a phrase: word order matters");
assertEq(match(escapeFts5("mother-child")).docs?.join("|"), "mother-child relationship", "hyphenated term still matches");
assertEq(match(escapeFts5('say "hello"')).docs?.join("|"), "say hello world", "embedded quotes do not break the phrase");
assertEq(match(escapeFts5("angel\u0000blowing")).docs?.join("|"), "angel blowing a trumpet", "a NUL separates words like whitespace");
assertEq(escapeFts5(""), null, "empty string → null");
assertEq(escapeFts5("***"), null, "only operators → null");
assertEq(escapeFts5("\u0000"), null, "only a control character → null");

// ── escapeFts5Terms ─────────────────────────────────────────────

section("escapeFts5Terms");

for (const input of ADVERSARIAL) {
  const q = escapeFts5Terms(input);
  const r = q === null ? {} : match(q);
  assert(!r.error, `terms: ${JSON.stringify(input)} never reaches FTS5 as invalid syntax${r.error ? ` (${r.error})` : ""}`);
}

assertEq(match(escapeFts5Terms("trumpet angel")).docs?.join("|"), "angel blowing a trumpet", "words AND-ed in any order");
assertEq(match(escapeFts5Terms("prey beasts")).docs?.join("|"), "beasts of prey sleeping|prey of beasts", "terms ignore word order");
assertEq(match(escapeFts5Terms("angel crucifixion")).docs?.length, 0, "every word must match (AND, not OR)");
assertEq(match(escapeFts5Terms("angel\u0000trumpet")).docs?.join("|"), "angel blowing a trumpet", "a NUL separates terms");
assertEq(escapeFts5Terms("crucifixion"), null, "single word → null (phrase search already covered it)");
assertEq(escapeFts5Terms(""), null, "empty string → null");
assertEq(escapeFts5Terms("***"), null, "only operators → null");

// ── formatCollections ───────────────────────────────────────────

section("formatCollections");

assertEq(formatCollections([]), "", "empty → empty string");
assertEq(formatCollections(["rijksmuseum"]), " (rijksmuseum)", "single collection");
assertEq(formatCollections(["rijksmuseum", "met"]), " (rijksmuseum, met)", "two collections");
assertEq(formatCollections(["rijksmuseum", "met", "louvre"]), " (rijksmuseum, met, louvre)", "three collections");

// ── formatEntryLine ─────────────────────────────────────────────

section("formatEntryLine");

const entry = {
  notation: "73D6",
  text: "the crucifixion of Christ",
  collections: ["rijksmuseum"],
  path: [{ notation: "7" }, { notation: "73" }, { notation: "73D" }],
};

assertEq(
  formatEntryLine(entry),
  '73D6 (rijksmuseum) "the crucifixion of Christ" [7 > 73 > 73D]',
  "basic entry with path and collections"
);

assertEq(
  formatEntryLine(entry, "1. "),
  '1. 73D6 (rijksmuseum) "the crucifixion of Christ" [7 > 73 > 73D]',
  "with numbered prefix"
);

assertEq(
  formatEntryLine(entry, "3. [0.879] "),
  '3. [0.879] 73D6 (rijksmuseum) "the crucifixion of Christ" [7 > 73 > 73D]',
  "with similarity prefix"
);

const noPath = {
  notation: "0",
  text: "Abstract Art",
  collections: [],
  path: [],
};

assertEq(
  formatEntryLine(noPath),
  '0 "Abstract Art"',
  "no path, no collections"
);

const multiCol = {
  notation: "31A33",
  text: "smell",
  collections: ["rijksmuseum", "met"],
  path: [{ notation: "3" }],
};

assertEq(
  formatEntryLine(multiCol),
  '31A33 (rijksmuseum, met) "smell" [3]',
  "multiple collections"
);

// ── artResearchUrl ──────────────────────────────────────────────

section("artResearchUrl");
const AR = "https://artresearch.net/resource/?uri=http%3A%2F%2Ficonclass.org%2F";
assertEq(artResearchUrl("25F23"), AR + "25F23", "plain notation, no special chars");
assertEq(artResearchUrl("25F23(LION)"), AR + "25F23%2528LION%2529", "named key — double-encoded parens");
assertEq(artResearchUrl("73D82:11H(JOHN)"), AR + "73D82%253A11H%2528JOHN%2529", "colon + parens double-encoded");
assertEq(artResearchUrl("25F23(+46)"), AR + "25F23%2528%252B46%2529", "plus + parens double-encoded");

// ── Summary ─────────────────────────────────────────────────────

report();
