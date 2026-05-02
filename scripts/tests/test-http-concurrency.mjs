/**
 * Smoke test: HTTP mode handles concurrent /mcp POSTs without
 * "Already connected to a transport" or cross-request interference.
 *
 * Regression for review-issues/01-shared-mcp-server-http-concurrency.md.
 *
 * Run:  node scripts/tests/test-http-concurrency.mjs
 * Requires: npm run build, data/iconclass.db present
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = process.env.TEST_PORT ?? "31337";
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

// ── Boot HTTP server ────────────────────────────────────────────

const child = spawn("node", ["dist/index.js"], {
  cwd: PROJECT_DIR,
  env: { ...process.env, PORT, STRUCTURED_CONTENT: "true" },
  stdio: ["ignore", "inherit", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  const s = chunk.toString();
  stderr += s;
  process.stderr.write(s);
});

// Wait for "listening" line in stderr or 10s timeout
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server didn't start within 10s")), 10_000);
  const check = () => {
    if (stderr.includes("listening on http://")) { clearTimeout(t); resolve(); }
  };
  child.stderr.on("data", check);
  check();
});

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
  // Fire N sessions in parallel — each does its own initialize + tool call.
  // With the old shared-server bug, overlapping requests would race
  // server.connect() / transport.close() and produce errors.
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
    !stderr.includes("Already connected to a transport"),
    "no 'Already connected to a transport' errors in server logs"
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
