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

### Testing

There is no test framework — the suites are standalone Node scripts under
`scripts/tests/`, run via npm:

| Command | Layer | Requires |
|---------|-------|----------|
| `npm test` | Pure-function + unit tests | nothing (runs in CI) |
| `npm run test:tools` | Integration tests via the MCP client | the main `data/iconclass.db` |
| `npm run test:http` | HTTP concurrency smoke test | a built `dist/` |

Only `npm test` runs in CI; the integration layer needs the large database, so
run it locally.

## Artwork counts

Artwork count data lives in a separate **sidecar database** (`iconclass-counts.db`, ~1.4 MB) so it can be updated independently of the main 3 GB notation/text/embedding database. The Rijksmuseum collection overlay ships by default with ~20,200 notations and per-notation artwork counts. The `find_artworks` tool returns these counts; the other tools use the sidecar for presence filtering (`onlyWithArtworks`, `collectionId`).

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

modal run scripts/generate-embeddings-modal.py   # → data/iconclass-gemma.npz
python scripts/import-gemma-embeddings.py --npz data/iconclass-gemma.npz --db data/iconclass.db
```

This embeds ~40K base notations with `google/embeddinggemma-2` (768d) on an A10G GPU; the import step quantises them to int8 and records the document and query model revisions in `version_info`. Key-expanded notations are not embedded — they are searchable via FTS.

The script reads `HF_TOKEN` from a Modal secret (default name `huggingface-secret`, override with `HF_SECRET_NAME`):

```bash
modal secret create huggingface-secret HF_TOKEN=hf_...
```

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
| `EMBEDDING_MODEL_DTYPE` | `q8` | Query encoder ONNX precision: `q8` ≈ +480 MB RSS / ~120 ms per query on Railway, `fp32` ≈ +1 GB / ~28 ms |
| `EMBEDDING_THREADS` | `2` | onnxruntime intra-op threads for the query encoder (it otherwise sizes to visible cores, not the container's CPU quota) |
| `HF_HOME` | — | HuggingFace cache directory |
| `ALLOWED_ORIGINS` | `*` | CORS origins for HTTP mode |
| `STRUCTURED_CONTENT` | `true` | Set `false` to disable `outputSchema` |
| `USAGE_STATS_PATH` | `data/usage-stats.json` | Per-tool call/error/latency counters (flushed hourly + on shutdown). The default lives inside the image and is clobbered on every redeploy — set this to a path on the Railway volume to persist across restarts. |

## HTTP endpoints

In HTTP mode (`PORT` set or `--http`):

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | Stateless Streamable HTTP MCP endpoint |
| `GET` | `/health` | Liveness + DB/model readiness |
| `GET` | `/debug/memory` | Process + DB memory snapshot (issue #272) |
| `GET` | `/debug/stats` | Per-tool call/error/latency counters since `since`, backed by `USAGE_STATS_PATH` (flushed hourly + on shutdown) |

`/debug/memory` and `/debug/stats` are unauthenticated by convention — operational signals only (no inputs, no PII), matching `/health`.

## Performance

| Operation | Local | Production | Notes |
|-----------|-------|------------|-------|
| FTS search (844 hits) | ~7ms | ~60ms | "crucifixion" |
| FTS search (8.5K hits) | ~26ms | ~85ms | "horse" |
| FTS search (28.7K hits) | ~137ms | ~203ms | "portrait" |
| Semantic search | ~200ms | — | Query encoding (q8, ~180 ms on M4) + in-memory two-pass KNN (~20 ms) |
| Browse | ~1ms | ~54ms | B-tree lookup + child resolution |
| Browse with key variants | ~1ms | ~58ms | Default page of 25 key variants |
| Resolve (batch of 15) | ~1ms | ~54ms | 15 notations with full metadata |
| Find artworks | ~1ms | — | Per-notation artwork count lookup (Rijksmuseum) |
| Prefix search | ~113ms | ~196ms | Depends on subtree size; accurate COUNT query |
| Server cold start | ~8s | ~77s | Local: embedding model only. Production: chunked DB download + decompression |

**Local:** Apple M4, 24 GB unified memory, warm mmap caches. **Production:** Railway, warm caches (2026-04-03). Production times are median of 5 runs, including network round-trip.

## Notes

### Embedding model

The server uses [`google/embeddinggemma-2`](https://huggingface.co/google/embeddinggemma-2) for semantic search — the same model as the Rijksmuseum server, so query and notation vectors share one 768-dimensional space across both. Notations are embedded as documents (`title: none | text: …`) and queries with the `task: search result | query: ` prefix. At query time the server loads only the text tower of the pinned [`onnx-community/embeddinggemma-2-ONNX`](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) export; the vision and audio encoders would add ~325 MB for nothing. The DB records which query model its vectors were built for, and the server disables semantic search rather than rank against a mismatched model.

The composite texts (label + Dutch label + keywords + category path) average 105 Gemma tokens, with a 99th percentile of 246 and a maximum of 381 — well inside the 1,024-token cap used when embedding them.

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

#### Semantic search ranking and filters

The server holds all ~40K int8 vectors in memory (~40 MB, loaded during background warm-up) and ranks them in two passes: cosine over the first 256 dimensions (an MRL prefix) picks 500 candidates, which are rescored on the full 768. `collectionId`, `onlyWithArtworks` and `parentNotation` narrow the candidate rows *before* ranking, so a filtered page holds the true top-k within the filter rather than what survives a post-filter. Filtered sets of ≤2,000 rows skip the first pass and are ranked exactly.

#### Resolve batch limit

The resolve tool accepts up to 25 notations per call (default 15). This is intentionally conservative — a 25-entry resolve response is ~8 KB, and the SKILL.md coaches LLMs to "use search for discovery, resolve only for the 3–5 you need full metadata on."

#### Keywords

The per-notation keyword limit of 40 matches the observed maximum in the database, so no keywords are truncated. The 99th percentile is 9 keywords; only 705 notations (0.04%) exceed 20. These are concentrated in a few keyword-heavy base notations — notably `46C1313` ("equestrian statue", 28 keywords listing famous statues by name), `23K` ("labours of the months", 30 keywords), and saint notations like `11H(THOMAS AQUINAS)`. Key-expanded variants of these inherit the base keywords and add modifier keywords on top, reaching up to 40.

#### Artwork count sparsity

With the Rijksmuseum collection overlay, ~1.5% of notations have artwork counts (20K of 1.3M). The `collections` field is empty for the vast majority of entries, adding negligible overhead. The `onlyWithArtworks` and `collectionId` filters are aggressive narrowers — useful when the caller only needs notations that appear in the Rijksmuseum. The collection's `totalNotations` reflects the number of distinct notations with artworks (computed at runtime by joining against the main notations table to exclude malformed entries).

#### FTS multi-word fallback

Multi-word queries try phrase match first (adjacent words, high precision), then fall back to AND-ed individual terms if the phrase returns zero results. This adds at most two extra FTS queries on the zero-result path — negligible given sub-millisecond FTS query times on the mmap'd database.
