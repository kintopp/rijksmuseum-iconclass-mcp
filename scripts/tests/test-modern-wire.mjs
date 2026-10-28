/**
 * Coverage for the 2026-07-28 ("modern") MCP wire.
 *
 * The v1 client pinned in devDependencies caps at 2025-11-25, so test-tools.mjs
 * and warm-cache can only ever exercise the legacy handshake. claude.ai has
 * begun probing 2026-07-28 in production (a sibling server still on the v1 SDK
 * answers those probes with HTTP 400), so the modern path needs its own gate.
 * Everything here is raw fetch on purpose — do not "simplify" it by importing
 * the SDK client, which is exactly what cannot reach this wire.
 *
 * The modern wire has no initialize handshake. Each request carries:
 *   - MCP-Protocol-Version + Mcp-Method headers (Mcp-Name too, for tools/call)
 *   - a params._meta envelope with protocolVersion, clientInfo, clientCapabilities
 * Header and body must agree; the server rejects any disagreement.
 *
 * stdio has no header layer, so there the opening message alone picks the
 * era for the whole connection (section 8). A legacy `initialize` pins
 * 2025-11-25; a modern-enveloped request pins 2026-07-28.
 *
 * Run:  node scripts/tests/test-modern-wire.mjs
 * Requires: npm run build (runs on the fixture DB, so semantic search is off; the
 * embedding path over HTTP is covered in test-tools.mjs)
 */
import { assert, assertEq, section, atest, report } from "./_assert.mjs";
import { bootHttpServer, bootStdioServer } from "./_server.mjs";
import { fixtureEnv } from "./fixture-client.mjs";

const PORT = process.env.TEST_PORT ?? "31338";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

/** The per-request envelope every modern-wire request must carry. */
const envelope = (version = MODERN) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "modern-wire-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

const server = await bootHttpServer({ port: PORT, env: fixtureEnv("modern-http") });
const MCP_URL = server.url;

console.log(`\nServer up on ${MCP_URL}`);

// ── Wire helpers ────────────────────────────────────────────────

/** Both wires are accepted here: modern answers as JSON, legacy as an SSE frame. */
function parseBody(text) {
  try {
    return JSON.parse(text.replace(/^event:.*\ndata: /m, ""));
  } catch {
    return null;
  }
}

async function post(headers, body) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, contentType: res.headers.get("content-type"), body: parseBody(await res.text()) };
}

// Well-formed modern requests: headers and envelope consistent with the body.
// The malformed variants in sections 4-5 build their own bodies inline, since
// the malformation is the thing under test.

const modernList = (version = MODERN) =>
  post(
    { "mcp-protocol-version": version, "mcp-method": "tools/list" },
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope(version) } }
  );

const modernCall = (name, args) =>
  post(
    { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name },
    {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args, _meta: envelope() },
    }
  );

const initialize = (version, headers = {}) =>
  post(headers, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });

// ── Tests ───────────────────────────────────────────────────────

