/**
 * The test harness itself (_server.mjs, fixture-client.mjs): every suite's boot and
 * shutdown go through it, so a fault here looks like a hang or a server bug.
 *
 * Run:  node scripts/tests/test-harness.mjs   (in `npm test`; needs ./dist)
 *
 * Failure modes guarded:
 *  - a server that crashes at boot is reported only at the full timeout, or
 *    without the stderr that holds the diagnosis
 *  - stop() on a server that already died waits forever on an "exit" that has
 *    fired, so Node exits 13 and report() never prints its summary
 *  - stop() on a server that ignores SIGTERM never returns
 *  - PORT in the shell env puts a stdio server in HTTP mode, so it never answers
 *  - bootHttpServer loses its port
 */
import { assert, assertEq, atest, section, report } from "./_assert.mjs";
import { bootHttpServer, bootStdioServer } from "./_server.mjs";
import { connectFixtureClient, fixtureEnv } from "./fixture-client.mjs";

const PORT = 3196;
// Far below both boot timeouts (20 s, 30 s): reaching the bound means the crash was noticed.
const FAST_MS = 10_000;
// Node refuses to start, before any of our code runs.
const CRASH_ENV = { NODE_OPTIONS: "--not-a-real-node-flag" };

/** Pending stop() is the bug, and a pending promise alone lets Node exit 13 without a report. */
const settlesWithin = (promise, ms) => Promise.race([
  promise.then(() => true),
  new Promise((resolve) => { setTimeout(() => resolve(false), ms).unref(); }),
]);

const waitFor = async (condition, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

async function bootError(boot) {
  const t0 = Date.now();
  try {
    await boot();
    return { err: null, ms: Date.now() - t0 };
  } catch (err) {
    return { err, ms: Date.now() - t0 };
  }
}

// ══════════════════════════════════════════════════════════════════
section("a crash at boot is reported at once");

await atest("HTTP", async () => {
  const { err, ms } = await bootError(() => bootHttpServer({ port: PORT, env: { ...fixtureEnv("harness"), ...CRASH_ENV }, echoStderr: false }));
  if (assert(err !== null, "HTTP: boot rejects")) {
    assert(ms < FAST_MS, `HTTP: rejected at once (${ms} ms)`);
    assert(err.message.includes("exited during boot"), `HTTP: says it exited (${err.message.slice(0, 80)})`);
    assert(err.message.includes("--not-a-real-node-flag"), "HTTP: carries the server's stderr");
  }
});

await atest("stdio", async () => {
  const { err, ms } = await bootError(() => bootStdioServer({ env: { ...fixtureEnv("harness"), ...CRASH_ENV } }));
  if (assert(err !== null, "stdio: boot rejects")) {
    assert(ms < FAST_MS, `stdio: rejected at once (${ms} ms)`);
    assert(err.message.includes("exited during boot"), `stdio: says it exited (${err.message.slice(0, 80)})`);
    assert(err.message.includes("--not-a-real-node-flag"), "stdio: carries the server's stderr");
  }
});

// ══════════════════════════════════════════════════════════════════
section("stop()");

await atest("stop() on a server that already died returns", async () => {
  const server = await bootHttpServer({ port: PORT, env: fixtureEnv("harness"), echoStderr: false });
  server.signal("SIGKILL");
  const dead = await waitFor(() => fetch(server.url.replace(/\/mcp$/, "/health")).then(() => false, () => true), 5_000);
  assert(dead, "the server is gone");
  assert(await settlesWithin(server.stop(), 2_000), "HTTP: stop() returns");
});

await atest("stop() on a dead stdio server returns", async () => {
  const server = await bootStdioServer({ env: fixtureEnv("harness") });
  server.signal("SIGKILL");
  await new Promise((r) => setTimeout(r, 200));
  assert(await settlesWithin(server.stop(), 2_000), "stdio: stop() returns");
});

await atest("stop() on a server that ignores SIGTERM escalates to SIGKILL", async () => {
  const server = await bootHttpServer({ port: PORT, env: fixtureEnv("harness"), echoStderr: false });
  // A stopped process holds SIGTERM pending; only SIGKILL ends it.
  server.signal("SIGSTOP");
  const stopped = await settlesWithin(server.stop({ graceMs: 200 }), 2_000);
  assert(stopped, "stop() returns after the grace period");
  // A failed check must not leave a frozen server holding the port for later runs.
  if (!stopped) server.signal("SIGKILL");
});

await atest("stop() on a healthy server still shuts it down cleanly", async () => {
  const server = await bootHttpServer({ port: PORT, env: fixtureEnv("harness"), echoStderr: false });
  assert(await settlesWithin(server.stop(), 7_000), "stop() returns");
  assert(server.stderr().includes("Shutting down"), "the server saw SIGTERM, not SIGKILL");
});

// ══════════════════════════════════════════════════════════════════
section("PORT in the shell env");

process.env.PORT = "3197";

await atest("connectFixtureClient answers on stdio", async () => {
  const client = await connectFixtureClient("harness");
  try {
    const { tools } = await client.listTools();
    assertEq(tools.length, 6, "the fixture client reaches all six tools");
  } finally {
    await client.close();
  }
});

await atest("bootStdioServer starts on stdio", async () => {
  const server = await bootStdioServer({ env: fixtureEnv("harness") });
  assert(server.stderr().includes("running on stdio"), "stdio mode, not HTTP");
  await server.stop();
});

await atest("bootHttpServer keeps its own port", async () => {
  const server = await bootHttpServer({ port: PORT, env: fixtureEnv("harness"), echoStderr: false });
  try {
    assertEq((await fetch(`http://127.0.0.1:${PORT}/health`)).status, 200, "HTTP mode on the requested port");
  } finally {
    await server.stop();
  }
});

report();
