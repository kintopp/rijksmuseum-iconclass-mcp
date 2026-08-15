/**
 * Shared HTTP-server boot for the no-framework test scripts in this dir
 * (test-http-concurrency.mjs, test-modern-wire.mjs).
 *
 * Owns the readiness sentinel in one place: it is the startup line from
 * src/index.ts, so a change there breaks boot detection for every suite at
 * once — silently, as a full-timeout hang — if each script keeps its own copy.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const READY_SENTINEL = "listening on http://";

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
