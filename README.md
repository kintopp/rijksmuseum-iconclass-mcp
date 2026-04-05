# rijksmuseum-iconclass-mcp

[![MCP Protocol](https://img.shields.io/badge/MCP_Protocol-2025--11--25-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIi8+PC9zdmc+)](https://modelcontextprotocol.io/specification/2025-11-25)

Rijksmuseum-iconclass-mcp is a tool for searching and exploring [Iconclass](https://iconclass.org) notations in natural language with an AI assistant. It was designed as a companion resource for [rijksmuseum-mcp+](https://github.com/kintopp/rijksmuseum-mcp-plus), an analogous resource for the Rijksmuseum's art collections.

It provides access to over 1.3 million Iconclass notations — all of the c. 39,000 base concepts and c. 1.3 million key-expanded variants that add modifiers like posture, context, or symbolism. Beside simple keyword matching, rijksmuseum-iconclass-mcp supports semantic search in natural language, so that you can discover iconclass notations related to concepts like "homesickness and exile" -> `94I2111 — Ulysses longs for home"` or "coming of age and youth" -> `31D120 — "Youth, Adolescence, 'Iuventus'; 'Adolescenza', 'Gioventù' (Ripa)"` even when your search terms don't appear in the notation text. You can also, for example, use the AI assistant to explore the Iconclass hierarchy, visualise these relationships, or provide cataloguing advice. The Rijksmuseum-iconclass-mcp database includes collection counts from the Rijksmuseum, RKD, and Arkyves, to let you see how many artworks at these institutions carry a given notation, can provide you with a custom link to search for these notations on their respective websites. 

## Quick start

Add the Iconclass server as a custom connector in [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) using the URL below. This currently requires a paid ('Pro') or higher [subscription](https://claude.com/pricing) from Anthropic.

```
https://rijksmuseum-iconclass-mcp-production.up.railway.app/mcp
```

Go to _Settings_ → _Connectors_ → _Add custom connector_ → name it as you like and paste the URL into the _Remote MCP Server URL_ field. You can ignore the Authentication section. Once configured, optionally set the permissions for its tools (e.g. 'Always allow'). See Anthropic's [instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) for more details.

The server is based on the open [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) (MCP) standard and also works with other AI applications that support remote MCP servers.

### Development setup

For local development or self-hosting:

```bash
git clone https://github.com/kintopp/rijksmuseum-iconclass-mcp.git
cd rijksmuseum-iconclass-mcp
npm install && npm run build
npm start          # stdio mode
npm run serve      # HTTP mode on port 3000
```

On first run, the server downloads `iconclass.db` (~1 GB compressed) to `data/` if `ICONCLASS_DB_URL` is set. Subsequent starts are fast.

To use the local server with Claude Desktop (stdio), add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "iconclass": {
      "command": "node",
      "args": ["/path/to/rijksmuseum-iconclass-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### `search` — keyword or semantic search

Find notations by text or concept.

```
query: "crucifixion"          → 844 FTS matches across labels and keywords
semanticQuery: "domestic animals" → top matches by embedding similarity
```

| Parameter | Description |
|-----------|-------------|
| `query` | FTS keyword search (13 languages, multi-word fallback) |
| `semanticQuery` | Semantic concept search (finds by meaning, not exact words) |
| `parentNotation` | Restrict results to a subtree (e.g. `"11F"` for Virgin Mary) |
| `onlyWithArtworks` | Filter to notations with artworks in any loaded collection |
| `collectionId` | Filter to a specific collection (e.g. `"rijksmuseum"`) |
| `lang` | Preferred language for labels (default: `en`) |
| `maxResults` | 1–50 (default 25) |

Provide exactly one of `query` or `semanticQuery`.

### `browse` — navigate the hierarchy

Explore a notation's place in the tree: path, children (expandable to depth 1–3), cross-references, key variants.

```
notation: "73D", depth: 2  → Passion of Christ, children + grandchildren
notation: "25F23", includeKeys: true  → 204 key-expanded variants
```

### `resolve` — batch notation lookup

Look up one or more notations by code. Accepts a single string or an array of up to 25.

```
notation: ["73D6", "31A33", "25F23"]  → full metadata for each
```

### `expand_keys` — key variant exploration

Given a base notation, return all its key-expanded variants with texts and counts.

```
notation: "25F23"  → 204 variants (swimming, sleeping, fighting, etc.)
```

### `search_prefix` — hierarchical subtree search

Find all notations under a hierarchy prefix. Leverages Iconclass's left-to-right encoding.

```
notation: "73D8"  → 8 notations under "instruments of the Passion"
notation: "25F"   → all animal notations
```

### `find_adopters` — which collections have this subject?

Given one or more notations, find which external art collections have artworks tagged with those notations. Returns per-collection counts and link-out URLs.

```
notation: "73B57"  → Rijksmuseum: 429, RKD: 1,390, Arkyves: 245
notation: ["73D6", "92D192134"]  → batch lookup across collections
```

Currently includes three collections:
- **Rijksmuseum, Amsterdam** — 24,066 notations (count only; use [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus) for artwork search)
- **RKD — Netherlands Institute for Art History** — 13,984 notations with search link-out
- **Arkyves** — 34,721 notations with search link-out

## Typical workflow

1. **Search** for a concept: `search({ semanticQuery: "religious suffering" })`
2. **Browse** the hierarchy to find the right specificity level
3. **Find adopters** to see which collections have artworks with that subject: `find_adopters({ notation: "73D6" })`
4. **Follow links** to browse artworks at the RKD or Arkyves, or **pass the notation** to a collection server's search (e.g., `search_artwork(iconclass: "73D6")` in [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus))

This two-server workflow separates the classification vocabulary (this server) from collection-specific search (the Rijksmuseum server). When both servers are connected, the LLM can automatically follow up on `find_adopters` results by calling the Rijksmuseum server's `search_artwork` tool.

For more detailed examples — sensory history, finding saints, navigating the hierarchy, classifying complex scenes — see [Example Prompts](docs/example-prompts.md).

## Collection counts

Artwork counts per notation live in a separate **sidecar database** (`iconclass-counts.db`, ~3.8 MB) so they can be updated independently of the main 3 GB notation/text/embedding database. Three collection overlays ship by default: Rijksmuseum (24,066 notations), RKD (13,984), and Arkyves (34,721) — totalling 72,771 notation counts.

Each collection can optionally include a `search_url_template` for generating link-out URLs (e.g. `https://research.rkd.nl/en/search?q={notation}&...`). The `find_adopters` tool uses these templates to produce clickable links alongside counts.

To add or update collections, rebuild only the sidecar — no need to touch the main DB:

```bash
# Export counts from your collection database
# CSV format: notation,count (one per line)
python scripts/export-collection-counts.py --vocab-db path/to/vocab.db --output data/my-museum-counts.csv

# Build the counts sidecar with multiple overlays
python scripts/build-counts-db.py \
  --counts-csv data/rijksmuseum-counts.csv \
  --counts-csv data/rkd-counts.csv \
  --counts-csv data/arkyves-counts.csv \
  --counts-csv data/my-museum-counts.csv
```

Results then show counts per collection: `73D6 (rijksmuseum: 371, rkd: 45, my-museum: 12)`. To add search link-out URLs for a new collection, add an entry to `COLLECTION_META` in `build-counts-db.py`.

## Building the database

The database is built from the [Iconclass CC0 data dump](https://github.com/iconclass/data) and the [`iconclass`](https://pypi.org/project/iconclass/) Python library.

```bash
# Clone the CC0 data
git clone https://github.com/iconclass/data /tmp/iconclass-data

# Install Python dependencies
uv pip install iconclass

# Build the main DB (takes ~6 minutes)
python scripts/build-iconclass-db.py \
  --data-dir /tmp/iconclass-data \
  --output data/iconclass.db

# Build the counts sidecar (~instant)
python scripts/build-counts-db.py \
  --counts-csv data/rijksmuseum-counts.csv \
  --counts-csv data/rkd-counts.csv \
  --counts-csv data/arkyves-counts.csv
```

### Adding semantic embeddings

Embeddings enable the `semanticQuery` parameter. Generation uses [Modal](https://modal.com) for cloud GPU access (free tier works).

```bash
uv pip install modal sqlite-vec numpy
modal setup  # one-time auth

modal run scripts/generate-embeddings-modal.py
```

This embeds ~40K base notations using `intfloat/multilingual-e5-base` (768d, int8). Takes ~4 minutes on an A10G GPU. Key-expanded notations are not embedded — they are searchable via FTS.

### Releasing the database

The main database is ~1 GB compressed — too large for a single reliable upload on slow connections. The release script splits it into 200 MB chunks and uploads each as a separate GitHub release asset, with automatic retry on failure:

```bash
# Compress the database
gzip -k data/iconclass.db

# Split and upload to a release
scripts/split-for-release.sh v0.1.0
```

The server's download logic auto-detects chunked assets (`.part-aa`, `.part-ab`, …), downloads them in sequence, reassembles, and decompresses. Single-file uploads are still supported as a fallback.

## Data sources

| Source | Content | License |
|--------|---------|---------|
| [iconclass/data](https://github.com/iconclass/data) | 1.3M notations, texts in 13 languages, keywords, hierarchy | CC0 |
| [iconclass](https://pypi.org/project/iconclass/) Python library | Text composition for key-expanded notations | CC0 |
| [Rijksmuseum vocabulary.db](https://github.com/kintopp/rijksmuseum-mcp-plus) | Artwork counts per notation (24K notations) | MIT |
| [RKD Knowledge Graph](https://triplydb.com/rkd/RKD-Knowledge-Graph) | Artwork counts per notation (14K notations) | ODC-By 1.0 |
| [Iconclass AI Test Set](https://iconclass.org/testset/) | Arkyves artwork counts per notation (35K notations, derived from data.json) | CC0 |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | — | Set to enable HTTP mode (e.g. `3000`) |
| `ICONCLASS_DB_PATH` | `data/iconclass.db` | Main database (notations, texts, keywords, embeddings) |
| `ICONCLASS_DB_URL` | — | URL to download main DB if missing (supports `.gz`) |
| `COUNTS_DB_PATH` | `data/iconclass-counts.db` | Sidecar database (collection counts) |
| `COUNTS_DB_URL` | — | URL to download counts DB if missing (supports `.gz`) |
| `EMBEDDING_MODEL_ID` | `Xenova/multilingual-e5-base` | HuggingFace model for query embedding |
| `HF_HOME` | — | HuggingFace cache directory |
| `ALLOWED_ORIGINS` | `*` | CORS origins for HTTP mode |
| `STRUCTURED_CONTENT` | `true` | Set `false` to disable `outputSchema` |

## Performance

| Operation | Local | Production | Notes |
|-----------|-------|------------|-------|
| FTS search (844 hits) | ~7ms | ~60ms | "crucifixion" |
| FTS search (8.5K hits) | ~26ms | ~85ms | "horse" |
| FTS search (28.7K hits) | ~137ms | ~203ms | "portrait" |
| Semantic search | ~51ms | ~115ms | vec0 KNN over 40K embeddings + query encoding |
| Browse | ~1ms | ~54ms | B-tree lookup + child resolution |
| Browse with key variants | ~1ms | ~58ms | Default page of 25 key variants |
| Resolve (batch of 15) | ~1ms | ~54ms | 15 notations with full metadata |
| Find adopters | ~1ms | — | Per-notation count lookup across 3 collections |
| Prefix search | ~113ms | ~196ms | Depends on subtree size; accurate COUNT query |
| Server cold start | ~8s | ~77s | Local: embedding model only. Production: chunked DB download + decompression |

**Local:** Apple M4, 24 GB unified memory, warm mmap caches. **Production:** Railway, warm caches (2026-04-03). Production times are median of 5 runs, including network round-trip.

## Notes

### Embedding model

The server uses [`intfloat/multilingual-e5-base`](https://huggingface.co/intfloat/multilingual-e5-base) for semantic search — a 278M-parameter multilingual model that produces 768-dimensional embeddings. It was chosen because it supports 100+ languages and runs efficiently on CPU via 8-bit ONNX quantisation (~350 MB memory). The base variant (768d) was preferred over the small variant (384d) for better discrimination between closely related concepts.

E5-base has a 512-token context window. The composite texts fed to the model (label + Dutch label + keywords + category path) have a mean length of 122 and a 99th percentile of 298. A single entry in the taxonomy tops out at 478 tokens. The model's token limit is therefore not a constraint.

### Semantic search and Iconclass structure

Semantic search embeddings are built from a composite text that includes each notation's label, keywords, and full category path (e.g., "Religion and Magic > non-Christian religions > Mithraism and other Hellenistic..."). Because Iconclass labels are often inherited verbatim from parent to child, notations deep in verbose branches end up with the same qualifying phrase repeated at every level of the path. The embedding model sees this repetition as emphasis, which means **deep notations in long-named branches are over-represented in embedding space** relative to equally relevant notations in shallower or more concisely named parts of the hierarchy. A broad semantic query like "ancient religion" will favour the Mithraism subtree (9 levels, verbose labels) over a structurally simpler branch that may be just as relevant.

In practice, this may rarely matter — semantic search is a fallback for when the exact vocabulary term is unknown, and FTS keyword search is unaffected by these structural biases.

Other, more minor biases to be aware of: named notations like `11H(JOHN)` embed the name itself, so saints or figures with common English names may rank slightly higher than those with non-English names; the composite text mixes English and Dutch keywords, which can give a small boost to notations that happen to have Dutch keywords matching a query; and structural placeholder notations like `25F23(...)` ("beasts of prey, with NAME") sit in a generic part of embedding space and can surface as top results for broad queries even though they are not real subject entries.

### Limits, defaults, and response sizing

The constants below were chosen by profiling the Iconclass database, balancing response size (protecting the LLM's context window) against round-trip overhead (each tool call costs several seconds of LLM reasoning time).

#### Result pages

A resolved Iconclass entry averages ~350 bytes of JSON (median). At the default page size of 25, a typical `search` response is ~8 KB (~2,300 tokens) — roughly 1% of a 200K-token context window. At the maximum of 50 results, responses reach ~16 KB (~4,600 tokens). Both leave ample room for LLM reasoning.

FTS queries return anywhere from ~800 unique notations ("crucifixion") to ~30,000 ("portrait"). Results are sorted by total collection count so the most relevant notations appear first regardless of page size. The fixed cost of the FTS scan dominates — returning 10 or 50 results takes roughly the same time.

`search_prefix` allows up to 100 results per page (default 25). Broad prefixes can match very large subtrees — e.g. `7%` spans ~89K notations, of which ~3K have Rijksmuseum artworks. To discourage LLMs from exhaustively paginating these, the tool description and response text nudge the caller to narrow the prefix rather than page through thousands of results. The `totalResults` count is always accurate (computed via SQL `COUNT` for unfiltered queries, or batch-filtered for collection-scoped queries).

#### Browse depth and subtree caps

The `browse` tool supports `depth` 1–3 for recursive child expansion. The Iconclass tree has a skewed fanout: the median node has 0 children (leaf), P95 is 6, but the widest node has 183 (`11H(...)`, saints by name). Subtree sizes at each depth level vary dramatically:

| Notation | d+1 | d+2 | d+3 |
|----------|-----|-----|-----|
| `73D82` (road to Calvary) | 1 | 10 | 11 |
| `25F` (animals) | 9 | 46 | 85 |
| `11H` (saints) | 1 | 192 | 1,837 |

To prevent wide branches from flooding the context window, two caps apply:
- **Per-parent cap** of 25 children — wide branches self-document via `totalChildren` count vs entries shown
- **Total subtree cap** of 250 entries — a hard safety net across all depth levels

At ~350 bytes per entry, a full 250-entry subtree is ~85 KB (~25K tokens) — substantial but bounded. Narrow branches (the common case) are returned complete with no truncation.

#### Key variant distribution

81% of base notations have 25 or fewer key variants, so the default page of 25 captures most notations in a single call. The maximum of 335 matches the largest notation in the database and eliminates pagination entirely — important because each pagination round-trip costs the user several seconds of LLM reasoning time, far more than the ~9 ms the database needs to resolve 335 variants.

#### Semantic search with collection filters

When `collectionId` or `onlyWithArtworks` is set, the semantic path over-fetches from the KNN index (up to `k × 20`, capped at 4,096 candidates) and then batch-filters by collection count before resolving entries. This ensures the requested page fills reliably even when the target collection covers a small fraction of the embedding space. Without a filter, the index returns exactly `k` neighbors with no over-fetch.

#### Resolve batch limit

The resolve tool accepts up to 25 notations per call (default 15). This is intentionally conservative — a 25-entry resolve response is ~8 KB, and the SKILL.md coaches LLMs to "use search for discovery, resolve only for the 3–5 you need full metadata on."

#### Keywords

The per-notation keyword limit of 40 matches the observed maximum in the database, so no keywords are truncated. The 99th percentile is 9 keywords; only 705 notations (0.04%) exceed 20. These are concentrated in a few keyword-heavy base notations — notably `46C1313` ("equestrian statue", 28 keywords listing famous statues by name), `23K` ("labours of the months", 30 keywords), and saint notations like `11H(THOMAS AQUINAS)`. Key-expanded variants of these inherit the base keywords and add modifier keywords on top, reaching up to 40.

#### Collection count sparsity

With three collection overlays, ~5.6% of notations have artwork counts (73K of 1.3M). The `collectionCounts` field is empty for the vast majority of entries, adding negligible overhead. The `onlyWithArtworks` and `collectionId` filters are aggressive narrowers — useful when the caller only needs notations that appear in a specific collection. Each collection's `totalArtworks` in the sidecar DB reflects the number of distinct notations with artworks in that collection (not the number of artworks themselves, which cannot be derived from notation-level counts).

#### FTS multi-word fallback

Multi-word queries try phrase match first (adjacent words, high precision), then fall back to AND-ed individual terms if the phrase returns zero results. This adds at most two extra FTS queries on the zero-result path — negligible given sub-millisecond FTS query times on the mmap'd database.

## Citation

If you use rijksmuseum-iconclass-mcp in your research, please cite it as follows. A `CITATION.cff` file is included for use with Zotero, GitHub's "Cite this repository" button, and other reference managers.

**APA (7th ed.)**

> Bosse, A. (2026). *rijksmuseum-iconclass-mcp* (Version 0.1.0) [Software]. Research and Infrastructure Support (RISE), University of Basel. https://github.com/kintopp/rijksmuseum-iconclass-mcp

**BibTeX**
```bibtex
@software{bosse_2026_rijksmuseum_iconclass_mcp,
  author    = {Bosse, Arno},
  title     = {{rijksmuseum-iconclass-mcp}},
  year      = {2026},
  version   = {0.1.0},
  publisher = {Research and Infrastructure Support (RISE), University of Basel},
  url       = {https://github.com/kintopp/rijksmuseum-iconclass-mcp},
  orcid     = {0000-0003-3681-1289},
  note      = {Developed with Claude Code (Anthropic, \url{https://www.anthropic.com})}
}
```

## License

MIT

## Acknowledgements

The [Iconclass](https://iconclass.org) classification system was created by Henri van de Waal and is maintained by the Iconclass Foundation. The [data](https://github.com/iconclass/data) used in this server is published under a Creative Commons CC0 license.
