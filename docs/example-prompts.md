## Example Prompts

Sample prompts that show what the AI assistant can do with this server's six tools. Each prompt is designed around a real research question drawn from the [Iconclass community](https://forum.iconclass.org).

- [Smell and the Senses in Art](#1-smell-and-the-senses-in-art)
- [Finding Saints by Name](#2-finding-saints-by-name)
- [Where Does Alchemy Belong?](#3-where-does-alchemy-belong)
- [The Life and Miracles of St. Francis](#4-the-life-and-miracles-of-st-francis)
- [Mapping All Animal Notations](#5-mapping-all-animal-notations)
- [Classifying a Complex Scene](#6-classifying-a-complex-scene)
- [From Notation to Artwork](#7-from-notation-to-artwork)
- [Last Supper or Wedding at Cana?](#8-last-supper-or-wedding-at-cana)
- [A Broken Lute String as Vanitas](#9-a-broken-lute-string-as-vanitas)
- [Classifying Jungle Book Illustrations](#10-classifying-jungle-book-illustrations)

---

### 1. Smell and the Senses in Art

*"How does Iconclass classify the sense of smell? What notations exist for odours, fragrant objects, and olfactory experience — and which of these actually appear in the Rijksmuseum's collections?"* [link](https://claude.ai/share/df2662de-c3de-4d5e-aba7-edf0a98fb906)

**Tools:** `search` (semantic + FTS), `browse`

**How the tools enable it:**
- `search` with `semanticQuery: "smell and olfactory experience"` finds notations by meaning — it surfaces `31A33` (smell) and related concepts even when the exact word doesn't appear in the notation text
- `search` with `query: "smell"` for precise FTS matches across all 13 languages — picks up notations that mention smell in keywords or labels
- `browse` on `31A3` (the five senses) to see the full hierarchy: `31A31` sight, `31A32` hearing, `31A33` smell, `31A34` taste, `31A35` touch — plus their children and cross-references
- `browse` on `31A33` with `includeKeys: true` to discover 116 key-expanded variants like `31A33(+1)` (front view), `31A33(+72)` (in the open air) that add situational modifiers
- The `collections` array on each result reveals which smell-related notations have artworks in the Rijksmuseum — `31A33` is present, but deeper variants may not be

**Why it matters:** Sensory history is a growing research field, but olfactory experience is underrepresented in art classification systems. A [discussion on the Iconclass forum](https://forum.iconclass.org/t/iconclass-and-sensory-history/15) proposed expanding `31A33` with sub-codes for smell sources, odour carriers, and fragrant spaces. This prompt maps the current Iconclass landscape for olfaction.

---

### 2. Finding Saints by Name

*"I need to find Iconclass notations for St. Jerome and St. Catherine of Siena. Do they exist? What are their attributes, and how many artworks does the Rijksmuseum hold for each?"* [link](https://claude.ai/share/fafef7e7-e6a7-481c-949c-465a1a564bcf)

**Tools:** `search` (FTS)

**How the tools enable it:**
- `search` with `query: "Jerome"` finds `11H(JEROME)` — the notation includes his attributes listed in the label text ("book, cardinal's hat, crucifix, hour-glass, lion, skull, stone") and shows Rijksmuseum artwork counts
- `search` with `query: "Catherine Siena"` finds `11HH(CATHERINE OF SIENA)` — the results distinguish male saints under `11H(...)` from female saints under `11HH(...)`, a naming convention that encodes gender in the notation structure
- Each result includes a `collections` array showing artwork counts — Jerome has numerous artworks in the Rijksmuseum, reflecting his popularity as a subject in Northern European art
- Searching for a name not in the database (e.g. "Euphemia" or "Balbina") returns zero results — confirming the saint is missing and needs to be proposed

**Why it matters:** The Iconclass forum maintains a [collaborative list of saints missing from the system](https://forum.iconclass.org/t/list-saints-missing-in-iconclass/148). Researchers cataloguing religious art need to verify whether a saint already has an Iconclass notation before proposing a new one. The FTS search across all languages is essential because a saint may have a notation with labels only in Italian or German, not English. The artwork counts tell the researcher how actively the notation is used in museum collections.

---

### 3. Where Does Alchemy Belong?

*"Alchemy sits under 'science' in Iconclass (49E39), but its symbolism overlaps with religion and magic. Show me the full hierarchy around alchemy — its parent path, siblings, children, and cross-references — so I can understand and evaluate how Iconclass positions it."* [link](https://claude.ai/share/53ed27f2-5e43-412d-afff-ba092439fdc2)

**Tools:** `browse`

**How the tools enable it:**
- `browse` on `49E39` returns the entry with its full path from root to leaf: `4` (Society) → `49` (education, science, learning) → `49E` (sciences) → `49E3` (chemistry) → `49E39` (alchemy)
- The `children` array shows sub-topics like `49E3945` (Philosopher's Stone), `49E394` (transmutation of metals)
- The `refs` array would reveal cross-references to related notations elsewhere in the hierarchy — but in this case it is empty, meaning Iconclass does not formally link alchemy to religion or magic despite the conceptual overlap
- Use `search` with `query: "alchemy"` to find notations *outside* `49E39` that mention alchemy in their keywords or labels — this may surface connections the hierarchy itself does not encode

**Why it matters:** A [critique on the Iconclass forum](https://forum.iconclass.org/t/what-bothers-me-about-iconclass/16) argued that alchemy's placement under science misrepresents its historical character — for most of its history, alchemy was inseparable from mystical and religious practice. The `browse` tool makes Iconclass's structural decisions transparent: the path reveals the editorial choice, the absence of cross-references reveals a gap in the system's internal linking, and keyword search can find connections the hierarchy misses. 

---

### 4. The Life and Miracles of St. Francis

*"What scenes from the life of St. Francis of Assisi does Iconclass cover? Show me the full narrative structure — his early life, visions, miracles, martyrdom, and posthumous events — and which scenes have artworks in the Rijksmuseum."* [link](https://claude.ai/share/5762502a-3803-4c5f-899a-6136c18c6a81)

**Tools:** `browse`, `search_prefix`

**How the tools enable it:**
- `browse` on `11H(FRANCIS)` returns the top-level entry with its attributes ("book, crucifix, lily, skull, stigmata") and direct children — numbered sub-codes that follow the generic saint lifecycle template
- The children reveal a structured narrative: `11H(FRANCIS)2` (early life), `11H(FRANCIS)3` (personal devotion), `11H(FRANCIS)4` (non-miraculous events), `11H(FRANCIS)5` (miracles), `11H(FRANCIS)6` (martyrdom and death)
- `browse` on `11H(FRANCIS)5` to expand the miracles: the pope's dream of St. Francis saving the Lateran Church (`51`), preaching to the birds (`53`), taming the wolf of Gubbio (`54`), the stigmatization (`59`)
- `search_prefix` on `11H(FRANCIS)` to retrieve all 48 notations in the Francis sub-tree at once, with artwork counts showing which scenes appear in the Rijksmuseum (stigmatization and preaching to the birds are well represented)
- Compare with `browse` on `11H(...)` to see the generic template that all saints share — the same lifecycle structure (early life → devotion → miracles → death → posthumous events) applies to every saint in the system

**Why it matters:** Iconclass encodes the lives of saints as structured narratives following a common lifecycle template. A [forum discussion on missing saints](https://forum.iconclass.org/t/list-saints-missing-in-iconclass/148) revealed the depth of this system — each named saint has a unique sub-tree with specific scenes, while the generic template `11H(...)` defines the slots available. For a researcher studying Franciscan iconography, the `browse` tool makes the full catalogue of classifiable scenes visible in seconds, and the artwork counts immediately show which scenes are represented in museum holdings.

---

### 5. Mapping All Animal Notations

*"How many notations exist under 'animals' in Iconclass? Give me an overview of the major sub-branches — mammals, birds, reptiles, fish, insects — with counts of notations and artworks in each. For the salamander specifically, show me where it appears in the hierarchy and what modifiers are available — is it classified as a real animal, a fabulous creature, or both?"* [link](https://claude.ai/share/6bbd38a7-729f-4c57-8403-5471d674f896)

**Tools:** `search_prefix`, `browse`, `search` (FTS), `expand_keys`

**How the tools enable it:**
- `browse` on `25F` (animals) to see the top-level structure: `25F2` (mammals), `25F3` (birds), `25F4` (reptiles), etc.
- `search_prefix` on `25F2` to count all mammal notations (base + key-expanded), `25F3` for birds, `25F4` for reptiles, and so on
- The `totalResults` in each prefix search gives the size of each sub-branch — showing that mammals and birds dominate while insects are sparse
- `search` with `query: "salamander"` reveals the salamander under fabulous animals: `25FF412` ("salamander as spirit of fire") and its 204 key-expanded variants — the salamander also appears as an *attribute* of Ananias/Shadrach (`11I62(ANANIAS)`, discoverable via `resolve`), linking it to the story of the three youths in the fiery furnace
- `expand_keys` on `25FF412` to see its modifiers: `+11` (bestiaries, Physiologus), `+12` (heraldic), `+13` (as attribute), `+46` (sleeping), and so on — the same 204 modifier codes apply uniformly across all animal notations
- `browse` on `25FF412` to see the fabulous-animal branch, where the salamander's mythological identity as a fire spirit is explicitly encoded — its path runs through `25FF` (fabulous animals) → `25FF4` (fabulous reptiles) → `25FF41` (fabulous lizards)

**Why it matters:** Prefix search exploits Iconclass's left-to-right hierarchical encoding — everything under `25F3` is a bird, everything under `25F44` is a tortoise or turtle. The salamander is classified solely as a fabulous animal (`25FF412`), not as a real reptile — reflecting Iconclass's editorial judgment that the salamander's cultural significance is primarily mythological. It also appears as a saint's attribute (`11I62(ANANIAS)`), discoverable via `resolve` rather than keyword search. A [forum discussion on specifying musicians in ensembles](https://forum.iconclass.org/t/specifying-the-number-of-musicians-in-music-ensembles/199) revealed that many users don't know what modifiers are available for a given notation — the same is true for animals, where the Physiologus modifier `+11` is easy to miss.

---

### 6. Classifying a Complex Scene

*"I'm cataloguing a painting that shows the Virgin Mary seated with the Christ Child on her lap, reading from an open book, with a vase of lilies on a table beside her. What Iconclass notations should I assign? Show me the full metadata for each so I can verify they fit."* [link](https://claude.ai/share/d0d2f5c0-efee-4389-9e5f-201cd488c23c)

**Tools:** `search` (FTS + semantic), `resolve`

**How the tools enable it:**
- `search` with `semanticQuery: "Virgin Mary reading with Christ Child"` to find the most conceptually relevant notations — surfaces candidates like `73B732` (Mary teaches Christ-child to read)
- `search` with `query: "Christ-child"` to catch labels describing this common scene type — Iconclass uses the hyphenated form in its English labels, so this finds notations like `73B732` (Mary teaches the Christ-child to read)
- `search` with `query: "open book"` and `query: "lily vase"` to find notations for the secondary elements
- `resolve` with all candidate notations in a single batch call — e.g. `["73B732", "11F4212", "49MM32", "25G41(LILY)"]` — to retrieve full metadata for each: labels, keywords, hierarchy path, cross-references, and collection presence
- The resolved entries let the LLM compare and recommend: `73B732` captures the primary scene, `49MM32` adds the open book as a distinct iconographic element, and `25G41(LILY)` records the symbolic flower

**Why it matters:** Complex images require multiple Iconclass notations — this is a point the Iconclass community [emphasises repeatedly](https://forum.iconclass.org/t/what-bothers-me-about-iconclass/16). The batch `resolve` tool lets the LLM present all candidate notations side by side with full context, so the cataloguer can make an informed decision rather than guessing from notation codes alone. The cross-references on each notation may also reveal related codes the cataloguer hadn't considered.

---

### 7. From Notation to Artwork

*"Find the Iconclass notation for 'the deposition from the cross', then check whether the Rijksmuseum has artworks with this notation."* [link](https://claude.ai/share/a87d2b5b-a7f4-4d65-b973-9cd7eeba2069) [link](https://claude.ai/share/6b2dfed6-bbbb-411c-9da6-2949fe273f54)

**Tools:** `search` (FTS), `find_artworks`, then `search_artwork`

**How the tools enable it:**
- `search` with `query: "deposition from the cross"` → 0 results → "semanticQuery": "deposition from the cross, taking Christ down from the cross" → 73D71 — "descent from the cross" and its sub-notations
- `find_artworks` with `notation: ["73D71", "73D711", "73D712", "73D713","73D714"]` to see artwork counts for these related notations in the Rijksmuseum

**Why it matters:** A similar challenge was highlighted in a [forum question about quantitative iconographical data](https://forum.iconclass.org/t/quantitative-iconographical-data/219): a researcher studying hospital artworks needed to know which collections hold works tagged with specific Iconclass codes, and whether any single collection's coverage is representative. The `find_artworks` tool attempts to address this for the Rijksmuseum.

---

### 8. Last Supper or Wedding at Cana?

*"I'm looking at a painting of a banquet scene with Christ at a long table surrounded by guests. It could be the Last Supper or the Marriage at Cana — both are large gatherings around a table. What are the Iconclass notations for each, and what distinguishing features does the classification record?"* [link](https://claude.ai/share/d695c60a-826f-4d36-9f29-36e875d4ee2f)

**Tools:** `search` (FTS), `resolve`, `browse`

**How the tools enable it:**
- `search` with `query: "Last Supper"` finds `73D24` (Last Supper, with artworks in the Rijksmuseum) and related notations under `73D2` (the episode of the Last Supper) — including sub-scenes like the washing of feet and the institution of the Eucharist
- `search` with `query: "Cana"` finds `73C611` (the marriage-feast at Cana, with artworks in the Rijksmuseum) and sub-scenes like the water-into-wine miracle
- `resolve` with `["73D24", "73C611"]` in a single batch call to compare both entries side-by-side: their full labels, hierarchy paths, keywords, and cross-references
- The hierarchy paths alone are diagnostic: `73D24` sits under Passion of Christ (`73D`), while `73C611` sits under Christ's miracles (`73C6`) — placing the same visual motif (banquet with Christ) in entirely different theological contexts
- Browsing into the sub-scenes reveals distinguishing iconographic elements in their keywords — `73D244` (institution of the Eucharist) lists bread and wine, while `73C6113` (Christ orders jars filled with water) lists jar and water

**Why it matters:** A [forum discussion about a mysterious Mannerist drawing](https://forum.iconclass.org/t/mannerist-drawing-mysterious-iconography/264) debated exactly this question — was the scene the Last Supper or the Wedding at Cana? The presence of women among the guests, the exact number of diners, and the absence of water jars were all cited as evidence. The `resolve` tool's side-by-side comparison gives the cataloguer the full Iconclass description for both candidates, with hierarchy context that frames the theological distinction.

---

### 9. A Broken Lute String as Vanitas

*"A still-life painting includes a lute with a broken string — a classic vanitas motif. How should I classify this in Iconclass? Is the broken string a vanitas symbol, a damaged musical instrument, or both?"* [link](https://claude.ai/share/d6083605-e56e-4470-a12e-674bbd3a914a)

**Tools:** `browse`, `search` (FTS), `expand_keys`

**How the tools enable it:**
- `browse` on `11R7` (vanitas symbols) to see what the system offers: `11R71` (skull), `11R72` (smoking pot) — but no specific entry for broken strings or musical instruments
- `search` with `query: "broken string"` to check if it appears anywhere as a keyword or label
- `browse` on `48C7323` (lute) to see the base instrument notation, then `expand_keys` on `48C7323` to explore key variants — note that `48C7323(+42)` ("lute + damage and repair of work of art") does exist but is a category error here: the `(+4...)` key group concerns artistic production and works of art as objects (stages of production, damage, restoration), not the depicted condition of an instrument within a scene
- `search` with `query: "vanitas"` to find all vanitas-related notations and confirm the gap
- The result: there is no single notation for "broken string as vanitas," nor does the key expansion system provide one. The cataloguer should assign `11R7` (vanitas symbols) and `48C7323` (lute), with the broken string recorded in a scope note or catalogue description

**Why it matters:** A [forum discussion on broken strings as vanitas symbols](https://forum.iconclass.org/t/broken-strings-as-symbol-of-vanitas/302) raised this classification gap. The broken string as a vanitas motif is a well-known art-historical convention, but the classification system has no notation for it. The `(+42)` key expansion is a tempting false match that illustrates why key meanings must be verified in context: "damage to a work of art" is about the artwork-as-object, not about depicted objects within a scene. The correct approach is multi-code assignment (`11R7` + `48C7323`) with the interpretive nuance captured in prose.

---

### 10. Classifying Jungle Book Illustrations

*"I'm cataloguing a set of prints illustrating Kipling's Jungle Book. How do I classify Mowgli, Baloo, and Bagheera in Iconclass? Are they literary characters, animals, or something else?"* [link](https://claude.ai/share/8f96b5b5-dd70-4d17-9836-ea2664285d09)

**Tools:** `search` (FTS), `browse`

**How the tools enable it:**
- `search` with `query: "Mowgli"` to check whether the name already exists in Iconclass — it may appear under `82A(MOWGLI)` (named male literary character) if the community has added it
- `browse` on `82` (literary characters and objects) to understand the top-level structure: `82A` for named human characters, `82B` for named fictional animals and objects
- `browse` on `83(...)` (specific works of literature, with AUTHOR and Title) to check whether `83(KIPLING, The Jungle Book)` exists as a work-level notation
- `browse` on `85` (fables) and `29A` (animals acting as human beings) to see alternative classification paths — Baloo could go under `82B(BALOO)` as a named fictional animal, or under `29A` as an animal acting as a human
- `search` with `query: "Jungle Book"` to find any existing notations across all branches

**Why it matters:** A [forum discussion about Jungle Book prints](https://forum.iconclass.org/t/prints-from-kiplings-jungle-book/150) wrestled with a classification dilemma: is Baloo a literary animal (`82B`) or an anthropomorphic animal (`29A`)? Should the whole set be tagged with a work-level notation (`83`)? The answer depends on whether you're cataloguing the *character*, the *literary source*, or the *visual motif*. The Iconclass hierarchy offers multiple valid classification paths for the same subject — browsing several branches before deciding is better than picking the first match.
