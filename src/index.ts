#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import compression from "compression";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingModel, DEFAULT_MODEL_ID } from "./api/EmbeddingModel.js";
import { ensureDb, type DbSpec } from "./utils/db.js";
import { registerTools } from "./registration.js";

const SERVER_NAME = "rijksmuseum-iconclass-mcp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
const SERVER_VERSION: string = pkg.version;

// ─── Determine transport mode ────────────────────────────────────────

function shouldUseHttp(): boolean {
  return process.argv.includes("--http") || !!process.env.PORT;
}

function getHttpPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
}

// ─── Database spec ──────────────────────────────────────────────────

const ICONCLASS_DB_SPEC: DbSpec = {
  name: "Iconclass",
  pathEnvVar: "ICONCLASS_DB_PATH",
  urlEnvVar: "ICONCLASS_DB_URL",
  defaultFile: "iconclass.db",
  validationQuery: "SELECT 1 FROM notations LIMIT 1",
};

const COUNTS_DB_SPEC: DbSpec = {
  name: "Counts",
  pathEnvVar: "COUNTS_DB_PATH",
  urlEnvVar: "COUNTS_DB_URL",
  defaultFile: "iconclass-counts.db",
  validationQuery: "SELECT 1 FROM version_info WHERE key = 'schema_version' AND CAST(value AS INTEGER) >= 3",
};

// ─── Shared instances ───────────────────────────────────────────────

let iconclassDb: IconclassDb | null = null;
let embeddingModel: EmbeddingModel | null = null;

async function initDatabase(): Promise<void> {
  await ensureDb(ICONCLASS_DB_SPEC);
  await ensureDb(COUNTS_DB_SPEC);
  iconclassDb = new IconclassDb();

  if (iconclassDb.embeddingsAvailable) {
    embeddingModel = new EmbeddingModel();
    const modelId = process.env.EMBEDDING_MODEL_ID ?? DEFAULT_MODEL_ID;
    const targetDim = iconclassDb.embeddingDimensions;
    await embeddingModel.init(modelId, targetDim);
  }
}

// ─── Create a configured McpServer ──────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, logging: {} },
      instructions:
        "Iconclass subject classification explorer — a hierarchical taxonomy for art subjects " +
        "covering 1.3 million notations across 13 languages.\n\n" +

        "Six tools for discovery and navigation:\n" +
        "• search — keyword (FTS) or semantic concept search across labels and keywords\n" +
        "• browse — navigate the hierarchy: entry + children + cross-references + key variants\n" +
        "• resolve — batch lookup of specific notation codes (up to 25)\n" +
        "• expand_keys — list all key-expanded variants of a base notation\n" +
        "• search_prefix — find all notations under a hierarchy subtree (e.g. '73D8' = Passion of Christ)\n" +
        "• find_artworks — see which collections have artworks for given notations, with links\n\n" +

        "Notations are hierarchical and encode left-to-right: broader → narrower. " +
        "A parent notation covers all its descendants. " +
        "Key expansions add modifiers in parentheses (e.g. 25F23(+46) = beasts of prey, sleeping).\n\n" +

        "Collection presence shows which loaded collections have artworks for each notation. " +
        "Use collectionId to filter results to a specific collection.\n\n" +

        "Workflow: search/browse here to find notation codes, then pass them to a collection server's " +
        "search_artwork(iconclass=...) for artworks matching that subject.",
    }
  );

  if (iconclassDb?.available) {
    registerTools(server, iconclassDb, embeddingModel);
  }

  return server;
}

// ─── Stdio mode ─────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  await initDatabase();
  if (!iconclassDb?.available) {
    console.error("FATAL: Iconclass DB is not available — cannot register tools. Exiting.");
    process.exit(1);
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

// ─── HTTP mode ──────────────────────────────────────────────────────

let httpServer: import("node:http").Server | undefined;

async function runHttp(): Promise<void> {
  await initDatabase();
  if (!iconclassDb?.available) {
    console.error("FATAL: Iconclass DB is not available — cannot register tools. Exiting.");
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
  app.use(express.json());

  // ── MCP endpoint (stateless — no sessions, no SSE streams) ─────
  //
  // Server is reused across requests; only the transport is per-request.
  // transport.close() resets the server so the next connect() succeeds.

  const server = createServer();

  // 30s safety net — respond 504 before Railway's proxy kills the connection silently
  app.use("/mcp", (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setTimeout(30_000, () => {
      if (!res.headersSent) {
        res.status(504).json({ error: "Request timeout" });
      }
    });
    next();
  });

  app.post("/mcp", async (req: express.Request, res: express.Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      await transport.close();
    } catch (err) {
      console.error("MCP endpoint error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

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
      notations: iconclassDb?.available ? "loaded" : "unavailable",
      embeddings: iconclassDb?.embeddingsAvailable ? "loaded" : "unavailable",
      collections: iconclassDb?.collections.map(c => c.collectionId) ?? [],
      countsDb: iconclassDb?.countsDbVersion ?? null,
    });
  });

  // ── Start ──────────────────────────────────────────────────────

  httpServer = app.listen(port, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://localhost:${port}`);
    console.error(`  MCP endpoint: POST /mcp`);
    console.error(`  Health:       GET  /health`);
  });
}

// ─── Graceful shutdown ──────────────────────────────────────────────

function shutdown() {
  console.error("Shutting down...");
  if (httpServer) {
    httpServer.close(() => {
      console.error("All connections closed.");
      process.exit(0);
    });
    // Force exit after 5s if connections don't drain
    setTimeout(() => {
      console.error("Forcing shutdown after timeout.");
      process.exit(1);
    }, 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Entry point ────────────────────────────────────────────────────

if (shouldUseHttp()) {
  runHttp().catch((err) => {
    console.error("Failed to start HTTP server:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Failed to start stdio server:", err);
    process.exit(1);
  });
}
