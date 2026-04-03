import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Escape a value for safe FTS5 phrase matching. Returns null if input is empty after stripping.
 *  Strips FTS5 operators and bracket characters; preserves hyphens (safe inside quoted phrases). */
export function escapeFts5(value: string): string | null {
  const cleaned = value.replace(/[.*^():{}[\]\\]/g, "").replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

/** Resolve a database path from environment variable or default data/ location.
 *  Returns null if the file doesn't exist at either location. */
export function resolveDbPath(envVarName: string, defaultFilename: string): string | null {
  const envPath = process.env[envVarName];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const defaultPath = path.join(PROJECT_ROOT, "data", defaultFilename);
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}

// ─── DB download helper ─────────────────────────────────────────────

export interface DbSpec {
  name: string;
  pathEnvVar: string;
  urlEnvVar: string;
  defaultFile: string;
  /** SQL query that must succeed for the DB to be considered valid. */
  validationQuery: string;
}

function resolveDbPathForSpec(spec: DbSpec): string {
  return process.env[spec.pathEnvVar] || path.join(PROJECT_ROOT, "data", spec.defaultFile);
}

/**
 * Ensure a SQLite database exists and passes validation.
 * Downloads from the URL env var if missing or invalid.
 */
export async function ensureDb(spec: DbSpec): Promise<void> {
  const dbPath = resolveDbPathForSpec(spec);

  if (fs.existsSync(dbPath)) {
    try {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      db.prepare(spec.validationQuery).get();
      db.close();
      return;
    } catch {
      console.error(`${spec.name} DB invalid or outdated — will re-download`);
    }
  }

  const url = process.env[spec.urlEnvVar];
  if (!url) return;

  console.error(`Downloading ${spec.name} DB...`);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = dbPath + ".tmp";
  const controller = new AbortController();
  const downloadTimer = setTimeout(() => controller.abort(), 330_000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const dest = fs.createWriteStream(tmpPath);
    const isGzip = url.endsWith(".gz") || res.headers.get("content-type")?.includes("gzip");

    if (isGzip) {
      await pipeline(res.body, createGunzip(), dest);
    } else {
      await pipeline(res.body, dest);
    }

    fs.renameSync(tmpPath, dbPath);
    console.error(`${spec.name} DB ready: ${dbPath}`);
  } catch (err) {
    console.error(`Failed to download ${spec.name} DB: ${err instanceof Error ? err.message : err}`);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } finally {
    clearTimeout(downloadTimer);
  }
}
