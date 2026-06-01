#!/usr/bin/env node
/**
 * probe-extensions-prod.mjs — confirm whether the extensions sidecar is live
 * on a deployed server by actually calling `search(include_extensions:true)`
 * and inspecting the response, rather than trusting /health.
 *
 * Usage: node scripts/tests/probe-extensions-prod.mjs [--url URL]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://rijksmuseum-iconclass-mcp-production.up.railway.app/mcp";

const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "ext-probe", version: "1.0.0" });
await client.connect(transport);
console.log(`Connected to ${url}\n`);

const res = await client.callTool({
  name: "search",
  arguments: { query: "Mary Magdalene", include_extensions: true, maxResults: 5 },
});

const sc = res.structuredContent;
console.log("isError:", res.isError ?? false);
console.log("structuredContent present:", sc !== undefined);
if (sc) {
  console.log("has 'extensions' key:", Object.prototype.hasOwnProperty.call(sc, "extensions"));
  console.log("extensions count:", Array.isArray(sc.extensions) ? sc.extensions.length : "(no array)");
  if (Array.isArray(sc.extensions) && sc.extensions.length) {
    console.log("first extension hit:", JSON.stringify(sc.extensions[0], null, 2));
  }
  console.log("base results count:", Array.isArray(sc.results) ? sc.results.length : "(none)");
}
// Text content carries an "Extensions (N):" block when the sidecar is attached.
const text = res.content?.find?.((c) => c.type === "text")?.text ?? "";
const m = text.match(/Extensions \((\d+)\):/);
console.log("text mentions Extensions block:", m ? `yes (${m[1]})` : "no");

await client.close();

const attached = sc && Object.prototype.hasOwnProperty.call(sc, "extensions");
console.log(`\nVERDICT: extensions sidecar is ${attached ? "ATTACHED" : "NOT attached"} on this server.`);
process.exit(0);
