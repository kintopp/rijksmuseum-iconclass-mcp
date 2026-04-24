# Iconclass Animal Taxonomy Audit — Design

**Status:** draft, awaiting user review.
**Date:** 2026-04-24.
**Author:** Arno Bosse (with Claude).
**Target artifact:** a research report + row-level catalogue in `offline/audits/animal-taxonomy/`, not a change to the deployed MCP server.

## 1. Context and purpose

Iconclass is a hierarchical taxonomy for art subjects. Its animal tree contains known taxonomic oddities — notably `25F26(WOMBAT)` filed under "rodents" (wombats are marsupials) and `25FF412` "salamander (fabulous animal); salamander as spirit of fire" as the only salamander notation in the entire catalogue (real salamanders are amphibians but have no entry under `25F5`). Rabbits and hares are also filed under `25F26 rodents` though lagomorphs are not rodents.

**Question the audit answers:** *Is this a systemic problem, or a handful of anecdotes?* A scoping exercise, not a final scientifically-validated report. If the answer is "systemic, here are 50+ examples," a bigger follow-up project is warranted. If "no, just the famous 3–4 cases," the question is answered and we stop.

**First-pass scope:** mammals only. The methodology is designed to extend cleanly to other branches (reptiles+amphibians, lower animals, fish, birds) by changing one CLI argument.

## 2. What counts as an error

Three error classes flagged per **mammal concept** (not per notation — see §4 for the concept-centric pivot):

- **E1. Misplacement under a wrong parent bucket** — a real animal placed under a `25F2x` bucket that is biologically wrong even under a generous 1970s reading. Example: `25F26(WOMBAT)` under `25F26 rodents`.
- **E2. Real animal present only as fabulous** — a creature that is also a real biological animal appears in the Iconclass catalogue only in `25FF2*` (fabulous mammals) and has no corresponding entry in `25F2*` (real mammals). Example: salamander (real amphibian) appears only as `25FF412`.
- **E3. Polysemous / ambiguous name** — one Iconclass notation's NAME variant covers two biologically distinct species under one historical term. Example: "panther" (leopard vs. jaguar vs. mythical panther).

**E4** (critique of the `25F2x` bucket design itself — morphological, not cladistic) is included as a one-paragraph framing appendix in each report, not as per-row findings.

**Out of scope explicitly:**
- External cross-references (Wikidata, GBIF, Wikipedia) used as ground truth. The audit is **inward-looking**: Haiku analyses only the animals already in the Iconclass catalogue, using the catalogue itself as its universe of discourse.
- Collection-specific evidence (e.g. Rijksmuseum artwork counts) as grounding for E2. Rijksmuseum counts are happenstance — using them would conflate "Iconclass is incomplete" with "Rijksmuseum cataloguers worked around Iconclass's incompleteness".
- Discovery of mammal concepts that have zero presence in `25F2 ∪ 25FF2` but are mentioned elsewhere (e.g. a mammal mentioned only in a saint-attribute notation). The audit boundary: "correctness and completeness of the animal tree relative to animals Iconclass already indexes as animals."

## 3. Architecture

Single Python script, read-only against `data/iconclass.db`, writes a report bundle to `offline/`. No changes to the deployed MCP server, the DB schema, or the test suite.

```
offline/
├── scripts/
│   └── audit-animal-taxonomy.py              ← the one script
└── audits/
    └── animal-taxonomy/
        ├── README.md                         ← index across branches, grows per run
        └── 25F2-mammals/                     ← first branch
            ├── report.md                     ← narrative verdict
            ├── findings.csv                  ← per-concept rows
            ├── concepts.jsonl                ← Stage 1 cached output
            ├── audit.jsonl                   ← Stage 2 raw Haiku responses
            └── prompts/                      ← exact text of each call
                ├── batch-001.txt
                └── ...
```

**CLI:**
```
audit-animal-taxonomy.py --branch 25F2 [--model claude-haiku-4-5-20251001] [--force] [--dry-run]
```

- `--branch`: required. One prefix (`25F2`) or comma-separated pair (`25F4,25F5` for reptiles+amphibians joint run). Paired fabulous branch derived automatically (`25F2` → also sweep `25FF2`).
- `--model`: default `claude-haiku-4-5-20251001`.
- `--force`: bust the response cache.
- `--dry-run`: skip API calls, echo prompts to stdout.

