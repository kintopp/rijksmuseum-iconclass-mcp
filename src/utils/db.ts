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

/** Escape a multi-word value as individual AND-ed FTS5 terms.
 *  Returns null if fewer than 2 words remain after stripping. */
export function escapeFts5Terms(value: string): string | null {
  const words = value.replace(/[.*^():{}[\]\\"/]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  return words.map(w => `"${w}"`).join(" AND ");
}

/** Build the ArtResearch.net resource URL for a notation. The notation is a
 *  path segment inside a `uri=` query-param value that is itself a URL, so it is
 *  percent-encoded twice. encodeURIComponent handles ':' '+' and friends but
 *  leaves '(' ')' alone, so those are encoded explicitly in the first pass. */
export function artResearchUrl(notation: string): string {
  const once = encodeURIComponent(notation).replace(
    /[()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  const twice = encodeURIComponent(once);
  return `https://artresearch.net/resource/?uri=http%3A%2F%2Ficonclass.org%2F${twice}`;
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

/** Timeout per download operation (single file or individual chunk). */
const DOWNLOAD_TIMEOUT_MS = 330_000;

export interface DbSpec {
  name: string;
  pathEnvVar: string;
  urlEnvVar: string;
  defaultFile: string;
  /** SQL query that must succeed for the DB to be considered valid. */
  validationQuery: string;
  /** When true, re-download from urlEnvVar on every startup even if the local file passes validation.
   *  Use for small rolling-release sidecars whose content changes without a schema bump.
   *  The existing local file is preserved if the download or post-download validation fails. */
  refreshOnStartup?: boolean;
}

function resolveDbPathForSpec(spec: DbSpec): string {
  return process.env[spec.pathEnvVar] || path.join(PROJECT_ROOT, "data", spec.defaultFile);
}

/** Generate the two-letter suffix that `split -b` produces for index i (0→aa, 1→ab, …). */
function chunkSuffix(i: number): string {
  return String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
}

/** Fetch a single URL to a writable path, with timeout. */
async function fetchToFile(url: string, destPath: string, flags: "w" | "a" = "w"): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    await pipeline(res.body, fs.createWriteStream(destPath, { flags }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try downloading a URL as split chunks (.part-aa, .part-ab, …).
 * Returns true if chunks were found and downloaded, false if no chunks exist.
 * Downloaded chunks are reassembled into `assembledPath` and decompressed to `destPath` if gzip.
 */
async function tryChunkedDownload(baseUrl: string, destPath: string, assembledPath: string, isGzip: boolean): Promise<boolean> {
  let chunkCount = 0;

  for (let i = 0; ; i++) {
    const partUrl = `${baseUrl}.part-${chunkSuffix(i)}`;
    try {
      await fetchToFile(partUrl, assembledPath, i === 0 ? "w" : "a");
      chunkCount++;
      console.error(`  chunk ${chunkCount} (${chunkSuffix(i)}) ✓`);
    } catch {
      if (i === 0) return false; // no chunks exist
      break; // end of chunk sequence
    }
  }

  console.error(`  ${chunkCount} chunks downloaded, decompressing...`);
  if (isGzip) {
    await pipeline(fs.createReadStream(assembledPath), createGunzip(), fs.createWriteStream(destPath));
    fs.unlinkSync(assembledPath);
  } else {
    fs.renameSync(assembledPath, destPath);
  }
  return true;
}

/**
 * Ensure a SQLite database exists and passes validation.
 * Downloads from the URL env var if missing or invalid.
 * Supports both single-file and chunked (.part-aa/ab/…) release assets.
 */
export async function ensureDb(spec: DbSpec): Promise<void> {
  const dbPath = resolveDbPathForSpec(spec);
  const url = process.env[spec.urlEnvVar];
  const shouldRefresh = !!spec.refreshOnStartup && !!url;

  if (!shouldRefresh && fs.existsSync(dbPath)) {
    try {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare(spec.validationQuery).get();
      db.close();
      if (!row) throw new Error("validation query returned no rows");
      return;
    } catch {
      console.error(`${spec.name} DB invalid or outdated — will re-download`);
    }
  }

  if (!url) return;

  console.error(shouldRefresh ? `Refreshing ${spec.name} DB from ${spec.urlEnvVar}...` : `Downloading ${spec.name} DB...`);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = dbPath + ".tmp";
  const gzTmpPath = tmpPath + ".gz";
  try {
    const isGzip = url.endsWith(".gz");

    // Try chunked download first (split-for-release.sh assets), fall back to single file
    const chunked = await tryChunkedDownload(url, tmpPath, gzTmpPath, isGzip);
    if (!chunked) {
      console.error("  single-file download...");
      await fetchToFile(url, isGzip ? gzTmpPath : tmpPath);
      if (isGzip) {
        await pipeline(fs.createReadStream(gzTmpPath), createGunzip(), fs.createWriteStream(tmpPath));
        fs.unlinkSync(gzTmpPath);
      }
    }

    // Validate the downloaded file before swapping it in. Protects against corrupt
    // downloads or schema-incompatible builds replacing a working local DB.
    const { default: Database } = await import("better-sqlite3");
    const newDb = new Database(tmpPath, { readonly: true });
    try {
      const row = newDb.prepare(spec.validationQuery).get();
      if (!row) throw new Error("validation query returned no rows on downloaded file");
    } finally {
      newDb.close();
    }

    fs.renameSync(tmpPath, dbPath);
    console.error(`${spec.name} DB ready: ${dbPath}`);
  } catch (err) {
    console.error(`Failed to download ${spec.name} DB: ${err instanceof Error ? err.message : err}`);
    for (const f of [tmpPath, gzTmpPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}
