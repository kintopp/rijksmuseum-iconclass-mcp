/**
 * Smoke test: HTTP mode handles concurrent /mcp POSTs without
 * "Already connected to a transport" or cross-request interference — each
 * request must get its own server instance.
 *
 * Run:  node scripts/tests/test-http-concurrency.mjs
 * Requires: npm run build (runs on the fixture DB)
 */
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
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
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

report();
