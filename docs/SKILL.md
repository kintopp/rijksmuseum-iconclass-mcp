---
name: iconclass-mcp
description: >
  Research workflows for the Iconclass MCP server — a universal art-subject
  taxonomy with ~1.3M notations across 13 languages. Use this skill whenever
  the user wants to explore iconographic subjects, find Iconclass notation codes,
  browse the classification hierarchy, discover what subjects exist for a theme,
  or prepare notation codes for use with a collection server like the Rijksmuseum
  MCP. Also use when the user mentions Iconclass, subject classification,
  iconography, or art-historical taxonomy — even if they don't name the server.
metadata:
  version: "0.1.1"
  last_updated: "2026-04-04"
---

# Iconclass MCP Research Skill

## Core Mental Model

This server is the **vocabulary layer** — it helps you find and understand Iconclass notation codes. A companion collection server (e.g. Rijksmuseum MCP+) is the **collection layer** that searches actual artworks. The canonical workflow is:

```
DISCOVER  ->  NARROW  ->  RESOLVE  ->  CHECK ADOPTION  ->  HAND OFF
(search)     (browse)    (resolve)    (find_adopters)     (collection server)
```

Iconclass is a retrieval tool, not a descriptive language. A notation's meaning comes from its position in the hierarchy, not just its label. Complex artworks carry many codes (often 30+) across different branches because a single image contains multiple subjects — a scene, its setting, its actors, their attributes, symbolic objects. The goal is not to find *the one right code* but to identify the set of codes that carve out the search space you need.

Most of the ~40K base notations are "theoretical" — they exist in the taxonomy but no museum has tagged artworks with them. Always check `collectionCounts` before handing a code to a collection server: a code with 0 artworks returns nothing, and a code with 371 vs 2 signals very different curatorial depth.

**Never truncate discovery queries.** When searching for notation codes, use the default `maxResults` (25) or higher — never set a lower value. You need to see the full result set with collection counts to evaluate which codes are useful. Cutting results short means you miss relevant notations and can't make informed handoff decisions.

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
| "Which museums have artworks about X?" | `find_adopters` with notation(s) from a prior search |
| "Where can I find artworks tagged 73D82?" | `find_adopters` with `notation: "73D82"` |

---

## Notation Syntax

Iconclass notations encode hierarchy left-to-right. Understanding the syntax helps you read results and construct queries.

**Base notations** use alphanumeric codes: `7` (Bible) → `73` (New Testament) → `73D` (Passion) → `73D8` (instruments of the Passion) → `73D82` (road to Calvary).

**Named notations** add a parenthesised qualifier for specific entities: `11H(FRANCIS)` (St. Francis), `25F44(SALAMANDER)` (salamander). The name is part of the notation — `11H(FRANCIS)` and `11H(JEROME)` are siblings under `11H(...)` (male saints). Named notations for female saints use `11HH(...)`.

**Key-expanded notations** add modifiers in `(+N)` suffixes: `25F23(+46)` means "beasts of prey, sleeping." Key codes are standardised across the system — `(+46)` always means "sleeping" regardless of the base notation. But be careful: the `(+4...)` group concerns **artistic production and works of art as objects** (stages of creation, damage, restoration), not the depicted condition of things within a scene. `48C7323(+42)` means "lute as a work of art being damaged," not "a lute with a broken string in a painting." This is a common misclassification trap.

When using `expand_keys`, pass the **base notation** — `25F23`, not `25F23(+46)`. Named notations like `25F44(SALAMANDER)` are not base notations; use `25F44` to expand keys for all turtles/tortoises including the salamander.

---

## FTS Query Patterns

The keyword search (`query`) uses FTS5 across labels and keywords in all 13 languages. Understanding its behaviour avoids wasted tool calls.

**Inflected forms often work** because the Iconclass keyword data includes variants — "crucified" finds "crucifixion" (675 matches). But **spelling variants do not** — "odour" and "odor" are separate words and won't cross-match. When in doubt, try both spellings or fall back to `semanticQuery`.

**Multi-word queries** try phrase match first (adjacent words), then fall back to AND-ed individual terms if the phrase returns zero results. "Marriage at Cana" finds notations containing both "Marriage" and "Cana" even if they're not adjacent.

**Single words are usually best.** FTS matches whole words against the Iconclass vocabulary, so a single specific word ("salamander", "crucifixion", "lute") has the highest recall. Multi-word queries are useful when a single word is too broad — "broken string" to distinguish from intact string instruments, or "Last Supper" to avoid matching other uses of "supper."

