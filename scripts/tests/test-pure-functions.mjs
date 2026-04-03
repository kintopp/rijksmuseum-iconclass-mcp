/**
 * Unit tests for exported pure functions.
 *
 * Run:  node scripts/tests/test-pure-functions.mjs
 * Requires: npm run build (imports from dist/)
 */
import { escapeFts5, escapeFts5Terms } from "../../dist/utils/db.js";
import { formatCounts, formatEntryLine } from "../../dist/registration.js";

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

// ── formatCounts ────────────────────────────────────────────────

section("formatCounts");

assertEq(formatCounts({}), "", "empty counts → empty string");
assertEq(formatCounts({ rijksmuseum: 0 }), "", "zero count → empty string");
assertEq(formatCounts({ rijksmuseum: 42 }), " (42 artworks)", "single collection");
assertEq(
  formatCounts({ rijksmuseum: 42, met: 17 }),
  " (rijksmuseum: 42, met: 17)",
  "multiple collections"
);
assertEq(formatCounts({ rijksmuseum: 0, met: 5 }), " (5 artworks)", "zero filtered out, one remains");
assertEq(
  formatCounts({ rijksmuseum: 10, met: 0, nga: 3 }),
  " (rijksmuseum: 10, nga: 3)",
  "zero filtered, two remain"
);

// ── formatEntryLine ─────────────────────────────────────────────

section("formatEntryLine");

const entry = {
  notation: "73D6",
  text: "the crucifixion of Christ",
  collectionCounts: { rijksmuseum: 371 },
  path: [{ notation: "7" }, { notation: "73" }, { notation: "73D" }],
};

assertEq(
  formatEntryLine(entry),
  '73D6 (371 artworks) "the crucifixion of Christ" [7 > 73 > 73D]',
  "basic entry with path and counts"
);

assertEq(
  formatEntryLine(entry, "1. "),
  '1. 73D6 (371 artworks) "the crucifixion of Christ" [7 > 73 > 73D]',
  "with numbered prefix"
);

assertEq(
  formatEntryLine(entry, "3. [0.879] "),
  '3. [0.879] 73D6 (371 artworks) "the crucifixion of Christ" [7 > 73 > 73D]',
  "with similarity prefix"
);

const noPath = {
  notation: "0",
  text: "Abstract Art",
  collectionCounts: {},
  path: [],
};

assertEq(
  formatEntryLine(noPath),
  '0 "Abstract Art"',
  "no path, no counts"
);

const multiCount = {
  notation: "31A33",
  text: "smell",
  collectionCounts: { rijksmuseum: 114, met: 22 },
  path: [{ notation: "3" }],
};

assertEq(
  formatEntryLine(multiCount),
  '31A33 (rijksmuseum: 114, met: 22) "smell" [3]',
  "multiple collection counts"
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
