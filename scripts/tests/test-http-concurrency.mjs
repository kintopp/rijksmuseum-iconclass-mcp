/**
 * Smoke test: HTTP mode handles concurrent /mcp POSTs without
 * "Already connected to a transport" or cross-request interference — each
 * request must get its own server instance. Also covers /debug/memory's
 * leak-tracking fields (#427): `heapAfterMajorGc` stays null if the GC
 * observer never fires or filters the wrong GC kind; `cgroup` is null on Linux
 * if memory.stat parsing breaks, or garbage off Linux.
 *
 * Response framing and body limits around the SDK's toNodeHandler, failure
 * modes: a Content-Length forwarded beside a gzipped body truncates it; SSE
 * compressed or buffered, so a listen stream's first frame never arrives; a
 * body-less 202 that won't decode; express.json and the adapter disagreeing on
 * the size limit (the adapter alone sees non-JSON bodies); compressed request
 * bodies accepted again (they must stay off zlib); a body express.json rejects
 * answered in HTML, or its stack written to bare stderr, which Railway tags
 * level=error. The handler's own
 * maxRequestBodySize is an equivalent mutation: the adapter's bound applies
 * first and express.json has already checked parsed bodies.
 *
 * Run:  node scripts/tests/test-http-concurrency.mjs
 * Requires: npm run build (runs on the fixture DB)
 */
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { assert, assertEq, atest, section, report } from "./_assert.mjs";
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

// ── Framing and limits ──────────────────────────────────────────

/** Raw node:http, because fetch hides the wire: it decodes gzip and has no way to send a chosen Content-Length. */
function raw(url, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const wire = Buffer.concat(chunks);
        const gzipped = res.headers["content-encoding"] === "gzip";
        resolve({ status: res.statusCode, headers: res.headers, wire, text: (gzipped ? zlib.gunzipSync(wire) : wire).toString() });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const JSON_POST = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const MODERN = "2026-07-28";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "framing-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const modernHeaders = (method) => ({ ...JSON_POST, "mcp-protocol-version": MODERN, "mcp-method": method });
const modernBody = (method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: MODERN_META } });
const LIMIT = 100 * 1024;

