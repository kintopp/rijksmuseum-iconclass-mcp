# rijksmuseum-iconclass-mcp

MCP server for [Iconclass](https://iconclass.org) — a hierarchical classification system for art subjects, used by museums and art historians worldwide.

The database includes all 1.3 million Iconclass notations — both the 39,802 base concepts and over 1.3 million key-expanded variants that add modifiers like posture, context, or symbolism. Labels and keywords are available in 13 languages, from English and Dutch to Japanese and Chinese. Beyond simple keyword matching, the server supports semantic search using multilingual-e5-base embeddings, so you can search for concepts like "religious suffering" or "domestic animals" and get meaningful results even when the exact words don't appear in the notation text. Collection count overlays let you see at a glance how many artworks in the Rijksmuseum (or any other collection you load) carry a given notation — useful for focusing on subjects that actually appear in a specific collection rather than the full taxonomy. The server speaks both stdio (for Claude Desktop and CLI tools) and HTTP (for claude.ai and web clients).

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

## Typical workflow

1. **Search** for a concept: `search({ semanticQuery: "religious suffering" })`
2. **Browse** the hierarchy to find the right specificity level
3. **Pass the notation** to a collection server's search (e.g., `search_artwork(iconclass: "73D6")` in [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus))

This two-server workflow separates the classification vocabulary (this server) from collection-specific search (the Rijksmuseum server).

For more detailed examples — sensory history, finding saints, navigating the hierarchy, classifying complex scenes — see [Example Prompts](docs/example-prompts.md).

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
| `COUNTS_DB_PATH` | `data/iconclass-counts.db` | Sidecar database (collection counts) |
| `COUNTS_DB_URL` | — | URL to download counts DB if missing (supports `.gz`) |
| `EMBEDDING_MODEL_ID` | `Xenova/multilingual-e5-base` | HuggingFace model for query embedding |
| `HF_HOME` | — | HuggingFace cache directory |
| `ALLOWED_ORIGINS` | `*` | CORS origins for HTTP mode |
| `STRUCTURED_CONTENT` | `true` | Set `false` to disable `outputSchema` |

## Performance

| Operation | Local | Production | Notes |
|-----------|-------|------------|-------|
| FTS search (844 hits) | ~18ms | ~118ms | "crucifixion" |
| FTS search (8.5K hits) | ~38ms | ~148ms | "horse" |
| FTS search (28.7K hits) | ~165ms | ~260ms | "portrait" |
| Semantic search | ~65ms | ~184ms | vec0 KNN over 40K embeddings + query encoding |
| Browse | ~5ms | ~149ms | B-tree lookup + child resolution |
| Browse with key variants | ~7ms | ~118ms | Default page of 25 key variants |
| Resolve (batch of 15) | ~7ms | ~117ms | 15 notations with full metadata |
| Prefix search | ~60ms | ~175ms | Depends on subtree size |
| Server cold start | ~8s | ~77s | Local: embedding model only. Production: chunked DB download + decompression |

**Local:** Apple M4, 24 GB unified memory, warm mmap caches. **Production:** Railway, warm caches. Production times include ~110ms network round-trip overhead.

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

A resolved Iconclass entry averages ~350 bytes of JSON (median). At the default page size of 25, a typical search response is ~8 KB (~2,300 tokens) — roughly 1% of a 200K-token context window. At the maximum of 50 results, responses reach ~16 KB (~4,600 tokens). Both leave ample room for LLM reasoning.

FTS queries return anywhere from ~800 unique notations ("crucifixion") to ~30,000 ("portrait"). Results are sorted by total collection count so the most relevant notations appear first regardless of page size. The fixed cost of the FTS scan dominates — returning 10 or 50 results takes roughly the same time.

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

#### Resolve batch limit

The resolve tool accepts up to 25 notations per call. This is intentionally conservative — a 25-entry resolve response is ~8 KB, and the SKILL.md coaches LLMs to "use search for discovery, resolve only for the 3–5 you need full metadata on."

#### Keywords

The per-notation keyword limit of 40 matches the observed maximum in the database, so no keywords are truncated. The 99th percentile is 9 keywords; only 705 notations (0.04%) exceed 20. These are concentrated in a few keyword-heavy base notations — notably `46C1313` ("equestrian statue", 28 keywords listing famous statues by name), `23K` ("labours of the months", 30 keywords), and saint notations like `11H(THOMAS AQUINAS)`. Key-expanded variants of these inherit the base keywords and add modifier keywords on top, reaching up to 40.

#### Collection count sparsity

Only 1.8% of notations have artwork counts (24K of 1.3M). The `collectionCounts` field is empty for the vast majority of entries, adding negligible overhead. The `onlyWithArtworks` and `collectionId` filters are aggressive narrowers — useful when the caller only needs notations that appear in a specific collection.

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