**When FTS fails, switch to semantic search.** If the exact vocabulary term is unknown — or you're searching by concept rather than keyword — use `semanticQuery`. It finds notations by meaning: "domestic animals" finds dogs, cats, horses even though none contain that exact phrase. Semantic search bridges the gap between your language and Iconclass's vocabulary.

**Non-English queries work.** FTS covers all 13 languages. Dutch "kruisiging", German "Kreuzigung", and French "crucifixion" all find the same notation.

---

## Critical Parameter Distinctions

### `browse` vs `expand_keys` for key variants

Both can show key-expanded variants (e.g. `25F23(+46)` "beasts of prey, sleeping"), but they serve different purposes:

- `browse` with `includeKeys: true`: quick preview of key variants alongside the entry's children, path, and cross-refs. Use for orientation — "what modifiers exist for this notation?"
- `expand_keys`: paginated list of all key variants with full metadata. Use when you need the complete inventory — some base notations have 200+ variants and `browse` only shows the first 25.

### `search` with `parentNotation` vs `search_prefix`

Both restrict to a subtree, but they answer different questions:

- `search(query=..., parentNotation="11F")`: keyword search *within* a subtree — "find notations about 'reading' under Virgin Mary." Combines text relevance with hierarchical scoping.
- `search_prefix(notation="11F")`: enumerate *all* notations starting with a prefix, ordered alphabetically. No text search — pure hierarchy traversal. Use when you want the full inventory of a branch.

If `parentNotation` returns zero results, the concept may exist in a different branch. Try removing the scope for a global search, or broadening to a parent prefix (e.g. `"11"` instead of `"11F"`).

---

## Key Workflows

### 1. Discover a Notation Code

Start with keyword search. If the term is unknown or the concept is atmospheric/interpretive, use semantic search.

```
# Known term
search(query: "crucifixion")
# -> 73D6 (371 artworks) "the Crucifixion of Christ" [7 > 73 > 73D]

# Unknown vocabulary — concept search
search(semanticQuery: "domestic animals")
# -> 34B1 "pets, domestic animals" [3 > 34 > 34B]
```

### 2. Explore a Hierarchy Branch

Use `browse` with `depth: 2` for narrative exploration — it returns the entry, its children, and their children in one call, avoiding the sequential browse-per-child pattern that would cost 8+ tool calls on a branch like St. Francis.

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

Wide branches (e.g. saints by name under `11H`, 183 children) are capped at 25 children per parent to protect your context window. The response shows `totalChildren` so you know when truncation occurred.

Use `depth: 3` only on narrow branches where you can see the full structure. For wide branches like `11H`, browse at depth 1 first to see the top-level names, then drill into specific children at depth 2.

### 3. Cross-Branch Discovery

The same concept can appear in multiple Iconclass branches because the system classifies by context, not just identity. A dog might be:
- `34B11` — pets, domestic animals: dog (zoological classification)
- `11A(DOG)` — the dog as symbol of fidelity (religious symbolism)
- `25FF21(DOG)` — predatory animals: dog (wild/feral context)

Use keyword or semantic search to discover all branches, then `resolve` to compare them side by side:

```
search(query: "dog", maxResults: 10)
# -> multiple notations across branches 11, 25, 34, 46...

resolve(notation: ["34B11", "11A(DOG)", "25FF21(DOG)"])
# -> full metadata for comparison — paths, keywords, counts
```

### 4. Scoped Search Within a Subtree

When you know the branch but need to find a specific concept within it, use `parentNotation` to avoid drowning in global results:

```
# "reading" within New Testament (73)
search(query: "reading", parentNotation: "73")
# -> 73A51 "Mary alone reading", 73B732 "Mary teaches the Christ-child to read"

# "crown" within saints (11H)
search(query: "crown", parentNotation: "11H")
# -> notations about crowned saints, martyrs' crowns, etc.
```

If a scoped search returns zero results, the concept may live in a different branch than expected. "reading" under `11F` (Virgin Mary) returns nothing — those notations are under `73` (New Testament narrative). Remove the scope and search globally to find where the concept actually lives.

### 5. Multi-Code Assignment for Artworks

Complex artworks need codes from multiple branches because a single image contains overlapping subjects: a scene, its actors, their attributes, symbolic objects, the setting. A painting of St. Francis preaching to birds might need:

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

Codes from different branches AND-combine when passed to a collection server — `iconclass: ["11H(FRANCIS)32", "25F3"]` finds artworks tagged with both codes. This is how you express compound iconographic queries.

