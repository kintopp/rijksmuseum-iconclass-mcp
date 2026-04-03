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

Artwork counts per notation live in a separate **sidecar database** (`iconclass-counts.db`, ~700 KB) so they can be updated independently of the main 3 GB notation/text/embedding database. The Rijksmuseum overlay ships by default (24,066 notations with artworks).

To add or update collections, rebuild only the sidecar — no need to touch the main DB:

```bash
# Export counts from your collection database
# CSV format: notation,count (one per line)
python scripts/export-collection-counts.py --vocab-db path/to/vocab.db --output data/my-museum-counts.csv

# Build the counts sidecar with multiple overlays
python scripts/build-counts-db.py \
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
| `ICONCLASS_DB_PATH` | `data/iconclass.db` | Main database (notations, texts, keywords, embeddings) |
| `ICONCLASS_DB_URL` | — | URL to download main DB if missing (supports `.gz`) |
| `COUNTS_DB_PATH` | `data/iconclass-counts.db` | Sidecar database (collection counts) |
| `COUNTS_DB_URL` | — | URL to download counts DB if missing (supports `.gz`) |
| `EMBEDDING_MODEL_ID` | `Xenova/multilingual-e5-base` | HuggingFace model for query embedding |
| `HF_HOME` | — | HuggingFace cache directory |
| `ALLOWED_ORIGINS` | `*` | CORS origins for HTTP mode |
| `STRUCTURED_CONTENT` | `true` | Set `false` to disable `outputSchema` |

## Performance

Benchmarked on Apple M4, 24 GB unified memory. Cold-start times (fresh server process per query, no warm caches).

| Operation | Time | Notes |
|-----------|------|-------|
| FTS search (800 hits) | ~18ms | "crucifixion" |
| FTS search (8K hits) | ~36ms | "horse" |
| FTS search (28K hits) | ~170ms | "portrait" |
| Semantic search | ~50ms | vec0 KNN over 40K base-notation embeddings + ~10ms query embedding |
| Browse | ~1ms | B-tree lookup + child resolution |
| Browse with key variants | ~35ms | Default page of 25 key variants (DB-layer LIMIT/OFFSET) |
| Resolve (batch of 10) | ~13ms | 10 notations with full metadata |
| Prefix search | ~55ms | Depends on subtree size |
| Server cold start | ~8s | Embedding model download cached after first run |

## Notes

### Embedding model

The server uses [`intfloat/multilingual-e5-base`](https://huggingface.co/intfloat/multilingual-e5-base) for semantic search — a 278M-parameter multilingual model that produces 768-dimensional embeddings. It was chosen because it supports 100+ languages and runs efficiently on CPU via 8-bit ONNX quantisation (~350 MB memory). The base variant (768d) was preferred over the small variant (384d) for better discrimination between closely related concepts.

E5-base has a 512-token context window. The composite texts fed to the model (label + Dutch label + keywords + category path) have a mean length of 122 and a 99th percentile of 298. A single entry in the taxonomy tops out at 478 tokens. The model's token limit is therefore not a constraint.

### Semantic search and Iconclass structure

Semantic search embeddings are built from a composite text that includes each notation's label, keywords, and full category path (e.g., "Religion and Magic > non-Christian religions > Mithraism and other Hellenistic..."). Because Iconclass labels are often inherited verbatim from parent to child, notations deep in verbose branches end up with the same qualifying phrase repeated at every level of the path. The embedding model sees this repetition as emphasis, which means **deep notations in long-named branches are over-represented in embedding space** relative to equally relevant notations in shallower or more concisely named parts of the hierarchy. A broad semantic query like "ancient religion" will favour the Mithraism subtree (9 levels, verbose labels) over a structurally simpler branch that may be just as relevant.

In practice, this may rarely matter — semantic search is a fallback for when the exact vocabulary term is unknown, and FTS keyword search is unaffected by these structural biases.

Other, more minor biases to be aware of: named notations like `11H(JOHN)` embed the name itself, so saints or figures with common English names may rank slightly higher than those with non-English names; the composite text mixes English and Dutch keywords, which can give a small boost to notations that happen to have Dutch keywords matching a query; and structural placeholder notations like `25F23(...)` ("beasts of prey, with NAME") sit in a generic part of embedding space and can surface as top results for broad queries even though they are not real subject entries.

## License

MIT

## Acknowledgements

The [Iconclass](https://iconclass.org) classification system was created by Henri van de Waal and is maintained by the Iconclass Foundation. The data used in this server is published under the CC0 license.
