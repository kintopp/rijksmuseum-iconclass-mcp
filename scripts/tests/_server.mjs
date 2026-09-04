/**
 * Shared server boot for the no-framework test scripts in this dir
 * (test-http-concurrency.mjs, test-modern-wire.mjs).
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

/**
 * Spawn `dist/index.js` in HTTP mode and resolve once it is serving.
 * Returns a handle: `url`, `stderr()` for assertions on server logs, `stop()`.
 */
export async function bootHttpServer({ port, timeoutMs = 20_000, env = {} } = {}) {
  const child = spawn("node", ["dist/index.js"], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: String(port), STRUCTURED_CONTENT: "true", ...env },
    stdio: ["ignore", "inherit", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    const s = chunk.toString();
    stderr += s;
    // Mirror through, so a boot failure (e.g. missing DB → FATAL) is visible
    // instead of being swallowed behind "server didn't start".
    process.stderr.write(s);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server didn't start within ${timeoutMs}ms`)),
      timeoutMs
    );
    const check = () => {
      if (!stderr.includes(READY_SENTINEL)) return;
      clearTimeout(timer);
      child.stderr.off("data", check);
      resolve();
    };
    child.stderr.on("data", check);
    check();
  }).catch((err) => {
    // Without this the orphan keeps the 3.2 GB DB mmap and the port, so the
    // next run fails with EADDRINUSE.
    child.kill("SIGKILL");
    throw err;
  });

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stderr: () => stderr,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

/**
 * Spawn `dist/index.js` in stdio mode and resolve once it is serving.
 * Returns a handle: `request(msg)` resolves with the response matching
 * `msg.id`, `notify(msg)` writes without waiting, `stderr()`, `stop()`.
 */
export async function bootStdioServer({ timeoutMs = 30_000, env = {} } = {}) {
  const child = spawn("node", ["dist/index.js"], {
    cwd: PROJECT_DIR,
    env: { ...process.env, STRUCTURED_CONTENT: "true", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

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

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`stdio server didn't start within ${timeoutMs}ms`)),
      timeoutMs
    );
    const check = () => {
      if (!stderr.includes(STDIO_READY_SENTINEL)) return;
      clearTimeout(timer);
      child.stderr.off("data", check);
      resolve();
    };
    child.stderr.on("data", check);
    check();
  }).catch((err) => {
    child.kill("SIGKILL");
    throw err;
  });

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
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}
