import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Project root: this file is src/utils/UsageStats.ts, so ../.. from its dir.
// Kept self-contained (db.ts keeps its own PROJECT_ROOT private) so this util
// can be dropped in without touching other modules.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ToolStats {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

interface DailyStats {
  calls: number;
  errors: number;
}

export interface StatsData {
  since: string;
  lastUpdated: string;
  tools: Record<string, ToolStats>;
  daily: Record<string, DailyStats>;
}

/**
 * Persistent per-tool call/error/latency counters. Ported from
 * rijksmuseum-mcp-plus (#326), lean variant — no slow-query histograms.
 *
 * record() is O(1) in-memory; the file is flushed hourly (and on shutdown) via
 * an atomic temp+rename. Default path is data/usage-stats.json, which is
 * clobbered on every redeploy — set USAGE_STATS_PATH to a Railway volume path
 * to survive restarts.
 */
export class UsageStats {
  private data: StatsData;
  private dirty = false;
  private readonly filePath: string;
  private readonly timer: NodeJS.Timeout;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.USAGE_STATS_PATH ??
      path.join(PROJECT_ROOT, "data", "usage-stats.json");

    this.data = this.load();

    // Flush every hour; .unref() so it won't keep the process alive.
    this.timer = setInterval(() => this.flush(), 3_600_000);
    this.timer.unref();
  }

  /** Record a single tool call. No I/O — just updates memory + dirty flag. */
  record(tool: string, ms: number, ok: boolean): void {
    const now = new Date().toISOString();

    const t = this.data.tools[tool] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    t.calls++;
    if (!ok) t.errors++;
    t.totalMs += ms;
    if (ms > t.maxMs) t.maxMs = ms;

    const day = now.slice(0, 10);
    const d = this.data.daily[day] ??= { calls: 0, errors: 0 };
    d.calls++;
    if (!ok) d.errors++;

    this.data.lastUpdated = now;
    this.dirty = true;
  }

  /** Write to disk if there are pending changes. Sync write (<1 KB file). */
  flush(): void {
    if (!this.dirty) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      console.error("[UsageStats] flush failed:", err);
    }
  }

  /** Return current stats snapshot (for potential /health enrichment). */
  toJSON(): StatsData {
    return this.data;
  }

  private load(): StatsData {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.since === "string" && parsed.tools && parsed.daily) {
        return parsed as StatsData;
      }
    } catch {
      // Missing or corrupt — start fresh.
    }
    const now = new Date().toISOString();
    return { since: now, lastUpdated: now, tools: {}, daily: {} };
  }
}
