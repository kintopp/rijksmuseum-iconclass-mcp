/**
 * Shared assertion harness for the no-framework test scripts in this dir
 * (test-pure-functions.mjs, test-units.mjs). Owns the pass/fail tally so
 * `report()` can print one summary and set the exit code.
 */

let passed = 0;
let failed = 0;
const failures = [];

const BAR = "═".repeat(60);

export function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

export function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function section(name) {
  console.log(`\n${BAR}`);
  console.log(`  ${name}`);
  console.log(BAR);
}

/** Run an async test body; a throw becomes a failure rather than aborting the suite. */
export async function atest(msg, fn) {
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push(`${msg} — threw: ${err.message}`);
    console.log(`  ✗ ${msg} (threw: ${err.message})`);
  }
}

/** Print the pass/fail summary; set a non-zero exit code if anything failed. */
export function report() {
  console.log(`\n${BAR}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(BAR);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}
