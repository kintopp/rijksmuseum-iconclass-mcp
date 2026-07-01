import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { escapeFts5, escapeFts5Terms, resolveDbPath, artResearchUrl } from "../utils/db.js";

const require = createRequire(import.meta.url);

/** Escape SQL LIKE wildcards (%, _) and the escape char so notation chars
 *  like '.', ':', '-', '(', ')' and spaces pass through as literals.
 *  Paired with `LIKE ? ESCAPE '\'` in prepared statements. */
function escapeLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** True when a loaded embeddings table is trustworthy: the recorded expected
 *  count matches the actual row count, OR no expected count was recorded
 *  (older DBs predate the `embedding_count` metadata key — can't check, so we
 *  assume the table is complete). A mismatch means the build was interrupted
 *  and the table is partial. */
export function embeddingsCountConsistent(expected: number | null, actual: number): boolean {
  if (expected === null || Number.isNaN(expected)) return true;
  return expected === actual;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface CollectionInfo {
  collectionId: string;
  label: string;
  countsAsOf: string | null;
  totalNotations: number;
  searchUrlTemplate: string | null;
}

export interface IconclassEntry {
  notation: string;
  text: string;
  path: { notation: string; text: string }[];
  children: string[];
  refs: string[];
  keywords: string[];
  isKeyExpanded: boolean;
  baseNotation: string | null;
  keyId: string | null;
  collections: string[];
}

export interface IconclassSearchResult {
  query: string;
  totalResults: number;
  results: IconclassEntry[];
  collections: CollectionInfo[];
}

export interface SubtreeEntry extends IconclassEntry {
  depth: number;
  totalChildren: number;
  truncated: boolean;
}

export interface IconclassBrowseResult {
  notation: string;
  entry: IconclassEntry;
  subtree: SubtreeEntry[];
  keyVariants: IconclassEntry[];
  totalKeyVariants: number;
  collections: CollectionInfo[];
}

export interface IconclassSemanticResult {
  query: string;
  totalResults: number;
  results: (IconclassEntry & { similarity: number })[];
  collections: CollectionInfo[];
}

export interface IconclassPrefixResult {
  prefix: string;
  totalResults: number;
  results: IconclassEntry[];
  collections: CollectionInfo[];
}

export interface IconclassKeyExpansionResult {
  notation: string;
  baseEntry: IconclassEntry;
  keyVariants: IconclassEntry[];
  totalKeyVariants: number;
  collections: CollectionInfo[];
}

export interface ArtworkCollectionInfo {
  collectionId: string;
  label: string;
  count: number;
  url: string | null;
}

export interface CountsDbVersion {
  releaseTag: string;
  builtAt: string;
}

export interface FindArtworksResult {
  notations: {
    notation: string;
    text: string;
    collections: ArtworkCollectionInfo[];
    artResearchUrl: string;
  }[];
  collections: CollectionInfo[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function langFallbacks(lang: string): string[] {
  const langs = [lang];
  if (lang !== "en") langs.push("en");
  if (lang !== "nl") langs.push("nl");
  return langs;
}

// ─── IconclassDb ─────────────────────────────────────────────────────

export class IconclassDb {
  private db: DatabaseType | null = null;
  private dbPath_: string | null = null;
  private countsDbPath_: string | null = null;
  private _hasEmbeddings = false;
  private _embeddingDimensions = 0;
  private _collections: CollectionInfo[] = [];
  private _collectionsMap: Map<string, CollectionInfo> = new Map();
  private _countsDbVersion: CountsDbVersion | null = null;
  private stmtTextFts!: Statement;
  private stmtKwFts!: Statement;
  private stmtTextFtsScoped!: Statement;
  private stmtKwFtsScoped!: Statement;
  private stmtGetNotation!: Statement;
  private stmtGetText!: Statement;
  private stmtGetTextAny!: Statement;
  private stmtGetKeywords!: Statement;
  private stmtGetKeywordsAny!: Statement;
  private stmtPrefixSearch!: Statement;
  private stmtPrefixCount!: Statement;
  private stmtKeyVariantsPage!: Statement;
  private stmtKeyVariantsCount!: Statement;
  private stmtGetCollectionCounts: Statement | null = null;
  private stmtPresenceJoin: Statement | null = null;
  private stmtBatchInsert: Statement | null = null;
  private stmtDeleteBatch: Statement | null = null;
  private batchInsertAll: ((ns: string[]) => void) | null = null;
  private stmtQuantize: Statement | null = null;
  private stmtKnn: Statement | null = null;
  private stmtFilteredKnn: Statement | null = null;
  private stmtPrefixFilteredKnn: Statement | null = null;
  private stmtPrefixCollCount: Statement | null = null;
  private stmtPrefixCollPage: Statement | null = null;

  constructor() {
    const dbPath = resolveDbPath("ICONCLASS_DB_PATH", "iconclass.db");
    if (!dbPath) {
      console.error("Iconclass DB not found — all tools disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.dbPath_ = dbPath;
      this.db.pragma("mmap_size = 805306368"); // 768 MB — empirical working set is ~285 MB across observed query paths (issue #272). Note: SQLite caps mmap_size at SQLITE_MAX_MMAP_SIZE = 2 GB anyway.
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM notations").get() as { n: number }).n;

      const countsPath = resolveDbPath("COUNTS_DB_PATH", "iconclass-counts.db");
      if (countsPath) {
        try {
          // Bind the path as a parameter rather than interpolating it — a quote
          // in a valid filesystem path (e.g. /Volumes/O'Hara/…) would otherwise
          // produce invalid SQL and silently discard the sidecar. ATTACH is
          // read-only per SQLite, so this is permitted on the readonly handle.
          this.db.prepare("ATTACH DATABASE ? AS counts").run(countsPath);
          this.db.prepare("SELECT 1 FROM counts.collection_counts LIMIT 1").get();
          this.countsDbPath_ = countsPath;

          this.stmtGetCollectionCounts = this.db.prepare(
            "SELECT collection_id, count FROM counts.collection_counts WHERE notation = ?"
          );

          const rows = this.db.prepare(`
            SELECT ci.collection_id, ci.label, ci.counts_as_of, ci.search_url_template,
                   COUNT(n.notation) AS total_notations
            FROM counts.collection_info ci
            LEFT JOIN counts.collection_counts cc ON cc.collection_id = ci.collection_id
            LEFT JOIN notations n ON cc.notation = n.notation
            GROUP BY ci.collection_id
          `).all() as {
            collection_id: string; label: string; counts_as_of: string | null; total_notations: number; search_url_template: string | null;
          }[];
          this._collections = rows.map(r => ({
            collectionId: r.collection_id,
            label: r.label,
            countsAsOf: r.counts_as_of,
            totalNotations: r.total_notations,
            searchUrlTemplate: r.search_url_template,
          }));
          this._collectionsMap = new Map(this._collections.map(c => [c.collectionId, c]));

          // Read counts DB version metadata
          try {
            const versionRows = this.db.prepare(
              "SELECT key, value FROM counts.version_info"
            ).all() as { key: string; value: string }[];
            const vMap = new Map(versionRows.map(r => [r.key, r.value]));
            this._countsDbVersion = {
              releaseTag: vMap.get("release_tag") ?? "unknown",
              builtAt: vMap.get("built_at") ?? "unknown",
            };
          } catch { /* version_info may not exist in older DBs */ }

          // Pre-create temp table and cache statements used by fetchPresenceForSort
          this.db!.exec("CREATE TEMP TABLE IF NOT EXISTS _batch_notations (notation TEXT PRIMARY KEY)");
          this.stmtPresenceJoin = this.db!.prepare(`
            SELECT cc.notation, cc.collection_id
            FROM counts.collection_counts cc
            INNER JOIN _batch_notations bn ON cc.notation = bn.notation
          `);
          this.stmtBatchInsert = this.db!.prepare("INSERT OR IGNORE INTO _batch_notations VALUES (?)");
          this.stmtDeleteBatch = this.db!.prepare("DELETE FROM _batch_notations");
          this.batchInsertAll = this.db!.transaction((ns: string[]) => {
            for (const n of ns) this.stmtBatchInsert!.run(n);
          });

          // Prefix + collection filter: filter, sort, and paginate entirely in
          // SQL so a broad prefix never materializes ~200K notations in JS.
          this.stmtPrefixCollCount = this.db!.prepare(`
            SELECT COUNT(*) AS n
            FROM notations n
            INNER JOIN counts.collection_counts cc ON cc.notation = n.notation
            WHERE n.notation LIKE ? ESCAPE '\\' AND cc.collection_id = ?
          `);
          this.stmtPrefixCollPage = this.db!.prepare(`
            SELECT n.notation
            FROM notations n
            INNER JOIN counts.collection_counts cc ON cc.notation = n.notation
            WHERE n.notation LIKE ? ESCAPE '\\' AND cc.collection_id = ?
            ORDER BY n.notation
            LIMIT ? OFFSET ?
          `);

          console.error(`  Counts DB attached: ${countsPath} (${this._collections.length} collections, ${this._countsDbVersion?.releaseTag ?? "no tag"})`);
        } catch (err) {
          // Schema mismatch or missing tables — fully discard the sidecar so tools
          // don't expose stale/inconsistent collection data.
          this.stmtGetCollectionCounts = null;
          this.stmtPresenceJoin = null;
          this.stmtBatchInsert = null;
          this.stmtDeleteBatch = null;
          this.batchInsertAll = null;
          this.stmtPrefixCollCount = null;
          this.stmtPrefixCollPage = null;
          this._collections = [];
          this._collectionsMap = new Map();
          this._countsDbVersion = null;
          try { this.db!.exec("DETACH DATABASE counts"); } catch { /* already detached or never attached */ }
          console.error(`  Counts DB not available: ${err instanceof Error ? err.message : err}`);
        }
      }

      try {
        const dimRow = this.db.prepare(
          "SELECT value FROM version_info WHERE key = 'embedding_dimensions'"
        ).get() as { value: string } | undefined;
        this._embeddingDimensions = dimRow ? parseInt(dimRow.value, 10) : 768;

        this.db.prepare("SELECT 1 FROM iconclass_embeddings LIMIT 1").get();
        const sqliteVec = require("sqlite-vec");
        sqliteVec.load(this.db);

        this.stmtQuantize = this.db.prepare(
          "SELECT vec_quantize_int8(vec_normalize(?), 'unit') as v"
        );
        this.stmtKnn = this.db.prepare(`
          SELECT notation, distance FROM vec_iconclass
          WHERE embedding MATCH vec_int8(?) AND k = ?
          ORDER BY distance
        `);

        if (this.stmtGetCollectionCounts) {
          this.stmtFilteredKnn = this.db.prepare(`
            SELECT ie.notation,
                   vec_distance_cosine(vec_int8(ie.embedding), vec_int8(?)) as distance
            FROM iconclass_embeddings ie
            WHERE ie.notation IN (SELECT DISTINCT notation FROM counts.collection_counts)
            ORDER BY distance LIMIT ?
          `);
        }

        // Brute-force cosine over a prefix-restricted subset. The PK b-tree on
        // notations makes the LIKE scan cheap; replaces the registration.ts
        // overfetch loop that was paying multiple full-vec0 scans per scoped
        // semantic query (see #237 follow-up perf review).
        this.stmtPrefixFilteredKnn = this.db.prepare(`
          SELECT ie.notation,
                 vec_distance_cosine(vec_int8(ie.embedding), vec_int8(?)) as distance
          FROM iconclass_embeddings ie
          WHERE ie.notation LIKE ? ESCAPE '\\'
          ORDER BY distance LIMIT ?
        `);

        const embCount = (this.db.prepare("SELECT COUNT(*) as n FROM iconclass_embeddings").get() as { n: number }).n;
        const expectedRow = this.db.prepare(
          "SELECT value FROM version_info WHERE key = 'embedding_count'"
        ).get() as { value: string } | undefined;
        const expectedCount = expectedRow ? parseInt(expectedRow.value, 10) : null;

        if (!embeddingsCountConsistent(expectedCount, embCount)) {
          console.error(
            `  Iconclass embeddings INCOMPLETE: expected ${expectedCount}, found ${embCount.toLocaleString()} — ` +
            `disabling semantic search (likely an interrupted embedding build)`
          );
          this._hasEmbeddings = false;
        } else {
          this._hasEmbeddings = true;
          console.error(`  Iconclass embeddings: ${embCount.toLocaleString()} vectors (${this._embeddingDimensions}d)`);
        }
      } catch { /* no embeddings */ }

      // Text and keyword FTS share an identical shape; the scoped variants only
      // append a notation-prefix filter. Build all four from one template so the
      // SELECT/JOIN/GROUP BY can never drift between the scoped and unscoped copies.
      const ftsSql = (ftsTable: string, srcTable: string, alias: string, scoped: boolean) =>
        `SELECT ${alias}.notation, MIN(f.rank) as rank
         FROM ${ftsTable} f
         JOIN ${srcTable} ${alias} ON ${alias}.rowid = f.rowid
         WHERE ${ftsTable} MATCH ?${scoped ? `\n           AND ${alias}.notation LIKE ? ESCAPE '\\'` : ""}
         GROUP BY ${alias}.notation`;
      this.stmtTextFts = this.db.prepare(ftsSql("texts_fts", "texts", "t", false));
      this.stmtTextFtsScoped = this.db.prepare(ftsSql("texts_fts", "texts", "t", true));
      this.stmtKwFts = this.db.prepare(ftsSql("keywords_fts", "keywords", "k", false));
      this.stmtKwFtsScoped = this.db.prepare(ftsSql("keywords_fts", "keywords", "k", true));
      this.stmtGetNotation = this.db.prepare(
        "SELECT notation, path, children, refs, base_notation, key_id, is_key_expanded FROM notations WHERE notation = ?"
      );
      this.stmtGetText = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1"
      );
      this.stmtGetTextAny = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? LIMIT 1"
      );
      this.stmtGetKeywords = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? AND lang = ? LIMIT 40"
      );
      this.stmtGetKeywordsAny = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? LIMIT 40"
      );
      this.stmtPrefixSearch = this.db.prepare(
        "SELECT notation FROM notations WHERE notation LIKE ? ESCAPE '\\' ORDER BY notation LIMIT ? OFFSET ?"
      );
      this.stmtPrefixCount = this.db.prepare(
        "SELECT COUNT(*) as n FROM notations WHERE notation LIKE ? ESCAPE '\\'"
      );
      this.stmtKeyVariantsPage = this.db.prepare(
        "SELECT notation FROM notations WHERE base_notation = ? ORDER BY notation LIMIT ? OFFSET ?"
      );
      this.stmtKeyVariantsCount = this.db.prepare(
        "SELECT COUNT(*) as n FROM notations WHERE base_notation = ?"
      );

      console.error(`Iconclass DB loaded: ${dbPath} (${count.toLocaleString()} notations, ${this._collections.length} collection overlays)`);
    } catch (err) {
      console.error(`Failed to open Iconclass DB: ${err instanceof Error ? err.message : err}`);
      this.stmtGetCollectionCounts = null;
      this.stmtPresenceJoin = null;
      this.stmtBatchInsert = null;
      this.stmtPrefixCollCount = null;
      this.stmtPrefixCollPage = null;
      this._collections = [];
      this._collectionsMap = new Map();
      this._countsDbVersion = null;
      try { this.db?.exec("DETACH DATABASE counts"); } catch { /* ignore */ }
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  /** Page in critical mmap regions so the first user query is fast.
   *  Touches FTS5 indexes (texts + keywords), the notations PK b-tree,
   *  the texts/keywords leaf pages, the counts DB join path, and the
   *  vec0 vector index. Run once before app.listen() — Railway's
   *  healthcheck only flips healthy after listen, so the cold cost
   *  hits the deploy, not users. */
  warmCorePages(): void {
    if (!this.db) return;
    const t0 = Date.now();
    try {
      this.db.prepare("SELECT rowid FROM texts_fts WHERE texts_fts MATCH 'art' LIMIT 1").get();
      this.db.prepare("SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH 'figure' LIMIT 1").get();
      this.db.prepare("SELECT notation FROM notations LIMIT 1").get();
      this.db.prepare("SELECT text FROM texts WHERE notation = '1' AND lang = 'en' LIMIT 1").get();
      this.db.prepare("SELECT keyword FROM keywords WHERE notation = '11F' AND lang = 'en' LIMIT 1").get();
      if (this.stmtGetCollectionCounts) {
        this.stmtGetCollectionCounts.all("11F");
      }
      console.error(`  Iconclass DB core pages warmed in ${Date.now() - t0}ms`);

      if (this._hasEmbeddings && this.stmtQuantize && this.stmtKnn) {
        const t1 = Date.now();
        const zeros = new Float32Array(this._embeddingDimensions);
        const quantized = this.stmtQuantize.get(zeros) as { v: Buffer };
        this.stmtKnn.all(quantized.v, 1);
        if (this.stmtPrefixFilteredKnn) {
          this.stmtPrefixFilteredKnn.all(quantized.v, "11F%", 1);
        }
        console.error(`  Iconclass embeddings pages warmed in ${Date.now() - t1}ms`);
      }
    } catch (err) {
      console.error(`  Iconclass DB warmup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Resolved on-disk path of the iconclass DB (or null if unavailable). */
  get dbPath(): string | null {
    return this.dbPath_;
  }

  /** Resolved on-disk path of the attached counts DB (or null if not attached). */
  get countsDbPath(): string | null {
    return this.countsDbPath_;
  }

  /** Underlying better-sqlite3 handle for pragma queries (memory observability). */
  get rawDb(): DatabaseType | null {
    return this.db;
  }

  get embeddingsAvailable(): boolean {
    return this._hasEmbeddings;
  }

  get embeddingDimensions(): number {
    return this._embeddingDimensions;
  }

  get collections(): CollectionInfo[] {
    return this._collections;
  }

  get countsDbVersion(): CountsDbVersion | null {
    return this._countsDbVersion;
  }

  get hasKeyExpansion(): boolean {
    return this.db !== null;
  }

  // ─── Search (FTS) ─────────────────────────────────────────────────

  search(query: string, maxResults: number = 25, lang: string = "en", offset: number = 0, collectionId?: string, onlyWithArtworks: boolean = false, parentNotation?: string): IconclassSearchResult {
    const empty: IconclassSearchResult = { query, totalResults: 0, results: [], collections: this._collections };
    if (!this.db) return empty;

    const ftsPhrase = escapeFts5(query);
    if (!ftsPhrase) return empty;

    let rankMap = this.runFtsQueries(ftsPhrase, parentNotation);

    // Auto-fallback: if phrase match returns 0, retry with individual AND-ed terms
    if (rankMap.size === 0) {
      const ftsTerms = escapeFts5Terms(query);
      if (!ftsTerms) return empty;
      rankMap = this.runFtsQueries(ftsTerms, parentNotation);
    }

    if (rankMap.size === 0) return empty;

    const presenceCache = new Map<string, Set<string>>();
    const countedNotations = this.fetchPresenceForSort([...rankMap.keys()], presenceCache, collectionId, onlyWithArtworks);

    countedNotations.sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      // Within same coverage tier, sort by FTS rank (lower = more relevant)
      const rankA = rankMap.get(a.notation) ?? 0;
      const rankB = rankMap.get(b.notation) ?? 0;
      if (rankA !== rankB) return rankA - rankB;
      return a.notation.localeCompare(b.notation);
    });

    const totalResults = countedNotations.length;
    const page = countedNotations.slice(offset, offset + maxResults);

    const textCache = new Map<string, string | null>();
    const results = page
      .map(({ notation }) => this.resolveEntry(notation, lang, textCache, presenceCache))
      .filter((e): e is IconclassEntry => e !== null);

    return { query, totalResults, results, collections: this._collections };
  }

  // ─── Browse ───────────────────────────────────────────────────────

  private static readonly MAX_CHILDREN_PER_PARENT = 25;
  private static readonly MAX_SUBTREE_ENTRIES = 250;

  browse(
    notation: string,
    lang: string = "en",
    includeKeys: boolean = false,
    maxKeyVariants: number = 25,
    keyOffset: number = 0,
    depth: number = 1,
  ): IconclassBrowseResult | null {
    if (!this.db) return null;

    const textCache = new Map<string, string | null>();
    const entry = this.resolveEntry(notation, lang, textCache);
    if (!entry) return null;

    const subtree: SubtreeEntry[] = [];
    this.collectSubtree(entry.children, lang, 1, depth, textCache, subtree);

    let keyVariants: IconclassEntry[] = [];
    let totalKeyVariants = 0;
    if (includeKeys && !entry.isKeyExpanded) {
      totalKeyVariants = (this.stmtKeyVariantsCount.get(notation) as { n: number }).n;
      keyVariants = this.resolveKeyVariantsPage(notation, lang, maxKeyVariants, keyOffset, textCache);
    }

    return { notation, entry, subtree, keyVariants, totalKeyVariants, collections: this._collections };
  }

  private collectSubtree(
    childNotations: string[],
    lang: string,
    currentDepth: number,
    maxDepth: number,
    textCache: Map<string, string | null>,
    out: SubtreeEntry[],
  ): void {
    const cap = IconclassDb.MAX_CHILDREN_PER_PARENT;
    const truncated = childNotations.length > cap;
    const visibleChildren = truncated ? childNotations.slice(0, cap) : childNotations;

    for (const n of visibleChildren) {
      if (out.length >= IconclassDb.MAX_SUBTREE_ENTRIES) return;

      const resolved = this.resolveEntry(n, lang, textCache);
      if (!resolved) continue;

      const totalChildren = resolved.children.length;

      out.push({
        ...resolved,
        depth: currentDepth,
        totalChildren,
        truncated: currentDepth < maxDepth && totalChildren > cap,
      });

      if (currentDepth < maxDepth && totalChildren > 0 && out.length < IconclassDb.MAX_SUBTREE_ENTRIES) {
        this.collectSubtree(resolved.children, lang, currentDepth + 1, maxDepth, textCache, out);
      }
    }
  }

  // ─── Resolve (batch) ──────────────────────────────────────────────

  resolve(notations: string[], lang: string = "en"): IconclassEntry[] {
    if (!this.db) return [];
    const textCache = new Map<string, string | null>();
    return notations
      .map((n) => this.resolveEntry(n, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);
  }

  // ─── Prefix search ───────────────────────────────────────────────

  searchPrefix(
    prefix: string,
    maxResults: number = 25,
    lang: string = "en",
    offset: number = 0,
    collectionId?: string,
  ): IconclassPrefixResult {
    const empty: IconclassPrefixResult = { prefix, totalResults: 0, results: [], collections: this._collections };
    if (!this.db) return empty;

    const clean = prefix.trim();
    if (!clean) return empty;

    const likePattern = escapeLikePrefix(clean);
    const presenceCache = new Map<string, Set<string>>();

    if (collectionId) {
      // Direct JOIN against the counts sidecar — filter, sort, and paginate in
      // SQL. Avoids pulling every prefix-matching notation (up to ~200K for a
      // broad prefix) into JS and re-inserting them into the temp table.
      if (!this.stmtPrefixCollCount || !this.stmtPrefixCollPage) {
        return empty; // counts DB not attached → no collection data to filter on
      }

      const totalResults = (this.stmtPrefixCollCount.get(likePattern, collectionId) as { n: number }).n;
      const rows = this.stmtPrefixCollPage.all(likePattern, collectionId, maxResults, offset) as { notation: string }[];

      const textCache = new Map<string, string | null>();
      const results = rows
        .map((r) => this.resolveEntry(r.notation, lang, textCache, presenceCache))
        .filter((e): e is IconclassEntry => e !== null);

      return { prefix, totalResults, results, collections: this._collections };
    }

    // No collection filter: use SQL COUNT + LIMIT/OFFSET directly
    const totalResults = (this.stmtPrefixCount.get(likePattern) as { n: number }).n;
    const rows = this.stmtPrefixSearch.all(likePattern, maxResults, offset) as { notation: string }[];

    const textCache = new Map<string, string | null>();
    const results = rows
      .map((r) => this.resolveEntry(r.notation, lang, textCache, presenceCache))
      .filter((e): e is IconclassEntry => e !== null);

    return { prefix, totalResults, results, collections: this._collections };
  }

  // ─── Key expansion ────────────────────────────────────────────────

  expandKeys(
    notation: string,
    lang: string = "en",
    maxResults: number = 25,
    offset: number = 0,
  ): IconclassKeyExpansionResult | null {
    if (!this.db) return null;

    const textCache = new Map<string, string | null>();
    const baseEntry = this.resolveEntry(notation, lang, textCache);
    if (!baseEntry) return null;

    const totalKeyVariants = (this.stmtKeyVariantsCount.get(notation) as { n: number }).n;
    const keyVariants = this.resolveKeyVariantsPage(notation, lang, maxResults, offset, textCache);

    return { notation, baseEntry, keyVariants, totalKeyVariants, collections: this._collections };
  }

  // ─── Semantic search ──────────────────────────────────────────────

  semanticSearch(
    query: string,
    queryEmbedding: Float32Array,
    k: number,
    opts: {
      lang?: string;
      onlyWithArtworks?: boolean;
      collectionId?: string;
      parentNotation?: string;
    } = {},
  ): IconclassSemanticResult | null {
    if (!this.db || !this._hasEmbeddings || !this.stmtQuantize) return null;

    const { lang = "en", onlyWithArtworks = false, collectionId, parentNotation } = opts;
    const quantized = this.stmtQuantize.get(queryEmbedding) as { v: Buffer };

    let rows: { notation: string; distance: number }[];

    // Three execution paths chosen by which filters are set; collectionId is
    // always post-filtered since it requires a JOIN against the counts DB.
    // When parentNotation has already narrowed via SQL, the collection-presence
    // overfetch is much smaller (k * 5 vs k * 20).
    const needsCollectionPostFilter = collectionId || onlyWithArtworks;
    const overfetchMultiplier = parentNotation ? 5 : 20;
    const fetchK = needsCollectionPostFilter
      ? Math.min(k * overfetchMultiplier, 4096)
      : Math.min(k, 4096);

    if (parentNotation && this.stmtPrefixFilteredKnn) {
      rows = this.stmtPrefixFilteredKnn.all(quantized.v, escapeLikePrefix(parentNotation), fetchK) as { notation: string; distance: number }[];
    } else if (onlyWithArtworks && this.stmtFilteredKnn) {
      rows = this.stmtFilteredKnn.all(quantized.v, fetchK) as { notation: string; distance: number }[];
    } else if (this.stmtKnn) {
      rows = this.stmtKnn.all(quantized.v, fetchK) as { notation: string; distance: number }[];
    } else {
      return null;
    }

    // Batch-filter by collectionId/onlyWithArtworks using temp table + JOIN.
    // When parentNotation already restricted via SQL, this still applies any
    // additional collection constraints on the smaller candidate set.
    const presenceCache = new Map<string, Set<string>>();
    let candidates = rows;
    if (collectionId || onlyWithArtworks) {
      const kept = new Set(
        this.fetchPresenceForSort(rows.map(r => r.notation), presenceCache, collectionId, onlyWithArtworks)
          .map(c => c.notation)
      );
      candidates = rows.filter(r => kept.has(r.notation));
    }
    candidates = candidates.slice(0, k);

    const textCache = new Map<string, string | null>();
    const results = candidates
      .map((row) => {
        const entry = this.resolveEntry(row.notation, lang, textCache, presenceCache);
        if (!entry) return null;
        return { ...entry, similarity: Math.round((1 - row.distance) * 1000) / 1000 };
      })
      .filter((e): e is IconclassEntry & { similarity: number } => e !== null);

    return {
      query,
      totalResults: results.length,
      results,
      collections: this._collections,
    };
  }

  // ─── Find artworks ────────────────────────────────────────────────

  findArtworks(notations: string[], lang: string = "en"): FindArtworksResult {
    const empty: FindArtworksResult = { notations: [], collections: this._collections };
    if (!this.db) return empty;

    const results: FindArtworksResult["notations"] = [];

    for (const notation of notations) {
      const text = this.getText(notation, lang) ?? notation;
      const cols: ArtworkCollectionInfo[] = [];

      if (this.stmtGetCollectionCounts) {
        const rows = this.stmtGetCollectionCounts.all(notation) as { collection_id: string; count: number }[];
        for (const row of rows) {
          const info = this._collectionsMap.get(row.collection_id);
          const template = info?.searchUrlTemplate;
          cols.push({
            collectionId: row.collection_id,
            label: info?.label ?? row.collection_id,
            count: row.count,
            url: template ? template.replace("{notation}", encodeURIComponent(notation)) : null,
          });
        }
        cols.sort((a, b) => b.count - a.count);
      }

      results.push({ notation, text, collections: cols, artResearchUrl: artResearchUrl(notation) });
    }

    return { notations: results, collections: this._collections };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private runFtsQueries(ftsExpr: string, parentNotation?: string): Map<string, number> {
    const map = new Map<string, number>();
    const likePattern = parentNotation ? escapeLikePrefix(parentNotation) : null;
    const textRows = likePattern
      ? this.stmtTextFtsScoped.all(ftsExpr, likePattern)
      : this.stmtTextFts.all(ftsExpr);
    const keywordRows = likePattern
      ? this.stmtKwFtsScoped.all(ftsExpr, likePattern)
      : this.stmtKwFts.all(ftsExpr);

    // FTS5 rank is negative BM25 (lower = more relevant). Keep the best (lowest) rank per notation.
    for (const rows of [textRows, keywordRows] as { notation: string; rank: number }[][]) {
      for (const r of rows) {
        const prev = map.get(r.notation);
        if (prev === undefined || r.rank < prev) map.set(r.notation, r.rank);
      }
    }
    return map;
  }

  /**
   * Batch-fetch collection presence for sorting. Uses a temp table + JOIN
   * instead of N+1 individual queries — ~200x faster for broad FTS result sets.
   * Populates presenceCache for later reuse by resolveEntry.
   */
  private fetchPresenceForSort(
    notations: string[],
    presenceCache: Map<string, Set<string>>,
    collectionId?: string,
    onlyWithArtworks: boolean = false,
  ): { notation: string; coverage: number }[] {
    if (!this.stmtGetCollectionCounts || !this.db) {
      return (collectionId || onlyWithArtworks) ? [] : notations.map(n => ({ notation: n, coverage: 0 }));
    }

    // Batch: insert all notations into a temp table, then JOIN against counts
    this.stmtDeleteBatch!.run();
    this.batchInsertAll!(notations);

    const presenceRows = this.stmtPresenceJoin!.all() as { notation: string; collection_id: string }[];

    // Build presence map
    for (const pr of presenceRows) {
      let cols = presenceCache.get(pr.notation);
      if (!cols) {
        cols = new Set();
        presenceCache.set(pr.notation, cols);
      }
      cols.add(pr.collection_id);
    }

    // Build sorted result — coverage = number of collections with artworks
    const results: { notation: string; coverage: number }[] = [];
    for (const notation of notations) {
      const cols = presenceCache.get(notation);
      if (!cols) {
        if (!collectionId && !onlyWithArtworks) results.push({ notation, coverage: 0 });
        continue;
      }
      const matches = collectionId ? (cols.has(collectionId) ? 1 : 0) : cols.size;
      if ((collectionId || onlyWithArtworks) && matches === 0) continue;
      results.push({ notation, coverage: matches });
    }
    return results;
  }

  private resolveKeyVariantsPage(notation: string, lang: string, limit: number, offset: number, textCache: Map<string, string | null>): IconclassEntry[] {
    const keyRows = this.stmtKeyVariantsPage.all(notation, limit, offset) as { notation: string }[];
    return keyRows
      .map((r) => this.resolveEntry(r.notation, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);
  }

  private resolveEntry(notation: string, lang: string, textCache: Map<string, string | null>, presenceCache?: Map<string, Set<string>>): IconclassEntry | null {
    if (!this.db) return null;

    const row = this.stmtGetNotation.get(notation) as {
      notation: string; path: string; children: string; refs: string;
      base_notation: string | null; key_id: string | null; is_key_expanded: number;
    } | undefined;
    if (!row) return null;

    const pathNotations: string[] = JSON.parse(row.path);
    const children: string[] = JSON.parse(row.children);
    const refs: string[] = JSON.parse(row.refs);

    const pathEntries = pathNotations.map((n) => ({
      notation: n,
      text: this.getTextCached(n, lang, textCache) ?? n,
    }));

    let collections: string[];
    const cached = presenceCache?.get(notation);
    if (cached) {
      collections = [...cached];
    } else if (this.stmtGetCollectionCounts) {
      const rows = this.stmtGetCollectionCounts.all(notation) as { collection_id: string }[];
      collections = rows.map(r => r.collection_id);
    } else {
      collections = [];
    }

    return {
      notation: row.notation,
      text: this.getTextCached(row.notation, lang, textCache) ?? row.notation,
      path: pathEntries,
      children,
      refs,
      keywords: this.getKeywords(row.notation, lang),
      isKeyExpanded: row.is_key_expanded === 1,
      baseNotation: row.base_notation,
      keyId: row.key_id,
      collections,
    };
  }

  private getTextCached(notation: string, lang: string, cache: Map<string, string | null>): string | null {
    const key = `${notation}:${lang}`;
    if (cache.has(key)) return cache.get(key)!;
    const text = this.getText(notation, lang);
    cache.set(key, text);
    return text;
  }

  private getText(notation: string, lang: string): string | null {
    if (!this.db) return null;

    for (const l of langFallbacks(lang)) {
      const row = this.stmtGetText.get(notation, l) as { text: string } | undefined;
      if (row) return row.text;
    }

    const any = this.stmtGetTextAny.get(notation) as { text: string } | undefined;
    return any?.text ?? null;
  }

  private getKeywords(notation: string, lang: string): string[] {
    if (!this.db) return [];

    for (const l of langFallbacks(lang)) {
      const rows = this.stmtGetKeywords.all(notation, l) as { keyword: string }[];
      if (rows.length > 0) return rows.map((r) => r.keyword);
    }

    const any = this.stmtGetKeywordsAny.all(notation) as { keyword: string }[];
    return any.map((r) => r.keyword);
  }
}
