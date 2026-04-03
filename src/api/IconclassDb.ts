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
  private _hasEmbeddings = false;
  private _embeddingDimensions = 0;
  private _collections: CollectionInfo[] = [];
  private stmtTextFts!: Statement;
  private stmtKwFts!: Statement;
  private stmtGetNotation!: Statement;
  private stmtGetText!: Statement;
  private stmtGetTextAny!: Statement;
  private stmtGetKeywords!: Statement;
  private stmtGetKeywordsAny!: Statement;
  private stmtPrefixSearch!: Statement;
  private stmtKeyVariantsPage!: Statement;
  private stmtKeyVariantsCount!: Statement;
  private stmtGetCollectionCounts: Statement | null = null;
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
      this.db.pragma("mmap_size = 4294967296"); // 4 GB — covers full DB + growth headroom
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM notations").get() as { n: number }).n;

      const countsPath = resolveDbPath("COUNTS_DB_PATH", "iconclass-counts.db");
      if (countsPath) {
        try {
          this.db.exec(`ATTACH DATABASE '${countsPath}' AS counts`);
          this.db.prepare("SELECT 1 FROM counts.collection_counts LIMIT 1").get();

          this.stmtGetCollectionCounts = this.db.prepare(
            "SELECT collection_id, count FROM counts.collection_counts WHERE notation = ?"
          );

          const rows = this.db.prepare("SELECT collection_id, label, counts_as_of, total_artworks FROM counts.collection_info").all() as {
            collection_id: string; label: string; counts_as_of: string | null; total_artworks: number;
          }[];
          this._collections = rows.map(r => ({
            collectionId: r.collection_id,
            label: r.label,
            countsAsOf: r.counts_as_of,
            totalArtworks: r.total_artworks,
          }));
          console.error(`  Counts DB attached: ${countsPath} (${this._collections.length} collections)`);
        } catch (err) {
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
            WHERE ie.notation IN (SELECT DISTINCT notation FROM counts.collection_counts WHERE count > 0)
            ORDER BY distance LIMIT ?
          `);
        }

        this._hasEmbeddings = true;
        const embCount = (this.db.prepare("SELECT COUNT(*) as n FROM iconclass_embeddings").get() as { n: number }).n;
        console.error(`  Iconclass embeddings: ${embCount.toLocaleString()} vectors (${this._embeddingDimensions}d)`);
      } catch { /* no embeddings */ }

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
        "SELECT keyword FROM keywords WHERE notation = ? AND lang = ? LIMIT 20"
      );
      this.stmtGetKeywordsAny = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? LIMIT 20"
      );
      this.stmtPrefixSearch = this.db.prepare(
        "SELECT notation FROM notations WHERE notation LIKE ? ORDER BY notation LIMIT ? OFFSET ?"
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
    return this.db !== null;
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

    const countsCache = new Map<string, Record<string, number>>();
    const countedNotations = this.fetchCountsForSort([...notationSet], countsCache, collectionId);

    countedNotations.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.notation.localeCompare(b.notation);
    });

    const totalResults = countedNotations.length;
    const page = countedNotations.slice(offset, offset + maxResults);

    const textCache = new Map<string, string | null>();
    const results = page
      .map(({ notation }) => this.resolveEntry(notation, lang, textCache, countsCache))
      .filter((e): e is IconclassEntry => e !== null);

    return { query, totalResults, results, collections: this._collections };
  }

  // ─── Browse ───────────────────────────────────────────────────────

  browse(
    notation: string,
    lang: string = "en",
    includeKeys: boolean = false,
    maxKeyVariants: number = 25,
    keyOffset: number = 0,
  ): IconclassBrowseResult | null {
    if (!this.db) return null;

    const textCache = new Map<string, string | null>();
    const entry = this.resolveEntry(notation, lang, textCache);
    if (!entry) return null;

    const subtree = entry.children
      .map((n) => this.resolveEntry(n, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);

    let keyVariants: IconclassEntry[] = [];
    let totalKeyVariants = 0;
    if (includeKeys && !entry.isKeyExpanded) {
      totalKeyVariants = (this.stmtKeyVariantsCount.get(notation) as { n: number }).n;
      keyVariants = this.resolveKeyVariantsPage(notation, lang, maxKeyVariants, keyOffset, textCache);
    }

    return { notation, entry, subtree, keyVariants, totalKeyVariants, collections: this._collections };
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
    const countsCache = new Map<string, Record<string, number>>();

    if (collectionId) {
      const counted = this.fetchCountsForSort(notations, countsCache, collectionId);
      notations = counted.map(c => c.notation);
    }

    const totalResults = notations.length;
    const page = notations.slice(offset, offset + maxResults);

    const textCache = new Map<string, string | null>();
    const results = page
      .map((n) => this.resolveEntry(n, lang, textCache, countsCache))
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

  /** Fetch counts for sorting. Also populates countsCache for later use by resolveEntry. */
  private fetchCountsForSort(
    notations: string[],
    countsCache: Map<string, Record<string, number>>,
    collectionId?: string,
  ): { notation: string; total: number }[] {
    if (!this.stmtGetCollectionCounts) {
      return collectionId ? [] : notations.map(n => ({ notation: n, total: 0 }));
    }

    const results: { notation: string; total: number }[] = [];
    for (const notation of notations) {
      const counts: Record<string, number> = {};
      let total = 0;
      const countRows = this.stmtGetCollectionCounts.all(notation) as { collection_id: string; count: number }[];
      for (const cr of countRows) {
        counts[cr.collection_id] = cr.count;
        if (!collectionId || cr.collection_id === collectionId) total += cr.count;
      }
      countsCache.set(notation, counts);
      if (collectionId && total === 0) continue;
      results.push({ notation, total });
    }
    return results;
  }

  private resolveKeyVariantsPage(notation: string, lang: string, limit: number, offset: number, textCache: Map<string, string | null>): IconclassEntry[] {
    const keyRows = this.stmtKeyVariantsPage.all(notation, limit, offset) as { notation: string }[];
    return keyRows
      .map((r) => this.resolveEntry(r.notation, lang, textCache))
      .filter((e): e is IconclassEntry => e !== null);
  }

  private resolveEntry(notation: string, lang: string, textCache: Map<string, string | null>, countsCache?: Map<string, Record<string, number>>): IconclassEntry | null {
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

    let collectionCounts = countsCache?.get(notation);
    if (!collectionCounts) {
      collectionCounts = {};
      if (this.stmtGetCollectionCounts) {
        const countRows = this.stmtGetCollectionCounts.all(notation) as { collection_id: string; count: number }[];
        for (const cr of countRows) {
          collectionCounts[cr.collection_id] = cr.count;
        }
      }
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
      collectionCounts,
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
