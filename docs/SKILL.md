---
name: iconclass-mcp
description: >
  Research workflows for the Iconclass MCP server — a universal art-subject
  taxonomy with ~1.3M notations across 13 languages. Use this skill whenever
  the user wants to explore iconographic subjects, find Iconclass notation codes,
  browse the classification hierarchy, discover what subjects exist for a theme,
  or find Rijksmuseum artworks by iconographic subject. This server is the
  companion vocabulary layer to rijksmuseum-mcp+ — notation codes discovered
  here should be passed directly to search_artwork(iconclass=...) there.
  Also use when the user mentions Iconclass, subject classification,
  iconography, art-historical taxonomy, what an artwork depicts, iconographic
  meaning, or subject-matter searches — even if they don't name the server.
metadata:
  version: "0.3.1"
  last_updated: "2026-04-06"
---

# Iconclass MCP Research Skill

## Core Mental Model

This server is the **vocabulary layer** — it helps you find and understand Iconclass notation codes. Its companion server, **rijksmuseum-mcp+**, is the **collection layer** that searches actual Rijksmuseum artworks. The two servers are designed to work together. The canonical workflow is:

```
DISCOVER  ->  NARROW  ->  RESOLVE  ->  FIND ARTWORKS  ->  HAND OFF
(search)     (browse)    (resolve)    (find_artworks)    (rijksmuseum-mcp+)
```

The final step — handing notation codes to `search_artwork(iconclass: [...])` on rijksmuseum-mcp+ — is the expected outcome of most workflows. When rijksmuseum-mcp+ is available, prefer passing notation codes to it directly rather than presenting them as plain text for the user to act on. If it is not available, that's fine — see the fallback guidance below.

For simple single-concept queries ("show me paintings of dogs"), rijksmuseum-mcp+'s `subject` parameter can sometimes find artworks directly without needing notation codes — it searches the same Iconclass label vocabulary. The full Iconclass workflow (search → browse → handoff with `iconclass:`) is most valuable for compound queries, cross-branch discovery, or when the user wants to understand the taxonomy itself.

Iconclass is a retrieval tool, not a descriptive language. A notation's meaning comes from its position in the hierarchy, not just its label. Complex artworks carry many codes (often 30+) across different branches because a single image contains multiple subjects — a scene, its setting, its actors, their attributes, symbolic objects. The goal is not to find *the one right code* but to identify the set of codes that carve out the search space you need.

Most of the ~40K base notations are "theoretical" — they exist in the taxonomy but the Rijksmuseum has not tagged artworks with them. Check the `collections` array before handing a code to rijksmuseum-mcp+ — an empty array means the Rijksmuseum has no artworks for that notation. The `find_artworks` tool returns per-notation artwork counts.

**Never truncate discovery queries.** When searching for notation codes, use the default `maxResults` (25) or higher — never set a lower value. You need to see the full result set with artwork counts to evaluate which codes are useful. Cutting results short means you miss relevant notations and can't make informed handoff decisions.

---

## Companion Server: rijksmuseum-mcp+

This server's notation codes are the input to rijksmuseum-mcp+'s `search_artwork(iconclass: [...])` parameter. The handoff is direct:

- **Single notation:** `search_artwork(iconclass: "73D82")` — finds all Rijksmuseum artworks tagged with "road to Calvary"
- **Multiple notations (AND):** `search_artwork(iconclass: ["11H(FRANCIS)32", "25F3"])` — finds artworks tagged with *both* codes
- **Combined with other filters:** `search_artwork(iconclass: "73D64", type: "painting")` — paintings of the Crucifixion

The `iconclass` parameter accepts exact notation codes (language-independent). These are the same codes returned by this server's `search`, `browse`, `resolve`, and `search_prefix` tools. Note that rijksmuseum-mcp+'s `subject` parameter is different — it searches Iconclass label *text* (primarily Dutch/English), not notation codes.

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
| "Which notations have Rijksmuseum artworks?" | `search` with `collectionId: "rijksmuseum"` |
| "How many Rijksmuseum artworks depict X?" | `find_artworks` with notation(s) from a prior search |
| "Show me artworks about X" | Full workflow: `search` → `find_artworks` → `search_artwork(iconclass: ...)` on rijksmuseum-mcp+ |

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