try {
  section("1. Modern wire — tools/list");

  const list = await modernList();
  assertEq(list.status, 200, "tools/list over the 2026-07-28 wire returns HTTP 200");
  assertEq(list.contentType, "application/json", "modern wire answers as application/json (not SSE)");
  assertEq(list.body?.result?.tools?.length, 6, "all 6 tools are listed");
  assertEq(
    list.body?.result?.tools?.map((t) => t.name).sort().join(","),
    "browse,expand_keys,find_artworks,resolve,search,search_prefix",
    "tool names match the registered set"
  );
  assertEq(
    list.body?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name,
    "rijksmuseum-iconclass-mcp",
    "result _meta carries serverInfo (modern replacement for the handshake's serverInfo)"
  );
  assert(
    !JSON.stringify(list.body.result).includes("$ref"),
    "emitted schemas stay $ref-free on the modern wire (Claude Desktop constraint)"
  );
  assert(
    list.body.result.tools.every((t) => t.inputSchema && t.outputSchema),
    "every tool still emits both inputSchema and outputSchema"
  );

  section("2. Modern wire — tools/call");

  await atest("resolve returns content + structuredContent", async () => {
    const r = await modernCall("resolve", { notation: ["73D6"], lang: "en" });
    assertEq(r.status, 200, "resolve returns HTTP 200");
    assert(!r.body?.result?.isError, "resolve is not an error result");
    assertEq(r.body?.result?.content?.[0]?.type, "text", "resolve returns a text content block");
    assert(
      String(r.body?.result?.content?.[0]?.text ?? "").includes("73D6"),
      "resolve text mentions the requested notation"
    );
    assertEq(
      r.body?.result?.structuredContent?.notations?.[0]?.notation,
      "73D6",
      "structuredContent survives the modern encode seam"
    );
  });

  await atest("browse returns the hierarchy payload", async () => {
    const r = await modernCall("browse", { notation: "73D6", lang: "en" });
    assert(!r.body?.result?.isError, "browse is not an error result");
    assertEq(r.body?.result?.structuredContent?.notation, "73D6", "browse structuredContent.notation is correct");
    assert(
      Array.isArray(r.body?.result?.structuredContent?.entry?.path),
      "browse returns the ancestor path array"
    );
  });

  await atest("search (FTS) returns results", async () => {
    const r = await modernCall("search", { query: "crucifixion", maxResults: 3, lang: "en" });
    assert(!r.body?.result?.isError, "FTS search is not an error result");
    assert(r.body?.result?.structuredContent?.results?.length > 0, "FTS search returns at least one result");
  });

  await atest("a tool error comes back as an isError result, not a JSON-RPC error", async () => {
    const r = await modernCall("search", { semanticQuery: "ships on a stormy sea", maxResults: 3 });
    assertEq(r.body?.result?.isError, true, "semantic search without embeddings is an isError result");
    assertEq(
      r.body?.result?.content?.[0]?.text,
      "Semantic search requires embeddings and an embedding model (not available). Use query (keyword search) instead.",
      "the tool's error text is carried intact"
    );
  });

  await atest("strict Zod rejection still applies", async () => {
    const r = await modernCall("resolve", { notation: ["73D6"], bogusParam: true });
    assert(r.body?.result?.isError, "an unknown argument is rejected on the modern wire too");
    assert(
      String(r.body?.result?.content?.[0]?.text ?? "").includes("bogusParam"),
      "the rejection names the offending key"
    );
  });

  section("3. Modern wire — envelope validation");

  await atest("missing _meta is rejected", async () => {
    const r = await post(
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    );
    assertEq(r.status, 400, "missing _meta returns HTTP 400");
    assertEq(r.body?.error?.code, -32602, "missing _meta is -32602 (invalid params)");
    assert(
      r.body?.error?.data?.envelope?.missing?.includes("_meta"),
      "the error names _meta as the missing envelope key"
    );
  });

  await atest("missing protocolVersion inside _meta is rejected", async () => {
    const { "io.modelcontextprotocol/protocolVersion": _drop, ...partial } = envelope();
    const r = await post(
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: partial } }
    );
    assertEq(r.status, 400, "incomplete envelope returns HTTP 400");
    assert(
      r.body?.error?.data?.envelope?.missing?.includes("io.modelcontextprotocol/protocolVersion"),
      "the error names the missing protocolVersion envelope key"
    );
  });

  section("4. Modern wire — header/body agreement");

  await atest("absent Mcp-Method header is rejected", async () => {
    const r = await post(
      { "mcp-protocol-version": MODERN },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } }
    );
    assertEq(r.status, 400, "absent Mcp-Method returns HTTP 400");
    assertEq(r.body?.error?.code, -32020, "absent Mcp-Method is -32020 (header/body disagreement)");
  });

  await atest("Mcp-Method disagreeing with the body is rejected", async () => {
    const r = await post(
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/call" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } }
    );
    assertEq(r.status, 400, "mismatched Mcp-Method returns HTTP 400");
    assertEq(r.body?.error?.code, -32020, "mismatched Mcp-Method is -32020");
    assertEq(r.body?.error?.data?.mismatch?.header, "tools/call", "the error reports the header's claim");
  });

  await atest("absent Mcp-Name on tools/call is rejected", async () => {
    const r = await post(
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/call" },
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "resolve", arguments: { notation: ["73D6"] }, _meta: envelope() },
      }
    );
    assertEq(r.status, 400, "absent Mcp-Name returns HTTP 400");
    assertEq(r.body?.error?.code, -32020, "absent Mcp-Name is -32020");
  });

  await atest("a legacy initialize carrying a modern header is rejected", async () => {
    const r = await initialize(MODERN, { "mcp-protocol-version": MODERN });
    assertEq(r.status, 400, "mixing the legacy handshake with a modern header returns HTTP 400");
    assertEq(r.body?.error?.code, -32020, "the wire mix-up is -32020");
  });

  section("5. Modern wire — version negotiation");

  await atest("an unsupported future revision is refused with the supported list", async () => {
    const r = await modernList("2099-01-01");
    assertEq(r.status, 400, "an unknown revision returns HTTP 400");
    assertEq(r.body?.error?.code, -32022, "an unknown revision is -32022 (unsupported protocol version)");
    assert(
      r.body?.error?.data?.supported?.includes(MODERN),
      `the server advertises ${MODERN} as supported — the assertion that would fail on a v1 SDK`
    );
  });

  section("6. Modern wire — subscriptions/listen after a client disconnect");

  // A listen stream the client abandons must be torn down. If the disconnect
  // never reaches the SDK, the stream stays registered and its keep-alive
  // queues chunks forever (#427's heap leak); the observable symptom is the
  // SDK's per-handler cap (1024 open streams) refusing new subscriptions.
  const LISTEN_CAP = 1024;
  const listenAndDrop = async (id) => {
    const ac = new AbortController();
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id, method: "subscriptions/listen",
        params: { notifications: { toolsListChanged: true }, _meta: envelope() },
      }),
      signal: ac.signal,
    });
    const { value } = await res.body.getReader().read();
    ac.abort();
    return new TextDecoder().decode(value);
  };

  await atest(`a listen stream is still accepted after ${LISTEN_CAP} dropped ones`, async () => {
    const first = await listenAndDrop(1);
    if (!assert(first.includes("notifications/subscriptions/acknowledged"), "a listen stream is acknowledged")) return;
    for (let i = 2; i <= LISTEN_CAP; i++) await listenAndDrop(i);
    await new Promise((r) => setTimeout(r, 200));
    const next = await listenAndDrop(LISTEN_CAP + 1);
    assert(!next.includes("Subscription limit reached"), "dropped streams were released, so the cap is not hit");
    assert(next.includes("notifications/subscriptions/acknowledged"), "the next listen stream is acknowledged");
  });

  section("7. Legacy wire regression (the claude.ai path today)");

  await atest("the legacy handshake still negotiates 2025-11-25", async () => {
    const r = await initialize(LEGACY);
    assertEq(r.status, 200, "legacy initialize returns HTTP 200");
    assertEq(r.body?.result?.protocolVersion, LEGACY, "legacy initialize negotiates 2025-11-25");
    assert(
      String(r.contentType).includes("text/event-stream"),
      "legacy wire still answers as SSE (unchanged transport behaviour)"
    );
  });

  await atest("an older revision is still honoured", async () => {
    const r = await initialize("2025-06-18");
    assertEq(r.body?.result?.protocolVersion, "2025-06-18", "legacy initialize honours 2025-06-18");
  });

  await atest("legacy tools/list still works", async () => {
    const r = await post(
      { "mcp-protocol-version": LEGACY },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    );
    assertEq(r.body?.result?.tools?.length, 6, "legacy tools/list still returns 6 tools");
  });
} finally {
  await server.stop();
}

