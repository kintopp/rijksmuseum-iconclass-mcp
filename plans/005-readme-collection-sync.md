# Plan 005: Sync README collection claims with the actually-loaded collections (RKD)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat af139f1..HEAD -- README.md src/registration.ts`
> If these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `af139f1`, 2026-06-12

## Why this matters

README.md is the public front door of a deployed research service, and it is
factually wrong about what data the service contains. Line 109 says
`find_artworks` "currently only provides data from the Rijksmuseum in
Amsterdam", but the shipped counts sidecar contains **two** collections —
verified at planning time directly against `data/iconclass-counts.db`:

```
rijksmuseum | 22787 rows
rkd         | 13984 rows
```

(RKD = Royal Netherlands Institute for Art History / Rijksbureau voor
Kunsthistorische Documentatie, The Hague.) The production `/health` endpoint
lists both collection IDs. Researchers reading the README will under-use the
service — RKD adds ~14K notations of artwork coverage they're told doesn't
exist. `docs/SKILL.md` already mentions RKD (updated in commit `98d2931`),
so the README is the one surface left behind.

## Current state

- `README.md:109` — the stale sentence (verbatim, including trailing space):

  ```
  This currently only provides data from the Rijksmuseum in Amsterdam. 
  ```

  It sits in the `find_artworks` tool section of the README's "How it works"
  tool walkthrough.

- The README also describes each tool with a parameter table (e.g. the
  `search` section documents `query`, `semanticQuery`, `parentNotation`,
  `onlyWithArtworks`, `collectionId`). Earlier prose (intro, "How it works"
  paragraph) describes the counts DB as Rijksmuseum-only in places — e.g. the
  intro paragraph says "It includes data from the Rijksmuseum showing how
  many artworks are tagged with a particular notation". These should be
  checked and updated where they claim exclusivity, but keep edits minimal —
  this is a sync fix, not a rewrite.

- Authoritative tool facts to check the README against
  (`src/registration.ts`, commit `af139f1`):
  - `search`: maxResults 1-50, default 25; params `query`, `semanticQuery`,
    `onlyWithArtworks`, `collectionId`, `parentNotation`, `lang`, `maxResults`, `offset`.
  - `resolve`: up to 25 notations.
  - `expand_keys`: maxResults 1-335, default 25.
  - `search_prefix`: maxResults 1-100, default 25; params include `collectionId`.
  - `find_artworks`: up to 25 notations; returns per-collection counts +
    link-out URLs; tool description also tells the model to offer an
    ArtResearch.net link.
  - Languages: `en, nl, de, fr, it, es, pt, fi, cz, hu, pl, jp, zh` (13).

- Convention: README is written in user-facing prose (not changelog style);
  British/neutral academic tone; existing sentences are short and concrete.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Confirm loaded collections | `sqlite3 data/iconclass-counts.db "SELECT collection_id, COUNT(*) FROM collection_counts GROUP BY collection_id;"` | two rows: `rijksmuseum`, `rkd` (only if `data/` present locally) |
| Confirm stale text gone | `grep -n "only provides data from the Rijksmuseum" README.md` | no matches (after fix) |
| Build untouched | `git diff --name-only` | only `README.md` |

## Scope

**In scope** (the only file you should modify):
- `README.md`

**Out of scope** (do NOT touch):
- `docs/SKILL.md`, `docs/rijksmuseum-iconclass-mcp.skill*` — the skill bundle
  has its own versioning scheme (`0.41`) and regeneration process; editing it
  here would desync the bundled `.zip`.
- `docs/example-prompts.md`, `docs/technical-guide.md`, `CITATION.cff`.
- Any source file.

## Git workflow

- Branch: `advisor/005-readme-collection-sync`
- Commit style: `docs: README — reflect RKD as second loaded collection`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the find_artworks claim

Replace README.md line 109 (`This currently only provides data from the
Rijksmuseum in Amsterdam.`) with a sentence stating that artwork counts are
currently loaded for two collections — the Rijksmuseum (Amsterdam) and the
RKD – Netherlands Institute for Art History (The Hague) — and that the live
list is reported by the server's `/health` endpoint. Keep it to 1-2 sentences
in the existing tone.

**Verify**: `grep -n "only provides data from the Rijksmuseum" README.md` → no matches; `grep -n "RKD" README.md` → ≥1 match in the find_artworks section.

### Step 2: Sweep the rest of the README for exclusivity claims

Search for the other places that imply Rijksmuseum-only counts:

```
grep -n -i "rijksmuseum" README.md
```

For each hit that asserts the counts data is *only* Rijksmuseum (the intro
"It includes data from the Rijksmuseum…" sentence and the "How it works"
paragraph "A separate, small database records how many artworks in the
Rijksmuseum collection…"), adjust minimally to acknowledge both collections
(e.g. "from museum collections — currently the Rijksmuseum and the RKD —").
Do NOT touch hits that are about the companion server `rijksmuseum-mcp+`,
the project name, or the Railway URL.

**Verify**: re-run the grep; remaining "Rijksmuseum" mentions are the project
name, companion-server references, URLs, or now-accurate joint claims. List
the line numbers you changed in your report.

### Step 3: Spot-check parameter tables against the facts above

Compare each tool section's parameter table/limits in README.md with the
"Authoritative tool facts" list in Current state. Fix only concrete
mismatches (a wrong cap, a missing documented parameter); do not restyle.
If you find no mismatches, say so — that is the expected outcome.

**Verify**: `git diff README.md` shows only the edits from Steps 1-3.

## Test plan

Docs-only change; no automated tests apply. The verification greps above are
the gate. Do not run the build (nothing compiles README.md).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "only provides data from the Rijksmuseum" README.md` → 0
- [ ] `grep -n "RKD" README.md` → ≥1 match
- [ ] `git diff --name-only` → exactly `README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- README.md line 109 no longer contains the quoted sentence (already fixed
  or restructured since planning).
- You find evidence the RKD overlay was *removed* after 2026-06-12 (e.g.
  `data/iconclass-counts.db` shows only one collection, or a commit message
  says so) — the fix would then be wrong, not just stale.
- Step 3 reveals more than ~3 parameter-table mismatches — that suggests the
  README predates a larger API change and needs a human-scoped rewrite, not
  a sync patch.

## Maintenance notes

- Whenever a collection is added to or removed from the counts sidecar
  (`scripts/build-counts-db.py` / `COLLECTION_META`), README.md and
  `docs/SKILL.md` both need the same sync — consider keeping the README
  phrasing generic ("the collections listed at `/health`") to reduce churn.
- The SKILL.md bundle (`.skill`, `.zip`) is regenerated by the maintainer's
  own process; if Step 2's wording conflicts with SKILL.md, flag it in
  review rather than editing SKILL.md here.
