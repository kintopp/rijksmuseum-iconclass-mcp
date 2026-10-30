/**
 * Shared server boot and CLI runner for the no-framework test scripts in this
 * dir (test-http-concurrency.mjs, test-modern-wire.mjs, test-tools.mjs,
 * test-cli.mjs).
 *
 * Owns the readiness sentinels in one place: they are the startup lines from
 * src/index.ts, so a change there breaks boot detection for every suite at
 * once — silently, as a full-timeout hang — if each script keeps its own copy.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const READY_SENTINEL = "listening on http://";
const STDIO_READY_SENTINEL = "running on stdio";
// Longer than the server's own 5 s drain backstop.
const STOP_GRACE_MS = 8_000;

/**
 * Resolve once `sentinel` is in stderr; reject as soon as the child exits or fails
 * to spawn, rather than at the timeout. `tail()` is what a rejection reports.
 */
function waitForReady(child, readStderr, sentinel, timeoutMs, tail) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn't start within ${timeoutMs}ms${tail()}`)), timeoutMs);
    const check = () => {
      if (!readStderr().includes(sentinel)) return;
      clearTimeout(timer);
      child.stderr.off("data", check);
      child.off("close", onClose);
      resolve();
    };
    // "close", not "exit": it waits for stderr to drain, so the tail is complete.
    const onClose = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited during boot (${signal ?? `code ${code}`})${tail()}`));
    };
    child.stderr.on("data", check);
    child.on("close", onClose);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`server failed to spawn: ${err.message}`));
    });
    check();
  }).catch((err) => {
    // Without this the orphan keeps the 3.2 GB DB mmap and the port, so the
    // next run fails with EADDRINUSE.
    child.kill("SIGKILL");
    throw err;
  });
}

/** SIGTERM, then SIGKILL after `graceMs`. A child already dead resolves at once:
 *  its "exit" has fired, and waiting for it would leave the suite pending forever. */
function stopChild(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Spawn `dist/index.js` in HTTP mode and resolve once it is serving.
 * Returns a handle: `url`, `stderr()` for assertions on server logs, `signal()`, `stop()`.
 * `nodeArgs` go before the script; `echoStderr: false` keeps server logs out of
 * the caller's output (a failed boot then carries their tail instead).
 */
export async function bootHttpServer({ port, timeoutMs = 20_000, env = {}, nodeArgs = [], echoStderr = true } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, "dist/index.js"], {
    cwd: PROJECT_DIR,
    // PORT last: a caller's env is often a copy of process.env, with any PORT the shell has.
    env: { ...process.env, STRUCTURED_CONTENT: "true", ...env, PORT: String(port) },
    stdio: ["ignore", "inherit", "pipe"],
  });
  // A suite that throws before stop() would otherwise leave the server holding
  // the DB mmap and the port.
  const reap = () => child.kill("SIGKILL");
  process.once("exit", reap);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    const s = chunk.toString();
    stderr += s;
    // Mirror through, so a boot failure (e.g. missing DB → FATAL) is visible
    // instead of being swallowed behind "server didn't start".
    if (echoStderr) process.stderr.write(s);
  });

  await waitForReady(child, () => stderr, READY_SENTINEL, timeoutMs, () => (echoStderr ? "" : `\n${stderr.slice(-2000)}`));

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stderr: () => stderr,
    signal: (sig) => child.kill(sig),
    async stop({ graceMs = STOP_GRACE_MS } = {}) {
      process.off("exit", reap);
      await stopChild(child, graceMs);
    },
  };
}

/**
 * Run the icmcp CLI (scripts/cli.mjs) as a child and resolve when it exits, with
 * `{ code, stdout, stderr, args }`. stdin always ends, so a --stdin run can't hang.
 */
export function runCli(args, { input, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PROJECT_DIR, "scripts", "cli.mjs"), ...args],
      { cwd: PROJECT_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr, args }));
    child.stdin.end(input ?? "");
  });
}

/** A CLI run's stdout as JSONL rows. */
export const jsonlRows = (r) => r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));

/**
 * Spawn `dist/index.js` in stdio mode and resolve once it is serving.
 * Returns a handle: `request(msg)` resolves with the response matching
 * `msg.id`, `notify(msg)` writes without waiting, `stderr()`, `signal()`, `stop()`.
 */
export async function bootStdioServer({ timeoutMs = 30_000, env = {} } = {}) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: PROJECT_DIR,
    // PORT is cleared because any value puts the server in HTTP mode.
    env: { ...process.env, STRUCTURED_CONTENT: "true", ...env, PORT: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reap = () => child.kill("SIGKILL");
  process.once("exit", reap);

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const waiters = new Map();
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    let nl;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiters.get(msg.id);
      if (waiter) {
        waiters.delete(msg.id);
        waiter(msg);
      }
    }
  });

  await waitForReady(child, () => stderr, STDIO_READY_SENTINEL, timeoutMs, () => `\n${stderr.slice(-2000)}`);

  return {
    notify(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    request(msg, { timeoutMs: t = 15_000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(msg.id);
          reject(new Error(`no response to ${msg.method} (id ${msg.id}) within ${t}ms`));
        }, t);
        waiters.set(msg.id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        child.stdin.write(JSON.stringify(msg) + "\n");
      });
    },
    stderr: () => stderr,
    signal: (sig) => child.kill(sig),
    async stop({ graceMs = STOP_GRACE_MS } = {}) {
      process.off("exit", reap);
      await stopChild(child, graceMs);
    },
  };
}
