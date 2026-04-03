/**
 * Cold-start benchmark: each measurement spawns a fresh MCP server process.
 * Mirrors the README performance table methodology.
 *
 * Usage: node scripts/tests/benchmark-cold-start.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function freshCall(toolName, args) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: PROJECT_DIR,
    env: { ...process.env, STRUCTURED_CONTENT: "true" },
  });
  const client = new Client({ name: "bench", version: "0.1" });
  await client.connect(transport);

  const t0 = performance.now();
  const result = await client.callTool({ name: toolName, arguments: args });
  const elapsed = performance.now() - t0;

  await client.close();
  return { elapsed, result };
}

function fmt(ms) { return ms.toFixed(0) + "ms"; }

console.log("Cold-start benchmark (fresh server per query)\n");
console.log("Operation                          Time     Notes");
console.log("─".repeat(65));

// FTS search — narrow
const fts1 = await freshCall("search", { query: "crucifixion", maxResults: 25 });
const fts1total = fts1.result.structuredContent?.totalResults ?? "?";
console.log(`FTS search (${fts1total} hits)`.padEnd(35) + fmt(fts1.elapsed).padStart(6) + `     "crucifixion"`);

// FTS search — medium
const fts2 = await freshCall("search", { query: "horse", maxResults: 25 });
const fts2total = fts2.result.structuredContent?.totalResults ?? "?";
console.log(`FTS search (${fts2total} hits)`.padEnd(35) + fmt(fts2.elapsed).padStart(6) + `     "horse"`);

// FTS search — broad
const fts3 = await freshCall("search", { query: "portrait", maxResults: 25 });
const fts3total = fts3.result.structuredContent?.totalResults ?? "?";
console.log(`FTS search (${fts3total} hits)`.padEnd(35) + fmt(fts3.elapsed).padStart(6) + `     "portrait"`);

// Semantic search
const sem = await freshCall("search", { semanticQuery: "domestic animals", maxResults: 25 });
console.log(`Semantic search`.padEnd(35) + fmt(sem.elapsed).padStart(6) + `     "domestic animals"`);

// Browse — no keys
const br1 = await freshCall("browse", { notation: "73D" });
console.log(`Browse`.padEnd(35) + fmt(br1.elapsed).padStart(6) + `     73D`);

// Browse — with key variants (default 25)
const br2 = await freshCall("browse", { notation: "25F23", includeKeys: true });
console.log(`Browse with key variants`.padEnd(35) + fmt(br2.elapsed).padStart(6) + `     25F23, default page of 25`);

// Resolve — batch of 15 (new default)
const res15 = await freshCall("resolve", {
  notation: ["73D6", "31A33", "25F23", "11H", "48C73", "92D", "73D82", "34B1", "25FF21", "46C1313", "9", "71B", "52D41", "23K", "41D"],
});
const resCount = res15.result.structuredContent?.notations?.length ?? "?";
console.log(`Resolve (batch of ${resCount})`.padEnd(35) + fmt(res15.elapsed).padStart(6) + `     15 notations with full metadata`);

// Resolve — batch of 10 (old default, for comparison)
const res10 = await freshCall("resolve", {
  notation: ["73D6", "31A33", "25F23", "11H", "48C73", "92D", "73D82", "34B1", "25FF21", "46C1313"],
});
console.log(`Resolve (batch of 10, comparison)`.padEnd(35) + fmt(res10.elapsed).padStart(6) + `     for comparison with old default`);

// Prefix search
const pfx = await freshCall("search_prefix", { notation: "73D8", maxResults: 25 });
console.log(`Prefix search`.padEnd(35) + fmt(pfx.elapsed).padStart(6) + `     "73D8"`);

console.log("\n✓ Done.\n");
