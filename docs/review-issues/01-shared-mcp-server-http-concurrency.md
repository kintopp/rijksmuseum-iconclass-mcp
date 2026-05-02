# Shared MCP Server Breaks Concurrent HTTP Requests

Priority: P1
Area: HTTP transport / MCP lifecycle
Source: `src/index.ts`

## Summary

HTTP mode creates one `McpServer` instance outside the request handler and reconnects that same server to a new `StreamableHTTPServerTransport` for every `POST /mcp` request.

The MCP SDK only allows one active transport per server instance. If two HTTP requests overlap, the second request can throw `Already connected to a transport`, or request cleanup can close/reset another in-flight request.

## Impact

Remote clients can see intermittent 500s, dropped responses, or failed parallel tool calls when multiple clients or one client with concurrent requests hits the HTTP endpoint.

This is especially risky for hosted usage, where Claude, warm-cache scripts, monitors, or multiple users can produce overlapping MCP requests.

## Affected Code

`src/index.ts`

The shared server is created once:

```ts
const server = createServer();
```

and reused inside the request handler:

```ts
await server.connect(transport);
await transport.handleRequest(req, res, req.body);
await transport.close();
```

## Reproduction

1. Run the HTTP server.
2. Send two overlapping `POST /mcp` requests that both require request processing.
3. Observe that the SDK rejects the second connection or that closing one transport interferes with another in-flight request.

The SDK’s `Protocol.connect()` guard rejects reconnecting a server while `_transport` is already set.

## Recommended Fix

Create a fresh `McpServer` for each stateless HTTP request while continuing to share the initialized `IconclassDb` and `EmbeddingModel` instances.

For example:

```ts
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    await transport.close();
    await server.close();
  }
});
```

Check the exact cleanup behavior to avoid double-close errors.

## Acceptance Criteria

- Each HTTP request gets its own `McpServer` and transport.
- The database and embedding model are still initialized once and shared read-only.
- Parallel `POST /mcp` requests no longer fail due to `Already connected`.
- Existing stdio mode behavior is unchanged.
- Integration or smoke coverage includes at least two concurrent HTTP tool calls.
