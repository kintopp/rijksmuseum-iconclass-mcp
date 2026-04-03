---
name: iconclass-mcp
version: "0.1.0"
last_updated: 2026-04-03
description: >
  Research workflows for the Iconclass MCP server — a universal art-subject
  taxonomy with ~40K base notations across 13 languages. Use this skill whenever
  the user wants to explore iconographic subjects, find Iconclass notation codes,
  browse the classification hierarchy, discover what subjects exist for a theme,
  or prepare notation codes for use with a collection server like the Rijksmuseum
  MCP. Also use when the user mentions Iconclass, subject classification,
  iconography, or art-historical taxonomy — even if they don't name the server.
---

# Iconclass MCP Research Skill

## Core Mental Model

This server is the **vocabulary layer** — it helps you find and understand Iconclass notation codes. A companion collection server (e.g. Rijksmuseum MCP+) is the **collection layer** that searches actual artworks. The canonical workflow is:

```
DISCOVER  ->  NARROW  ->  RESOLVE  ->  HAND OFF
(search)     (browse)    (resolve)    (collection server)
```

Iconclass is a retrieval tool, not a descriptive language. A notation's meaning comes from its position in the hierarchy, not just its label. Complex artworks carry many codes (often 30+) across different branches. The goal is not to find *the one right code* but to identify the codes that carve out the search space you need.

---

## Tool Selection Guide

| Question type | Start here |
|---|---|
| "What's the Iconclass code for X?" — known term | `search` with `query` |
| "Find notations about X" — conceptual / atmospheric | `search` with `semanticQuery` |
| "What subjects exist under X?" — exploring a branch | `browse` with `depth: 2` |
| "What does notation 73D82 mean?" | `resolve` with the notation |
| "What's related to this notation?" | `browse` — shows children, cross-refs, path |
| "List all key variants of 25F23" | `expand_keys` |
| "Everything under 'Passion of Christ'" | `search_prefix` with `73D8` |
| "Find 'reading' within Virgin Mary subjects" | `search` with `query: "reading"`, `parentNotation: "11F"` |
| "Which notations have Rijksmuseum artworks?" | `search` with `onlyWithArtworks: true` |

---

## FTS Query Patterns

The keyword search (`query`) uses FTS5 across labels and keywords in all 13 languages. Understanding its behaviour avoids wasted tool calls.

**Inflected forms often work** because the Iconclass keyword data includes variants — "crucified" finds "crucifixion" (675 matches). But **spelling variants do not** — "odour" and "odor" are separate words and won't cross-match. When in doubt, try both spellings or fall back to `semanticQuery`.

**Multi-word queries** try phrase match first (adjacent words), then fall back to AND-ed individual terms if the phrase returns zero results. So "Marriage at Cana" will find notations containing both "Marriage" and "Cana" even if they're not adjacent.

**Single words are usually best.** Start with the most specific single word ("salamander", "crucifixion", "lute"). Multi-word queries are useful when a single word is too broad ("broken string" to distinguish from intact string instruments).

**When FTS fails, switch to semantic search.** If the exact vocabulary term is unknown — or you're searching by concept rather than keyword — use `semanticQuery`. It finds notations by meaning: "domestic animals" finds dogs, cats, horses even though none contain that exact phrase. Semantic search is the entry point when you don't already know the Iconclass vocabulary.

**Non-English queries work.** FTS covers all 13 languages. Dutch "kruisiging", German "Kreuzigung", and French "crucifixion" all find the same notation.

---

## Critical Parameter Distinctions

### `query` vs `semanticQuery`

These are mutually exclusive — provide exactly one.

- `query`: exact word matching, fast, covers all 13 languages, supports `parentNotation` for scoped search. Best when you know the vocabulary term.
- `semanticQuery`: embedding-based concept search, bridges the gap between your language and Iconclass's vocabulary. Best for discovery, broad concepts, and when keyword search returns nothing useful.

### `browse` vs `expand_keys` for key variants

Both can show key-expanded variants (e.g. `25F23(+46)` "beasts of prey, sleeping"), but they serve different purposes:

- `browse` with `includeKeys: true`: quick preview of key variants alongside the entry's children, path, and cross-refs. Use for orientation.
- `expand_keys`: paginated list of all key variants with full metadata. Use when you need the complete inventory (some base notations have 200+ variants).

### `search` with `parentNotation` vs `search_prefix`

Both restrict to a subtree, but they work differently:

- `search(query=..., parentNotation="11F")`: keyword search within a subtree — "find notations about 'reading' under Virgin Mary". Combines text relevance with hierarchy.
- `search_prefix(notation="11F")`: enumerate all notations starting with a prefix, ordered alphabetically. No text search — pure hierarchy traversal.

### `onlyWithArtworks` and `collectionId`

