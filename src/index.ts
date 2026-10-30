#!/usr/bin/env node
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express from "express";
import cors from "cors";
import compression from "compression";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { ensureDb, type DbSpec } from "./utils/db.js";
import { logInfo, logWarn, logError } from "./utils/log.js";
import { withResponseTimeout } from "./utils/responseTimeout.js";
import {
  captureMemorySnapshot,
  formatMemorySnapshotDetailed,
  startGcObserver,
  type DbHandle,
} from "./utils/MemoryStats.js";
import { registerTools } from "./registration.js";
import { UsageStats } from "./utils/UsageStats.js";

const SERVER_NAME = "rijksmuseum-iconclass-mcp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
const SERVER_VERSION: string = pkg.version;

function getGitCommit(): string {
  // Railway webhook deploys inject the SHA — no .git needed at runtime.
  if (process.env.RAILWAY_GIT_COMMIT_SHA) {
    return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  }
  // `railway up` / CLI deploys — read the hash baked into dist/ at build time.
  try {
    const commitFile = new URL("commit.txt", import.meta.url);
    return fs.readFileSync(commitFile, "utf-8").trim();
  } catch { /* no build artifact */ }
  // Local dev with git repo available.
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

const GIT_COMMIT = getGitCommit();

// ─── Determine transport mode ────────────────────────────────────────

function shouldUseHttp(): boolean {
  return process.argv.includes("--http") || !!process.env.PORT;
}

function getHttpPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
}

// Set by the CLI (scripts/cli.mjs): a one-shot keyword lookup shouldn't wait
// for the embedding model or the page warm-up. A semantic query loads the model.
const SKIP_STARTUP_WARM = process.env.MCP_SKIP_STARTUP_WARM === "1";

// ─── Database spec ──────────────────────────────────────────────────

const ICONCLASS_DB_SPEC: DbSpec = {
  name: "Iconclass",
  pathEnvVar: "ICONCLASS_DB_PATH",
  urlEnvVar: "ICONCLASS_DB_URL",
  defaultFile: "iconclass.db",
  validationQuery: "SELECT 1 FROM version_info WHERE key = 'schema_version' AND CAST(value AS INTEGER) >= 5",
};

const COUNTS_DB_SPEC: DbSpec = {
  name: "Counts",
  pathEnvVar: "COUNTS_DB_PATH",
  urlEnvVar: "COUNTS_DB_URL",
  defaultFile: "iconclass-counts.db",
  validationQuery: "SELECT 1 FROM version_info WHERE key = 'schema_version' AND CAST(value AS INTEGER) >= 3",
  refreshOnStartup: true,
};

// ─── Shared instances ───────────────────────────────────────────────

let iconclassDb: IconclassDb | null = null;
let embeddingModel: EmbeddingModel | null = null;
// Per-tool usage telemetry (#326). Module-scope singleton: createServer() runs
// per-request in HTTP mode, so this must NOT be created inside it.
let usageStats: UsageStats | undefined;

function buildMemoryDbHandles(): DbHandle[] {
  return [
    { name: "iconclass", schema: "main", filePath: iconclassDb?.dbPath ?? null, db: iconclassDb?.rawDb ?? null },
    { name: "counts", schema: "counts", filePath: iconclassDb?.countsDbPath ?? null, db: iconclassDb?.rawDb ?? null },
  ];
}

async function initDatabase(): Promise<void> {
  await ensureDb(ICONCLASS_DB_SPEC);
  await ensureDb(COUNTS_DB_SPEC);
  iconclassDb = new IconclassDb();

  if (iconclassDb.embeddingsAvailable) {
    embeddingModel = new EmbeddingModel();
    // KICK OFF the model load without awaiting it — the ~seconds-long ONNX
    // init must not gate app.listen() / a scale-to-zero wake. embed() awaits
    // this same load lazily (so the first semantic query after a wake waits,
    // within the /mcp 30s net), and runStdio() awaits whenReady() to keep
    // stdio startup eager. warmCorePages() likewise moves off the boot path.
    // Under SKIP_STARTUP_WARM (stdio only: HTTP's warmInBackground still loads
    // it right after listen) the first semantic query starts the load instead.
    if (!SKIP_STARTUP_WARM) embeddingModel.init();
  }

  // Per-tool usage telemetry (#326). Instantiated once here (both runStdio and
  // runHttp call initDatabase), shared read-only by every per-request server.
  usageStats = new UsageStats();
}

