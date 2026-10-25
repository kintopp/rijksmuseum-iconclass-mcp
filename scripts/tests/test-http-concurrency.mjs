/**
 * Smoke test: HTTP mode handles concurrent /mcp POSTs without
 * "Already connected to a transport" or cross-request interference — each
 * request must get its own server instance. Also covers /debug/memory's
 * leak-tracking fields (#427): `heapAfterMajorGc` stays null if the GC
 * observer never fires or filters the wrong GC kind; `cgroup` is null on Linux
 * if memory.stat parsing breaks, or garbage off Linux.
 *
 * Run:  node scripts/tests/test-http-concurrency.mjs
 * Requires: npm run build (runs on the fixture DB)
 */
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { assert, report } from "./_assert.mjs";
import { bootHttpServer } from "./_server.mjs";
import { fixtureEnv } from "./fixture-client.mjs";

const PORT = process.env.TEST_PORT ?? "31337";

// ── Boot HTTP server ────────────────────────────────────────────

const server = await bootHttpServer({ port: PORT, env: fixtureEnv("http") });
const MCP_URL = server.url;

console.log(`\nServer up on ${MCP_URL}\n`);

// ── Run concurrent client sessions ──────────────────────────────

async function runSession(i) {
  return runSessionAt(MCP_URL, i);
}

async function runSessionAt(url, i) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: `concurrent-${i}`, version: "0.1" });
  await client.connect(transport);
  const r = await client.callTool({
    name: "resolve",
    arguments: { notation: ["73D6"], lang: "en" },
  });
  await client.close();
  return r;
}

try {
  // Fire N sessions in parallel — each does its own initialize + tool call, so
  // overlapping requests would race a shared server's connect()/close().
  const N = 8;
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => runSession(i))
  );

  const ok = results.filter(r => r.status === "fulfilled" && !r.value.isError);
  const rejected = results.filter(r => r.status === "rejected");
  const toolErr = results.filter(r => r.status === "fulfilled" && r.value.isError);

  if (rejected.length) {
    for (const e of rejected) console.error("  rejected:", e.reason?.message ?? e.reason);
  }
  if (toolErr.length) {
    for (const e of toolErr) console.error("  tool error:", JSON.stringify(e.value));
  }

  assert(ok.length === N, `${N} concurrent sessions all succeeded (got ${ok.length}/${N})`);
  assert(
    !server.stderr().includes("Already connected to a transport"),
    "no 'Already connected to a transport' errors in server logs"
  );
} finally {
  await server.stop();
}

// ── /debug/memory leak-tracking fields ─────────────────────────
// --gc-global makes every GC a major one, so a few requests guarantee one.

const memServer = await bootHttpServer({
  port: String(Number(PORT) + 1),
  env: fixtureEnv("http-memory"),
  nodeArgs: ["--gc-global"],
});
try {
  for (let i = 0; i < 3; i++) await runSessionAt(memServer.url, i);
  const m = await (await fetch(memServer.url.replace(/\/mcp$/, "/debug/memory"))).json();

  const gc = m.heapAfterMajorGc;
  if (assert(gc !== null && typeof gc === "object", "heapAfterMajorGc is recorded after a major GC")) {
    assert(gc.usedBytes > 0, `heapAfterMajorGc.usedBytes > 0 (got ${gc.usedBytes})`);
    assert(!Number.isNaN(Date.parse(gc.at)), `heapAfterMajorGc.at is a timestamp (got ${gc.at})`);
  }

  if (process.platform === "linux" && fs.existsSync("/sys/fs/cgroup/memory.stat")) {
    const c = m.cgroup;
    if (assert(c !== null, "cgroup stats present on a cgroup-v2 Linux host")) {
      assert(c.anonBytes > 0, `cgroup.anonBytes > 0 (got ${c.anonBytes})`);
      assert(c.currentBytes === null || c.currentBytes >= c.anonBytes, `cgroup.currentBytes is null or >= anonBytes (${c.currentBytes} vs ${c.anonBytes})`);
    }
  } else {
    assert(m.cgroup === null, `cgroup is null without cgroup v2 (got ${JSON.stringify(m.cgroup)})`);
  }
} finally {
  await memServer.stop();
}

report();
