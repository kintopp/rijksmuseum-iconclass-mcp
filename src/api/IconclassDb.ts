import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { escapeFts5, resolveDbPath } from "../utils/db.js";

const require = createRequire(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────

export interface CollectionInfo {
  collectionId: string;
  label: string;
  countsAsOf: string | null;
  totalArtworks: number;
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
  collectionCounts: Record<string, number>;
}

export interface IconclassSearchResult {
  query: string;
  totalResults: number;
  results: IconclassEntry[];
  collections: CollectionInfo[];
}

export interface IconclassBrowseResult {
  notation: string;
  entry: IconclassEntry;
  subtree: IconclassEntry[];
  keyVariants: IconclassEntry[];
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
  collections: CollectionInfo[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function langFallbacks(lang: string): string[] {
  const langs = [lang];
  if (lang !== "en") langs.push("en");
  if (lang !== "nl") langs.push("nl");
  return langs;
}

function hasColumn(db: DatabaseType, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some(c => c.name === column);
}

function tableExists(db: DatabaseType, table: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
  return row !== undefined;
}

// ─── IconclassDb ─────────────────────────────────────────────────────

export class IconclassDb {
  private db: DatabaseType | null = null;
  private _hasEmbeddings = false;
  private _embeddingDimensions = 0;
  private _collections: CollectionInfo[] = [];
  private _hasKeyColumns = false;

  private stmtTextFts!: Statement;
  private stmtKwFts!: Statement;
  private stmtGetNotation!: Statement;
  private stmtGetText!: Statement;
  private stmtGetTextAny!: Statement;
  private stmtGetKeywords!: Statement;
  private stmtGetKeywordsAny!: Statement;
  private stmtPrefixSearch!: Statement;
  private stmtGetCollectionCounts: Statement | null = null;
  private stmtKeyVariants: Statement | null = null;
  private stmtQuantize: Statement | null = null;
  private stmtKnn: Statement | null = null;
  private stmtFilteredKnn: Statement | null = null;

  constructor() {
    const dbPath = resolveDbPath("ICONCLASS_DB_PATH", "iconclass.db");
    if (!dbPath) {
      console.error("Iconclass DB not found — all tools disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma("mmap_size = 1073741824");
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM notations").get() as { n: number }).n;

      // Schema detection
      this._hasKeyColumns = hasColumn(this.db, "notations", "base_notation");
      const hasCollectionCounts = tableExists(this.db, "collection_counts");
      const hasRijksCount = hasColumn(this.db, "notations", "rijks_count");

      // Collection info
      if (hasCollectionCounts && tableExists(this.db, "collection_info")) {
        const rows = this.db.prepare("SELECT collection_id, label, counts_as_of, total_artworks FROM collection_info").all() as {
          collection_id: string; label: string; counts_as_of: string | null; total_artworks: number;
        }[];
        this._collections = rows.map(r => ({
          collectionId: r.collection_id,
          label: r.label,
          countsAsOf: r.counts_as_of,
          totalArtworks: r.total_artworks,
        }));
      } else if (hasRijksCount) {
        // Legacy schema: synthesize collection info from version_info built_at
        let countsAsOf: string | null = null;
        try {
          const row = this.db.prepare("SELECT value FROM version_info WHERE key = 'built_at'").get() as { value: string } | undefined;
          countsAsOf = row ? row.value.slice(0, 10) : null;
        } catch { /* version_info may not exist */ }
        this._collections = [{
          collectionId: "rijksmuseum",
          label: "Rijksmuseum",
          countsAsOf,
          totalArtworks: 0,
        }];
      }

      // Embeddings
      try {
        const dimRow = this.db.prepare(
          "SELECT value FROM version_info WHERE key = 'embedding_dimensions'"
        ).get() as { value: string } | undefined;
        this._embeddingDimensions = dimRow ? parseInt(dimRow.value, 10) : 384;

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

        if (hasCollectionCounts) {
          this.stmtFilteredKnn = this.db.prepare(`
            SELECT ie.notation,
                   vec_distance_cosine(vec_int8(ie.embedding), vec_int8(?)) as distance
            FROM iconclass_embeddings ie
            WHERE ie.notation IN (SELECT DISTINCT notation FROM collection_counts WHERE count > 0)
            ORDER BY distance LIMIT ?
          `);
        } else if (hasRijksCount) {
          this.stmtFilteredKnn = this.db.prepare(`
            SELECT ie.notation,
                   vec_distance_cosine(vec_int8(ie.embedding), vec_int8(?)) as distance
            FROM iconclass_embeddings ie
            JOIN notations n ON ie.notation = n.notation
            WHERE n.rijks_count > 0
            ORDER BY distance LIMIT ?
          `);
        }

        this._hasEmbeddings = true;
        const embCount = (this.db.prepare("SELECT COUNT(*) as n FROM iconclass_embeddings").get() as { n: number }).n;
        console.error(`  Iconclass embeddings: ${embCount.toLocaleString()} vectors (${this._embeddingDimensions}d)`);
      } catch {
        // No embeddings or sqlite-vec not available
      }

      // Prepared statements
      this.stmtTextFts = this.db.prepare(
        `SELECT DISTINCT t.notation
         FROM texts t
         WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
      );
      this.stmtKwFts = this.db.prepare(
        `SELECT DISTINCT k.notation
         FROM keywords k
         WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
      );

      if (this._hasKeyColumns) {
        this.stmtGetNotation = this.db.prepare(
          "SELECT notation, path, children, refs, base_notation, key_id, is_key_expanded FROM notations WHERE notation = ?"
        );
      } else if (hasRijksCount) {
        this.stmtGetNotation = this.db.prepare(
          "SELECT notation, path, children, refs, rijks_count FROM notations WHERE notation = ?"
        );
      } else {
        this.stmtGetNotation = this.db.prepare(
          "SELECT notation, path, children, refs FROM notations WHERE notation = ?"
        );
      }

      this.stmtGetText = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1"
      );
      this.stmtGetTextAny = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? LIMIT 1"
      );
      this.stmtGetKeywords = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? AND lang = ? LIMIT 20"
      );
      this.stmtGetKeywordsAny = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? LIMIT 20"
      );
      this.stmtPrefixSearch = this.db.prepare(
        "SELECT notation FROM notations WHERE notation LIKE ? ORDER BY notation LIMIT ? OFFSET ?"
      );

      if (hasCollectionCounts) {
        this.stmtGetCollectionCounts = this.db.prepare(
          "SELECT collection_id, count FROM collection_counts WHERE notation = ?"
        );
      }
      if (this._hasKeyColumns) {
        this.stmtKeyVariants = this.db.prepare(
          "SELECT notation FROM notations WHERE base_notation = ? ORDER BY notation"
        );
      }

      const schemaLabel = this._hasKeyColumns ? "expanded" : "legacy";
      console.error(`Iconclass DB loaded: ${dbPath} (${count.toLocaleString()} notations, ${schemaLabel} schema, ${this._collections.length} collection overlays)`);
    } catch (err) {
      console.error(`Failed to open Iconclass DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
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

  get hasKeyExpansion(): boolean {
    return this._hasKeyColumns;
  }

  // ─── Search (FTS) ─────────────────────────────────────────────────

  search(query: string, maxResults: number = 25, lang: string = "en", offset: number = 0, collectionId?: string): IconclassSearchResult {
    const empty: IconclassSearchResult = { query, totalResults: 0, results: [], collections: this._collections };
    if (!this.db) return empty;

    const ftsPhrase = escapeFts5(query);
    if (!ftsPhrase) return empty;

    const textHits = this.stmtTextFts.all(ftsPhrase) as { notation: string }[];
    const kwHits = this.stmtKwFts.all(ftsPhrase) as { notation: string }[];

    const notationSet = new Set<string>();
    for (const r of textHits) notationSet.add(r.notation);
    for (const r of kwHits) notationSet.add(r.notation);

    if (notationSet.size === 0) return empty;

    // Fetch counts cheaply for sorting, then resolve only the page
    const countedNotations = this.fetchCountsForSort([...notationSet], collectionId);

    // Sort by total count DESC, notation ASC
    countedNotations.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.notation.localeCompare(b.notation);
    });

    const totalResults = countedNotations.length;
    const page = countedNotations.slice(offset, offset + maxResults);

    // Only resolve full entries for the page
    const textCache = new Map<string, string | null>();
    const results = page
      .map(({ notation }) => this.resolveEntry(notation, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);

    return { query, totalResults, results, collections: this._collections };
  }

  // ─── Browse ───────────────────────────────────────────────────────

  browse(notation: string, lang: string = "en", includeKeys: boolean = false): IconclassBrowseResult | null {
    if (!this.db) return null;

    const textCache = new Map<string, string | null>();
    const entry = this.resolveEntry(notation, lang, textCache);
    if (!entry) return null;

    const subtree = entry.children
      .map((n) => this.resolveEntry(n, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);

    let keyVariants: IconclassEntry[] = [];
    if (includeKeys && !entry.isKeyExpanded) {
      keyVariants = this.resolveKeyVariants(notation, lang, textCache);
    }

    return { notation, entry, subtree, keyVariants, collections: this._collections };
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

    const clean = prefix.replace(/[^a-zA-Z0-9()+]/g, "");
    if (!clean) return empty;

    const fetchLimit = collectionId ? maxResults * 5 + offset : maxResults + offset;
    const rows = this.stmtPrefixSearch.all(`${clean}%`, fetchLimit, 0) as { notation: string }[];

    let notations = rows.map(r => r.notation);

    if (collectionId) {
      const counted = this.fetchCountsForSort(notations, collectionId);
      notations = counted.map(c => c.notation);
    }

    const totalResults = notations.length;
    const page = notations.slice(offset, offset + maxResults);

    const textCache = new Map<string, string | null>();
    const results = page
      .map((n) => this.resolveEntry(n, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);

    return { prefix, totalResults, results, collections: this._collections };
  }

  // ─── Key expansion ────────────────────────────────────────────────

  expandKeys(notation: string, lang: string = "en"): IconclassKeyExpansionResult | null {
    if (!this.db || !this.stmtKeyVariants) return null;

    const textCache = new Map<string, string | null>();
    const baseEntry = this.resolveEntry(notation, lang, textCache);
    if (!baseEntry) return null;

    const keyVariants = this.resolveKeyVariants(notation, lang, textCache);

    return { notation, baseEntry, keyVariants, collections: this._collections };
  }

  // ─── Semantic search ──────────────────────────────────────────────

  semanticSearch(
    query: string,
    queryEmbedding: Float32Array,
    k: number,
    lang: string = "en",
    onlyWithArtworks: boolean = false,
    collectionId?: string,
  ): IconclassSemanticResult | null {
    if (!this.db || !this._hasEmbeddings || !this.stmtQuantize) return null;

    const quantized = this.stmtQuantize.get(queryEmbedding) as { v: Buffer };

    let rows: { notation: string; distance: number }[];

    if (onlyWithArtworks && this.stmtFilteredKnn) {
      rows = this.stmtFilteredKnn.all(quantized.v, k) as { notation: string; distance: number }[];
    } else if (this.stmtKnn) {
      rows = this.stmtKnn.all(quantized.v, Math.min(k, 4096)) as { notation: string; distance: number }[];
    } else {
      return null;
    }

    const textCache = new Map<string, string | null>();
    let results = rows
      .map((row) => {
        const entry = this.resolveEntry(row.notation, lang, textCache);
        if (!entry) return null;
        return { ...entry, similarity: Math.round((1 - row.distance) * 1000) / 1000 };
      })
      .filter((e): e is IconclassEntry & { similarity: number } => e !== null);

    if (collectionId) {
      results = results.filter(e => e.collectionCounts[collectionId] > 0);
    }

    return {
      query,
      totalResults: results.length,
      results,
      collections: this._collections,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /** Fetch total collection counts for a list of notations (cheap — no full entry resolution). */
  private fetchCountsForSort(notations: string[], collectionId?: string): { notation: string; total: number }[] {
    const results: { notation: string; total: number }[] = [];
    for (const notation of notations) {
      let total = 0;
      if (this.stmtGetCollectionCounts) {
        const countRows = this.stmtGetCollectionCounts.all(notation) as { collection_id: string; count: number }[];
        for (const cr of countRows) {
          if (collectionId && cr.collection_id !== collectionId) continue;
          total += cr.count;
        }
      } else {
        // Legacy: rijks_count is on the notation row
        const row = this.stmtGetNotation.get(notation) as Record<string, unknown> | undefined;
        if (row && "rijks_count" in row && typeof row.rijks_count === "number") {
          total = row.rijks_count;
        }
      }
      if (collectionId && total === 0) continue; // filter out zero-count entries
      results.push({ notation, total });
    }
    return results;
  }

  private resolveKeyVariants(notation: string, lang: string, textCache: Map<string, string | null>): IconclassEntry[] {
    if (!this.stmtKeyVariants) return [];
    const keyRows = this.stmtKeyVariants.all(notation) as { notation: string }[];
    return keyRows
      .map((r) => this.resolveEntry(r.notation, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);
  }

  private resolveEntry(notation: string, lang: string, textCache: Map<string, string | null>): IconclassEntry | null {
    if (!this.db) return null;

    const row = this.stmtGetNotation.get(notation) as Record<string, unknown> | undefined;
    if (!row) return null;

    const pathNotations: string[] = JSON.parse(row.path as string);
    const children: string[] = JSON.parse(row.children as string);
    const refs: string[] = JSON.parse(row.refs as string);

    const pathEntries = pathNotations.map((n) => ({
      notation: n,
      text: this.getTextCached(n, lang, textCache) ?? n,
    }));

    const collectionCounts: Record<string, number> = {};
    if (this.stmtGetCollectionCounts) {
      const countRows = this.stmtGetCollectionCounts.all(notation) as { collection_id: string; count: number }[];
      for (const cr of countRows) {
        collectionCounts[cr.collection_id] = cr.count;
      }
    } else if ("rijks_count" in row && typeof row.rijks_count === "number") {
      if (row.rijks_count > 0) {
        collectionCounts["rijksmuseum"] = row.rijks_count;
      }
    }

    return {
      notation: row.notation as string,
      text: this.getTextCached(row.notation as string, lang, textCache) ?? (row.notation as string),
      path: pathEntries,
      children,
      refs,
      keywords: this.getKeywords(row.notation as string, lang),
      isKeyExpanded: this._hasKeyColumns ? (row.is_key_expanded as number) === 1 : false,
      baseNotation: this._hasKeyColumns ? (row.base_notation as string | null) : null,
      keyId: this._hasKeyColumns ? (row.key_id as string | null) : null,
      collectionCounts,
    };
  }

  /** getText with per-request cache — path ancestors repeat across sibling results. */
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
