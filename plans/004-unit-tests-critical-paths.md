# Plan 004: Unit-test the untested critical paths (ensureDb download/swap, UsageStats, MRL truncation)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat af139f1..HEAD -- src/utils/db.ts src/utils/UsageStats.ts src/api/EmbeddingModel.ts scripts/tests/ package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (tests) / MED for the one small source refactor in Step 3
- **Depends on**: 001 (CI baseline; soft — tests are useful without it)
- **Category**: tests
- **Planned at**: commit `af139f1`, 2026-06-12

## Why this matters

The 26 existing unit tests cover only string-formatting helpers; the 207
integration tests exercise tool behaviour against the real 3.2 GB DB. Three
modules sit between those layers with **zero coverage**, and two of them run
unattended on every Railway deploy:

1. `ensureDb()` (`src/utils/db.ts:112-171`) — downloads, gunzips, validates,
   and atomically swaps the production databases at container start. A
   regression here bricks deploys or silently keeps stale data.
2. `UsageStats` (`src/utils/UsageStats.ts`) — new code (#326), persists
   telemetry with an atomic temp+rename; corrupt-file recovery is untested.
3. MRL truncation in `EmbeddingModel.embed()`
   (`src/api/EmbeddingModel.ts:70-76`) — dimension-sensitive math; a bug
   makes semantic search silently return garbage similarity scores.

All three are testable without the big DB, the network, or the HuggingFace
model — so these tests can run in CI (Plan 001).

## Current state

- Test conventions: no framework. `scripts/tests/test-pure-functions.mjs` is
  the exemplar — local `assert`/`assertEq` helpers, counters, prints
  `N passed, M failed`, `process.exit(1)` on failure, imports the code under
  test **from `dist/`**:

  ```js
  import { escapeFts5, escapeFts5Terms } from "../../dist/utils/db.js";
  let passed = 0; let failed = 0; const failures = [];
  function assert(condition, msg) { ... }
  ```

  Model the new file on it exactly (header comment, helpers, summary block).

- `src/utils/db.ts:112-171` — `ensureDb(spec)` behaviour to pin down:
  - resolves path from `spec.pathEnvVar` env var, else `<root>/data/<defaultFile>`;
  - if file exists, passes `spec.validationQuery`, and `refreshOnStartup` is
    not set → returns without downloading;
  - if `spec.urlEnvVar` env is unset → returns (no download possible);
  - downloads to `<dbPath>.tmp` (gz auto-detected by `.gz` URL suffix,
    gunzipped via `node:zlib`), tries chunked `.part-aa/-ab/…` URLs first,
    falls back to single file;
  - validates the downloaded file with `spec.validationQuery` **before**
    `fs.renameSync(tmpPath, dbPath)`;
  - on any failure: logs, deletes tmp files, **preserves the existing local
    file**, and does not throw.

  ```ts
  export interface DbSpec {
    name: string;
    pathEnvVar: string;
    urlEnvVar: string;
    defaultFile: string;
    validationQuery: string;
    refreshOnStartup?: boolean;
  }
  ```

- `src/utils/UsageStats.ts` — constructor accepts an explicit
  `filePath` (first parameter, overrides env), `record(tool, ms, ok)` is
  in-memory, `flush()` writes `<filePath>.tmp` then renames, `load()` falls
  back to a fresh `{since, lastUpdated, tools: {}, daily: {}}` on missing or
  corrupt file.

- `src/api/EmbeddingModel.ts:58-79` — `embed()` contains inline truncation
  logic that is currently unreachable without loading a real model:

  ```ts
  let vec = new Float32Array(output.data);

  // MRL truncation: when the DB was built at a lower dimension than the model
  // outputs, truncate and re-normalize so the query vector matches stored embeddings.
  if (this.targetDim > 0 && vec.length > this.targetDim) {
    vec = vec.slice(0, this.targetDim);
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 1e-10) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  return vec;
  ```

- Repo conventions: ESM with `.js` import extensions; strict TS; project
  rule **"No `node -e` for anything non-trivial"** — all test logic lives in
  the `.mjs` file. Another rule: all scripts must live inside the project
  tree (they do — `scripts/tests/`). Temp fixture files must go in
  `fs.mkdtempSync(path.join(os.tmpdir(), "iconclass-test-"))`, cleaned in a
  `finally`.

## Commands you will need

| Purpose    | Command                                  | Expected on success     |
|------------|------------------------------------------|--------------------------|
| Typecheck  | `npx tsc --noEmit`                       | exit 0                   |
| Build      | `npm run build`                          | exit 0                   |
| Old units  | `node scripts/tests/test-pure-functions.mjs` | `26 passed, 0 failed` |
| New units  | `node scripts/tests/test-units.mjs`      | all pass, exit 0         |
| Combined   | `npm test`                               | both files' tests pass   |
| Integration (optional) | `npm run test:tools`        | 207 pass — only if `data/iconclass.db` exists |

## Scope

**In scope**:
- `scripts/tests/test-units.mjs` (create)
- `src/api/EmbeddingModel.ts` (extract one pure function — Step 3 only)
- `package.json` (extend the `test` script)

**Out of scope** (do NOT touch):
- `src/utils/db.ts` and `src/utils/UsageStats.ts` — test them as they are;
  if you believe a refactor is needed to test them, that's a STOP condition.
- `scripts/tests/test-tools.mjs`, `test-http-concurrency.mjs` — existing
  suites unchanged.
- `src/api/IconclassDb.ts` — needs the real DB; covered by integration tests.

## Git workflow

- Branch: `advisor/004-unit-tests-critical-paths`
- Commit style: `test: add unit coverage for ensureDb, UsageStats, MRL truncation`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: UsageStats tests

Create `scripts/tests/test-units.mjs` modeled on `test-pure-functions.mjs`
(same helper functions, same summary format). First section — UsageStats,
importing from `../../dist/utils/UsageStats.js`. Each test uses its own file
path inside a `mkdtempSync` dir. Cases:

1. fresh instance with non-existent path → `toJSON()` has empty `tools`/`daily`, `since` is an ISO string;
2. `record("search", 100, true)` twice + `record("search", 50, false)` →
   `tools.search` is `{calls: 3, errors: 1, totalMs: 250, maxMs: 100}`;
3. `flush()` → file exists, parses as JSON, no `.tmp` file left behind;
4. new instance on the flushed path → loads the same counts (round-trip);
5. corrupt file (write `not json{` to the path first) → instance starts
   fresh instead of throwing;
6. `record` updates the right `daily` bucket (key = `toISOString().slice(0,10)`).

**Verify**: `npm run build && node scripts/tests/test-units.mjs` → all pass so far.

### Step 2: ensureDb tests

`ensureDb` is `async` (it `await`s `tryChunkedDownload` internally) — every
test must `await ensureDb(spec)`, and each `() => { ... }` test body that
calls it must be an `async` function.

Second section — `ensureDb`, importing from `../../dist/utils/db.js`. Use a
unique pair of env var names per test (e.g. `TEST_DB_PATH_1`/`TEST_DB_URL_1`)
in the `DbSpec`, pointing into the temp dir; create fixture SQLite files with
`better-sqlite3` (`import Database from "better-sqlite3"`; create table `t`,
insert a row; validation query `"SELECT 1 FROM t LIMIT 1"`). For download
cases, start a local `node:http` server on an ephemeral port serving fixture
bytes; close it in `finally`. Cases:

1. existing valid DB, no URL set → ensureDb returns, file mtime unchanged
   (no re-download attempted);
2. no local file, no URL → returns without creating anything, no throw;
3. no local file + URL serving a valid uncompressed fixture → file appears
   at the spec path and passes the validation query;
4. no local file + URL ending `.gz` serving a gzipped fixture
   (`node:zlib gzipSync`) → file appears decompressed and valid;
5. corrupt download (URL serves random bytes) over an existing **valid**
   local DB with `refreshOnStartup: true` → local file preserved unchanged
   (compare content hash before/after), no `.tmp`/`.tmp.gz` files left;
6. existing local file that FAILS validation + URL with valid fixture →
   file is replaced and now passes validation.

Note on case 3/4: the HTTP fixture server must return 404 for
`*.part-aa` requests so `tryChunkedDownload` falls through to the
single-file path (read `src/utils/db.ts:82-105` — first chunk failure
returns false, which is the fall-through).

**Verify**: `node scripts/tests/test-units.mjs` → all pass; temp dir cleaned.

### Step 3: Extract and test MRL truncation

In `src/api/EmbeddingModel.ts`, extract lines 70-76's logic into an exported
pure function in the same file:

```ts
/** MRL truncation: cut a vector to targetDim and re-normalize to unit length.
 *  No-op when targetDim is 0 or the vector is already <= targetDim. */
export function mrlTruncate(vec: Float32Array, targetDim: number): Float32Array {
  if (targetDim <= 0 || vec.length <= targetDim) return vec;
  const out = vec.slice(0, targetDim);
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 1e-10) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
```

and replace the inline block in `embed()` with
`vec = mrlTruncate(vec, this.targetDim);` (the surrounding
`new Float32Array(output.data)` and `return vec` stay). Behaviour must be
identical — same guard conditions, same epsilon.

Third test section, importing `mrlTruncate` from
`../../dist/api/EmbeddingModel.js`. Cases:

1. `targetDim = 0` → returns the same values, full length (no-op);
2. `vec.length === targetDim` → no-op;
3. 768-length vector → `targetDim 384` → length 384 and L2 norm ≈ 1
   (`Math.abs(norm - 1) < 1e-5`);
4. all-zeros vector with truncation → no NaNs (epsilon guard holds);
5. truncation preserves direction: first 384 components proportional to the
   input's first 384 components (check ratio of two non-zero components).

**Verify**: `npx tsc --noEmit` → exit 0; `npm run build && node scripts/tests/test-units.mjs` → all pass.

### Step 4: Wire into npm test

In `package.json`, change:

```json
"test": "node scripts/tests/test-pure-functions.mjs && node scripts/tests/test-units.mjs",
```

**Verify**: `npm test` → both suites pass (26 + your new count, two summary blocks), exit 0.

### Step 5: Regression check on the embedding path (conditional)

Only if `data/iconclass.db` exists: `npm run test:tools` (exercises semantic
search end-to-end through the refactored `embed()`).

**Verify**: all 207 pass. If the DB is absent, skip and say so in your report.

## Test plan

This plan *is* the test plan: ~17 new cases across three sections in
`scripts/tests/test-units.mjs`, modeled structurally on
`scripts/tests/test-pure-functions.mjs` (helpers, counters, exit code).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm run build && npm test` exits 0; output contains two summary blocks, 0 failed
- [ ] `node scripts/tests/test-units.mjs` exits 0 standalone
- [ ] `grep -n "mrlTruncate" src/api/EmbeddingModel.ts` → ≥2 matches (definition + call site)
- [ ] `git status` shows only `scripts/tests/test-units.mjs`, `src/api/EmbeddingModel.ts`, `package.json` changed
- [ ] No stray temp files in the repo `data/` dir: `ls data/*.tmp* 2>/dev/null`
      → empty. (Tests must write all fixtures under
      `fs.mkdtempSync(path.join(os.tmpdir(), "iconclass-test-"))`, never into
      `data/`; this check guards against a test or the refactor leaking there.)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/utils/db.ts` or `src/api/EmbeddingModel.ts` no longer match the
  excerpts above (drift).
- Testing `ensureDb` seems to require modifying `src/utils/db.ts` (e.g. an
  env-handling subtlety not captured here) — report the subtlety instead of
  refactoring source.
- The refactored `embed()` would change any behaviour visible in
  `npm run test:tools` (if runnable) — i.e. any of the 207 tests fail.
- Tests are flaky across two consecutive runs (likely port reuse or temp-dir
  collision — report rather than adding sleeps).

## Maintenance notes

- If `ensureDb` grows features (checksums, chunk manifests — see backlog
  finding BUILD-C in `plans/README.md`), extend section 2 first
  (characterization-tests-first).
- `mrlTruncate` is now public API of the module; the embeddings build script
  (`scripts/generate-embeddings-modal.py`) implements the same truncation in
  Python — if either side changes the epsilon or normalization, they must
  change together.
- CI (Plan 001) picks the new tests up automatically via `npm test`.