/** Non-blocking warm-up run AFTER the transport is serving: pages in the DB
 *  mmap regions and waits on the (already-kicked-off) model load, yielding to
 *  the event loop first so a concurrent /health or MCP `initialize` during a
 *  wake is never starved. Not awaited by HTTP mode. */
async function warmInBackground(): Promise<void> {
  const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  try {
    await yieldTick(); // let listen()'s callback + any queued wake requests flush first
    iconclassDb?.warmCorePages();
    await embeddingModel?.whenReady();
    logInfo("Background warmup complete");
    // One entry, not one per line: JSON-encoding collapses the multi-line
    // snapshot. Don't split it into a loop.
    logInfo(formatMemorySnapshotDetailed(captureMemorySnapshot(buildMemoryDbHandles())));
  } catch (err) {
    // Warm failure only costs latency on the first real query — the server serves.
    logWarn("Background warmup failed", err);
  }
}

// ─── Create a configured McpServer ──────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Iconclass subject classification explorer — a hierarchical taxonomy for art subjects " +
        "covering 1.3 million notations across 13 languages.\n\n" +

        "Notations are hierarchical and encode left-to-right: broader → narrower. " +
        "A parent notation covers all its descendants. " +
        "Key expansions add modifiers in parentheses (e.g. 25F23(+46) = beasts of prey, sleeping).\n\n" +

        "Collection presence shows which loaded collections have artworks for each notation. " +
        "Use collectionId to filter results to a specific collection.\n\n" +

        "Workflow: search/browse here to find notation codes, then pass them to a collection server's " +
        "search_artwork(iconclass=...) for artworks matching that subject; multiple codes are AND-combined.",
    }
  );

  if (iconclassDb?.available) {
    registerTools(server, iconclassDb, embeddingModel, usageStats);
  }

  return server;
}

