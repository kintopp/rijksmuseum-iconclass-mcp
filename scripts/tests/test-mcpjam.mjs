/**
 * MCPJam SDK tests for the Iconclass MCP server.
 *
 * Two layers:
 *   1. Unit tests — call tools directly via MCPClientManager (no LLM)
 *   2. E2E tests  — LLM picks tools via TestAgent + EvalTest
 *
 * Run:  node scripts/tests/test-mcpjam.mjs
 * Requires: npm run build, data/iconclass.db present, ANTHROPIC_API_KEY set
 */
import { MCPClientManager, TestAgent, EvalSuite, EvalTest, matchToolCalls } from "@mcpjam/sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Setup ───────────────────────────────────────────────────────

const serverConfig = {
  command: "node",
  args: [path.join(PROJECT_DIR, "dist/index.js")],
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
};

const manager = new MCPClientManager({}, { lazyConnect: true });
await manager.connectToServer("iconclass", serverConfig);

const tools = await manager.listTools("iconclass");
console.log("Connected. Tools:", tools.tools.map(t => t.name).join(", "));

// ── Unit tests (no LLM) ────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

/** Extract structured data from executeTool result. */
function parse(r) {
  if (r.structuredContent) return r.structuredContent;
  return JSON.parse(r.content[0].text);
}

section("Unit: search tool");
{
  const r = await manager.executeTool("iconclass", "search", { query: "crucifixion" });
  const data = parse(r);
  assert(data.totalResults > 0, `search 'crucifixion' returns results (got ${data.totalResults})`);
  assert(data.results.some(e => e.notation.startsWith("73D")), "results include 73D (Passion of Christ)");
}

section("Unit: browse tool");
{
  const r = await manager.executeTool("iconclass", "browse", { notation: "71" });
  const data = parse(r);
  assert(data.notation === "71", "browse returns notation 71");
  assert(data.entry.text.length > 0, "entry has text label");
  assert(data.subtree.length > 0, `subtree has children (got ${data.subtree.length})`);
}

section("Unit: resolve tool");
{
  const r = await manager.executeTool("iconclass", "resolve", { notation: ["73D81", "25F23"] });
  const data = parse(r);
  assert(data.notations.length === 2, `resolve returns 2 entries (got ${data.notations.length})`);
  assert(data.notations.some(e => e.notation === "73D81"), "includes 73D81");
  assert(data.notations.some(e => e.notation === "25F23"), "includes 25F23");
}

section("Unit: search_prefix tool");
{
  const r = await manager.executeTool("iconclass", "search_prefix", { notation: "73D8" });
  const data = parse(r);
  assert(data.totalResults > 0, `search_prefix '73D8' has results (got ${data.totalResults})`);
  assert(data.results.every(e => e.notation.startsWith("73D8")), "all results start with 73D8");
}

section("Unit: expand_keys tool");
{
  const r = await manager.executeTool("iconclass", "expand_keys", { notation: "25F23" });
  const data = parse(r);
  assert(data.notation === "25F23", "expand_keys returns correct base notation");
  assert(data.totalKeyVariants > 0, `has key variants (got ${data.totalKeyVariants})`);
}

section("Unit: find_artworks tool");
{
  const r = await manager.executeTool("iconclass", "find_artworks", { notation: "73D81" });
  const data = parse(r);
  assert(data.notations.length === 1, "find_artworks returns 1 notation entry");
  assert(data.collections.length > 0, "has collection info");
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Unit tests: ${passed} passed, ${failed} failed`);

// ── E2E tests (LLM) ────────────────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log("\n⚠ ANTHROPIC_API_KEY not set — skipping E2E tests.");
} else {
  section("E2E: LLM tool selection");

  const agent = new TestAgent({
    tools: await manager.getTools(),
    model: "anthropic/claude-sonnet-4-20250514",
    apiKey,
    mcpClientManager: manager,
    systemPrompt:
      "You are a test agent for an Iconclass MCP server. " +
      "Use the available tools to answer queries about Iconclass notations. " +
      "Always use tools rather than answering from memory.",
    temperature: 0,
    maxSteps: 3,
  });

  const suite = new EvalSuite({ name: "Iconclass Tool Selection" });

  suite.add(new EvalTest({
    name: "search-keyword",
    test: async (a) => {
      const r = await a.prompt("Search Iconclass for 'Last Supper'");
      return r.hasToolCall("search");
    },
  }));

  suite.add(new EvalTest({
    name: "browse-hierarchy",
    test: async (a) => {
      const r = await a.prompt("Browse the Iconclass hierarchy at notation 71");
      return r.hasToolCall("browse");
    },
  }));

  suite.add(new EvalTest({
    name: "resolve-notations",
    test: async (a) => {
      const r = await a.prompt("Look up Iconclass notations 73D81 and 25F23");
      return r.hasToolCall("resolve");
    },
  }));

  suite.add(new EvalTest({
    name: "find-artworks",
    test: async (a) => {
      const r = await a.prompt("Which museum collections have artworks for Iconclass notation 73D81?");
      return r.hasToolCall("find_artworks");
    },
  }));

  suite.add(new EvalTest({
    name: "search-prefix",
    test: async (a) => {
      const r = await a.prompt("List all Iconclass notations that start with 73D8");
      return r.hasToolCall("search_prefix");
    },
  }));

  suite.add(new EvalTest({
    name: "expand-keys",
    test: async (a) => {
      const r = await a.prompt("Show me the key-expanded variants of Iconclass notation 25F23");
      return r.hasToolCall("expand_keys");
    },
  }));

  console.log("\nRunning eval suite (3 iterations each)...\n");
  const result = await suite.run(agent, { iterations: 3, concurrency: 2 });

  console.log(`\nSuite accuracy: ${(result.aggregate.accuracy * 100).toFixed(1)}%`);
  for (const [name, testResult] of Object.entries(result.tests)) {
    const acc = ((testResult.successes / testResult.iterations) * 100).toFixed(0);
    console.log(`  ${acc === "100" ? "✓" : "✗"} ${name}: ${acc}% (${testResult.successes}/${testResult.iterations})`);
  }
}

// ── Cleanup ─────────────────────────────────────────────────────

await manager.disconnectServer("iconclass");

if (failed > 0) {
  console.log(`\nFailed tests:\n${failures.map(f => `  • ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nDone.");
