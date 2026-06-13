# Plan 003: Expose the collected UsageStats via a /debug/stats HTTP endpoint

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat af139f1..HEAD -- src/index.ts src/utils/UsageStats.ts docs/technical-guide.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `af139f1`, 2026-06-12

## Why this matters

Commit `af139f1` (issue #326) added `UsageStats` — persistent per-tool
call/error/latency counters — but the data is only written to a JSON file on
the server's disk. The operator currently has to shell into the Railway
container (or mount the volume) to see which tools are used and which error.
`UsageStats.toJSON()` even carries the comment *"for potential /health
enrichment"* — the read side was anticipated but never built. A
`/debug/stats` endpoint closes the loop with ~10 lines, following the exact
pattern of the existing `/debug/memory` endpoint. The data is non-sensitive
(tool names, counts, latencies, dates — no inputs, no PII), so it follows the
documented convention that debug endpoints here are unauthenticated.

## Current state

- `src/index.ts:64` — module-scope singleton (this comment explains why it
  must NOT be created per-request):

  ```ts
  // Per-tool usage telemetry (#326). Module-scope singleton: createServer() runs
  // per-request in HTTP mode, so this must NOT be created inside it.
  let usageStats: UsageStats | undefined;
  ```

- `src/index.ts:224-232` — the existing debug endpoint to mirror (including
  the convention comment that justifies no auth):

  ```ts
  // ── Memory observability (issue #272) ──────────────────────────
  //
  // Startup logs a detailed snapshot; /debug/memory exposes the same shape
  // on demand. Unauthenticated to match /health — operational signal, not
  // sensitive.

  app.get("/debug/memory", (_req: express.Request, res: express.Response) => {
    res.json(captureMemorySnapshot(buildMemoryDbHandles()));
  });
  ```

- `src/utils/UsageStats.ts:93-96` — the read accessor already exists:

  ```ts
  /** Return current stats snapshot (for potential /health enrichment). */
  toJSON(): StatsData {
    return this.data;
  }
  ```

  `StatsData` shape: `{ since, lastUpdated, tools: Record<string, {calls, errors, totalMs, maxMs}>, daily: Record<string, {calls, errors}> }`.
  `toJSON()` returns the live in-memory state — fresher than the hourly disk
  flush, no I/O needed in the handler.

- `src/index.ts:236-242` — startup log block lists the endpoints; a new line
  should be added there for discoverability:

  ```ts
  httpServer = app.listen(port, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://localhost:${port}`);
    console.error(`  MCP endpoint: POST /mcp`);
    console.error(`  Health:       GET  /health`);
    console.error(`  Memory:       GET  /debug/memory`);
  ```

- `docs/technical-guide.md` documents HTTP endpoints and env vars (it already
  covers `USAGE_STATS_PATH`). Locate its endpoint documentation by searching
  for `/debug/memory` in that file.

## Commands you will need

| Purpose    | Command              | Expected on success              |
|------------|----------------------|----------------------------------|
| Typecheck  | `npx tsc --noEmit`   | exit 0 (or `npm run typecheck` if Plan 001 landed) |
| Build      | `npm run build`      | exit 0                           |
| Unit tests | `npm test`           | `26 passed, 0 failed`            |
| Lint       | `npm run lint`       | exit 0                           |

## Scope

**In scope** (the only files you should modify):
- `src/index.ts`
- `docs/technical-guide.md` (one short addition)

**Out of scope** (do NOT touch):
- `src/utils/UsageStats.ts` — `toJSON()` already does what's needed.
- `src/registration.ts` — recording is already wired via `createLogger(stats)`.
- The `/health` response shape — external monitors may depend on it; do not
  fold stats into `/health`.
- Authentication/middleware — unauthenticated is the documented convention
  for debug endpoints here.

## Git workflow

- Branch: `advisor/003-expose-usage-stats`
- Commit style: `feat(telemetry): expose usage stats via GET /debug/stats (#326 follow-up)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the endpoint

In `src/index.ts`, directly after the `/debug/memory` route (after line 232),
add:

```ts
// Per-tool usage counters (#326). Same convention as /debug/memory:
// unauthenticated operational signal — tool names, counts, latencies only.
app.get("/debug/stats", (_req: express.Request, res: express.Response) => {
  res.json(usageStats?.toJSON() ?? { error: "usage stats not initialized" });
});
```

**Verify**: `npx tsc --noEmit` → exit 0.

### Step 2: Add the startup log line

In the `app.listen` callback, after the `Memory:` line, add:

```ts
console.error(`  Stats:        GET  /debug/stats`);
```

**Verify**: `npm run build` → exit 0.

### Step 3: Smoke-test locally (conditional on local DB)

Only if `data/iconclass.db` exists: run `PORT=3100 node dist/index.js` in the
background, wait for the `listening` log line (the embedding model load can
take ~10-30 s on first run), then:

```
curl -s http://localhost:3100/debug/stats
```

**Verify**: HTTP 200 with JSON containing `"since"`, `"tools"`, `"daily"`
keys (tools may be `{}` if no calls were made). Then stop the server
(SIGINT). If `data/iconclass.db` is absent, skip this step and say so in
your report — typecheck + build + Step 4 still gate the change.

### Step 4: Document the endpoint

In `docs/technical-guide.md`, find where `/debug/memory` is documented and
add a parallel entry for `GET /debug/stats`: one or two sentences — returns
per-tool call/error/latency counters since `since`; backed by
`USAGE_STATS_PATH` (flushed hourly + on shutdown); same unauthenticated
convention as `/debug/memory`. Match the surrounding formatting (table row
or heading — whichever the file uses for `/debug/memory`).

**Verify**: `grep -n "debug/stats" docs/technical-guide.md` → at least one match.

## Test plan

- No new automated test file: the integration suites (`test-tools.mjs`) run
  over stdio where this HTTP route doesn't exist, and `test-http-concurrency.mjs`
  targets `/mcp`. The smoke test in Step 3 is the behavioural check.
- Existing gates: `npm test` (26 unit tests) must stay green — this plan
  shouldn't affect them at all; if they fail, your change leaked further
  than intended.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm run build && npm test` exits 0, 26 passed
- [ ] `npm run lint` exits 0
- [ ] `grep -n '"/debug/stats"' src/index.ts` → one match (the route)
- [ ] `grep -n "debug/stats" docs/technical-guide.md` → ≥1 match
- [ ] `git status` shows only `src/index.ts` and `docs/technical-guide.md` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/index.ts` no longer matches the "Current state" excerpts (e.g. a
  `/debug/stats` or stats-in-`/health` already exists — the feature may have
  been built since planning).
- `usageStats` is no longer a module-scope variable accessible from the
  route handler scope.
- The smoke test returns anything other than 200 + the expected JSON shape
  after one fix attempt.

## Maintenance notes

- If the operator later wants stats to survive redeploys, that's an env
  change (`USAGE_STATS_PATH` → Railway volume path), not a code change —
  already documented in `docs/technical-guide.md` and CLAUDE.md.
- If a dashboard ever consumes this endpoint, freeze the `StatsData` shape
  or version it; today it's an internal debugging shape.
- Deliberately deferred: auth, rate limiting, and folding stats into
  `/health` (monitors depend on the current `/health` shape).
