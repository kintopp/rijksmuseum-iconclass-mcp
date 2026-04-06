# rijksmuseum-iconclass-mcp

[![MCP Protocol](https://img.shields.io/badge/MCP_Protocol-2025--11--25-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzIi8+PC9zdmc+)](https://modelcontextprotocol.io/specification/2025-11-25)

**rijksmuseum-iconclass-mcp** is a tool for searching and exploring [Iconclass](https://iconclass.org) notations in natural language with an AI assistant. It was designed as a companion resource for [rijksmuseum-mcp+](https://github.com/kintopp/rijksmuseum-mcp-plus), an analogous resource for the [Rijksmuseum's](https://www.rijksmuseum.nl/en) art collections.

The tool provides access to over 1.3 million Iconclass notations — all of the c. 39,000 base concepts and c. 1.3 million key-expanded variants that add modifiers like posture, context, or symbolism. Beside simple keyword matching, rijksmuseum-iconclass-mcp supports semantic search in natural language, so that you can discover iconclass notations related to concepts like "homesickness and exile" -> `94I2111 — "Ulysses longs for home"` even when the search term doesn't appear in the notation text. You can also, for example, use the AI assistant to explore the Iconclass hierarchy, visualise their relationships, or prompt it for cataloguing advice. The database includes artwork count data from the [Rijksmuseum](https://www.rijksmuseum.nl/en/collection), showing how many artworks are tagged with each notation. 

The resource was developed as a technology demo by the [Research and Infrastructure Support](https://rise.unibas.ch/en/) (RISE) group at the University of Basel and complements our ongoing work on [benchmarking](https://github.com/RISE-UNIBAS/humanities_data_benchmark) and [optimizing](https://github.com/kintopp/dspy-rise-humbench) humanities research tasks carried out by large language models (LLMs). We are particularly interested in exploring the research opportunities, methodological risks, and technical challenges posed by retrieving and analysing data with LLMs. If you are interested in collaborating with us in this area, please [get in touch](mailto:rise@unibas.ch).

## Quick start

For the best results, add rijksmuseum-iconclass-mcp as a custom connector in [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) using the URL below. This currently requires a paid ('Pro') or higher [subscription](https://claude.com/pricing) from Anthropic.

```
https://rijksmuseum-iconclass-mcp-production.up.railway.app/mcp
```

Go to _Settings_ → _Connectors_ → _Add custom connector_ → name it as you like and paste the URL into the _Remote MCP Server URL_ field. You can ignore the Authentication section. Once configured, optionally set the permissions for its tools (e.g. 'Always allow'). See Anthropic's [instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) for more details. To use it for free without a subscription, please see [Choosing an AI System](#choosing-an-ai-system).

Recommended: After that, follow the same procedure to install its companion resource, [rijksmuseum-mcp+](https://github.com/kintopp/rijksmuseum-mcp-plus). This allows you to explore over 830,000 artworks and metadata records from the Rijksmuseum with semantic search, provenance analysis, similarity comparisons, and spatial reasoning. 

## Sample Queries

tba. See [docs/example-prompts.md](docs/example-prompts.md).

## Features

tba.

## Choosing an AI system

Technically speaking, both rijksmuseum-iconclass-mcp and rijksmuseum-mcp+ are based on the open [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro) (MCP) standard. As such, they also work with generative large language models (LLMs) in other chatbots and applications which support this standard, including several which can be used **without a paid subscription** (see below). However, none beside [Claude Desktop](https://claude.com/download) and [claude.ai](https://claude.ai) support viewing, analysing, and interacting with images and visualisations in the chat timeline. If this is important to you, then your best (and currently only) choice is to use Anthropic Claude with a monthly subscription. 

However, if you don't need these features, or only want to use rijksmuseum-iconclass-mcp, then you can use it just as well with many other, free to use, browser based chatbots. Mistral's [LeChat](https://chat.mistral.ai/chat) (follow [these instructions](https://help.mistral.ai/en/articles/393572-configuring-a-custom-connector)) is a fine example of a browser based chatbot with good, basic support of the MCP standard. It also offers a 'Personal Library' feature which can be used to upload research skill files (see below). In addition, many desktop 'LLM client' applications, such as [Jan.ai](https://jan.ai), are also MCP-compatible, and can even be used with many different LLM models (including local models). Most agentic coding applications (e.g. Claude Code, OpenAI Codex, Google Gemini CLI) also support the MCP standard. In contrast, OpenAI's ChatGPT still only offers limited, 'developer mode' support for MCP servers, and while Google has announced MCP support for Gemini it has not indicated when this will be ready. Currently (April, 2026) the best, free alternative to Claude for most people is probably Mistral's LeChat.

## How it works

introduction tba.

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

Given a base notation, return all its key-expanded variants with texts and collection data.

```
notation: "25F23"  → 204 variants (swimming, sleeping, fighting, etc.)
```

### `search_prefix` — hierarchical subtree search

Find all notations under a hierarchy prefix. Leverages Iconclass's left-to-right encoding.

```
notation: "73D8"  → 8 notations under "instruments of the Passion"
notation: "25F"   → all animal notations
```

### `find_artworks` — how many artworks use this subject?

Given one or more notations, check which collections have artworks tagged with those notations. Returns per-collection artwork counts and link-out URLs where available. An empty `collections` array means no loaded collection has artworks for that notation — try a parent or sibling notation instead.

```
notation: "73B57"  → Rijksmuseum: 24 artworks
notation: ["73D6", "92D192134"]  → batch lookup with counts
```

Currently includes:

- **Rijksmuseum, Amsterdam** — artwork counts per notation; use [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus) for artwork search

## Typical workflow

1. **Search** for a concept: `search({ semanticQuery: "religious suffering" })`
2. **Browse** the hierarchy to find the right specificity level
3. **Check collections** for that subject: `find_artworks({ notation: "73D6" })`
4. **Pass the notation** to a collection server's search (e.g., `search_artwork(iconclass: "73D6")` in [rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus))

This two-server workflow separates the classification vocabulary (this server) from collection-specific search (the Rijksmuseum server). When both servers are connected, the LLM can automatically follow up on `find_artworks` results by calling the Rijksmuseum server's `search_artwork` tool.

For more detailed examples — sensory history, finding saints, navigating the hierarchy, classifying complex scenes — see [Example Prompts](docs/example-prompts.md).

## Technical Notes

Introduction tba. For local setup (stdio or HTTP), deployment, architecture, data sources, and configuration, please see the [technical guide](/docs/technical-guide.md).

```mermaid
graph TB
    Client["LLM Client<br/>(Claude, Mistral, etc.)"] --> HTTP["HTTP Server<br/>POST /mcp | GET /health"]

    HTTP --> MCP["MCP Server<br/>rijksmuseum-iconclass-mcp"]

    MCP --> T1["search"]
    MCP --> T2["browse"]
    MCP --> T3["resolve"]
    MCP --> T4["expand_keys"]
    MCP --> T5["search_prefix"]
    MCP --> T6["find_artworks"]

    T1 -->|"FTS keyword search"| DB["Iconclass DB"]
    T1 -->|"semantic query"| EMB["EmbeddingModel<br/>(e5-base 768d)"]
    EMB -->|"query vector"| DB

    T2 & T3 & T4 & T5 & T6 --> DB

    DB -->|"SQL queries"| MAIN["iconclass.db<br/>(1.3M notations, 13 languages,<br/>FTS5, KNN embeddings)"]
    DB -->|"ATTACH + JOIN"| COUNTS["iconclass-counts.db<br/>(artwork counts:<br/>Rijksmuseum)"]

    style Client fill:#e8f4f8,stroke:#2196F3
    style HTTP fill:#fff3e0,stroke:#FF9800
    style MCP fill:#f3e5f5,stroke:#9C27B0
    style T1 fill:#e8f5e9,stroke:#4CAF50
    style T2 fill:#e8f5e9,stroke:#4CAF50
    style T3 fill:#e8f5e9,stroke:#4CAF50
    style T4 fill:#e8f5e9,stroke:#4CAF50
    style T5 fill:#e8f5e9,stroke:#4CAF50
    style T6 fill:#e8f5e9,stroke:#4CAF50
    style DB fill:#fce4ec,stroke:#E91E63
    style EMB fill:#fce4ec,stroke:#E91E63
    style MAIN fill:#fff9c4,stroke:#FFC107
    style COUNTS fill:#fff9c4,stroke:#FFC107
```

## Authors

[Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE](https://rise.unibas.ch/), University of Basel with [Claude Code](https://claude.com/product/claude-code), Anthropic.

## Citation

If you use rijksmuseum-iconclass-mcp in your research, please cite it as follows. A `CITATION.cff` file is included for use with Zotero, GitHub's "Cite this repository" button, and other reference managers.

**APA (7th ed.)**

> Bosse, A. (2026). *rijksmuseum-iconclass-mcp* (Version 0.3.0) [Software]. Research and Infrastructure Support (RISE), University of Basel. https://github.com/kintopp/rijksmuseum-iconclass-mcp

**BibTeX**
```bibtex
@software{bosse_2026_rijksmuseum_iconclass_mcp,
  author    = {Bosse, Arno},
  title     = {{rijksmuseum-iconclass-mcp}},
  year      = {2026},
  version   = {0.3.0},
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
