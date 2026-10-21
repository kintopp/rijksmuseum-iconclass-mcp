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

### CLI

`icmcp` (`scripts/cli.mjs`) is a headless command-line client for the six tools. It is an MCP *client* that drives the real server, so a CLI query returns exactly what an LLM gets. Run it as `npm run cli -- <command> …`, or run `npm link` once to put `icmcp` on your `PATH`.

```bash
icmcp search "crucifixion" --max 5 --fields notation,text     # JSONL, one row per line
icmcp semantic "grief and mourning" --max 5                   # semanticQuery mode of `search`
icmcp browse 73D8 --depth 2 --json                            # one object; --json pretty-prints all of it
icmcp resolve 25F23 "25F23(+46)" 73D82                        # several codes in one call
icmcp keys 25F23 --max 5 --table                              # expand_keys
icmcp prefix 73D8 --offset 25                                 # search_prefix
icmcp artworks 73D6 "73D82(CROSS)"                            # find_artworks
cat codes.txt | icmcp resolve --stdin                         # batches of up to 25 codes per call
icmcp tools --compact                                         # capability manifest for agents
```

- **Output.** List commands print JSONL on stdout and `browse` prints one JSON object. Counts, paging hints (`pass --offset N for more`) and `note:` lines go to stderr. The notes restate caveats that only the tools' text output carries, such as codes in `notFound`, codes with no label, key variants beyond the page, and capped subtrees. `--fields a,b,c` keeps only those keys in each row, `--table` prints a terse table, and `--quiet` silences stderr.
- **Flags.** Each tool's flags come from its live input schema (`icmcp <command> --help`). `--max`/`-n` maps to each command's own cap (`maxResults`, or `maxKeyVariants` for `browse`). Unknown flags, missing arguments and too many codes fail with exit code 2 before anything is sent. `--show-call` prints the resolved call without running it.
- **Transports.** By default the CLI spawns `node dist/index.js` over stdio, which needs `npm run build` and the DBs in `data/`. Each command starts its own server and exits when it is done. The server runs with `MCP_SKIP_STARTUP_WARM=1`, so a keyword lookup doesn't wait for the embedding model, but every `semantic` command loads the model afresh (about 3 s, against about 0.6 s for a keyword lookup). `--http <url>` (or `ICMCP_HTTP`) uses a running server instead, such as `npm run serve` or the Railway URL. For a series of queries, especially semantic ones, start `npm run serve` once and `export ICMCP_HTTP=http://localhost:3000/mcp`: the model then loads once, and each command takes well under a second. `--protocol legacy|auto|2026-07-28` picks the protocol era; the default is `legacy`.
- **Exit codes.** 0 ok, 1 tool or connection error, 2 usage error.

### Testing

There is no test framework — the suites are standalone Node scripts under
`scripts/tests/`, run via npm. All of them need a built `dist/`.

| Command | Layer | Requires |
|---------|-------|----------|
| `npm test` | Pure-function, unit, tool-level, HTTP concurrency, 2026-07-28 wire and CLI tests | nothing — tool-level suites run on a small fixture DB built from `fixtures/` |
| `npm run test:fixture` | Just the fixture-backed tool suite | nothing |
| `npm run test:cli` | Just the `icmcp` CLI suite | nothing |
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

The database is built from the [Iconclass CC0 data dump](https://github.com/iconclass/data) and the [`iconclass`](https://pypi.org/project/iconclass/) Python library, then completed by importing the semantic embeddings. **Both steps are required:** the build alone writes `schema_version` 3, and the server only accepts a DB at version 5 or later, which the embeddings import sets.

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
| `MCP_SKIP_STARTUP_WARM` | — | `1` skips the stdio startup warm-up and the eager embedding-model load (the model then loads on the first semantic query). Set by the CLI |
| `ICMCP_HTTP` | — | CLI only: server URL, as `--http` |
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

Maxima are sized to the hosts' per-result ceilings, not the model's context window: claude.ai / Claude Desktop accept ~150,000 characters per tool result, and Claude Code saves results over ~25,000 tokens to a file. The binding cost is the `structuredContent` JSON (~700–850 bytes per entry, 4–9× the text rendering, because each entry carries its full labelled path), so every maximum keeps the whole result under ~120,000 characters.

| Tool / field | Default | Max |
|--------------|---------|-----|
| `search` results | 25 | 50 |
| `search_prefix` results | 25 | 50 |
| `resolve` notations per call | — | 25 |
| `find_artworks` notations per call | — | 25 |
| `browse` depth | 1 | 3 |
| `browse` children | 25 per parent, 120 per subtree (`subtreeCapped` says when the cap cut it short) | — |
| Key variants (`browse`, `expand_keys`) | 25 (covers 81% of base notations) | 100 (covers 90%) |
| Keywords per notation | — | 40 — the largest in the DB, so none are truncated |