const frameServer = await bootHttpServer({ port: String(Number(PORT) + 2), env: fixtureEnv("http-framing") });
try {
  const url = frameServer.url;

  section("Response framing behind compression");

  await atest("a large JSON response is gzipped whole", async () => {
    const r = await raw(url, {
      headers: { ...modernHeaders("tools/list"), "accept-encoding": "gzip" },
      body: modernBody("tools/list"),
    });
    assertEq(r.status, 200, "tools/list returns 200");
    assertEq(r.headers["content-encoding"], "gzip", "a response over the 1 KB threshold is compressed");
    assertEq(r.headers["content-length"], undefined, "no Content-Length describes the uncompressed size");
    assertEq(JSON.parse(r.text).result?.tools?.length, 6, "the gunzipped body is the complete tool list");
  });

  await atest("without Accept-Encoding the same response is plain and correctly framed", async () => {
    const r = await raw(url, { headers: modernHeaders("tools/list"), body: modernBody("tools/list") });
    assertEq(r.headers["content-encoding"], undefined, "not compressed");
    assertEq(JSON.parse(r.text).result?.tools?.length, 6, "the body is the complete tool list");
    if (r.headers["content-length"] !== undefined) {
      assertEq(Number(r.headers["content-length"]), r.wire.length, "a Content-Length matches the bytes sent");
    }
  });

  await atest("a small JSON response decodes with gzip accepted", async () => {
    const r = await raw(url, {
      headers: { ...modernHeaders("tools/list"), "mcp-protocol-version": "2099-01-01", "accept-encoding": "gzip" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
    });
    assertEq(r.status, 400, "an unsupported revision returns 400");
    assertEq(JSON.parse(r.text).error?.code, -32022, "the error body survives framing");
  });

  await atest("a legacy SSE response is not compressed", async () => {
    const r = await raw(url, {
      headers: { ...JSON_POST, "accept-encoding": "gzip" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    assertEq(r.status, 200, "legacy initialize returns 200");
    assert(String(r.headers["content-type"]).includes("text/event-stream"), "legacy initialize answers as SSE");
    assertEq(r.headers["content-encoding"], undefined, "SSE stays uncompressed");
    assert(r.text.includes('"protocolVersion":"2025-11-25"'), "the SSE frame carries the result");
  });

  await atest("a body-less 202 still decodes with gzip accepted", async () => {
    const r = await raw(url, {
      headers: { ...JSON_POST, "accept-encoding": "gzip", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assertEq(r.status, 202, "a legacy notification returns 202");
    assertEq(r.text, "", "the decoded body is empty");
  });

  await atest("a listen stream's first frame arrives unbuffered with gzip accepted", async () => {
    const first = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers: { ...modernHeaders("subscriptions/listen"), "accept-encoding": "gzip" } }, (res) => {
        res.once("data", (chunk) => {
          resolve({ encoding: res.headers["content-encoding"], frame: chunk.toString() });
          req.destroy();
        });
      });
      req.on("error", reject);
      req.end(modernBody("subscriptions/listen", { notifications: { toolsListChanged: true } }));
    });
    assertEq(first.encoding, undefined, "the stream is not compressed");
    assert(first.frame.includes("notifications/subscriptions/acknowledged"), "the acknowledgement arrives while the stream is open");
  });

  section("Request body limits");

  const paddedJson = (size) => {
    const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "" } } });
    return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "x".repeat(size - empty.length) } } });
  };
  const legacyJson = { ...JSON_POST, "mcp-protocol-version": "2025-11-25" };

  await atest("a JSON body at the limit is served, one byte over is 413", async () => {
    const at = await raw(url, { headers: legacyJson, body: paddedJson(LIMIT) });
    assertEq(at.status, 200, "a JSON body of exactly 100 KiB is served");
    const over = await raw(url, { headers: legacyJson, body: paddedJson(LIMIT + 1) });
    assertEq(over.status, 413, "a JSON body one byte over is refused");
    const err = JSON.parse(over.text);
    assertEq(err.error?.code, -32000, "the JSON 413 is a JSON-RPC error");
    assertEq(err.error?.message, `Payload Too Large: Request body must not exceed ${LIMIT} bytes`, "the JSON 413 names the limit, as the adapter's does");
  });

  await atest("a non-JSON body hits the same limit in the adapter", async () => {
    const at = await raw(url, { headers: { "content-type": "text/plain" }, body: "x".repeat(LIMIT) });
    assertEq(at.status, 415, "a text/plain body at the limit reaches the content-type check");
    assertEq(
      JSON.parse(at.text).error?.message,
      "Unsupported Media Type: Content-Type must be application/json",
      "the 415 says what's wrong"
    );
    const over = await raw(url, { headers: { "content-type": "text/plain" }, body: "x".repeat(LIMIT + 1) });
    assertEq(over.status, 413, "a text/plain body one byte over is refused");
    assertEq(
      JSON.parse(over.text).error?.message,
      `Payload Too Large: Request body must not exceed ${LIMIT} bytes`,
      "the 413 names the limit"
    );
  });

  await atest("a compressed request body is refused without inflating", async () => {
    const body = zlib.gzipSync(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const r = await raw(url, { headers: { ...legacyJson, "content-encoding": "gzip" }, body });
    assertEq(r.status, 415, "Content-Encoding on a JSON request returns 415");
    assertEq(
      JSON.parse(r.text).error?.message,
      "Unsupported Media Type: compressed or non-UTF-8 request bodies are not accepted",
      "the 415 says what's wrong"
    );
  });

  await atest("malformed JSON is a JSON-RPC parse error", async () => {
    const r = await raw(url, { headers: legacyJson, body: "{not json" });
    assertEq(r.status, 400, "malformed JSON returns 400");
    const err = JSON.parse(r.text);
    assertEq(err.error?.code, -32700, "the code is -32700 (parse error)");
    assertEq(err.error?.message, "Parse error: the request body is not valid JSON", "the message names the parse failure");
    assertEq(err.id, null, "the id is null, since the body couldn't be read");
  });

  await atest("rejected bodies log structured warnings, nothing bare", async () => {
    const lines = frameServer.stderr().split("\n").filter(Boolean);
    const bare = lines.filter((l) => {
      try { return typeof JSON.parse(l).level !== "string"; } catch { return true; }
    });
    assertEq(bare.join("\n").slice(0, 200), "", "every stderr line is JSON with a level");
    const warns = lines.filter((l) => l.includes('"message":"Rejected MCP request body"'));
    assertEq(warns.length, 3, "the 413, the 415 and the parse error each log one line");
    assert(warns.every((l) => JSON.parse(l).level === "warn"), "rejected input is logged at warn, not error");
    assert(warns.every((l) => !l.includes('"stack"')), "a rejected body logs no stack");
  });

  await atest("GET /mcp is 405 with Allow: POST", async () => {
    const r = await raw(url, { method: "GET", headers: { accept: "text/event-stream" } });
    assertEq(r.status, 405, "GET returns 405");
    assertEq(r.headers.allow, "POST", "Allow names POST");
  });
} finally {
  await frameServer.stop();
}

report();
