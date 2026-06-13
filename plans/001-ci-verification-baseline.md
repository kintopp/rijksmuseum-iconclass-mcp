# Plan 001: Establish a CI verification baseline (typecheck script + GitHub Actions)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat af139f1..HEAD -- package.json .github/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `af139f1`, 2026-06-12

## Why this matters

This repo has no CI at all (there is no `.github/` directory) and no
typecheck-only script. Tests run only when the maintainer remembers to run
them locally; a TypeScript error or lint regression can be committed and
auto-deployed by Railway with zero automated gate. The unit test suite
(26 pure-function tests) and the typecheck need neither the 3.2 GB database
nor any network secrets, so a fast CI gate is essentially free. This plan is
also the prerequisite verification baseline for every other plan in
`plans/` — they all cite `npm run typecheck` / `npm test` as done criteria.

## Current state

- `package.json` — npm scripts. There is `build` (`tsc`), `lint`
  (`eslint src/`), `test` (`node scripts/tests/test-pure-functions.mjs`),
  but **no `typecheck` script**. Relevant excerpt (package.json, `scripts`):

  ```json
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "serve": "node dist/index.js --http",
    "lint": "eslint src/",
    "test": "node scripts/tests/test-pure-functions.mjs",
    "test:tools": "node scripts/tests/test-tools.mjs",
    "test:http": "node scripts/tests/test-http-concurrency.mjs",
    "test:all": "node scripts/tests/test-pure-functions.mjs && node scripts/tests/test-tools.mjs && node scripts/tests/test-http-concurrency.mjs",
    "warm-cache": "node scripts/warm-cache-local.mjs --validate"
  }
  ```

- `scripts/tests/test-pure-functions.mjs:1-8` — the unit tests import from
  `dist/`, so **`npm run build` must run before `npm test`** in CI:

  ```js
  /**
   * Unit tests for exported pure functions.
   * Requires: npm run build (imports from dist/)
   */
  import { escapeFts5, escapeFts5Terms } from "../../dist/utils/db.js";
  import { formatCollections, formatEntryLine } from "../../dist/registration.js";
  ```

- `package.json` `engines`: `"node": ">=24.14.1 <25"` — CI must use Node 24.
- `npm run test:tools` and `npm run test:http` require the 3.2 GB local
  `data/iconclass.db` — they CANNOT run in CI. Do not add them to the workflow.
- `better-sqlite3` is a native dependency; `npm ci` installs prebuilt
  binaries for Node 24 on ubuntu runners — no extra build tooling needed.
- Verified green at planning time (2026-06-12): `npx tsc --noEmit` exits 0;
  `npm test` reports `26 passed, 0 failed`.

## Commands you will need

| Purpose   | Command              | Expected on success                  |
|-----------|----------------------|--------------------------------------|
| Install   | `npm ci`             | exit 0                               |
| Typecheck | `npm run typecheck`  | exit 0, no output (after step 1)     |
| Lint      | `npm run lint`       | exit 0                               |
| Build     | `npm run build`      | exit 0, writes `dist/`               |
| Unit tests| `npm test`           | `26 passed, 0 failed`, exit 0        |

## Scope

**In scope** (the only files you should modify/create):
- `package.json` (add one script)
- `.github/workflows/ci.yml` (create)

**Out of scope** (do NOT touch):
- `railway.json` — Railway deploy config is independent of CI.
- `scripts/tests/*.mjs` — no test changes in this plan.
- Any `npm install`/dependency change — `package-lock.json` must not change.
- `eslint.config.js`, `tsconfig.json`.

## Git workflow

- Branch: `advisor/001-ci-verification-baseline`
- Commit style: conventional commits, e.g. `ci: add GitHub Actions verification gate and typecheck script`
  (matches repo history: `feat(telemetry): ...`, `test: add prod probe ...`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a `typecheck` script

In `package.json`, add to `scripts` (after `"build"`):

```json
"typecheck": "tsc --noEmit",
```

**Verify**: `npm run typecheck` → exits 0 with no errors.

### Step 2: Create the CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

Note the order: `build` before `test`, because the unit tests import from
`dist/` (see Current state).

**Verify**: `node -e "const y=require('js-yaml')"` is NOT available — instead
validate by running each workflow command locally in sequence:
`npm ci && npm run lint && npm run typecheck && npm run build && npm test`
→ all exit 0, final line `26 passed, 0 failed`.

### Step 3: Sanity-check the workflow file shape

**Verify**: `npx --yes yaml-lint .github/workflows/ci.yml` → "valid YAML" / exit 0.
If `yaml-lint` cannot be fetched (offline), instead verify with
`node --input-type=module -e "import fs from 'node:fs'; const t=fs.readFileSync('.github/workflows/ci.yml','utf8'); if(!t.includes('npm run build')||!t.includes('node-version: 24')) process.exit(1)"` → exit 0.

## Test plan

No new tests — this plan creates the harness that runs existing ones.
The verification is the full local command chain in Step 2.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run build && npm test` exits 0 with `26 passed, 0 failed`
- [ ] `.github/workflows/ci.yml` exists and contains `npm run typecheck`
- [ ] `git status` shows only `package.json` and `.github/workflows/ci.yml` modified/added
- [ ] `git diff package-lock.json` is empty
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm run typecheck` fails on the untouched codebase (codebase drifted;
  fixing source type errors is out of scope).
- `npm test` fails before your changes (baseline broken — report, don't fix).
- A `.github/` directory already exists with workflows (another CI was added
  since planning; reconcile instead of overwriting).
- `npm ci` fails to build/install `better-sqlite3`.

## Maintenance notes

- Plan 004 (unit tests for download/stats/truncation) adds a new test file;
  its plan extends `npm test` — CI picks it up automatically through that script.
- After the first push, the operator should check the Actions tab once to
  confirm the runner installs `better-sqlite3` cleanly on Node 24.
- Deliberately NOT in CI: `test:tools` / `test:http` (need the 3.2 GB DB) and
  `npm audit` (would make CI red on every new upstream advisory; run it
  manually or via a scheduled workflow later if wanted).