// ── stdio ───────────────────────────────────────────────────────

section("8. Modern wire over stdio (body-only era selection)");

const modern = await bootStdioServer({ env: fixtureEnv("modern-stdio") });
try {
  await atest("a modern server/discover pins the connection to 2026-07-28", async () => {
    const r = await modern.request({
      jsonrpc: "2.0", id: 1, method: "server/discover",
      params: { supportedVersions: [MODERN], _meta: envelope() },
    });
    assert(r.result?.supportedVersions?.includes(MODERN), `discover advertises ${MODERN}`);
    assertEq(r.result?.resultType, "complete", "discover carries the modern resultType");
    assertEq(
      r.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name,
      "rijksmuseum-iconclass-mcp",
      "serverInfo is relocated into _meta on the modern wire"
    );
  });

  await atest("tools/list over modern stdio returns the tool list", async () => {
    const r = await modern.request({
      jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope() },
    });
    assertEq(r.result?.tools?.length, 6, "modern stdio tools/list returns 6 tools");
  });

  await atest("tools/call over modern stdio returns structuredContent", async () => {
    const r = await modern.request({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "resolve", arguments: { notation: ["73D6"], lang: "en" }, _meta: envelope() },
    });
    assert(!r.result?.isError, "resolve is not an error result");
    assertEq(
      r.result?.structuredContent?.notations?.[0]?.notation,
      "73D6",
      "structuredContent survives the modern stdio encode seam"
    );
  });

  await atest("a legacy initialize on a modern-pinned connection is refused", async () => {
    const r = await modern.request({
      jsonrpc: "2.0", id: 4, method: "initialize",
      params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    assertEq(r.error?.code, -32022, "era is pinned per connection: legacy request is -32022");
    assert(r.error?.data?.supported?.includes(MODERN), "the refusal names the pinned revision");
  });
} finally {
  await modern.stop();
}

const legacy = await bootStdioServer({ env: fixtureEnv("legacy-stdio") });
try {
  await atest("a legacy initialize still pins the connection to 2025-11-25", async () => {
    const r = await legacy.request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    assertEq(r.result?.protocolVersion, LEGACY, "legacy stdio initialize negotiates 2025-11-25");
    legacy.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  await atest("legacy stdio tools/list still works", async () => {
    const r = await legacy.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assertEq(r.result?.tools?.length, 6, "legacy stdio tools/list still returns 6 tools");
  });
} finally {
  await legacy.stop();
}

report();
