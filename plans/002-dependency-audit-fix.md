# Plan 002: Clear the npm audit backlog (protobufjs critical + qs DoS advisories)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat af139f1..HEAD -- package.json package-lock.json`
> If these files changed since this plan was written, re-run
> `npm audit --omit=dev` first — the advisories may already be fixed; if the
> audit is already clean, mark this plan DONE-superseded in `plans/README.md`
> and stop.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (001 recommended first so CI guards the change)
- **Category**: security
- **Planned at**: commit `af139f1`, 2026-06-12

## Why this matters

`npm audit --omit=dev` reports **8 vulnerabilities (6 moderate, 1 high,
1 critical)** in production dependencies as of 2026-06-12. The critical and
high advisories are in `protobufjs@7.5.4` (prototype pollution / DoS family,
advisory range `protobufjs <=7.5.7`), reached via
`@huggingface/transformers@3.8.1 → onnxruntime-web@1.22.0-dev… → protobufjs`.
The moderate `qs` advisory (DoS in `qs.stringify`, range 6.11.1–6.15.1) comes
via `express@5.2.1 → body-parser → qs@6.15.0`.

Honest reachability assessment: **low**. `onnxruntime-web` is the browser
backend of transformers.js — this server runs the Node backend — and the `qs`
advisory is in `stringify`, while Express uses `parse` on query strings. This
is hygiene, not an active hole. But `npm audit` says a compatible fix exists
(`fix available via npm audit fix`, no `--force` needed), the server is a
public unauthenticated HTTP endpoint, and a clean audit keeps real future
advisories visible instead of buried in noise.

## Current state

- `package.json` dependencies (do not edit by hand — `npm audit fix` should
  only touch `package-lock.json` since all ranges are semver-compatible):

  ```json
  "dependencies": {
    "@huggingface/transformers": "3.8.1",
    "@modelcontextprotocol/sdk": "^1.26.0",
    "better-sqlite3": "^12.6.2",
    "compression": "^1.8.1",
    "cors": "^2.8.5",
    "express": "^5.1.0",
    "sqlite-vec": "0.1.9",
    "zod": "^3.25.0"
  }
  ```

  Note `@huggingface/transformers` and `sqlite-vec` are **exact-pinned**
  (project rule: `sqlite-vec` pinned at 0.1.9 — never change it). The
  protobufjs fix happens inside the transitive tree (lockfile), not by
  bumping `@huggingface/transformers` itself.

- Vulnerable chains (from `npm ls protobufjs qs`):

  ```
  ├─┬ @huggingface/transformers@3.8.1
  │ └─┬ onnxruntime-web@1.22.0-dev.20250409-89f8206ba4
  │   └── protobufjs@7.5.4
  └─┬ express@5.2.1
    ├─┬ body-parser@2.2.2
    │ └── qs@6.15.0 deduped
    └── qs@6.15.0
  ```

- Verified green baseline at planning time: `npx tsc --noEmit` clean,
  `npm test` → 26 passed.

## Commands you will need

| Purpose      | Command                      | Expected on success                       |
|--------------|------------------------------|-------------------------------------------|
| Audit (read) | `npm audit --omit=dev`       | after fix: `found 0 vulnerabilities`       |
| Fix          | `npm audit fix`              | exit 0, no `--force` prompt                |
| Build        | `npm run build`              | exit 0                                     |
| Unit tests   | `npm test`                   | `26 passed, 0 failed`                      |
| Integration  | `npm run test:tools`         | all pass — ONLY if `data/iconclass.db` exists |

## Scope

**In scope** (the only files you should modify):
- `package-lock.json`

**Out of scope** (do NOT touch):
- `package.json` — if `npm audit fix` modifies it, see STOP conditions.
- `sqlite-vec` at any version other than 0.1.9 (project rule — pinned;
  `vec_int8()` wrappers depend on this exact version).
- `@huggingface/transformers` version (exact-pinned at 3.8.1 deliberately).
- Any source file under `src/`.

## Git workflow

- Branch: `advisor/002-dependency-audit-fix`
- Commit style: `chore(deps): npm audit fix — clear protobufjs/qs advisories`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the before state

Run `npm audit --omit=dev` and save the summary line (count of vulns) for
your final report.

**Verify**: output ends with a line like `8 vulnerabilities (6 moderate, 1 high, 1 critical)`
(counts may differ slightly if new advisories landed — that's fine, note them).

### Step 2: Apply the fix

Run `npm audit fix` (NOT `npm audit fix --force`).

**Verify**: exit 0, and `git diff --name-only` → only `package-lock.json`.

### Step 3: Confirm the audit is clean and the pins held

**Verify**:
- `npm audit --omit=dev` → `found 0 vulnerabilities` (or only advisories that
  have no compatible fix — report any remainder verbatim).
- `npm ls sqlite-vec @huggingface/transformers` → still `sqlite-vec@0.1.9`
  and `@huggingface/transformers@3.8.1`.

### Step 4: Rebuild and test

Run `npm ci && npm run build && npm test`.

**Verify**: exit 0, `26 passed, 0 failed`.

### Step 5 (conditional): Integration tests

Only if `data/iconclass.db` exists (check with `ls -la data/iconclass.db`):
run `npm run test:tools`.

**Verify**: all 207 tests pass. If the DB is absent (e.g. you are in a fresh
worktree — `data/` is gitignored), skip and state so in your report.

## Test plan

No new tests. The existing suites are the regression net: unit tests always,
integration tests when the local DB is available.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm audit --omit=dev` reports 0 critical and 0 high vulnerabilities
- [ ] `git diff --name-only` shows only `package-lock.json`
- [ ] `npm ls sqlite-vec` shows exactly `sqlite-vec@0.1.9`
- [ ] `npm run build && npm test` exits 0 with 26 passed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm audit fix` wants to modify `package.json` (it should not — the fix
  ranges are lockfile-compatible per the audit output at planning time).
- `npm audit fix` says a fix requires `--force` or a semver-major bump.
- `sqlite-vec` or `@huggingface/transformers` resolve to a different version
  after the fix.
- `npm test` or (if run) `npm run test:tools` fails after the fix.

## Maintenance notes

- Re-run `npm audit --omit=dev` after any future dependency change; consider
  a monthly scheduled GitHub Actions audit job once Plan 001's CI exists.
- If a future advisory in `onnxruntime-web` has no compatible fix, remember
  the reachability argument above (browser backend, not loaded in Node)
  before escalating.