// ─── Stdio mode ─────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  await initDatabase();
  if (!iconclassDb?.available) {
    logError("FATAL: Iconclass DB is not available — cannot register tools. Exiting.");
    process.exit(1);
  }
  // stdio has no wake/connect-race concern, so keep startup eager: finish the
  // model load (kicked off non-blocking in initDatabase) and warm before serving.
  if (!SKIP_STARTUP_WARM) {
    await embeddingModel?.whenReady();
    iconclassDb.warmCorePages();
  }
  // The factory is invoked once per connection; the opening exchange pins the
  // era (2025-era clients are served exactly as the hand-wired transport did).
  serveStdio(() => createServer(), {
    onerror: (err) => logError("transport error", err),
  });
  // The transport closes on stdin EOF but leaves the exit to the event loop, which
  // a model load in flight keeps alive; exit as soon as the client hangs up.
  process.stdin.once("end", shutdown);
  logInfo(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

// ─── HTTP mode ──────────────────────────────────────────────────────

let httpServer: import("node:http").Server | undefined;

const MAX_REQUEST_BODY_BYTES = 100 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;
const REJECTED_BODY: Record<number, { code: number; message: string }> = {
  400: { code: -32700, message: "Parse error: the request body is not valid JSON" },
  413: { code: -32000, message: `Payload Too Large: Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes` },
  415: { code: -32000, message: "Unsupported Media Type: compressed or non-UTF-8 request bodies are not accepted" },
};

async function runHttp(): Promise<void> {
  await initDatabase();
  if (!iconclassDb?.available) {
    logError("FATAL: Iconclass DB is not available — cannot register tools. Exiting.");
    process.exit(1);
  }
  const port = getHttpPort();
  const app = express();
  app.set("trust proxy", 1);

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  app.use(
    cors({
      origin: allowedOrigins ? allowedOrigins.split(",") : "*",
    })
  );
  app.use(compression({ threshold: 1024 })); // gzip responses >= 1 KB
  // inflate: false rejects Content-Encoding'd bodies (415): MCP clients never
  // compress requests, and it keeps zlib/Brotli decoding off attacker input.
  app.use(express.json({ inflate: false, limit: MAX_REQUEST_BODY_BYTES }));

  // ── MCP endpoint (stateless — no sessions) ─────────────────────
  //
  // createMcpHandler invokes the server factory per request, so a fresh
  // McpServer still backs every POST: the SDK enforces one transport per
  // server (Protocol.connect rejects re-binding), so a shared server breaks
  // under concurrent POSTs. The expensive state — IconclassDb and
  // EmbeddingModel — is initialized once in initDatabase() and shared
  // read-only via the closure captured by registerTools().
  //
  // 2026-era requests are served statelessly; 2025-era clients fall back to
  // the `sessionIdGenerator: undefined` idiom, so existing connectors keep
  // working unchanged.
  const mcpHandler = createMcpHandler(() => createServer(), {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Fires for rejected client requests as well as serving failures.
    onerror: (err) => logWarn("MCP handler error", err),
  });
  const handleMcp = toNodeHandler(withResponseTimeout(mcpHandler, RESPONSE_TIMEOUT_MS), {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: (err) => logError("MCP endpoint error", err),
  });

  app.post("/mcp", (req: express.Request, res: express.Response) => handleMcp(req, res, req.body));

  app.all("/mcp", (_req: express.Request, res: express.Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed — this server is stateless (POST only)" });
  });

  // ── Health check ───────────────────────────────────────────────

  app.get("/health", (_req: express.Request, res: express.Response) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      commit: GIT_COMMIT,
      notations: iconclassDb?.available ? "loaded" : "unavailable",
      embeddings: iconclassDb?.embeddingsAvailable ? "loaded" : "unavailable",
      collections: iconclassDb?.collections.map(c => c.collectionId) ?? [],
      countsDb: iconclassDb?.countsDbVersion ?? null,
    });
  });

  // ── Memory observability (issue #272) ──────────────────────────
  //
  // Startup logs a detailed snapshot; /debug/memory exposes the same shape
  // on demand. Unauthenticated to match /health — operational signal, not
  // sensitive.

  startGcObserver();
  app.get("/debug/memory", (_req: express.Request, res: express.Response) => {
    res.json(captureMemorySnapshot(buildMemoryDbHandles()));
  });

  // Per-tool usage counters (#326). Same convention as /debug/memory:
  // unauthenticated operational signal — tool names, counts, latencies only.
  app.get("/debug/stats", (_req: express.Request, res: express.Response) => {
    res.json(usageStats?.toJSON() ?? { error: "usage stats not initialized" });
  });

  // ── Rejected requests ──────────────────────────────────────────
  //
  // express.json() fails here. Express's default handler answers in HTML and
  // writes the stack to bare stderr, which Railway tags level=error.
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = err.status ?? 500;
    const rejection = REJECTED_BODY[status];
    if (rejection) logWarn("Rejected MCP request body", err.message);
    else logError("MCP request error", err);
    res.status(rejection ? status : 500).json({
      jsonrpc: "2.0",
      error: rejection ?? { code: -32603, message: "Internal server error" },
      id: null,
    });
  });

  // ── Start ──────────────────────────────────────────────────────

  httpServer = app.listen(port, () => {
    // scripts/tests/_server.mjs waits on the raw substring "listening on
    // http://" in stderr — keep it intact and on one line.
    logInfo(`${SERVER_NAME} v${SERVER_VERSION} listening on http://localhost:${port}`, {
      mcp: "POST /mcp",
      health: "GET /health",
      memory: "GET /debug/memory",
      stats: "GET /debug/stats",
    });
  });

  // Warm AFTER listen() so /health + the DB-free MCP `initialize` handshake
  // answer within ~node-boot time on a cold scale-to-zero wake, instead of
  // waiting on the e5-base model load + mmap warm. The model load was already
  // kicked off (non-blocking) in initDatabase(); this pages in the DB and logs
  // a post-warm memory snapshot.
  void warmInBackground();
}

// ─── Graceful shutdown ──────────────────────────────────────────────

function shutdown() {
  logInfo("Shutting down...");
  // Flush at exit, not here: calls still in flight finish during the drain (#326).
  const exit: () => never = () => {
    usageStats?.flush();
    process.exit(0);
  };
  if (!httpServer) exit();

  // Backstop: force exit before SIGKILL if a connection never closes. Exit 0 —
  // Railway reports any non-zero exit on redeploy as "Deploy Crashed".
  const forceExit = setTimeout(() => {
    logWarn("Drain timed out; forcing exit.");
    exit();
  }, 5000);
  forceExit.unref();

  httpServer.closeIdleConnections(); // release idle keep-alive sockets
  httpServer.close(() => {
    // wait only on in-flight requests
    clearTimeout(forceExit);
    logInfo("All connections closed.");
    exit();
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Entry point ────────────────────────────────────────────────────

if (shouldUseHttp()) {
  runHttp().catch((err) => {
    logError("Failed to start HTTP server", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    logError("Failed to start stdio server", err);
    process.exit(1);
  });
}
