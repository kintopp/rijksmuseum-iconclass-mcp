/**
 * Start dist/index.js over stdio on a freshly built fixture DB pair and return a
 * connected MCP client. Needs ./dist.
 *
 * `name` picks the fixture files; give each test file its own, because a build
 * deletes the files before seeding.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./build-fixture-db.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Server env for a fixture run. Exported so the HTTP boot helpers can reuse it. */
export function fixtureEnv(name) {
  const { mainPath, countsPath } = buildFixture(name);
  // resolveDbPath falls back to data/ when the env path is missing, which would
  // silently test the real DB.
  for (const p of [mainPath, countsPath]) {
    if (!fs.existsSync(p)) throw new Error(`fixture DB missing: ${p}`);
  }
  return {
    ...process.env,
    ICONCLASS_DB_PATH: mainPath,
    COUNTS_DB_PATH: countsPath,
    // A URL in the shell env would make ensureDb download over the fixture
    // (COUNTS_DB_SPEC refreshes on every start).
    ICONCLASS_DB_URL: "",
    COUNTS_DB_URL: "",
    USAGE_STATS_PATH: path.join(os.tmpdir(), `iconclass-fixture-${name}-${process.pid}-usage.json`),
    STRUCTURED_CONTENT: "true",
  };
}

export async function connectFixtureClient(name, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, "dist", "index.js")],
    cwd: PROJECT_ROOT,
    env: { ...fixtureEnv(name), ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: `test-${name}`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}