**Runtime dependencies:** Python 3.11+, `anthropic` SDK, stdlib `sqlite3`. Run via the existing `embeddings` conda env: `~/miniconda3/envs/embeddings/bin/python`.

## 4. Unit of analysis: mammal *concepts*, not notations

The foundational design decision, arrived at after discovering (via a subagent survey of the hierarchy) that mammals appear across **at least 26 significant notations spanning all 10 top-level branches** — e.g. "lion" hits 24 distinct notations (beasts-of-prey, Agnus Dei pair, Mark's winged lion, St. Jerome, Nemean lion, Daniel, heraldry, etc.).

The audit therefore iterates over **mammal concepts**, each clustered with every notation that references it:

- **Concept** = a canonical animal name (e.g. `salamander`, `lion`, `wombat`).
- **Cluster** = every base notation across the whole Iconclass catalogue that references the concept, with metadata (label, parent, parent label, branch category).

For each concept, Haiku evaluates three sub-questions:
1. Does the concept have an entry in `25F*` (real animals)?
2. If yes, is its placement within `25F*` taxonomically correct under a generous 1970s reading?
3. Is the name unambiguous, or does it cover multiple species?

This pivot has two consequences:
- **E2 becomes principled** — it's a dictionary lookup over the cluster ("is there a `25F*` entry for this concept?"), not LLM speculation about what might be missing.
- **Number of Haiku calls is bounded by concept count, not notation count.** For mammals: ~120–160 concepts → ~6–8 batched calls. Single-digit-dollar total cost.

## 5. Pipeline

Three stages. Stages 1 and 3 are deterministic and LLM-free; Stage 2 is the only stage that calls the Anthropic API.

### Stage 1 — Build concept clusters (pure SQL + Python)

1. **Seed names.** For the given root (e.g. `25F2`), pull every base notation (no key-expanded variants) under `25F2*` and `25FF2*`. For each:
   - If the notation has a NAME-in-parens variant (e.g. `25F26(WOMBAT)`, `25F23(POLAR BEAR)`) → extract the bracketed string.
   - Otherwise (bucket-level like `25F26 "rodents"`) → use the English keyword from the `keywords` table.
   - Canonicalise: lowercase, strip, collapse whitespace. Preserve multi-word names (`"polar bear"`).
   - Deduplicate. Expected ~120–160 unique mammal names.

2. **Expand via FTS5.** For each seed name, query `texts_fts` and `keywords_fts` for every base notation across the whole catalogue that mentions it. SQL sketch:

   ```sql
   SELECT DISTINCT n.notation, n.parent,
          (SELECT text FROM texts WHERE notation=n.notation AND lang='en' LIMIT 1) AS label_en,
          (SELECT text FROM texts WHERE notation=n.notation AND lang='nl' LIMIT 1) AS label_nl,
          (SELECT text FROM texts WHERE notation=n.parent   AND lang='en' LIMIT 1) AS parent_label_en
   FROM notations n
   WHERE n.notation NOT LIKE '%(+%'
     AND (
       n.notation IN (SELECT notation FROM texts_fts    WHERE texts_fts    MATCH :name)
    OR n.notation IN (SELECT notation FROM keywords_fts WHERE keywords_fts MATCH :name)
     );
   ```

   FTS5 escape rules apply (port the logic from `utils/db.ts:escapeFts5`).

3. **Attach branch context.** For each matched notation, compute a branch category from its prefix: `25F*` → "real animal tree", `25FF*` → "fabulous", `34B*` → "symbolic animals", `11D/H/I` → "religious symbolism / saint attributes", `71/73` → "Bible OT/NT", `82A` → "literary characters", `94/95` → "classical mythology", `46C13/14` → "transport/traction", `46A122` → "heraldry". Unknown prefixes → "other".

4. **Emit `concepts.jsonl`.** One JSON line per concept:

   ```json
   {
     "concept": "salamander",
     "seed_notations": ["25FF412"],
     "cluster": [
       {"notation": "25FF412", "label_en": "salamander (fabulous animal)...",
        "label_nl": "salamander (fabeldier)...", "parent": "25FF41",
        "parent_label_en": "fabulous animals ~ lizards", "branch": "25FF fabulous"}
     ],
     "cluster_size": 1
   }
   ```

**Known gotchas accepted at this stage:**
- **Homograph noise** (e.g. `ram` animal vs. battering ram). Stage 1 returns both; Haiku's polysemy flag handles it in Stage 2. This keeps Stage 1 a pure function of the DB.
- **Cluster-size = 1** is common for obscure concepts — still valid input to Stage 2.
- **Multi-word names** use phrase-matched FTS (`"polar bear"` in quotes), via the escape utility.

Runtime: seconds.

### Stage 2 — Haiku audit (batched API calls)

One system prompt (shared across calls). Concepts batched in groups of ~20–30 per call to keep prompts under a comfortable context size. Each call receives: the batch of concept clusters as JSON, plus few-shot examples (wombat → E1, salamander → E2, panther → E3).

**System-prompt guardrails** (paraphrased):
- "Iconclass buckets like `rodents`, `beasts of prey`, `hoofed` are morphological / behavioural categories from 1970s art-historical usage — not Linnaean clades. Flag E1 only when the placement is wrong **even under a generous 1970s reading**."
- "If a name is archaic and could refer to several animals, flag E3 — do not guess which one was meant."
- "If unsure, return `uncertain` with a brief reason. Do not fabricate taxonomic detail."
- "Emit valid JSON only, no prose outside the array."

**Haiku output per concept (schema).** Note: the `cluster` field is compressed to bare notation IDs in Haiku's output (it received the full `list[object]` cluster from Stage 1 as context in the prompt; the response only needs to echo identifiers).

```json
{
  "concept": "salamander",
  "cluster": ["25FF412"],
  "real_animal": true,
  "real_tree_presence": {
    "has_entry": false,
    "flag": "E2",
    "finding": "Real salamanders are amphibians. Only Iconclass entry is 25FF412 (fabulous fire-spirit). No entry under 25F5."
  },
  "real_tree_taxonomy": {
    "placement_ok": null,
    "flag": "na",
    "finding": "N/A — no real-tree entry to evaluate."
  },
  "polysemy": {
    "flag": "ok",
    "finding": "Name refers unambiguously to Salamandridae."
  },
  "confidence": "high"
}
```

Allowed flags:
- `real_tree_flag`: `E2` / `ok` / `na` (not a real animal) / `uncertain`.
- `taxonomy_flag`: `E1` / `ok` / `na` (no real-tree entry to check) / `uncertain`.
- `polysemy_flag`: `E3` / `ok` / `uncertain`.
- `confidence`: `high` / `medium` / `low`.

Temperature fixed at 0. Responses appended to `audit.jsonl`.

**Typical mammal run:** ~6–8 Haiku calls, single-digit-dollar cost, minutes of runtime.

### Stage 3 — Report assembly (pure Python)

Join Stage 1 (clusters) with Stage 2 (judgements). Emit:
- `findings.csv` — one row per concept, columns as listed in §6.
- `report.md` — narrative verdict + top cases + appendices (structure in §6).
- `README.md` at the top level of `offline/audits/animal-taxonomy/` — updated to include the new branch (one-line index entry).

## 6. Output schemas

### `findings.csv`

One row per concept. Columns:

| column | type | example |
|---|---|---|
| `concept` | str | `salamander` |
| `seed_notations` | `;`-joined list[str] | `25FF412` |
| `cluster_size` | int | `1` |
| `cluster_branches` | `;`-joined list[str] | `25FF fabulous` |
| `real_animal` | bool | `true` |
| `real_tree_flag` | `E2` / `ok` / `na` / `uncertain` | `E2` |
| `real_tree_finding` | str | "Real salamanders are amphibians. Only Iconclass entry is 25FF412 (fabulous fire-spirit). No entry under 25F5." |
| `taxonomy_flag` | `E1` / `ok` / `na` / `uncertain` | `na` |
| `taxonomy_finding` | str | "N/A — no real-tree entry to evaluate." |
| `polysemy_flag` | `E3` / `ok` / `uncertain` | `ok` |
| `polysemy_finding` | str | "Name refers unambiguously to Salamandridae." |
| `confidence` | `high` / `medium` / `low` | `high` |

### `report.md` structure

Target length ~1000–1500 words for mammals.

1. **Verdict (3 sentences max).** "Of N mammal concepts audited, X are flagged in one or more error classes. The distribution suggests this is systemic / isolated / mixed." + counts by flag.
2. **Ten most compelling cases** — 3–4 per error class, each with: concept, cluster summary, the finding narrative, confidence. Hand-picked from the CSV.
3. **Counts tables** — per-flag totals; distribution of E1 flags by parent bucket (so `25F26 rodents`-heavy results are visible).
4. **Appendix A** — full list of concepts flagged E2.
5. **Appendix B** — full list of concepts flagged E3.
6. **Appendix C** — concepts with any `uncertain` flag, so the reader knows what remains to be spot-checked manually.
7. **Appendix D** — one-paragraph E4 framing note: Iconclass mammal buckets are pre-Linnaean morphological categories (hoofed / predatory / rodent-as-small-furry-quadruped / trunked / flying / swimming / other). This context frames the rest of the findings — many E1 flags are symptoms of the bucket design, not isolated editorial slips.
8. **Methodology** — model ID, SDK version, run date, `iconclass.db` row counts + schema version, `concepts.jsonl` hash, total API calls.

### `README.md` (top-level index)

Grows incrementally. One line per audited branch. Illustrative layout only — the numeric cells below are placeholders, not expected results:

```markdown
# Animal Taxonomy Audit

| Branch | Date | Concepts | E1 | E2 | E3 | Uncertain | Report |
|---|---|---|---|---|---|---|---|
| 25F2 mammals | YYYY-MM-DD | N | … | … | … | … | [report](25F2-mammals/report.md) |
| ... | ... | ... | ... | ... | ... | ... | ... |
```

## 7. Extensibility across branches

Single CLI arg. Two small nuances baked in:

- **Joint runs for small twinned branches.** `--branch 25F4,25F5` for reptiles+amphibians (salamander-style errors span both). Mammals / lower animals / fish / birds stand alone.
- **One branch-specific string in the system prompt.** The "bucket design" sentence varies: mammals mentions "rodents/hoofed/predatory"; lower animals mentions "pre-Darwinian habit-grouped non-vertebrates". Parameterised, not restructured.

Rollout order (tentative, based on likely error density):

1. Mammals (pilot — 171 base notations across real + fabulous, ~120-160 concepts).
2. Reptiles + amphibians (joint, 49 base notations).
3. Lower animals (117 base notations — likely the highest-yield single branch).
4. Fish (87 base notations).
5. Birds (180 base notations — largest but probably cleanest).

## 8. Caching and reproducibility

**Caching.** Every Haiku call keyed on `sha256(model_id + system_prompt + user_prompt)`. Responses stored in `audit.jsonl` indexed by hash. On re-run the script reads cache first; only missing hashes hit the API. `--force` invalidates the cache. Stage 1 is fast enough to re-run from the live DB every time — `concepts.jsonl` is a build artifact, not a cache.

**Reproducibility.**
- `report.md` methodology section records: model ID + version, Anthropic SDK version, `iconclass.db` row counts + schema version, run date, `concepts.jsonl` SHA256. A reader can tell exactly what DB state the audit reflects.
- Temperature fixed at 0. Not perfectly reproducible (Haiku remains stochastic at T=0 in rare cases), but good enough for a scoping report; re-runs hit the cache anyway.
- No external network calls beyond the Anthropic API. DB is local. Audit is a pure function of its inputs.

## 9. What is deliberately *not* in this design

- No visualisations, dashboards, or web UI. Scoping exercise — markdown + CSV suffice.
- No changes to the deployed MCP server (`src/`, `dist/`, production DB builds, HTTP endpoints).
- No new tests in `scripts/tests/`. The audit is offline research; no regression surface.
- No external data cross-referencing (Wikidata, GBIF, Rijksmuseum counts). Inward-looking only.
- No discovery of mammal concepts absent from `25F2 ∪ 25FF2` but mentioned elsewhere (e.g. exclusively as a saint's attribute). The audit's boundary: "correctness and completeness of the animal tree relative to animals Iconclass already indexes as animals."
- No multilingual label expansion beyond English + Dutch context. Seed uses English; Dutch labels are included in the Haiku prompt as disambiguation context only.

## 10. Success criteria

The audit is successful when it produces, for mammals:

- A verdict paragraph stating whether the problem is **systemic, isolated, or mixed**, with counts.
- At least **10 compelling per-concept findings** with high-confidence flags, spanning E1 / E2 / E3.
- A reproducible bundle (`findings.csv` + `report.md` + cached JSONL) that another reader can re-generate from the same `iconclass.db` and reach the same flags.
- Clear enough structure that extending to the next branch (reptiles+amphibians) is mechanical, not a design exercise.

Implementation planning follows in a separate step (`writing-plans` skill), with concrete task breakdown, test-checkpoints, and sequencing.
