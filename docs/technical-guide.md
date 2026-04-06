## Technical Guide

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

## Artwork counts

Artwork count data lives in a separate **sidecar database** (`iconclass-counts.db`, ~1.4 MB) so it can be updated independently of the main 3 GB notation/text/embedding database. The Rijksmuseum collection overlay ships by default with 24,066 notations and per-notation artwork counts. The `find_artworks` tool returns these counts; the other tools use the sidecar for presence filtering (`onlyWithArtworks`, `collectionId`).

Each collection can optionally include a `search_url_template` for generating link-out URLs. The `find_artworks` tool uses these templates to produce clickable links.

To update the Rijksmuseum counts or add a new collection, rebuild only the sidecar — no need to touch the main DB:

```bash
# Export counts from the Rijksmuseum vocabulary database
python scripts/export-collection-counts.py --vocab-db path/to/vocab.db --output data/rijksmuseum-counts.csv

# Build the sidecar
python scripts/build-counts-db.py \
  --counts-csv data/rijksmuseum-counts.csv
```

To add a new collection, create a CSV (`notation,count`), add an entry to `COLLECTION_META` in `build-counts-db.py`, and pass the CSV as an additional `--counts-csv` argument.

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
  --counts-csv data/rijksmuseum-counts.csv
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

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | — | Set to enable HTTP mode (e.g. `3000`) |
| `ICONCLASS_DB_PATH` | `data/iconclass.db` | Main database (notations, texts, keywords, embeddings) |
| `ICONCLASS_DB_URL` | — | URL to download main DB if missing (supports `.gz`) |
| `COUNTS_DB_PATH` | `data/iconclass-counts.db` | Sidecar database (artwork counts) |
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
| Find artworks | ~1ms | — | Per-notation artwork count lookup (Rijksmuseum) |
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

#### Artwork count sparsity

With the Rijksmuseum collection overlay, ~1.5% of notations have artwork counts (20K of 1.3M). The `collections` field is empty for the vast majority of entries, adding negligible overhead. The `onlyWithArtworks` and `collectionId` filters are aggressive narrowers — useful when the caller only needs notations that appear in the Rijksmuseum. The collection's `totalNotations` reflects the number of distinct notations with artworks (computed at runtime by joining against the main notations table to exclude malformed entries).

#### FTS multi-word fallback

Multi-word queries try phrase match first (adjacent words, high precision), then fall back to AND-ed individual terms if the phrase returns zero results. This adds at most two extra FTS queries on the zero-result path — negligible given sub-millisecond FTS query times on the mmap'd database.
