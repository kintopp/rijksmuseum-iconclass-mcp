# rijksmuseum-iconclass-mcp

MCP server for [Iconclass](https://iconclass.org) — a hierarchical classification system for art subjects, used by museums and art historians worldwide.

The database includes all 1.3 million Iconclass notations — both the 39,802 base concepts and over 1.3 million key-expanded variants that add modifiers like posture, context, or symbolism. Labels and keywords are available in 13 languages, from English and Dutch to Japanese and Chinese. Beyond simple keyword matching, the server supports semantic search using multilingual-e5-base embeddings, so you can search for concepts like "religious suffering" or "domestic animals" and get meaningful results even when the exact words don't appear in the notation text. Collection count overlays let you see at a glance how many artworks in the Rijksmuseum (or any other collection you load) carry a given notation — useful for focusing on subjects that actually appear in a specific collection rather than the full taxonomy. The server speaks both stdio (for Claude Desktop and CLI tools) and HTTP (for claude.ai and web clients).

## What is Iconclass?

Iconclass is a subject classification system designed for art and iconography. It organises subjects hierarchically — from broad categories like "Religion" (1) down to specific scenes like "the crucifixion of Christ" (73D6). Notations encode meaning left-to-right: `73D6` = Bible (7) → New Testament (73) → Passion of Christ (73D) → Crucifixion (73D6).

**Key expansions** add modifiers in parentheses. `25F23` is "beasts of prey"; `25F23(+46)` is "beasts of prey, sleeping". The server covers all 1.3M combinations.

## Quick start

### Claude Desktop (stdio)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "iconclass": {
      "command": "npx",
      "args": ["-y", "rijksmuseum-iconclass-mcp"]
    }
  }
}
```

On first run, the server downloads `iconclass.db` (~1 GB compressed) to `data/`. Subsequent starts are fast.

### HTTP mode

```bash
PORT=3000 npx rijksmuseum-iconclass-mcp
# MCP endpoint: POST http://localhost:3000/mcp
# Health check: GET  http://localhost:3000/health
```

### From source

```bash
git clone https://github.com/kintopp/rijksmuseum-iconclass-mcp.git
cd rijksmuseum-iconclass-mcp
npm install && npm run build
npm start          # stdio mode
npm run serve      # HTTP mode on port 3000
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
| `query` | FTS5 keyword search (exact word match, 13 languages) |
| `semanticQuery` | Semantic concept search (finds by meaning, not exact words) |
| `onlyWithArtworks` | Filter to notations with artworks in any loaded collection |
| `collectionId` | Filter to a specific collection (e.g. `"rijksmuseum"`) |
| `lang` | Preferred language for labels (default: `en`) |
| `maxResults` | 1–50 (default 25) |

Provide exactly one of `query` or `semanticQuery`.

### `browse` — navigate the hierarchy

Explore a notation's place in the tree: path, children, cross-references, key variants.

```
notation: "73D"  → Passion of Christ, 9 children, cross-ref to 7 (Bible)
notation: "25F23", includeKeys: true  → 204 key-expanded variants
```

### `resolve` — batch notation lookup

Look up one or more notations by code. Accepts a single string or an array of up to 50.

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

## Typical workflow

1. **Search** for a concept: `search({ semanticQuery: "religious suffering" })`
2. **Browse** the hierarchy to find the right specificity level
3. **Pass the notation** to a collection server's search (e.g., `search_artwork(iconclass: "73D6")` in [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus))

This two-server workflow separates the classification vocabulary (this server) from collection-specific search (the Rijksmuseum server).

## Collection counts

Artwork counts per notation are loaded as **collection overlays** — CSV files mapping notations to counts. The Rijksmuseum overlay ships by default (24,066 notations with artworks).

To add another collection:

```bash
# Export counts from your collection database
# CSV format: notation,count (one per line)
python scripts/export-collection-counts.py --vocab-db path/to/vocab.db --output data/my-museum-counts.csv

# Rebuild the DB with multiple overlays
python scripts/build-iconclass-db.py \
  --counts-csv data/rijksmuseum-counts.csv \
  --counts-csv data/my-museum-counts.csv
```

Results then show counts per collection: `73D6 (rijksmuseum: 371, my-museum: 42)`.

## Building the database

The database is built from the [Iconclass CC0 data dump](https://github.com/iconclass/data) and the [`iconclass`](https://pypi.org/project/iconclass/) Python library.

```bash
# Clone the CC0 data
git clone https://github.com/iconclass/data /tmp/iconclass-data

# Install Python dependencies
pip install iconclass

# Build (takes ~6 minutes)
python scripts/build-iconclass-db.py \
  --data-dir /tmp/iconclass-data \
  --output data/iconclass.db \
  --counts-csv data/rijksmuseum-counts.csv
```

### Adding semantic embeddings

Embeddings enable the `semanticQuery` parameter. Generation uses [Modal](https://modal.com) for cloud GPU access (free tier works).

```bash
pip install modal sqlite-vec numpy
modal setup  # one-time auth

modal run scripts/generate-embeddings-modal.py
```

This embeds ~40K base notations using `intfloat/multilingual-e5-base` (768d, int8). Takes ~4 minutes on an A10G GPU. Key-expanded notations are not embedded — they are searchable via FTS.

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
| `ICONCLASS_DB_PATH` | `data/iconclass.db` | Override database location |
| `ICONCLASS_DB_URL` | — | URL to download DB if missing (supports `.gz`) |
| `EMBEDDING_MODEL_ID` | `Xenova/multilingual-e5-base` | HuggingFace model for query embedding |
| `HF_HOME` | — | HuggingFace cache directory |
| `ALLOWED_ORIGINS` | `*` | CORS origins for HTTP mode |
| `STRUCTURED_CONTENT` | `true` | Set `false` to disable `outputSchema` |

## Performance

Benchmarked on Apple M4, 24 GB unified memory.

| Operation | Time | Notes |
|-----------|------|-------|
| Semantic search | ~45ms | vec0 KNN over 40K base-notation embeddings |
| FTS search | 1–90ms | Depends on result count (1–30K matches) |
| Browse | <0.1ms | B-tree lookup |
| Prefix search | 0.04–90ms | Depends on subtree size |
| Query embedding | ~10ms | e5-base on CPU (ONNX/WASM) |
| Cold start (stdio) | ~8s | Model download cached after first run |

## License

MIT

## Acknowledgements

The [Iconclass](https://iconclass.org) classification system was created by Henri van de Waal and is maintained by the Iconclass Foundation. The data used in this server is published under the CC0 license.
