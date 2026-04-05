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

Given a base notation, return all its key-expanded variants with texts and collection presence.

```
notation: "25F23"  → 204 variants (swimming, sleeping, fighting, etc.)
```

### `search_prefix` — hierarchical subtree search

Find all notations under a hierarchy prefix. Leverages Iconclass's left-to-right encoding.

```
notation: "73D8"  → 8 notations under "instruments of the Passion"
notation: "25F"   → all animal notations
```

### `find_artworks` — which collections have this subject?

Given one or more notations, check which external art collections have artworks tagged with those notations. Returns collection presence and link-out URLs where available. An empty `collections` array means no loaded collection has artworks for that notation — try a parent or sibling notation instead.

```
notation: "73B57"  → Rijksmuseum, RKD → https://..., Arkyves → https://...
notation: ["73D6", "92D192134"]  → batch lookup across collections
```

Currently includes three collections:

- **Rijksmuseum, Amsterdam** — use [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus) for artwork search
- **RKD — Netherlands Institute for Art History** — 1with search link-out
- **Arkyves** — with search link-out

## Typical workflow

1. **Search** for a concept: `search({ semanticQuery: "religious suffering" })`
2. **Browse** the hierarchy to find the right specificity level
3. **Check collections** for that subject: `find_artworks({ notation: "73D6" })`
4. **Follow links** to browse artworks at the RKD or Arkyves, or **pass the notation** to a collection server's search (e.g., `search_artwork(iconclass: "73D6")` in [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus))

This two-server workflow separates the classification vocabulary (this server) from collection-specific search (the Rijksmuseum server). When both servers are connected, the LLM can automatically follow up on `find_artworks` results by calling the Rijksmuseum server's `search_artwork` tool.

For more detailed examples — sensory history, finding saints, navigating the hierarchy, classifying complex scenes — see [Example Prompts](docs/example-prompts.md).

## Collection presence

Collection presence data lives in a separate **sidecar database** (`iconclass-counts.db`, ~3.8 MB) so it can be updated independently of the main 3 GB notation/text/embedding database. Three collection overlays ship by default: Rijksmuseum (24,066 notations), RKD (13,984), and Arkyves (34,721) — totalling 72,771 notation-collection pairs. A row in the sidecar means "this collection has artworks for this notation"; absence means either no artworks or the collection hasn't been checked for that notation. The `collections` metadata returned by every tool lists all loaded collections, so consumers can distinguish "checked, not present" from "not checked."

Each collection can optionally include a `search_url_template` for generating link-out URLs (e.g. `https://research.rkd.nl/en/search?q={notation}&...`). The `find_artworks` tool uses these templates to produce clickable links.

To add or update collections, rebuild only the sidecar — no need to touch the main DB:

```bash
# Export presence data from your collection database
# CSV format: notation,count (one per line; any positive count = present)
python scripts/export-collection-counts.py --vocab-db path/to/vocab.db --output data/my-museum-counts.csv

# Build the sidecar with multiple overlays
python scripts/build-counts-db.py \
  --counts-csv data/rijksmuseum-counts.csv \
  --counts-csv data/rkd-counts.csv \
  --counts-csv data/arkyves-counts.csv \
  --counts-csv data/my-museum-counts.csv
```

Results then show which collections have artworks: `73D6 (rijksmuseum, rkd, my-museum)`. To add search link-out URLs for a new collection, add an entry to `COLLECTION_META` in `build-counts-db.py`.

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
| [Rijksmuseum vocabulary.db](https://github.com/kintopp/rijksmuseum-mcp-plus) | Artwork presence per notation (24K notations) | MIT |
| [RKD Knowledge Graph](https://triplydb.com/rkd/RKD-Knowledge-Graph) | Artwork presence per notation (14K notations) | ODC-By 1.0 |
| [Iconclass AI Test Set](https://iconclass.org/testset/) | Arkyves artwork presence per notation (35K notations, derived from data.json) | CC0 |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | — | Set to enable HTTP mode (e.g. `3000`) |
| `ICONCLASS_DB_PATH` | `data/iconclass.db` | Main database (notations, texts, keywords, embeddings) |
| `ICONCLASS_DB_URL` | — | URL to download main DB if missing (supports `.gz`) |
| `COUNTS_DB_PATH` | `data/iconclass-counts.db` | Sidecar database (collection presence) |
| `COUNTS_DB_URL` | — | URL to download sidecar DB if missing (supports `.gz`) |
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
| Find artworks | ~1ms | — | Per-notation presence lookup across 3 collections |
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

FTS queries return anywhere from ~800 unique notations ("crucifixion") to ~30,000 ("portrait"). Results are sorted by collection coverage (number of collections with artworks) so widely-represented notations appear first regardless of page size. The fixed cost of the FTS scan dominates — returning 10 or 50 results takes roughly the same time.

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

When `collectionId` or `onlyWithArtworks` is set, the semantic path over-fetches from the KNN index (up to `k × 20`, capped at 4,096 candidates) and then batch-filters by collection presence before resolving entries. This ensures the requested page fills reliably even when the target collection covers a small fraction of the embedding space. Without a filter, the index returns exactly `k` neighbors with no over-fetch.

#### Resolve batch limit

The resolve tool accepts up to 25 notations per call (default 15). This is intentionally conservative — a 25-entry resolve response is ~8 KB, and the SKILL.md coaches LLMs to "use search for discovery, resolve only for the 3–5 you need full metadata on."

#### Keywords

The per-notation keyword limit of 40 matches the observed maximum in the database, so no keywords are truncated. The 99th percentile is 9 keywords; only 705 notations (0.04%) exceed 20. These are concentrated in a few keyword-heavy base notations — notably `46C1313` ("equestrian statue", 28 keywords listing famous statues by name), `23K` ("labours of the months", 30 keywords), and saint notations like `11H(THOMAS AQUINAS)`. Key-expanded variants of these inherit the base keywords and add modifier keywords on top, reaching up to 40.

#### Collection presence sparsity

With three collection overlays, ~5.6% of notations have collection presence (73K of 1.3M). The `collections` field is empty for the vast majority of entries, adding negligible overhead. The `onlyWithArtworks` and `collectionId` filters are aggressive narrowers — useful when the caller only needs notations that appear in a specific collection. Each collection's `totalNotations` reflects the number of distinct notations with artworks in that collection (computed at runtime by joining against the main notations table to exclude malformed entries).

#### FTS multi-word fallback

Multi-word queries try phrase match first (adjacent words, high precision), then fall back to AND-ed individual terms if the phrase returns zero results. This adds at most two extra FTS queries on the zero-result path — negligible given sub-millisecond FTS query times on the mmap'd database.