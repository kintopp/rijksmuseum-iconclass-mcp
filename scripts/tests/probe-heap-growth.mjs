/**
 * Manual probe: does the HTTP server's JS heap grow with request count?
 *
 * Boots dist/index.js in HTTP mode on the real DB, fires batches of mixed
 * tool calls (one fresh client per call, like stateless production traffic),
 * logs /debug/memory after each batch, and writes heap snapshots before and
 * after (SIGUSR2 → --heapsnapshot-signal) for scripts/tests/diff-heap-snapshots.mjs.
 *
 * Variants isolate traffic shapes the default run lacks:
 *   --modern       2026-07-28 wire (raw fetch + envelope) instead of the v1 legacy client
 *   --unique       distinct query text per call, so input-keyed caches can grow
 *   --abort <p>    cancel fraction p of calls 0-50 ms in (modern wire), mid-handler
 *
 * Run:  node scripts/tests/probe-heap-growth.mjs [--batches 5] [--per-batch 200] [--out <dir>]
 *         [--modern] [--unique] [--abort 0.3]
 * Requires: npm run build, data/iconclass.db, embedding model in HF cache
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const BATCHES = Number(arg("batches", 5));
const PER_BATCH = Number(arg("per-batch", 200));
const OUT = path.resolve(arg("out", path.join(PROJECT_DIR, "heap-probe")));
const PORT = Number(arg("port", 31399));
const BASE = `http://127.0.0.1:${PORT}`;
const MODERN = process.argv.includes("--modern");
const UNIQUE = process.argv.includes("--unique");
const ABORT = Number(arg("abort", 0));
mkdirSync(OUT, { recursive: true });

const WORDS = ["lion", "dog", "ship", "angel", "saint", "horse", "tree", "battle", "virgin", "fruit",
  "king", "musician", "river", "skull", "bird", "crown", "sword", "mountain", "child", "feast"];
const NOTATIONS = ["73D6", "31A33", "25F23", "11F", "41A", "46C", "25G3", "71H", "92D", "48C"];
const callFor = (i) => {
  const w = WORDS[i % WORDS.length], w2 = WORDS[(i * 7 + 3) % WORDS.length];
  // Base-26 letters, not digits: FTS still sees a word, the tokenizer a new string.
  const tag = UNIQUE ? " " + i.toString(26).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 26))) : "";
  const n = NOTATIONS[i % NOTATIONS.length];
  switch (i % 6) {
    case 0: return { name: "search", arguments: { query: w + tag } };
    case 1: return { name: "search", arguments: { semanticQuery: `${w} with a ${w2}${tag}` } };
    case 2: return { name: "resolve", arguments: { notation: [n], lang: "en" } };
    case 3: return { name: "browse", arguments: { notation: n } };
    case 4: return { name: "search_prefix", arguments: { notation: n.slice(0, 3) } };
    default: return { name: "expand_keys", arguments: { notation: "25F23" } };
  }
};

const child = spawn("node", ["--heapsnapshot-signal=SIGUSR2", `--diagnostic-dir=${OUT}`, "dist/index.js"], {
  cwd: PROJECT_DIR,
  env: { ...process.env, PORT: String(PORT), STRUCTURED_CONTENT: "true" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString(); });
const stop = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}\n${stderr.slice(-2000)}`);
    await sleep(250);
  }
}

async function modernCall(i, signal) {
  const { name, arguments: args } = callFor(i);
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: i, method: "tools/call",
      params: {
        name, arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: `probe-${i}`, version: "0.1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = JSON.parse(await res.text());
  if (body.error || body.result?.isError) throw new Error(`${name}: ${JSON.stringify(body).slice(0, 200)}`);
}

let aborted = 0;
async function call(i) {
  if (ABORT > 0 && i >= 12 && Math.random() < ABORT) {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), Math.random() * 50);
    try { await modernCall(i, ac.signal); } catch (e) { if (e.name !== "AbortError") throw e; aborted++; }
    return;
  }
  if (MODERN) return modernCall(i);
  const client = new Client({ name: `probe-${i}`, version: "0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  try {
    const r = await client.callTool(callFor(i));
    if (r.isError) throw new Error(`${callFor(i).name}: ${JSON.stringify(r.content).slice(0, 200)}`);
  } finally {
    await client.close();
  }
}

async function mem() {
  const m = await (await fetch(`${BASE}/debug/memory`)).json();
  const mb = (b) => (b / 1048576).toFixed(0);
  return `rss=${mb(m.process.rssBytes)} heapUsed=${mb(m.process.heapUsedBytes)} heapTotal=${mb(m.process.heapTotalBytes)} ext=${mb(m.process.externalBytes)} MB`;
}

async function snapshot(label) {
  const before = new Set(readdirSync(OUT));
  child.kill("SIGUSR2");
  let file;
  await waitFor(async () => {
    file = readdirSync(OUT).find((f) => f.endsWith(".heapsnapshot") && !before.has(f));
    if (!file) return false;
    // Snapshot is complete once /debug/memory answers again (writing blocks the loop).
    try { await fetch(`${BASE}/health`); return true; } catch { return false; }
  }, 300_000, `snapshot ${label}`);
  console.log(`snapshot ${label}: ${path.join(OUT, file)}`);
}

try {
  await waitFor(async () => stderr.includes("listening on http://"), 120_000, "listen");
  // Semantic search needs the model; the first semantic call waits for its load.
  for (let i = 0; i < 12; i++) await call(i);
  console.log(`warm        ${await mem()}`);
  await snapshot("A");
  console.log(`after snapA ${await mem()}`);

  let n = 12;
  for (let b = 1; b <= BATCHES; b++) {
    const t0 = Date.now();
    for (let k = 0; k < PER_BATCH; k++) await call(n++);
    console.log(`batch ${b} (${n} calls${ABORT > 0 ? `, ${aborted} aborted` : ""}, ${((Date.now() - t0) / 1000).toFixed(1)}s) ${await mem()}`);
  }
  await snapshot("B");
  console.log(`after snapB ${await mem()}`);
} finally {
  stop();
}
