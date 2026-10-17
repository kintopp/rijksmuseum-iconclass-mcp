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

On first run, the server downloads `iconclass.db` (~0.7 GB compressed) to `data/` if `ICONCLASS_DB_URL` is set. Subsequent starts are fast.

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
`scripts/tests/`, run via npm. All of them need a built `dist/`.

| Command | Layer | Requires |
|---------|-------|----------|
| `npm test` | Pure-function, unit, tool-level, HTTP concurrency and 2026-07-28 wire tests | nothing — tool-level suites run on a small fixture DB built from `fixtures/` |
| `npm run test:fixture` | Just the fixture-backed tool suite | nothing |
| `npm run test:modern` / `test:http` | Just the 2026-07-28 wire / HTTP concurrency suite | nothing |
| `npm run test:tools` | Real-DB suite: semantic search, ranking at full volume | `data/iconclass.db` + the embedding model |
| `npm run test:all` | `npm test` + `test:tools` | as `test:tools` |

CI runs `npm test`; only `test:tools` needs to be run by hand.

## Artwork counts

Artwork count data lives in a separate **sidecar database** (`iconclass-counts.db`, ~1.4 MB) so it can be updated independently of the main 3 GB notation/text/embedding database. The Rijksmuseum collection overlay ships by default with ~20,200 notations and per-notation artwork counts. The `find_artworks` tool returns these counts; the other tools use the sidecar for presence filtering (`onlyWithArtworks`, `collectionId`).

Each collection can optionally include a `search_url_template` for generating link-out URLs. The `find_artworks` tool uses these templates to produce clickable links.

To update the Rijksmuseum counts or add a new collection, rebuild only the sidecar — no need to touch the main DB:

```bash
# Export counts from the Rijksmuseum vocabulary database
python scripts/export-collection-counts.py --vocab-db path/to/vocab.db --output data/rijksmuseum-counts.csv

# Build the sidecar
python scripts/build-counts-db.py \
  --counts-csv data/rijksmuseum-counts.csv \
  --release-tag counts-latest
```

To add a new collection, create a CSV (`notation,count`), add an entry to `COLLECTION_META` in `build-counts-db.py`, and pass the CSV as an additional `--counts-csv` argument.

## Building the database

The database is built from the [Iconclass CC0 data dump](https://github.com/iconclass/data) and the [`iconclass`](https://pypi.org/project/iconclass/) Python library, then completed by importing the semantic embeddings. **Both steps are required:** the build alone writes `schema_version` 3, and the server only accepts a DB at version 4 or later, which the embeddings import sets.

```bash
# Clone the CC0 data
git clone https://github.com/iconclass/data /tmp/iconclass-data

# Install Python dependencies
uv pip install iconclass modal sqlite-vec numpy

# 1. Build the main DB (takes ~6 minutes)
python scripts/build-iconclass-db.py \
  --data-dir /tmp/iconclass-data \
  --output data/iconclass.db

# 2. Generate and import embeddings (enables semanticQuery)
modal setup  # one-time auth
modal run scripts/generate-embeddings-modal.py   # → data/iconclass-gemma.npz
python scripts/import-gemma-embeddings.py --npz data/iconclass-gemma.npz --db data/iconclass.db

# Build the counts sidecar (~instant)
python scripts/build-counts-db.py \
  --counts-csv data/rijksmuseum-counts.csv \
  --release-tag counts-latest
```

Embedding generation uses [Modal](https://modal.com) for cloud GPU access (free tier works). It embeds ~40K base notations with `google/embeddinggemma-2` (768d) on an A10G GPU; the import step quantises them to int8 and records the document and query model revisions in `version_info`. Key-expanded notations are not embedded — they are searchable via FTS.

The Modal script reads `HF_TOKEN` from a Modal secret (default name `huggingface-secret`, override with `HF_SECRET_NAME`):

```bash
modal secret create huggingface-secret HF_TOKEN=hf_...
```

### Releasing the database

The main database lives on the rolling `iconclass-db-latest` release tag, not on versioned releases. At ~0.7 GB compressed it is too large for a single reliable upload, so the release script splits it into 200 MB chunks and uploads each as a separate asset, with automatic retry on failure.

Delete the old assets first. `--clobber` overwrites same-named chunks but leaves orphans, and a leftover `part-*` from a larger previous build corrupts reassembly.

```bash
gzip -k data/iconclass.db

for a in $(gh release view iconclass-db-latest --json assets --jq '.assets[].name'); do
  gh release delete-asset iconclass-db-latest "$a" --yes
done

scripts/split-for-release.sh iconclass-db-latest
```

The server's download logic auto-detects chunked assets (`.part-aa`, `.part-ab`, …), downloads them in sequence, reassembles, and decompresses. Single-file uploads are still supported as a fallback.

## Data sources

| Source | Content | License |
|--------|---------|---------|
| [iconclass/data](https://github.com/iconclass/data) | 1.3M notations, texts in 13 languages, keywords, hierarchy | CC0 |
| [iconclass](https://pypi.org/project/iconclass/) Python library | Text composition for key-expanded notations | CC0 |
| [Rijksmuseum vocabulary.db](https://github.com/kintopp/rijksmuseum-mcp-plus) | Artwork counts per notation (22.8K rows, ~20.2K matching valid notations) | MIT |

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

## Notes

### Search ranking

**Keyword search** tries the multi-word query as a phrase first, then falls back to AND-ed individual terms if the phrase matches nothing. Results are ranked by collection coverage (number of collections with artworks), then by FTS relevance.

**Semantic search** uses [`google/embeddinggemma-2`](https://huggingface.co/google/embeddinggemma-2), the same model as the Rijksmuseum server, so both share one 768-dimensional vector space. Only base notations are embedded. The server holds all ~40K int8 vectors in memory (~40 MB) and ranks them in two passes: the first 256 dimensions pick 500 candidates, which are rescored on all 768. Filters (`collectionId`, `onlyWithArtworks`, `parentNotation`) are applied *before* ranking, so a filtered page holds the true top-k within the filter; filtered sets of ≤2,000 rows are ranked exactly. Results are ranked by similarity only. The DB records which query model its vectors were built for, and the server disables semantic search rather than rank against a mismatched model.

### Limits

Limits are sized to keep responses well inside an LLM's context window (an entry averages ~350 bytes of JSON) while avoiding pagination round-trips.

| Tool / field | Default | Max |
|--------------|---------|-----|
| `search` results | 25 | 50 |
| `search_prefix` results | 25 | 100 |
| `resolve` notations per call | 15 | 25 |
| `browse` depth | 1 | 3 |
| `browse` children | 25 per parent, 250 per subtree | — |
| Key variants (`browse`, `expand_keys`) | 25 | 335 — the largest notation in the DB |
| Keywords per notation | — | 40 — the largest in the DB, so none are truncated |