When no notation exactly captures a nuanced concept (e.g., a broken lute string as a vanitas symbol), assign the closest codes (`11R7` vanitas symbols + `48C7323` lute) and record the interpretive nuance in a catalogue note. Don't force-fit a key expansion — verify the key's actual meaning first (see Notation Syntax above).

### 6. Find Which Collections Use a Notation

After discovering notation codes via `search` or `browse`, use `find_adopters` to see which external collections have artworks tagged with those codes. This answers "where does this subject appear in the real world?" — essential for gauging a notation's practical usefulness beyond its aggregate `collectionCounts`.

```
# Single notation
find_adopters(notation: "73D64")
# -> 73D64 "the Crucifixion of Christ"
#      Rijksmuseum: 371 artworks → https://...
#      RKD: 1,204 artworks → https://...
#      Arkyves: 892 artworks → https://...

# Batch: compare adoption across multiple notations (up to 25)
find_adopters(notation: ["34B11", "25F23", "11H(FRANCIS)32"])
# -> per-notation breakdown with counts and link-out URLs per collection
```

**When to use `find_adopters` vs `collectionCounts`:**
- `collectionCounts` (returned by `search`, `browse`, `resolve`) gives you a quick aggregate total per collection, useful for filtering during discovery — "does anything use this code?"
- `find_adopters` gives you the full per-collection breakdown with direct link-out URLs. Use it when you need to actually navigate to a collection's artworks for a notation, or when comparing adoption patterns across notations.

**Practical patterns:**

- **After narrowing to a handful of codes:** Run `find_adopters` on your shortlist to see which collections have the richest coverage, then hand off to the collection with the most artworks.
- **Comparing sibling notations:** When two notations seem interchangeable (e.g. `73D64` vs `73D641`), `find_adopters` reveals which one museums actually tag with — the one with higher adoption is usually the better handoff code.
- **Checking before handoff:** A notation with 0 adopters returns `"no collections"` — don't pass it to a collection server, it will return nothing. Look for a parent or sibling notation instead.

The `lang` parameter controls the language of notation labels in the response (default: `"en"`). The link-out URLs are collection-specific search links that open results in the collection's own interface.

### 7. Cross-Server Handoff

Once you have notation codes, use `find_adopters` to check which collections have artworks, then hand off to the richest collection:

```
# Step 1: discover the code
search(query: "Night Watch")
# -> 41D2621 "civic guard, 'schutterij'"

# Step 2: check adoption (optional but recommended)
find_adopters(notation: "41D2621")
# -> Rijksmuseum: 48 artworks → https://...
#    RKD: 215 artworks → https://...

# Step 3: hand off to the collection server
search_artwork(iconclass: ["41D2621"])
# -> artworks depicting civic guard scenes
```

Multiple codes AND-combine on the collection server. Use `find_adopters` or `collectionCounts` to predict result volume before making the handoff call — a notation with 0 counts in a collection will return nothing.

---

## Known Limitations

| Issue | Workaround |
|---|---|
| British/American spelling — "odour" vs "odor" | Try both spellings. `semanticQuery` handles this automatically. |
| Wide branches truncated at 25 per parent | Use `search_prefix` to enumerate all notations, or paginate with `offset`. |
| Resolve batch limit of 25 | Use `search` for discovery, `resolve` only for the 3–5 notations you need full metadata on. |
| `parentNotation` returns 0 but concept exists | The concept may live in a different branch. Remove the scope and search globally. |
| Key expansion labels can mislead | Always verify a key's meaning in context. The `(+4...)` group is about artistic production, not depicted object condition. See Notation Syntax. |
| `find_adopters` batch limit of 25 | Sufficient for most workflows — you should have narrowed to a shortlist before calling. |
| `find_adopters` covers 3 collections only | Rijksmuseum, RKD, and Arkyves. ~46K of ~40K base notations have at least one count. More collections will be added over time. |
| `find_adopters` returns "no collections" | The notation exists but no loaded collection has tagged artworks with it. Try a parent or sibling notation. |

---

## Output Conventions

- Always show notation codes (e.g. `73D82`) — they are the stable identifiers across all tools and the handoff format to collection servers
- Include collection counts when available — they signal whether a code is useful for artwork retrieval
- Show hierarchy paths (e.g. `7 > 73 > 73D > 73D8`) — they help the user understand where a notation sits in the classification system
- When presenting multiple notations, lead with highest collection count — these are the most practically useful codes
- Distinguish explicitly between what was found via keyword search vs semantic search — the confidence levels differ

---