When working with key expansions, remember that the `(+4...)` group is about artistic production (damage, restoration, stages of creation), not depicted object condition — see Notation Syntax.

### `search` with `parentNotation` vs `search_prefix`

Both restrict to a subtree, but they answer different questions:

- `search(query=..., parentNotation="11F")`: keyword search *within* a subtree — "find notations about 'reading' under Virgin Mary." Combines text relevance with hierarchical scoping.
- `search_prefix(notation="11F")`: enumerate *all* notations starting with a prefix, ordered alphabetically. No text search — pure hierarchy traversal. Use when you want the full inventory of a branch. Supports `collectionId` to filter to notations with Rijksmuseum artworks.

If `parentNotation` returns zero results, the concept may exist in a different branch. Try removing the scope for a global search, or broadening to a parent prefix (e.g. `"11"` instead of `"11F"`).

---

## Key Workflows

### 1. Discover a Notation Code

Start with keyword search. If the term is unknown or the concept is atmospheric/interpretive, use semantic search.

```
# Known term
search(query: "crucifixion")
# -> 73D6 (rijksmuseum) "the Crucifixion of Christ" [7 > 73 > 73D]

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

### 5. Querying with Multiple Codes

Complex artworks carry codes from multiple branches because a single image contains overlapping subjects: a scene, its actors, their attributes, symbolic objects, the setting. When searching for artworks of a specific subject, you can exploit this by combining codes from different branches. A search for artworks of St. Francis preaching to birds might use:

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

When passed to rijksmuseum-mcp+, these codes AND-combine — `search_artwork(iconclass: ["11H(FRANCIS)32", "25F3"])` finds artworks tagged with *both* codes. This is how you express compound iconographic queries.

When no notation exactly captures a nuanced concept (e.g., a broken lute string as a vanitas symbol), use the closest codes (`11R7` vanitas symbols + `48C7323` lute) and note the interpretive nuance separately. Verify the key's actual meaning before using key expansions (see Notation Syntax above).

### 6. Check Rijksmuseum Artwork Counts

After discovering notation codes via `search` or `browse`, use `find_artworks` to check artwork counts and get link-out URLs. This answers "how many Rijksmuseum artworks use this subject?" — essential for gauging a notation's practical usefulness before handing it to rijksmuseum-mcp+.

```
# Single notation
find_artworks(notation: "73D64")
# -> 73D64 "the Crucifixion of Christ"
#      Rijksmuseum, Amsterdam: 47 artworks

# Batch: compare counts across multiple notations (up to 25)
find_artworks(notation: ["34B11", "25F23", "11H(FRANCIS)32"])
# -> per-notation breakdown with artwork counts
```

**When to use `find_artworks` vs `collections`:**
- `collections` (returned by `search`, `browse`, `resolve`) gives a quick signal — "does the Rijksmuseum have artworks for this code?" Useful for filtering during discovery.
- `find_artworks` gives exact artwork counts. Use it when you need to know *how many* artworks are tagged with a notation, or when comparing coverage across notations before handoff.

**Practical patterns:**

- **After narrowing to a handful of codes:** Run `find_artworks` on your shortlist to see counts, then hand off the codes with the best coverage to rijksmuseum-mcp+.
- **Comparing sibling notations:** When two notations seem interchangeable (e.g. `73D64` vs `73D641`), `find_artworks` reveals which one the Rijksmuseum actually uses — the one with more artworks is the better handoff code.
- **Checking before handoff:** A notation with 0 artworks will return nothing on rijksmuseum-mcp+. Look for a parent or sibling notation instead.
- **When all queried notations return 0:** The specific codes may be too narrow. Try the parent notation — often the broader category has artworks even when the children don't:
  ```
  # 73D812 "Veronica wipes the face of Christ" — 0 artworks
  # Try the parent:
  find_artworks(notation: "73D81")
  # -> Rijksmuseum, Amsterdam: 12 artworks
  ```

The `lang` parameter controls the language of notation labels in the response (default: `"en"`). The link-out URLs open pre-filtered searches on the Rijksmuseum website — these are useful as a fallback when rijksmuseum-mcp+ is unavailable.

### 7. Cross-Server Handoff to rijksmuseum-mcp+

This is the terminal step of most workflows. Once you have notation codes with confirmed artwork counts, pass them directly to rijksmuseum-mcp+:

```
# Step 1: discover the code
search(query: "Jerome")
# -> 11H(JEROME) (rijksmuseum) "the monk and hermit Jerome (Hieronymus)"

