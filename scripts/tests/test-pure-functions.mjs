/**
 * Unit tests for exported pure functions.
 *
 * Run:  node scripts/tests/test-pure-functions.mjs
 * Requires: npm run build (imports from dist/)
 */
import { escapeFts5, escapeFts5Terms } from "../../dist/utils/db.js";
import { formatCollections, formatEntryLine } from "../../dist/registration.js";

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

// ── escapeFts5 ──────────────────────────────────────────────────

section("escapeFts5");

assertEq(escapeFts5("crucifixion"), '"crucifixion"', "simple word");
assertEq(escapeFts5("beasts of prey"), '"beasts of prey"', "multi-word phrase");
assertEq(escapeFts5("sleeping animal(s)"), '"sleeping animals"', "strips parentheses");
assertEq(escapeFts5('say "hello"'), '"say ""hello"""', "escapes double quotes");
assertEq(escapeFts5("dog*"), '"dog"', "strips wildcard");
assertEq(escapeFts5("AND OR NOT"), '"AND OR NOT"', "reserved words safe inside quotes");
assertEq(escapeFts5(""), null, "empty string → null");
assertEq(escapeFts5("***"), null, "only operators → null");
assertEq(escapeFts5("Christ's death"), '"Christ\'s death"', "apostrophe preserved");
assertEq(escapeFts5("mother-child"), '"mother-child"', "hyphen preserved (safe in FTS5 phrases)");

// ── escapeFts5Terms ─────────────────────────────────────────────

section("escapeFts5Terms");

assertEq(escapeFts5Terms("Marriage Cana"), '"Marriage" AND "Cana"', "two words AND-ed");
assertEq(escapeFts5Terms("broken string instrument"), '"broken" AND "string" AND "instrument"', "three words AND-ed");
assertEq(escapeFts5Terms("crucifixion"), null, "single word → null (use escapeFts5 instead)");
assertEq(escapeFts5Terms(""), null, "empty string → null");
assertEq(escapeFts5Terms("***"), null, "only operators → null");
assertEq(escapeFts5Terms("sleeping (animal)"), '"sleeping" AND "animal"', "strips parens then splits");
assertEq(escapeFts5Terms('say "hello" world'), '"say" AND "hello" AND "world"', "strips quotes then splits");

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

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