- `onlyWithArtworks: true`: filter to notations that have artworks in any loaded collection. Works in both FTS and semantic modes. Essential for narrowing "theoretical" notations to ones with real artworks.
- `collectionId`: filter to a specific collection (e.g. "rijksmuseum"). Results are ranked by count in that collection.

---

## Key Workflows

### 1. Discover a Notation Code

Start with keyword search. If the term is unknown, use semantic search.

```
# Known term
search(query: "crucifixion")
# -> 73D6 (371 artworks) "the Crucifixion of Christ" [7 > 73 > 73D]

# Unknown vocabulary — concept search
search(semanticQuery: "domestic animals")
# -> 34B1 "pets, domestic animals" [3 > 34 > 34B]
```

Check `collectionCounts` before proceeding — a code with 0 artworks returns nothing on the collection server. A code with 371 vs 2 signals curatorial depth.

### 2. Explore a Hierarchy Branch

Use `browse` with `depth: 2` for narrative exploration — it returns the entry, its children, and their children in one call, avoiding the sequential browse-per-child pattern.

```
browse(notation: "73D8", depth: 2)
# -> 73D8 "the Passion of Christ"
#      73D81 "carrying of the Cross"
#        73D811 "Christ falls under the Cross"
#        73D812 "Veronica wipes the face of Christ"
#      73D82 "the Crucifixion"
#        73D821 "the raising of the Cross"
#        ...
```

Wide branches (e.g. saints by name under `11H`) are capped at 25 children per parent to protect your context window. The response indicates when truncation occurred so you can paginate or narrow.

Use `depth: 3` only on narrow branches. For wide branches like `11H`, browse at depth 1 first, then drill into specific children.

### 3. Cross-Branch Discovery

The same concept can appear in multiple Iconclass branches. A dog might be:
- `34B11` — pets, domestic animals: dog
- `11A(DOG)` — the dog as symbol of fidelity
- `25FF21(DOG)` — predatory animals: dog (wild/feral)

Use keyword or semantic search to discover all branches, then `resolve` to compare them side by side:

```
search(query: "dog", maxResults: 10)
# -> multiple notations across branches 11, 25, 34, 46...

resolve(notation: ["34B11", "11A(DOG)", "25FF21(DOG)"])
# -> full metadata for comparison — paths, keywords, counts
```

### 4. Scoped Search Within a Subtree

When you know the branch but need to find a specific concept within it, use `parentNotation`:

```
# "reading" within Virgin Mary (11F)
search(query: "reading", parentNotation: "11F")
# -> 11F42 "the education of the Virgin: reading and writing"

# "crown" within saints (11H)
search(query: "crown", parentNotation: "11H")
# -> notations about crowned saints, martyrs' crowns, etc.
```

This is far more efficient than a global search followed by mental filtering.

### 5. Multi-Code Assignment for Artworks

Complex artworks need codes from multiple branches. A painting of St. Francis preaching to birds might need:

```
# Scene
search(query: "Francis", parentNotation: "11H")
# -> 11H(FRANCIS)32 "St. Francis preaching to the birds"

# Animals
search(query: "birds", parentNotation: "25F")
# -> 25F3 "birds"

# Setting
browse(notation: "25H1", depth: 2)
# -> landscape subcategories
```

Codes from different branches AND-combine when passed to a collection server — this is how you express compound iconographic queries.

### 6. Cross-Server Handoff

Once you have notation codes, pass them to the collection server:

```
# On this server: discover the code
search(query: "Night Watch")
# -> 41D2621 "civic guard, 'schutterij'"

# On the Rijksmuseum server: search artworks
search_artwork(iconclass: ["41D2621"])
# -> artworks depicting civic guard scenes
```

Multiple codes AND-combine on the collection server. Check `collectionCounts` here first to predict result volume.

---

## Known Limitations

| Issue | Workaround |
|---|---|
| British/American spelling — "odour" vs "odor" | Try both spellings. `semanticQuery` handles this automatically. |
| Wide branches truncated at 25 per parent | Use `search_prefix` to enumerate all notations, or paginate with `offset`. |
| Resolve batch limit of 25 | Use `search` for discovery (returns summary), `resolve` only for the 3-5 notations you need full metadata on. |
| `expand_keys` / `browse` overlap | Use `browse(includeKeys: true)` for a quick preview alongside hierarchy context. Use `expand_keys` when you need the full paginated list. |

---

## Output Conventions

- Always show notation codes (e.g. `73D82`) — they are the stable identifiers across all tools and the handoff format to collection servers
- Include collection counts when available — they signal whether a code is useful for artwork retrieval
- Show hierarchy paths (e.g. `7 > 73 > 73D > 73D8`) — they help the user understand where a notation sits in the classification system
- When presenting multiple notations, lead with highest collection count — these are the most practically useful codes
- Distinguish explicitly between what was found via keyword search vs semantic search — the confidence levels differ

---