# Step 2: check artwork counts
find_artworks(notation: "11H(JEROME)")
# -> Rijksmuseum, Amsterdam: 156 artworks

# Step 3: hand off to rijksmuseum-mcp+
search_artwork(iconclass: ["11H(JEROME)"])
# -> Rijksmuseum artworks depicting St. Jerome
```

**Combining iconclass with other filters on rijksmuseum-mcp+:**
```
# Paintings only
search_artwork(iconclass: ["11H(JEROME)"], type: "painting")

# By a specific artist
search_artwork(iconclass: ["11H(JEROME)"], creator: "Rembrandt van Rijn")

# Multiple subjects (AND)
search_artwork(iconclass: ["11H(JEROME)", "25F23"])
# -> artworks tagged with BOTH St. Jerome AND beasts of prey
```

When rijksmuseum-mcp+ is available and the user's goal involves seeing artworks, the natural next step is to call `search_artwork` with the notation codes you've found. The two servers are companions — notation codes flow from this server to that one directly.

### When rijksmuseum-mcp+ is not available

If `search_artwork` is not available (the server is not connected), present the notation codes you've found with their artwork counts and hierarchy context — this is more useful than bare codes alone. You can also offer the link-out URLs from `find_artworks`, which open pre-filtered searches on the Rijksmuseum website.

To enable direct artwork search in future conversations, the user can install the companion server **rijksmuseum-mcp+** from [github.com/kintopp/rijksmuseum-mcp-plus](https://github.com/kintopp/rijksmuseum-mcp-plus).

---

## Known Limitations

| Issue | Workaround |
|---|---|
| British/American spelling — "odour" vs "odor" | Try both spellings. `semanticQuery` handles this automatically. |
| Wide branches truncated at 25 per parent | Use `search_prefix` to enumerate all notations, or paginate with `offset`. |
| Resolve batch limit of 25 | Use `search` for discovery, `resolve` only for the 3–5 notations you need full metadata on. |
| `parentNotation` returns 0 but concept exists | The concept may live in a different branch. Remove the scope and search globally. |
| Key expansion labels can mislead | Verify a key's meaning in context. The `(+4...)` group is about artistic production, not depicted object condition. See Notation Syntax. |
| `find_artworks` batch limit of 25 | Sufficient for most workflows — you should have narrowed to a shortlist before calling. |
| Artwork counts cover Rijksmuseum only | ~20K of ~40K base notations (~50%) have Rijksmuseum artworks. |
| `find_artworks` returns "no collections" | The notation exists but the Rijksmuseum has not tagged artworks with it. Try a parent or sibling notation. |

---

## Output Conventions

- Show notation codes (e.g. `73D82`) — they are the stable identifiers across both servers and the handoff format to rijksmuseum-mcp+
- Include artwork counts when available — they signal whether a code is useful for artwork retrieval
- Show hierarchy paths (e.g. `7 > 73 > 73D > 73D8`) — they help the user understand where a notation sits in the classification system
- When presenting multiple notations, lead with highest artwork counts — these are the most practically useful codes
- Distinguish between what was found via keyword search vs semantic search — the confidence levels differ
- When the user's goal involves artworks, the workflow is most helpful when it reaches actual artworks on rijksmuseum-mcp+ rather than ending at notation codes

---
