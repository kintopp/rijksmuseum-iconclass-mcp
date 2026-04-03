import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";

// ─── Shared helpers ─────────────────────────────────────────────────

/** Preprocess: strip JSON null / "null" string / "" → undefined BEFORE Zod validates.
 *  Using factory functions so each field gets a unique Zod instance — avoids $ref. */
const stripNull = (v: unknown) =>
  (v === null || v === undefined || v === "null" || v === "") ? undefined : v;
const optStr = () => z.preprocess(stripNull, z.string().optional());

type ToolResponse = { content: [{ type: "text"; text: string }] };
type StructuredToolResponse = ToolResponse & { structuredContent: Record<string, unknown> };

function errorResponse(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const EMIT_STRUCTURED = process.env.STRUCTURED_CONTENT !== "false";

function structuredResponse(data: object, textContent?: string): ToolResponse | StructuredToolResponse {
  const text = textContent ?? JSON.stringify(data, null, 2);
  if (!EMIT_STRUCTURED) {
    return { content: [{ type: "text", text }] };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function withOutputSchema<T>(schema: T): { outputSchema: T } | Record<never, never> {
  return EMIT_STRUCTURED ? { outputSchema: schema } : {};
}

// ─── Output schemas ─────────────────────────────────────────────────

/** Factory — unique Zod instances per call to prevent $ref deduplication. */
const CollectionCountShape = () => z.record(z.string(), z.number().int());

const CollectionInfoShape = () => z.object({
  collectionId: z.string(),
  label: z.string(),
  countsAsOf: z.string().nullable(),
  totalArtworks: z.number().int(),
});

const IconclassEntryShape = () => z.object({
  notation: z.string(),
  text: z.string(),
  path: z.array(z.object({ notation: z.string(), text: z.string() })),
  children: z.array(z.string()),
  refs: z.array(z.string()),
  keywords: z.array(z.string()),
  isKeyExpanded: z.boolean(),
  baseNotation: z.string().nullable(),
  keyId: z.string().nullable(),
  collectionCounts: CollectionCountShape(),
});

const SearchOutput = {
  query: z.string(),
  totalResults: z.number().int(),
  results: z.array(IconclassEntryShape().extend({ similarity: z.number().optional() })),
  collections: z.array(CollectionInfoShape()),
  error: z.string().optional(),
};

const BrowseOutput = {
  notation: z.string(),
  entry: IconclassEntryShape(),
  subtree: z.array(IconclassEntryShape()),
  keyVariants: z.array(IconclassEntryShape()),
  totalKeyVariants: z.number().int().optional(),
  collections: z.array(CollectionInfoShape()),
  error: z.string().optional(),
};

const ResolveOutput = {
  notations: z.array(IconclassEntryShape()),
  collections: z.array(CollectionInfoShape()),
  error: z.string().optional(),
};

const ExpandKeysOutput = {
  notation: z.string(),
  baseEntry: IconclassEntryShape(),
  totalKeyVariants: z.number().int(),
  keyVariants: z.array(IconclassEntryShape()),
  collections: z.array(CollectionInfoShape()),
  error: z.string().optional(),
};

const PrefixSearchOutput = {
  prefix: z.string(),
  totalResults: z.number().int(),
  results: z.array(IconclassEntryShape()),
  collections: z.array(CollectionInfoShape()),
  error: z.string().optional(),
};

// ─── Tool limits ────────────────────────────────────────────────────

const TOOL_LIMITS = {
  search:        { max: 50, default: 25 },
  resolve:       { max: 50, default: 10 },
  search_prefix: { max: 100, default: 25 },
} as const;

// ─── Language codes ─────────────────────────────────────────────────

const LANG_CODES = ["en", "nl", "de", "fr", "it", "es", "pt", "fi", "cz", "hu", "pl", "jp", "zh"] as const;
const LANG_DESC = `Preferred language for labels (default: 'en'). Available: ${LANG_CODES.join(", ")}.`;

// ─── Registration ───────────────────────────────────────────────────

export function registerTools(
  server: McpServer,
  db: IconclassDb,
  embeddingModel: EmbeddingModel | null,
): void {
  const semanticAvailable = db.embeddingsAvailable && embeddingModel?.available;
  const keysAvailable = db.hasKeyExpansion;

  // ── search ─────────────────────────────────────────────────────

  server.registerTool(
    "search",
    {
      title: "Search Iconclass",
      description:
        "Search Iconclass notations by keyword or concept. " +
        "Two modes (provide exactly one of query or semanticQuery):\n" +
        "• query — FTS5 keyword search across labels and keywords in all 13 languages (exact word match)\n" +
        "• semanticQuery — find notations by meaning (e.g. 'domestic animals' finds dogs, cats, horses)" +
        (semanticAvailable ? "" : " [currently unavailable — embeddings not loaded]") + "\n\n" +
        "collectionCounts shows how many artworks carry each notation per loaded collection. " +
        "Results are ranked by total collection count.",
      inputSchema: z.object({
        query: optStr()
          .describe(
            "Text search across Iconclass labels and keywords. " +
            "Exact word matching (no stemming): 'crucifixion' won't match 'crucified'."
          ),
        semanticQuery: optStr()
          .describe(
            "Semantic concept search — finds notations by meaning rather than exact words. " +
            "Use when keyword search fails or for broad conceptual queries."
          ),
        onlyWithArtworks: z
          .boolean()
          .default(false)
          .optional()
          .describe("Only return notations that have artworks in any loaded collection (semantic mode only)."),
        collectionId: optStr()
          .describe("Filter to notations with artworks in this specific collection (e.g. 'rijksmuseum')."),
        lang: z.string().default("en").describe(LANG_DESC),
        maxResults: z
          .number().int()
          .min(1).max(TOOL_LIMITS.search.max)
          .default(TOOL_LIMITS.search.default)
          .describe(`Maximum results (1-${TOOL_LIMITS.search.max}, default ${TOOL_LIMITS.search.default}).`),
        offset: z.number().int().min(0).default(0).optional()
          .describe("Skip this many results (for pagination)."),
      }).strict(),
      ...withOutputSchema(SearchOutput),
    },
    async (args) => {
      const modes = [args.query, args.semanticQuery].filter(v => v !== undefined);
      if (modes.length === 0) {
        return errorResponse("Provide exactly one of: query or semanticQuery.");
      }
      if (modes.length > 1) {
        return errorResponse("Provide exactly one of: query or semanticQuery — not both.");
      }

      // Semantic search mode
      if (args.semanticQuery !== undefined) {
        if (!embeddingModel?.available || !db.embeddingsAvailable) {
          return errorResponse(
            "Semantic search requires embeddings and an embedding model (not available). " +
            "Use query (keyword search) instead."
          );
        }

        const queryVec = await embeddingModel.embed(args.semanticQuery);
        if (queryVec.length !== db.embeddingDimensions) {
          return errorResponse(
            `Semantic search requires ${db.embeddingDimensions}d query vectors, but model produced ${queryVec.length}d.`
          );
        }

        const result = db.semanticSearch(
          args.semanticQuery, queryVec, args.maxResults, args.lang,
          args.onlyWithArtworks ?? false, args.collectionId,
        );
        if (!result) {
          return errorResponse("Semantic search failed — embeddings may be corrupted.");
        }

        const header = `${result.results.length} semantic matches for "${args.semanticQuery}"`;
        const lines = result.results.map((e, i) =>
          formatEntryLine(e, `${i + 1}. [${e.similarity}] `)
        );
        return structuredResponse(result, [header, ...lines].join("\n"));
      }

      // FTS search mode
      const result = db.search(args.query!, args.maxResults, args.lang, args.offset ?? 0, args.collectionId);

      const header = `${result.results.length} of ${result.totalResults} matches for "${args.query}"`;
      const lines = result.results.map((e, i) =>
        formatEntryLine(e, `${i + 1}. `)
      );
      return structuredResponse(result, [header, ...lines].join("\n"));
    }
  );

  // ── browse ─────────────────────────────────────────────────────

  server.registerTool(
    "browse",
    {
      title: "Browse Iconclass",
      description:
        "Browse an Iconclass notation's hierarchy: returns the entry with its path, direct children, " +
        "cross-references, and optionally key-expanded variants. " +
        "Use this to navigate the Iconclass tree structure.",
      inputSchema: z.object({
        notation: z.string().min(1).describe("Iconclass notation to browse (e.g. '31A33', '73D82')."),
        lang: z.string().default("en").describe(LANG_DESC),
        includeKeys: z.boolean().default(false).optional()
          .describe("Include key-expanded variants (e.g. 25F23(+46)). Only applies to base notations."),
        maxKeyVariants: z.number().int().min(1).max(200).default(25).optional()
          .describe("Maximum key variants to return when includeKeys is true (1-200, default 25)."),
        keyOffset: z.number().int().min(0).default(0).optional()
          .describe("Skip this many key variants (for pagination)."),
      }).strict(),
      ...withOutputSchema(BrowseOutput),
    },
    async (args) => {
      const result = db.browse(args.notation, args.lang, args.includeKeys ?? false);
      if (!result) {
        return errorResponse(`Notation "${args.notation}" not found in Iconclass.`);
      }

      const { entry, subtree } = result;
      const totalKeyVariants = result.keyVariants.length;
      const keyOffset = args.keyOffset ?? 0;
      const keyVariants = result.keyVariants.slice(keyOffset, keyOffset + (args.maxKeyVariants ?? 25));
      const pathStr = entry.path.length > 0
        ? entry.path.map(p => `${p.notation} "${p.text}"`).join(" > ") + " > "
        : "";
      const counts = formatCounts(entry.collectionCounts);
      const sections = [`${pathStr}${entry.notation} "${entry.text}"${counts}`];

      if (entry.keywords.length > 0) {
        sections.push(`Keywords: ${entry.keywords.join(", ")}`);
      }
      if (entry.refs.length > 0) {
        sections.push(`Cross-references: ${entry.refs.join(", ")}`);
      }
      if (subtree.length > 0) {
        const childLines = subtree.map(c => {
          const cc = formatCounts(c.collectionCounts);
          return `  ${c.notation}${cc} "${c.text}"`;
        });
        sections.push(`Children (${childLines.length}):`, ...childLines);
      }
      if (keyVariants.length > 0) {
        const keyLines = keyVariants.map(k => {
          const kc = formatCounts(k.collectionCounts);
          return `  ${k.notation}${kc} "${k.text}"`;
        });
        const keyHeader = totalKeyVariants > keyVariants.length
          ? `Key variants (${keyOffset + 1}–${keyOffset + keyVariants.length} of ${totalKeyVariants}):`
          : `Key variants (${keyVariants.length}):`;
        sections.push(keyHeader, ...keyLines);
      }

      const data = { ...result, keyVariants, totalKeyVariants: totalKeyVariants || undefined };
      return structuredResponse(data, sections.join("\n"));
    }
  );

  // ── resolve ────────────────────────────────────────────────────

  server.registerTool(
    "resolve",
    {
      title: "Resolve Iconclass Notations",
      description:
        "Look up one or more Iconclass notations by code. Returns full metadata: " +
        "text, keywords, hierarchy path, children, cross-references, key info, and collection counts. " +
        "Accepts up to 50 notations in a single call.",
      inputSchema: z.object({
        notation: z.union([
          z.string().min(1),
          z.array(z.string().min(1)).min(1).max(TOOL_LIMITS.resolve.max),
        ]).describe("One notation or array of notations to resolve (max 50)."),
        lang: z.string().default("en").describe(LANG_DESC),
      }).strict(),
      ...withOutputSchema(ResolveOutput),
    },
    async (args) => {
      const notations = Array.isArray(args.notation) ? args.notation : [args.notation];
      const entries = db.resolve(notations, args.lang);

      if (entries.length === 0) {
        return errorResponse(`None of the requested notations were found.`);
      }

      const lines = entries.map(e => {
        const counts = formatCounts(e.collectionCounts);
        let line = `${e.notation}${counts} "${e.text}"`;
        if (e.path.length > 0) line += ` [${e.path.map(p => p.notation).join(" > ")}]`;
        if (e.keywords.length > 0) line += ` kw: ${e.keywords.join(", ")}`;
        return line;
      });
      const data = { notations: entries, collections: db.collections };
      return structuredResponse(data, lines.join("\n"));
    }
  );

  // ── expand_keys ────────────────────────────────────────────────

  server.registerTool(
    "expand_keys",
    {
      title: "Expand Iconclass Keys",
      description:
        "Given a base Iconclass notation, return all its key-expanded variants. " +
        "Key expansions add specificity — e.g. 25F23 (beasts of prey) → " +
        "25F23(+1) 'beasts of prey, swimming', 25F23(+46) 'beasts of prey, sleeping'. " +
        "Returns the base entry and all variants with their texts and collection counts." +
        (keysAvailable ? "" : " [currently unavailable — DB does not include key-expanded notations]"),
      inputSchema: z.object({
        notation: z.string().min(1).describe("Base notation to expand (e.g. '25F23'). Must not contain parentheses."),
        lang: z.string().default("en").describe(LANG_DESC),
        maxResults: z.number().int().min(1).max(200).default(25)
          .describe("Maximum key variants to return (1-200, default 25)."),
        offset: z.number().int().min(0).default(0).optional()
          .describe("Skip this many key variants (for pagination)."),
      }).strict(),
      ...withOutputSchema(ExpandKeysOutput),
    },
    async (args) => {
      if (!keysAvailable) {
        return errorResponse("Key expansion is not available — the loaded DB does not include key-expanded notations.");
      }
      const result = db.expandKeys(args.notation, args.lang);
      if (!result) {
        return errorResponse(`Notation "${args.notation}" not found in Iconclass.`);
      }

      const { baseEntry } = result;
      const totalKeyVariants = result.keyVariants.length;
      const kvOffset = args.offset ?? 0;
      const keyVariants = result.keyVariants.slice(kvOffset, kvOffset + args.maxResults);

      const counts = formatCounts(baseEntry.collectionCounts);
      const rangeStr = totalKeyVariants > keyVariants.length
        ? ` (${kvOffset + 1}–${kvOffset + keyVariants.length} of ${totalKeyVariants})`
        : "";
      const header = `${baseEntry.notation} "${baseEntry.text}"${counts} — ${totalKeyVariants} key variants${rangeStr}`;
      const lines = keyVariants.map(k => {
        const kc = formatCounts(k.collectionCounts);
        return `  ${k.notation} (${k.keyId})${kc} "${k.text}"`;
      });
      const data = { ...result, keyVariants, totalKeyVariants };
      return structuredResponse(data, [header, ...lines].join("\n"));
    }
  );

  // ── search_prefix ──────────────────────────────────────────────

  server.registerTool(
    "search_prefix",
    {
      title: "Search Iconclass by Prefix",
      description:
        "Search all notations under a hierarchy subtree by notation prefix. " +
        "Leverages Iconclass's left-to-right hierarchical encoding — " +
        "e.g. '73D8' finds everything under 'Passion of Christ'. " +
        "Results are ordered alphabetically by notation.",
      inputSchema: z.object({
        notation: z.string().min(1).describe("Notation prefix (e.g. '73D8', '25F'). Matches all notations starting with this prefix."),
        lang: z.string().default("en").describe(LANG_DESC),
        collectionId: optStr()
          .describe("Filter to notations with artworks in this collection."),
        maxResults: z
          .number().int()
          .min(1).max(TOOL_LIMITS.search_prefix.max)
          .default(TOOL_LIMITS.search_prefix.default)
          .describe(`Maximum results (1-${TOOL_LIMITS.search_prefix.max}, default ${TOOL_LIMITS.search_prefix.default}).`),
        offset: z.number().int().min(0).default(0).optional()
          .describe("Skip this many results (for pagination)."),
      }).strict(),
      ...withOutputSchema(PrefixSearchOutput),
    },
    async (args) => {
      const result = db.searchPrefix(
        args.notation, args.maxResults, args.lang,
        args.offset ?? 0, args.collectionId,
      );

      const header = `${result.results.length} of ${result.totalResults} notations under "${args.notation}"`;
      const lines = result.results.map(e => {
        const counts = formatCounts(e.collectionCounts);
        return `  ${e.notation}${counts} "${e.text}"`;
      });
      return structuredResponse(result, [header, ...lines].join("\n"));
    }
  );
}

// ─── Format helpers ─────────────────────────────────────────────────

export function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, c]) => c > 0);
  if (entries.length === 0) return "";
  if (entries.length === 1) return ` (${entries[0][1]} artworks)`;
  return ` (${entries.map(([id, c]) => `${id}: ${c}`).join(", ")})`;
}

/** Format an entry as a compact one-liner for LLM content. */
export function formatEntryLine(e: { notation: string; text: string; collectionCounts: Record<string, number>; path: { notation: string }[] }, prefix?: string): string {
  const counts = formatCounts(e.collectionCounts);
  let line = prefix ? `${prefix}${e.notation}${counts} "${e.text}"` : `${e.notation}${counts} "${e.text}"`;
  if (e.path.length > 0) line += ` [${e.path.map(p => p.notation).join(" > ")}]`;
  return line;
}
