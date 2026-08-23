// ─── Structured logging ──────────────────────────────────────────────
//
// Every line goes to stderr, never stdout: in stdio mode stdout carries the MCP
// JSON-RPC stream and any write there corrupts the protocol. Do not "fix" these
// to console.log.
//
// Each line is a single-line JSON object carrying an explicit `level`. Railway
// parses that field; without it, everything on stderr defaults to level=error
// and `railway logs --filter "@level:error"` returns every successful startup
// line alongside the real failures. Fields beyond `message` become queryable
// attributes (`@tool:`, `@ms:>500`), so prefer a constant `message` plus fields
// over interpolating variable data into the message.
//
// Three consumers substring-match `message`; keep these fragments intact:
//   * scripts/analyse-railway-logs.py — every entry in its STARTUP_PATTERNS
//   * scripts/tests/_server.mjs — "listening on http://"
//   * scripts/test-wake-timing.mjs — "Background warmup complete"

type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

/**
 * `cause` is unpacked into `error`/`stack` so a stack survives on one line and
 * stays filterable instead of being flattened into prose. `fields` is spread
 * last, so it must not carry a `level` or `message` key of its own.
 */
export function log(level: LogLevel, message: string, cause?: unknown, fields?: LogFields): void {
  const line: LogFields = { level, message, ...fields };
  if (cause !== undefined) {
    line.error = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof Error && cause.stack) line.stack = cause.stack;
  }
  console.error(JSON.stringify(line));
}

export function logInfo(message: string, fields?: LogFields): void {
  log("info", message, undefined, fields);
}

/** Degraded-but-running: an optional subsystem failed and was skipped. */
export function logWarn(message: string, cause?: unknown): void {
  log("warn", message, cause);
}

/** Something the operator must act on. */
export function logError(message: string, cause?: unknown): void {
  log("error", message, cause);
}
