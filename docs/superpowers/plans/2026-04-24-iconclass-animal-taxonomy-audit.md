# Iconclass Animal Taxonomy Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Python script that audits whether taxonomic errors (wombat-as-rodent, salamander-only-fabulous, rabbits-as-rodents, etc.) are systemic across the Iconclass mammal tree — by clustering every notation that mentions each mammal concept and having Claude Haiku adjudicate three error classes (E1 misplacement, E2 fabulous-only, E3 polysemy) per concept.

**Architecture:** Three-stage pipeline (pure-SQL cluster build → Haiku judgement → deterministic report assembly). Single CLI entry point, concept-centric unit of analysis. See the design spec at `docs/superpowers/specs/2026-04-24-iconclass-animal-taxonomy-audit-design.md` for full rationale.

**Tech Stack:** Python 3.11 (via `~/miniconda3/envs/embeddings/bin/python`), stdlib `sqlite3`, `anthropic` SDK 0.84+, `pytest` for tests. No new server-side dependencies; no changes to `src/` or `dist/`.

---

## Conventions and prerequisites

**Python path for every command.** The project's Python scripts run in the `embeddings` conda env. Prefix every `python` and `pytest` invocation with `~/miniconda3/envs/embeddings/bin/`. Example: `~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py -v`.

**Gitignore convention.** `offline/` is gitignored project-wide (`.gitignore:13`). All script and audit-output files created by this plan are **local-only by design** — no `git add`, no commits of those files. The only artifacts that get committed are:
- This plan file itself (already committed before task execution begins).
- Any updates to CLAUDE.md or design docs (unlikely; flagged explicitly below if needed).

Skip any mental "commit" step for in-progress script work. At the end, if the user chooses to preserve the audit output under version control, they can `git add -f` selectively.

**TDD cadence.** Every task that produces code follows: write failing test → run test, confirm failure message → write minimal implementation → run test, confirm it passes. Unit tests live next to the script file in `offline/scripts/test_audit_animal_taxonomy.py`. Use the real `data/iconclass.db` for integration-style tests where that's simpler than a fixture — the DB is a stable artifact (schema_version 3, 1.34M notations).

**Naming.** Script file uses underscores (`audit_animal_taxonomy.py`) not dashes — dashes break Python module imports, and tests need to import the script.

---

## File structure

```
offline/scripts/
├── audit_animal_taxonomy.py            ← main script (single file, modularly grouped)
└── test_audit_animal_taxonomy.py       ← pytest tests, unit + integration

offline/audits/animal-taxonomy/         ← created at runtime by the script
├── README.md                           ← index across branches
└── 25F2-mammals/
    ├── report.md
    ├── findings.csv
    ├── concepts.jsonl                  ← Stage 1 build artifact
    ├── audit.jsonl                     ← Stage 2 response cache
    └── prompts/batch-NNN.txt           ← exact prompts, for audit trail
```

Single-file script groups code into labelled sections (`# --- FTS5 ---`, `# --- branches ---`, `# --- stage 1 ---`, etc.). Each section is small enough to hold in context.

---

## Task 1: Scaffolding and prerequisites

**Files:**
- Create: `offline/scripts/audit_animal_taxonomy.py`
- Create: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Install pytest into the embeddings env**

```bash
uv pip install --python ~/miniconda3/envs/embeddings/bin/python pytest
```

Expected: `Installed 2 packages in XXms` (pytest + pluggy/iniconfig). Verify:
```bash
~/miniconda3/envs/embeddings/bin/pytest --version
```
Expected: `pytest 8.x.x`.

- [ ] **Step 2: Write `audit_animal_taxonomy.py` skeleton**

```python
#!/usr/bin/env python3
"""
Iconclass animal taxonomy audit — concept-centric LLM-adjudicated sweep.

Usage:
    python audit_animal_taxonomy.py --branch 25F2
    python audit_animal_taxonomy.py --branch 25F4,25F5 --model claude-haiku-4-5-20251001

See docs/superpowers/specs/2026-04-24-iconclass-animal-taxonomy-audit-design.md
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = PROJECT_ROOT / "data" / "iconclass.db"
AUDIT_ROOT = PROJECT_ROOT / "offline" / "audits" / "animal-taxonomy"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", required=True,
                        help="Iconclass branch prefix, e.g. 25F2. Comma-separate for joint runs (25F4,25F5).")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--force", action="store_true", help="Bust the response cache.")
    parser.add_argument("--dry-run", action="store_true", help="Skip API calls, echo prompts to stdout.")
    args = parser.parse_args(argv)

    print(f"TODO: branch={args.branch} model={args.model} force={args.force} dry_run={args.dry_run}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Write test file skeleton**

```python
"""Unit + integration tests for audit_animal_taxonomy."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import audit_animal_taxonomy as aat  # noqa: E402


def test_db_exists() -> None:
    assert aat.DB_PATH.exists(), f"iconclass.db missing at {aat.DB_PATH}"


def test_db_has_expected_schema() -> None:
    con = sqlite3.connect(aat.DB_PATH)
    try:
        cols = {row[1] for row in con.execute("PRAGMA table_info(notations)")}
    finally:
        con.close()
    assert {"notation", "path", "is_key_expanded"}.issubset(cols)
```

- [ ] **Step 4: Run tests — expect pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py -v
```
Expected: `2 passed`.

- [ ] **Step 5: Sanity-run the CLI stub**

```bash
~/miniconda3/envs/embeddings/bin/python offline/scripts/audit_animal_taxonomy.py --branch 25F2
```
Expected: `TODO: branch=25F2 model=claude-haiku-4-5-20251001 force=False dry_run=False`.

---

## Task 2: FTS5 escape utility (port from `src/utils/db.ts:11`)

FTS5's MATCH syntax treats several characters as operators; passing an animal name like `"polar bear"` or `lion's` unescaped will either error or match wrongly. The TypeScript side already solves this; port the same logic.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py` (add `escape_fts5` function)
- Modify: `offline/scripts/test_audit_animal_taxonomy.py` (add tests)

- [ ] **Step 1: Write failing tests**

Append to `test_audit_animal_taxonomy.py`:

```python
# --- FTS5 escape ---

class TestEscapeFts5:
    def test_plain_word_is_quoted(self) -> None:
        assert aat.escape_fts5("lion") == '"lion"'

    def test_multiword_kept_as_phrase(self) -> None:
        assert aat.escape_fts5("polar bear") == '"polar bear"'

    def test_fts5_metachars_stripped(self) -> None:
        # Parens, brackets, dots, asterisks, colons — all FTS5 operators — are removed.
        assert aat.escape_fts5("lion(king)") == '"lionking"'
        assert aat.escape_fts5("ram*") == '"ram"'

    def test_internal_doublequote_doubled(self) -> None:
        assert aat.escape_fts5('she said "cat"') == '"she said ""cat"""'

    def test_empty_and_whitespace_return_none(self) -> None:
        assert aat.escape_fts5("") is None
        assert aat.escape_fts5("   ") is None
        assert aat.escape_fts5("()") is None  # all stripped → empty
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestEscapeFts5 -v
```
Expected: all 5 fail with `AttributeError: module 'audit_animal_taxonomy' has no attribute 'escape_fts5'`.

- [ ] **Step 3: Implement `escape_fts5`**

Append to `audit_animal_taxonomy.py` (before `main`):

```python
import re

# --- FTS5 escape ---------------------------------------------------------

_FTS5_META_RE = re.compile(r"[.\*\^():{}\[\]\\]")

def escape_fts5(value: str) -> str | None:
    """Port of src/utils/db.ts:escapeFts5. Strips FTS5 metachars, doubles internal
    quotes, returns quote-wrapped term. Returns None if nothing meaningful remains.
    """
    cleaned = _FTS5_META_RE.sub("", value).replace('"', '""').strip()
    if not cleaned:
        return None
    return f'"{cleaned}"'
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestEscapeFts5 -v
```
Expected: `5 passed`.

---

## Task 3: Branch-category classifier

Each cluster member is tagged with a branch category (e.g. `25F real animal tree`, `11H saint attributes`, `94/95 classical mythology`) so Haiku's prompt can display *where* each notation lives.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py` (add `branch_category`)
- Modify: `offline/scripts/test_audit_animal_taxonomy.py` (add tests)

- [ ] **Step 1: Write failing tests**

```python
# --- branch categorisation ---

class TestBranchCategory:
    def test_real_animal_tree(self) -> None:
        assert aat.branch_category("25F26(WOMBAT)") == "25F real animal tree"
        assert aat.branch_category("25F2") == "25F real animal tree"

    def test_fabulous_tree(self) -> None:
        assert aat.branch_category("25FF412") == "25FF fabulous"
        assert aat.branch_category("25FF2") == "25FF fabulous"

    def test_symbolic_animals(self) -> None:
        assert aat.branch_category("34B121") == "34B symbolic animals"

    def test_religious_symbolism(self) -> None:
        assert aat.branch_category("11D1311") == "11D/H/I religious symbolism"
        assert aat.branch_category("11H(JEROME)") == "11D/H/I religious symbolism"
        assert aat.branch_category("11I423") == "11D/H/I religious symbolism"

    def test_bible(self) -> None:
        assert aat.branch_category("71D2") == "71/73 Bible"
        assert aat.branch_category("73C113") == "71/73 Bible"

    def test_literature(self) -> None:
        assert aat.branch_category("82A(DON QUIXOTE)") == "82 literary characters"

    def test_classical_mythology(self) -> None:
        assert aat.branch_category("94L32") == "94/95 classical mythology"
        assert aat.branch_category("95A(JASON)") == "94/95 classical mythology"

    def test_heraldry_and_transport(self) -> None:
        assert aat.branch_category("46A122") == "46A heraldry"
        assert aat.branch_category("46C141") == "46C transport/traction"

    def test_unknown_prefix_falls_through(self) -> None:
        assert aat.branch_category("99Z") == "other"
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestBranchCategory -v
```
Expected: all fail with `AttributeError`.

- [ ] **Step 3: Implement `branch_category`**

Append to `audit_animal_taxonomy.py`:

```python
# --- branch categorisation ----------------------------------------------

# Order matters: more specific prefixes (25FF) must be checked before less specific ones (25F).
_BRANCH_RULES: list[tuple[str, str]] = [
    ("25FF", "25FF fabulous"),
    ("25F",  "25F real animal tree"),
    ("34B",  "34B symbolic animals"),
    ("11D",  "11D/H/I religious symbolism"),
    ("11H",  "11D/H/I religious symbolism"),
    ("11I",  "11D/H/I religious symbolism"),
    ("71",   "71/73 Bible"),
    ("73",   "71/73 Bible"),
    ("82",   "82 literary characters"),
    ("94",   "94/95 classical mythology"),
    ("95",   "94/95 classical mythology"),
    ("46A",  "46A heraldry"),
    ("46C",  "46C transport/traction"),
]

def branch_category(notation: str) -> str:
    for prefix, label in _BRANCH_RULES:
        if notation.startswith(prefix):
            return label
    return "other"
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestBranchCategory -v
```
Expected: `9 passed`.

---

## Task 4: Seed-name extraction (Stage 1a)

Extract the candidate mammal-concept names from the 25F2 and 25FF2 base notations. Two cases: NAME-in-parens variants (`25F26(WOMBAT)` → `wombat`), and bucket-level notations (`25F26` → use the English keyword `rodent`).

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- seed name extraction ---

class TestExtractName:
    def test_name_in_parens(self) -> None:
        assert aat.extract_name_from_notation("25F26(WOMBAT)") == "wombat"
        assert aat.extract_name_from_notation("25F23(POLAR BEAR)") == "polar bear"

    def test_bucket_notation_returns_none(self) -> None:
        # Bucket-level notations have no embedded name — caller must use keyword fallback.
        assert aat.extract_name_from_notation("25F26") is None
        assert aat.extract_name_from_notation("25F2") is None

    def test_ellipsis_variant_ignored(self) -> None:
        # "25F26(...)" is a parent-of-NAMEd-variants placeholder, not a name.
        assert aat.extract_name_from_notation("25F26(...)") is None


class TestBuildSeedNames:
    def test_returns_known_mammals(self) -> None:
        names = aat.build_seed_names("25F2")
        assert "wombat" in names
        assert "lion" in names
        assert "polar bear" in names
        # rodents bucket falls back to the keyword:
        assert "rodent" in names or "rodents" in names

    def test_fabulous_branch_included(self) -> None:
        names = aat.build_seed_names("25F2")
        # 25FF2x entries contribute too. e.g. unicorn, centaur are base fabulous mammals.
        assert "unicorn" in names

    def test_deduplicates(self) -> None:
        names = aat.build_seed_names("25F2")
        assert len(names) == len(set(names)), "seed list contains duplicates"

    def test_plausible_size(self) -> None:
        names = aat.build_seed_names("25F2")
        assert 80 <= len(names) <= 250, f"expected 80-250 mammal concepts, got {len(names)}"
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestExtractName offline/scripts/test_audit_animal_taxonomy.py::TestBuildSeedNames -v
```
Expected: fail with `AttributeError: module has no attribute 'extract_name_from_notation'`.

- [ ] **Step 3: Implement extraction and seed-building**

Append to `audit_animal_taxonomy.py`:

```python
import sqlite3

# --- seed name extraction -----------------------------------------------

_NAME_IN_PARENS_RE = re.compile(r"\(([^)]+)\)$")

def extract_name_from_notation(notation: str) -> str | None:
    """Return lowercase name from a NAME-in-parens variant, or None for bucket
    notations and ellipsis placeholders."""
    m = _NAME_IN_PARENS_RE.search(notation)
    if not m:
        return None
    name = m.group(1).strip()
    if not name or name == "...":
        return None
    return name.lower()


def _paired_branches(branch: str) -> tuple[str, str]:
    """Given a real-tree branch prefix like '25F2', derive its fabulous counterpart '25FF2'."""
    if branch.startswith("25FF"):
        return branch.replace("25FF", "25F", 1), branch
    if branch.startswith("25F"):
        real = branch
        fab = "25FF" + branch[len("25F"):]
        return real, fab
    raise ValueError(f"Expected branch under 25F* or 25FF*, got: {branch}")


def build_seed_names(branch: str, db_path: Path = DB_PATH) -> list[str]:
    """Build deduplicated, canonicalised seed-name list from real+fabulous base notations
    under the given branch (e.g. '25F2' sweeps both 25F2* and 25FF2*)."""
    real_prefix, fab_prefix = _paired_branches(branch)
    names: set[str] = set()

    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            """
            SELECT notation FROM notations
            WHERE is_key_expanded = 0
              AND (notation LIKE ? OR notation LIKE ?)
            """,
            (f"{real_prefix}%", f"{fab_prefix}%"),
        ).fetchall()

        for (notation,) in rows:
            name = extract_name_from_notation(notation)
            if name is not None:
                names.add(name)
                continue
            # Bucket notation — use English keyword(s) as fallback.
            kw_rows = con.execute(
                "SELECT keyword FROM keywords WHERE notation = ? AND lang = 'en'",
                (notation,),
            ).fetchall()
            for (kw,) in kw_rows:
                cleaned = kw.strip().lower()
                if cleaned:
                    names.add(cleaned)
    finally:
        con.close()

    return sorted(names)
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestExtractName offline/scripts/test_audit_animal_taxonomy.py::TestBuildSeedNames -v
```
Expected: `7 passed`. If size assertion fails because actual count falls outside 80–250, inspect with:
```bash
~/miniconda3/envs/embeddings/bin/python -c "import sys; sys.path.insert(0,'offline/scripts'); import audit_animal_taxonomy as a; ns=a.build_seed_names('25F2'); print(len(ns)); print(ns[:40])"
```
Adjust the 80–250 bound in the test to match observed reality (one-line edit) — the goal is a sanity check, not a specific count.

---

## Task 5: Path-parsing helpers

Each notation's `path` column holds a JSON array of ancestor notation strings, e.g. `["2","25","25F","25F2","25F26","25F26(...)"]`. For audit purposes we want the "bucket-level" ancestor — the last element that is NOT a NAME-in-parens wildcard (i.e. the last bare bucket like `25F26`).

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- path parsing ---

class TestBucketAncestor:
    def test_wombat_bucket_is_rodents(self) -> None:
        path = ["2","25","25F","25F2","25F26","25F26(...)"]
        assert aat.bucket_ancestor(path) == "25F26"

    def test_bucket_itself_is_its_own_ancestor_minus_one(self) -> None:
        # For 25F26 itself, the path is ["2","25","25F","25F2"]; last bucket = 25F2.
        assert aat.bucket_ancestor(["2","25","25F","25F2"]) == "25F2"

    def test_salamander_fabulous_path(self) -> None:
        # 25FF412 path; last bucket before it is 25FF41.
        assert aat.bucket_ancestor(["2","25","25FF","25FF4","25FF41"]) == "25FF41"

    def test_top_level_returns_none(self) -> None:
        assert aat.bucket_ancestor([]) is None
        assert aat.bucket_ancestor(["2"]) == "2"


class TestParsePath:
    def test_parses_json_array(self) -> None:
        assert aat.parse_path('["2","25","25F"]') == ["2","25","25F"]

    def test_empty_array(self) -> None:
        assert aat.parse_path("[]") == []
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestBucketAncestor offline/scripts/test_audit_animal_taxonomy.py::TestParsePath -v
```
Expected: all fail with `AttributeError`.

- [ ] **Step 3: Implement path helpers**

Append to `audit_animal_taxonomy.py`:

```python
import json

# --- path parsing -------------------------------------------------------

def parse_path(path_json: str) -> list[str]:
    """Parse the JSON array stored in notations.path."""
    if not path_json:
        return []
    return list(json.loads(path_json))


def bucket_ancestor(path: list[str]) -> str | None:
    """Return the last ancestor notation that is NOT a '(...)' wildcard placeholder.
    For '25F26(WOMBAT)' whose path is [..., '25F26', '25F26(...)'], returns '25F26'."""
    for notation in reversed(path):
        if "(...)" not in notation:
            return notation
    return None
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestBucketAncestor offline/scripts/test_audit_animal_taxonomy.py::TestParsePath -v
```
Expected: `6 passed`.

---

## Task 6: FTS cluster expansion (Stage 1b)

For each seed name, query `texts_fts` and `keywords_fts` to find every base notation whose English text or keyword matches. Return rich records including English+Dutch labels, parent bucket, parent label, and branch category.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- FTS expansion ---

class TestFtsExpand:
    def test_wombat_finds_base_notation(self) -> None:
        matches = aat.fts_expand("wombat")
        notations = {m["notation"] for m in matches}
        assert "25F26(WOMBAT)" in notations
        # key-expanded variants like 25F26(WOMBAT)(+46) must NOT appear
        assert not any("(+4" in n for n in notations)

    def test_salamander_hits_fabulous_only(self) -> None:
        matches = aat.fts_expand("salamander")
        notations = {m["notation"] for m in matches}
        assert "25FF412" in notations
        # Verify there's no entry in the real amphibian tree (25F5*).
        assert not any(n.startswith("25F5") for n in notations), \
            "if a real salamander entry exists, E2 hypothesis is wrong"

    def test_lion_has_rich_cluster(self) -> None:
        matches = aat.fts_expand("lion")
        branches = {m["branch"] for m in matches}
        # lion appears across multiple top-level branches per the subagent survey
        assert len(branches) >= 3, f"expected lion across 3+ branches, got {branches}"
        notations = {m["notation"] for m in matches}
        assert "25F23(LION)" in notations

    def test_record_shape(self) -> None:
        matches = aat.fts_expand("wombat")
        assert matches, "wombat must match at least one notation"
        m = matches[0]
        assert set(m.keys()) >= {"notation", "label_en", "label_nl",
                                 "parent_bucket", "parent_label_en", "branch"}
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestFtsExpand -v
```
Expected: all fail with `AttributeError`.

- [ ] **Step 3: Implement `fts_expand`**

Append to `audit_animal_taxonomy.py`:

```python
from typing import TypedDict

# --- FTS expansion ------------------------------------------------------

class ClusterMember(TypedDict):
    notation: str
    label_en: str | None
    label_nl: str | None
    parent_bucket: str | None
    parent_label_en: str | None
    branch: str


def fts_expand(name: str, db_path: Path = DB_PATH) -> list[ClusterMember]:
    """Return all base notations whose English text or English keyword matches `name`."""
    fts_term = escape_fts5(name)
    if fts_term is None:
        return []

    con = sqlite3.connect(db_path)
    try:
        # texts_fts is FTS5 over texts.text. Filter to English after the join.
        # keywords_fts is FTS5 over keywords.keyword.
        rows = con.execute(
            """
            SELECT DISTINCT n.notation, n.path
            FROM notations n
            WHERE n.is_key_expanded = 0
              AND (
                n.rowid IN (
                    SELECT t.rowid FROM texts t
                    JOIN texts_fts f ON f.rowid = t.rowid
                    WHERE texts_fts MATCH :q AND t.lang = 'en'
                )
                OR n.notation IN (
                    SELECT k.notation FROM keywords k
                    JOIN keywords_fts g ON g.rowid = k.rowid
                    WHERE keywords_fts MATCH :q AND k.lang = 'en'
                )
              )
            """,
            {"q": fts_term},
        ).fetchall()

        results: list[ClusterMember] = []
        for notation, path_json in rows:
            path = parse_path(path_json)
            parent = bucket_ancestor(path)
            label_en = _first_text(con, notation, "en")
            label_nl = _first_text(con, notation, "nl")
            parent_label_en = _first_text(con, parent, "en") if parent else None
            results.append(ClusterMember(
                notation=notation,
                label_en=label_en,
                label_nl=label_nl,
                parent_bucket=parent,
                parent_label_en=parent_label_en,
                branch=branch_category(notation),
            ))
        return results
    finally:
        con.close()


def _first_text(con: sqlite3.Connection, notation: str | None, lang: str) -> str | None:
    if notation is None:
        return None
    row = con.execute(
        "SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1",
        (notation, lang),
    ).fetchone()
    return row[0] if row else None
```

Note: the `texts_fts` table was created with `content=texts`, so its `rowid` aligns with `texts.rowid`. We use that to filter to English after the FTS match.

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestFtsExpand -v
```
Expected: `4 passed`. If `test_salamander_hits_fabulous_only` fails by finding a real salamander entry, the E2 hypothesis is already falsified — record it and continue (the audit will flag the opposite condition).

---

## Task 7: Stage 1 integration — build `concepts.jsonl`

Combine seeds + FTS expansion into a JSONL artifact, one concept per line.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- Stage 1 integration ---

class TestBuildConcepts:
    def test_writes_jsonl_with_expected_shape(self, tmp_path) -> None:
        out = tmp_path / "concepts.jsonl"
        concepts = aat.build_concepts("25F2", out)
        assert out.exists()
        lines = out.read_text().splitlines()
        assert len(lines) == len(concepts)

        import json as _j
        first = _j.loads(lines[0])
        assert set(first.keys()) == {"concept", "seed_notations", "cluster", "cluster_size"}

    def test_wombat_cluster_is_present(self, tmp_path) -> None:
        out = tmp_path / "concepts.jsonl"
        concepts = aat.build_concepts("25F2", out)
        by_name = {c["concept"]: c for c in concepts}
        assert "wombat" in by_name
        wombat = by_name["wombat"]
        assert wombat["cluster_size"] >= 1
        assert any(m["notation"] == "25F26(WOMBAT)" for m in wombat["cluster"])

    def test_salamander_present_only_fabulous(self, tmp_path) -> None:
        out = tmp_path / "concepts.jsonl"
        concepts = aat.build_concepts("25F2", out)
        by_name = {c["concept"]: c for c in concepts}
        # salamander may or may not have been a seed (it's only in 25FF4, not 25F2/25FF2),
        # but if fts_expand was driven by seeds, salamander may not appear here.
        # The assertion is weaker: the mammal run doesn't *require* salamander.
        # Salamander will surface only when --branch 25F4,25F5 runs.
        if "salamander" in by_name:
            notations = {m["notation"] for m in by_name["salamander"]["cluster"]}
            assert not any(n.startswith("25F5") for n in notations)

    def test_dedup_identical_names(self, tmp_path) -> None:
        out = tmp_path / "concepts.jsonl"
        concepts = aat.build_concepts("25F2", out)
        names = [c["concept"] for c in concepts]
        assert len(names) == len(set(names))
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestBuildConcepts -v
```
Expected: fail with `AttributeError: module has no attribute 'build_concepts'`.

- [ ] **Step 3: Implement `build_concepts`**

Append to `audit_animal_taxonomy.py`:

```python
# --- Stage 1 integration ------------------------------------------------

def build_concepts(branch: str, out_path: Path, db_path: Path = DB_PATH) -> list[dict]:
    """Run Stage 1: seed names, expand each via FTS, serialise to JSONL."""
    names = build_seed_names(branch, db_path)

    # Track which seed notation(s) contributed each name so downstream reports
    # can show 'which notation prompted us to look at this concept'.
    seeds_by_name = _seed_notations_by_name(branch, names, db_path)

    concepts: list[dict] = []
    for name in names:
        cluster = fts_expand(name, db_path)
        seed_notations = sorted(seeds_by_name.get(name, []))
        concepts.append({
            "concept": name,
            "seed_notations": seed_notations,
            "cluster": cluster,
            "cluster_size": len(cluster),
        })

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for c in concepts:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    return concepts


def _seed_notations_by_name(branch: str, names: list[str], db_path: Path) -> dict[str, list[str]]:
    """Re-derive which 25F2/25FF2 base notations correspond to each seed name."""
    real_prefix, fab_prefix = _paired_branches(branch)
    mapping: dict[str, set[str]] = {n: set() for n in names}
    name_set = set(names)

    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            """
            SELECT notation FROM notations
            WHERE is_key_expanded = 0
              AND (notation LIKE ? OR notation LIKE ?)
            """,
            (f"{real_prefix}%", f"{fab_prefix}%"),
        ).fetchall()

        for (notation,) in rows:
            embedded = extract_name_from_notation(notation)
            if embedded and embedded in name_set:
                mapping[embedded].add(notation)
                continue
            # bucket-level: keywords
            kw_rows = con.execute(
                "SELECT keyword FROM keywords WHERE notation = ? AND lang = 'en'",
                (notation,),
            ).fetchall()
            for (kw,) in kw_rows:
                cleaned = kw.strip().lower()
                if cleaned in name_set:
                    mapping[cleaned].add(notation)
    finally:
        con.close()

    return {k: sorted(v) for k, v in mapping.items()}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestBuildConcepts -v
```
Expected: `4 passed`.

---

## Task 8: Haiku prompt construction

Build the system prompt (branch-parameterised guardrails + JSON schema definition) and a per-batch user prompt containing concept clusters as JSON plus few-shot examples (wombat → E1, salamander → E2, panther → E3).

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- prompt construction ---

class TestPrompts:
    def test_system_prompt_has_guardrails(self) -> None:
        sp = aat.system_prompt_for_branch("25F2")
        # Key guardrails from design spec §5 Stage 2
        assert "morphological" in sp.lower()
        assert "1970s" in sp
        assert "JSON" in sp
        assert "uncertain" in sp.lower()
        # Branch-specific bucket hint
        assert "rodents" in sp.lower()

    def test_system_prompt_lower_animals_branch(self) -> None:
        sp = aat.system_prompt_for_branch("25F7")
        assert "rodents" not in sp.lower(), "25F7 prompt should not mention mammal buckets"
        assert "pre-darwinian" in sp.lower() or "non-vertebrate" in sp.lower()

    def test_user_prompt_contains_cluster_json(self) -> None:
        concepts = [{"concept": "wombat", "seed_notations": ["25F26(WOMBAT)"],
                     "cluster": [{"notation": "25F26(WOMBAT)",
                                  "parent_bucket": "25F26",
                                  "parent_label_en": "rodents",
                                  "branch": "25F real animal tree"}],
                     "cluster_size": 1}]
        up = aat.user_prompt_for_batch(concepts)
        assert "wombat" in up
        assert "25F26(WOMBAT)" in up
        # Must include few-shot anchors so Haiku knows the expected judgement style
        assert "salamander" in up.lower()
        assert "panther" in up.lower()

    def test_user_prompt_requests_json_array(self) -> None:
        up = aat.user_prompt_for_batch([{"concept": "x", "seed_notations": [],
                                          "cluster": [], "cluster_size": 0}])
        assert "JSON array" in up or "json array" in up
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestPrompts -v
```
Expected: fail with `AttributeError`.

- [ ] **Step 3: Implement prompts**

Append to `audit_animal_taxonomy.py`:

```python
# --- prompt construction ------------------------------------------------

_BRANCH_BUCKET_HINTS: dict[str, str] = {
    "25F2": (
        "Iconclass mammal buckets like 'rodents', 'beasts of prey', 'hoofed animals', "
        "'trunked animals', 'swimming mammals', 'flying mammals' are morphological / "
        "behavioural categories from 1970s art-historical usage — not Linnaean clades."
    ),
    "25F3": "Iconclass bird buckets group by habit (birds of prey, waterbirds, songbirds, etc.).",
    "25F4": "Iconclass reptile buckets group by visible form (lizards, snakes, chelonians).",
    "25F5": "Iconclass amphibian buckets are coarse (frogs/toads vs. salamanders/newts).",
    "25F6": "Iconclass fish buckets group by habitat / shape, pre-dating modern ichthyology.",
    "25F7": (
        "Iconclass 'lower animals' buckets group pre-Darwinian non-vertebrate types "
        "(insects, arachnids, molluscs, echinoderms, worms) by habit and appearance."
    ),
}


def system_prompt_for_branch(branch: str) -> str:
    bucket_hint = _BRANCH_BUCKET_HINTS.get(branch,
                                            "Iconclass animal buckets are pre-Linnaean groupings.")
    return f"""You are auditing the Iconclass art-subject taxonomy for taxonomic errors in its animal tree. Your task is to judge, per mammal concept, whether its placement and presence in the catalogue is correct.

{bucket_hint}

Flag a placement as E1 only when it is wrong EVEN UNDER A GENEROUS 1970s READING — i.e. a competent 1970s art historian with access to a zoological dictionary would have placed it elsewhere. Example: wombat under 'rodents' is E1 because wombats are obviously marsupials, not rodents, and this was as clear in 1970 as it is now.

Flag E2 when a real biological animal appears in the Iconclass catalogue only under the fabulous tree (25FF*) and has NO corresponding entry under the real-animal tree (25F*). Example: salamander appears only as 25FF412 (fabulous fire-spirit); real salamanders are amphibians but no 25F5* entry exists — E2.

Flag E3 when one Iconclass notation's NAME variant covers two or more biologically distinct species under a single historical term. Example: 'panther' historically refers to leopard, jaguar, and a mythical panther indiscriminately — E3.

If a name is archaic and you cannot confidently identify the animal, return `uncertain` with a brief reason. Do not fabricate taxonomic detail.

Emit a JSON array, one object per concept, with this exact schema per object:
{{
  "concept": "<name>",
  "cluster": ["<notation>", ...],
  "real_animal": true | false,
  "real_tree_presence": {{"has_entry": true|false, "flag": "E2"|"ok"|"na"|"uncertain", "finding": "<1-2 sentences>"}},
  "real_tree_taxonomy":  {{"placement_ok": true|false|null, "flag": "E1"|"ok"|"na"|"uncertain", "finding": "<1-2 sentences>"}},
  "polysemy":            {{"flag": "E3"|"ok"|"uncertain", "finding": "<1-2 sentences>"}},
  "confidence": "high" | "medium" | "low"
}}

Use "na" when a sub-question doesn't apply (e.g. real_tree_taxonomy when real_tree_presence.has_entry is false).

Output ONLY the JSON array, no prose."""


_FEW_SHOT = """Few-shot reference examples — use their style when emitting judgements:

Example 1 (E1):
Concept: wombat. Cluster: [{"notation":"25F26(WOMBAT)","parent_bucket":"25F26","parent_label_en":"rodents","branch":"25F real animal tree"}]
Expected output:
{"concept":"wombat","cluster":["25F26(WOMBAT)"],"real_animal":true,"real_tree_presence":{"has_entry":true,"flag":"ok","finding":"Present as 25F26(WOMBAT)."},"real_tree_taxonomy":{"placement_ok":false,"flag":"E1","finding":"Wombats are marsupials (order Diprotodontia), not rodents. The 25F26 bucket is morphological but marsupial placement was clear in 1970s usage."},"polysemy":{"flag":"ok","finding":"Name unambiguous for Vombatidae."},"confidence":"high"}

Example 2 (E2):
Concept: salamander. Cluster: [{"notation":"25FF412","parent_bucket":"25FF41","parent_label_en":"fabulous animals ~ lizards","branch":"25FF fabulous"}]
Expected output:
{"concept":"salamander","cluster":["25FF412"],"real_animal":true,"real_tree_presence":{"has_entry":false,"flag":"E2","finding":"Real salamanders are amphibians but no 25F5* entry exists. Only notation is 25FF412 (fabulous fire-spirit)."},"real_tree_taxonomy":{"placement_ok":null,"flag":"na","finding":"N/A — no real-tree entry."},"polysemy":{"flag":"ok","finding":"Name refers to order Urodela."},"confidence":"high"}

Example 3 (E3):
Concept: panther. Cluster: [{"notation":"25F23(PANTHER)","parent_bucket":"25F23","parent_label_en":"beasts of prey","branch":"25F real animal tree"}]
Expected output:
{"concept":"panther","cluster":["25F23(PANTHER)"],"real_animal":true,"real_tree_presence":{"has_entry":true,"flag":"ok","finding":"Present as 25F23(PANTHER)."},"real_tree_taxonomy":{"placement_ok":true,"flag":"ok","finding":"Correctly placed as beast of prey."},"polysemy":{"flag":"E3","finding":"'Panther' historically covers leopard, jaguar, and a mythical panther in medieval bestiaries — not biologically unambiguous."},"confidence":"high"}
"""


def user_prompt_for_batch(concepts_batch: list[dict]) -> str:
    payload = json.dumps(concepts_batch, ensure_ascii=False, indent=2)
    return f"""{_FEW_SHOT}

Now audit the following {len(concepts_batch)} concept(s). Emit a JSON array with one judgement object per input concept, in the same order.

Concepts to audit:
{payload}

Respond with ONLY the JSON array."""
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestPrompts -v
```
Expected: `4 passed`.

---

## Task 9: Response caching layer

Cache every Haiku call keyed on `sha256(model + system + user)`. Responses stored as JSONL, one `{hash, model, response}` record per line. Fast startup load; append on write.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- response cache ---

class TestCache:
    def test_round_trip(self, tmp_path) -> None:
        cache_path = tmp_path / "audit.jsonl"
        cache = aat.ResponseCache(cache_path)
        h = cache.key("model-x", "sys", "usr")
        assert cache.get(h) is None
        cache.put(h, "model-x", '[{"concept":"x"}]')
        assert cache.get(h) == '[{"concept":"x"}]'

    def test_persistence_across_instances(self, tmp_path) -> None:
        cache_path = tmp_path / "audit.jsonl"
        c1 = aat.ResponseCache(cache_path)
        h = c1.key("m", "s", "u")
        c1.put(h, "m", "response-text")

        c2 = aat.ResponseCache(cache_path)
        assert c2.get(h) == "response-text"

    def test_different_prompts_produce_different_keys(self) -> None:
        c = aat.ResponseCache(Path("/tmp/unused"))
        assert c.key("m", "s", "a") != c.key("m", "s", "b")
        assert c.key("m", "s", "a") != c.key("m2", "s", "a")
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestCache -v
```
Expected: fail with `AttributeError: module has no attribute 'ResponseCache'`.

- [ ] **Step 3: Implement `ResponseCache`**

Append to `audit_animal_taxonomy.py`:

```python
import hashlib

# --- response cache -----------------------------------------------------

class ResponseCache:
    """Append-only JSONL cache of Haiku responses keyed by prompt hash."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._memo: dict[str, str] = {}
        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    rec = json.loads(line)
                    self._memo[rec["hash"]] = rec["response"]

    @staticmethod
    def key(model: str, system_prompt: str, user_prompt: str) -> str:
        h = hashlib.sha256()
        h.update(model.encode("utf-8"))
        h.update(b"\0")
        h.update(system_prompt.encode("utf-8"))
        h.update(b"\0")
        h.update(user_prompt.encode("utf-8"))
        return h.hexdigest()

    def get(self, hash_key: str) -> str | None:
        return self._memo.get(hash_key)

    def put(self, hash_key: str, model: str, response: str) -> None:
        self._memo[hash_key] = response
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"hash": hash_key, "model": model,
                                "response": response}, ensure_ascii=False) + "\n")
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestCache -v
```
Expected: `3 passed`.

---

## Task 10: Stage 2 batch driver

Iterate concepts in batches of 25, check cache, call Haiku on miss, parse JSON response, yield per-concept audit records.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

Use a mock API client to avoid real network calls in tests.

```python
# --- Stage 2 batch driver ---

class FakeAnthropic:
    """Minimal stand-in for anthropic.Anthropic() matching the shape used by the script."""
    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []
        self.messages = self  # expose .messages.create()

    def create(self, **kwargs):
        self.calls.append(kwargs)
        text = self._responses.pop(0)
        # mimic anthropic response.content = [TextBlock(type='text', text=...)]
        return type("Resp", (), {
            "content": [type("Blk", (), {"type": "text", "text": text})()]
        })()


class TestRunAudit:
    def test_batched_and_cached(self, tmp_path) -> None:
        concepts = [{"concept": f"c{i}", "seed_notations": [], "cluster": [],
                     "cluster_size": 0} for i in range(3)]
        fake_response = json.dumps([
            {"concept": "c0", "cluster": [], "real_animal": False,
             "real_tree_presence": {"has_entry": False, "flag": "na", "finding": "not an animal"},
             "real_tree_taxonomy":  {"placement_ok": None, "flag": "na", "finding": "n/a"},
             "polysemy":            {"flag": "ok", "finding": "n/a"},
             "confidence": "high"},
            {"concept": "c1", "cluster": [], "real_animal": False,
             "real_tree_presence": {"has_entry": False, "flag": "na", "finding": "not an animal"},
             "real_tree_taxonomy":  {"placement_ok": None, "flag": "na", "finding": "n/a"},
             "polysemy":            {"flag": "ok", "finding": "n/a"},
             "confidence": "high"},
            {"concept": "c2", "cluster": [], "real_animal": False,
             "real_tree_presence": {"has_entry": False, "flag": "na", "finding": "not an animal"},
             "real_tree_taxonomy":  {"placement_ok": None, "flag": "na", "finding": "n/a"},
             "polysemy":            {"flag": "ok", "finding": "n/a"},
             "confidence": "high"},
        ])
        client = FakeAnthropic(responses=[fake_response])
        cache = aat.ResponseCache(tmp_path / "audit.jsonl")

        results = aat.run_audit(
            concepts=concepts, branch="25F2", model="m",
            client=client, cache=cache, batch_size=5, prompts_dir=tmp_path / "prompts",
        )

        assert len(results) == 3
        assert {r["concept"] for r in results} == {"c0", "c1", "c2"}
        assert len(client.calls) == 1, "one API call for a single batch"

        # Second invocation should hit cache — zero new API calls.
        results2 = aat.run_audit(
            concepts=concepts, branch="25F2", model="m",
            client=client, cache=cache, batch_size=5, prompts_dir=tmp_path / "prompts",
        )
        assert len(client.calls) == 1, "cache hit should not call API"
        assert len(results2) == 3

    def test_prompts_written_to_disk(self, tmp_path) -> None:
        concepts = [{"concept": "x", "seed_notations": [], "cluster": [], "cluster_size": 0}]
        fake_response = json.dumps([
            {"concept": "x", "cluster": [], "real_animal": False,
             "real_tree_presence": {"has_entry": False, "flag": "na", "finding": "nope"},
             "real_tree_taxonomy":  {"placement_ok": None, "flag": "na", "finding": "nope"},
             "polysemy":            {"flag": "ok", "finding": "nope"},
             "confidence": "high"}])
        client = FakeAnthropic(responses=[fake_response])
        prompts_dir = tmp_path / "prompts"
        aat.run_audit(
            concepts=concepts, branch="25F2", model="m",
            client=client, cache=aat.ResponseCache(tmp_path / "audit.jsonl"),
            batch_size=5, prompts_dir=prompts_dir,
        )
        files = sorted(prompts_dir.glob("batch-*.txt"))
        assert len(files) == 1
        body = files[0].read_text()
        assert "SYSTEM:" in body and "USER:" in body
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestRunAudit -v
```
Expected: fail with `AttributeError: module has no attribute 'run_audit'`.

- [ ] **Step 3: Implement `run_audit`**

Append to `audit_animal_taxonomy.py`:

```python
# --- Stage 2 batch driver -----------------------------------------------

def run_audit(
    *,
    concepts: list[dict],
    branch: str,
    model: str,
    client,                        # anthropic.Anthropic or FakeAnthropic
    cache: ResponseCache,
    batch_size: int = 25,
    prompts_dir: Path,
    dry_run: bool = False,
) -> list[dict]:
    """Batch concepts, query Haiku (or cache), return flat list of audit records."""
    system_prompt = system_prompt_for_branch(branch)
    all_results: list[dict] = []
    prompts_dir.mkdir(parents=True, exist_ok=True)

    for i in range(0, len(concepts), batch_size):
        batch = concepts[i : i + batch_size]
        batch_num = i // batch_size + 1
        user_prompt = user_prompt_for_batch(batch)

        (prompts_dir / f"batch-{batch_num:03d}.txt").write_text(
            f"SYSTEM:\n{system_prompt}\n\nUSER:\n{user_prompt}\n", encoding="utf-8")

        if dry_run:
            print(f"[dry-run] batch {batch_num}: {len(batch)} concepts", file=sys.stderr)
            continue

        hash_key = cache.key(model, system_prompt, user_prompt)
        cached = cache.get(hash_key)
        if cached is None:
            resp = client.messages.create(
                model=model,
                max_tokens=8000,
                temperature=0,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
            cache.put(hash_key, model, text)
        else:
            text = cached

        all_results.extend(_parse_batch_response(text, batch))

    return all_results


def _parse_batch_response(text: str, batch: list[dict]) -> list[dict]:
    """Tolerant JSON parse: strip ```json fences if present, then json.loads()."""
    stripped = text.strip()
    if stripped.startswith("```"):
        # strip opening fence line and trailing fence
        lines = stripped.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        while lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        stripped = "\n".join(lines)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Haiku returned invalid JSON for batch of {len(batch)} concepts: {e}\n"
            f"First 200 chars of response: {stripped[:200]!r}"
        ) from e
    if not isinstance(parsed, list):
        raise RuntimeError(f"Expected JSON array, got {type(parsed).__name__}")
    return parsed
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestRunAudit -v
```
Expected: `2 passed`.

---

## Task 11: CSV writer (Stage 3a)

Flatten per-concept audit records + cluster context into one CSV row per concept.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- CSV output ---

class TestWriteFindingsCsv:
    def test_columns_match_spec(self, tmp_path) -> None:
        concepts = [{"concept": "wombat", "seed_notations": ["25F26(WOMBAT)"],
                     "cluster": [{"notation": "25F26(WOMBAT)", "label_en": "rodents: wombat",
                                  "label_nl": "knaagdieren: wombat", "parent_bucket": "25F26",
                                  "parent_label_en": "rodents", "branch": "25F real animal tree"}],
                     "cluster_size": 1}]
        audit = [{"concept": "wombat", "cluster": ["25F26(WOMBAT)"], "real_animal": True,
                  "real_tree_presence": {"has_entry": True, "flag": "ok", "finding": "present"},
                  "real_tree_taxonomy": {"placement_ok": False, "flag": "E1",
                                         "finding": "wombats are marsupials not rodents"},
                  "polysemy": {"flag": "ok", "finding": "unambiguous"},
                  "confidence": "high"}]

        out = tmp_path / "findings.csv"
        aat.write_findings_csv(concepts, audit, out)

        import csv as _c
        with out.open() as f:
            rdr = _c.DictReader(f)
            rows = list(rdr)
        assert len(rows) == 1
        r = rows[0]
        expected = {"concept","seed_notations","cluster_size","cluster_branches",
                    "real_animal","real_tree_flag","real_tree_finding",
                    "taxonomy_flag","taxonomy_finding","polysemy_flag","polysemy_finding",
                    "confidence"}
        assert set(rdr.fieldnames) == expected
        assert r["concept"] == "wombat"
        assert r["seed_notations"] == "25F26(WOMBAT)"
        assert r["taxonomy_flag"] == "E1"
        assert r["real_tree_flag"] == "ok"
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestWriteFindingsCsv -v
```
Expected: fail with `AttributeError: module has no attribute 'write_findings_csv'`.

- [ ] **Step 3: Implement `write_findings_csv`**

Append to `audit_animal_taxonomy.py`:

```python
import csv

# --- Stage 3a: CSV -----------------------------------------------------

_FINDINGS_COLUMNS = [
    "concept", "seed_notations", "cluster_size", "cluster_branches",
    "real_animal",
    "real_tree_flag", "real_tree_finding",
    "taxonomy_flag", "taxonomy_finding",
    "polysemy_flag", "polysemy_finding",
    "confidence",
]


def write_findings_csv(concepts: list[dict], audit: list[dict], out_path: Path) -> None:
    audit_by_concept = {a["concept"]: a for a in audit}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_FINDINGS_COLUMNS)
        writer.writeheader()
        for c in concepts:
            a = audit_by_concept.get(c["concept"], {})
            writer.writerow({
                "concept": c["concept"],
                "seed_notations": ";".join(c.get("seed_notations", [])),
                "cluster_size": c.get("cluster_size", 0),
                "cluster_branches": ";".join(sorted({m.get("branch","") for m in c.get("cluster",[])})),
                "real_animal": a.get("real_animal", ""),
                "real_tree_flag":     a.get("real_tree_presence", {}).get("flag", ""),
                "real_tree_finding":  a.get("real_tree_presence", {}).get("finding", ""),
                "taxonomy_flag":      a.get("real_tree_taxonomy", {}).get("flag", ""),
                "taxonomy_finding":   a.get("real_tree_taxonomy", {}).get("finding", ""),
                "polysemy_flag":      a.get("polysemy", {}).get("flag", ""),
                "polysemy_finding":   a.get("polysemy", {}).get("finding", ""),
                "confidence":         a.get("confidence", ""),
            })
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestWriteFindingsCsv -v
```
Expected: `1 passed`.

---

## Task 12: Markdown report writer (Stage 3b)

Generate `report.md` with verdict, top cases, count tables, and appendices per spec §6.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- Markdown report ---

class TestWriteReport:
    def _sample(self):
        concepts = [
            {"concept": "wombat", "seed_notations": ["25F26(WOMBAT)"],
             "cluster": [{"notation": "25F26(WOMBAT)", "parent_bucket": "25F26",
                          "parent_label_en": "rodents", "branch": "25F real animal tree"}],
             "cluster_size": 1},
            {"concept": "salamander", "seed_notations": ["25FF412"],
             "cluster": [{"notation": "25FF412", "parent_bucket": "25FF41",
                          "parent_label_en": "fabulous animals ~ lizards",
                          "branch": "25FF fabulous"}],
             "cluster_size": 1},
            {"concept": "panther", "seed_notations": ["25F23(PANTHER)"],
             "cluster": [{"notation": "25F23(PANTHER)", "parent_bucket": "25F23",
                          "parent_label_en": "beasts of prey",
                          "branch": "25F real animal tree"}],
             "cluster_size": 1},
        ]
        audit = [
            {"concept": "wombat", "cluster": ["25F26(WOMBAT)"], "real_animal": True,
             "real_tree_presence": {"has_entry": True, "flag": "ok", "finding": "present"},
             "real_tree_taxonomy": {"placement_ok": False, "flag": "E1",
                                    "finding": "marsupial, not rodent"},
             "polysemy": {"flag": "ok", "finding": "ok"}, "confidence": "high"},
            {"concept": "salamander", "cluster": ["25FF412"], "real_animal": True,
             "real_tree_presence": {"has_entry": False, "flag": "E2",
                                    "finding": "no 25F5* entry"},
             "real_tree_taxonomy": {"placement_ok": None, "flag": "na", "finding": "n/a"},
             "polysemy": {"flag": "ok", "finding": "ok"}, "confidence": "high"},
            {"concept": "panther", "cluster": ["25F23(PANTHER)"], "real_animal": True,
             "real_tree_presence": {"has_entry": True, "flag": "ok", "finding": "present"},
             "real_tree_taxonomy": {"placement_ok": True, "flag": "ok", "finding": "ok"},
             "polysemy": {"flag": "E3", "finding": "leopard vs jaguar vs mythical"},
             "confidence": "medium"},
        ]
        return concepts, audit

    def test_report_contains_required_sections(self, tmp_path) -> None:
        concepts, audit = self._sample()
        out = tmp_path / "report.md"
        meta = {"branch": "25F2", "model": "claude-haiku-4-5-20251001",
                "run_date": "2026-04-24", "db_row_counts": {"notations": 1346371},
                "db_schema_version": "3", "concepts_jsonl_sha256": "abcd",
                "total_api_calls": 1}
        aat.write_report_md(concepts, audit, out, meta)

        text = out.read_text()
        for needed in ["# ", "Verdict", "Most compelling", "E1", "E2", "E3",
                       "Appendix", "Methodology",
                       "claude-haiku-4-5-20251001", "25F2", "abcd"]:
            assert needed in text, f"missing section/marker: {needed}"

    def test_verdict_counts_match(self, tmp_path) -> None:
        concepts, audit = self._sample()
        out = tmp_path / "report.md"
        meta = {"branch": "25F2", "model": "m", "run_date": "2026-04-24",
                "db_row_counts": {"notations": 1}, "db_schema_version": "3",
                "concepts_jsonl_sha256": "x", "total_api_calls": 0}
        aat.write_report_md(concepts, audit, out, meta)
        text = out.read_text()
        # Three concepts, each flagged exactly once: 1 E1, 1 E2, 1 E3.
        assert "E1: 1" in text
        assert "E2: 1" in text
        assert "E3: 1" in text
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestWriteReport -v
```
Expected: fail with `AttributeError: module has no attribute 'write_report_md'`.

- [ ] **Step 3: Implement `write_report_md`**

Append to `audit_animal_taxonomy.py`:

```python
from collections import Counter

# --- Stage 3b: Markdown report -----------------------------------------

def write_report_md(concepts: list[dict], audit: list[dict], out_path: Path, meta: dict) -> None:
    audit_by_concept = {a["concept"]: a for a in audit}

    # Flag counts
    def flag(rec: dict, section: str) -> str:
        return rec.get(section, {}).get("flag", "")

    e1 = [a for a in audit if flag(a, "real_tree_taxonomy") == "E1"]
    e2 = [a for a in audit if flag(a, "real_tree_presence") == "E2"]
    e3 = [a for a in audit if flag(a, "polysemy") == "E3"]
    uncertain = [a for a in audit if any(flag(a, s) == "uncertain"
                                         for s in ["real_tree_presence","real_tree_taxonomy","polysemy"])]
    total = len(audit)
    flagged = {a["concept"] for a in e1 + e2 + e3}
    pct = (100.0 * len(flagged) / total) if total else 0.0

    verdict = "systemic" if pct >= 20 else "mixed" if pct >= 5 else "isolated"

    # E1 by bucket
    by_bucket: Counter[str] = Counter()
    concepts_by_name = {c["concept"]: c for c in concepts}
    for a in e1:
        c = concepts_by_name.get(a["concept"])
        if not c:
            continue
        for m in c["cluster"]:
            if m.get("branch") == "25F real animal tree":
                by_bucket[m.get("parent_label_en") or m.get("parent_bucket") or "?"] += 1
                break

    lines: list[str] = []
    lines.append(f"# Iconclass animal taxonomy audit — branch {meta['branch']}")
    lines.append("")
    lines.append(f"*Run date: {meta['run_date']} · Model: `{meta['model']}`*")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")
    lines.append(f"Of **{total}** mammal concepts audited, **{len(flagged)}** ({pct:.1f} %) are flagged "
                 f"in one or more error classes. The distribution suggests this is **{verdict}**.")
    lines.append("")
    lines.append(f"Counts by flag — **E1: {len(e1)}**, **E2: {len(e2)}**, **E3: {len(e3)}**, "
                 f"**uncertain: {len(uncertain)}**.")
    lines.append("")

    lines.append("## Most compelling cases")
    lines.append("")
    for label, recs in (("E1 (misplacement)", e1), ("E2 (fabulous-only real animal)", e2),
                       ("E3 (polysemy)", e3)):
        lines.append(f"### {label}")
        if not recs:
            lines.append("*No cases in this class.*")
            lines.append("")
            continue
        for a in recs[:4]:
            c = concepts_by_name.get(a["concept"], {})
            cluster_str = ", ".join(f"`{m['notation']}`" for m in c.get("cluster", []))
            section = ("real_tree_taxonomy" if label.startswith("E1")
                       else "real_tree_presence" if label.startswith("E2")
                       else "polysemy")
            finding = a.get(section, {}).get("finding", "")
            lines.append(f"- **{a['concept']}** — cluster: {cluster_str} "
                         f"(confidence {a.get('confidence','?')})")
            lines.append(f"  - {finding}")
        lines.append("")

    lines.append("## Counts by parent bucket (E1)")
    lines.append("")
    if by_bucket:
        lines.append("| Parent bucket | E1 count |")
        lines.append("|---|---|")
        for bucket, n in by_bucket.most_common():
            lines.append(f"| {bucket} | {n} |")
    else:
        lines.append("*No E1 flags.*")
    lines.append("")

    lines.append("## Appendix A — E2 full list (fabulous-only real animals)")
    lines.append("")
    for a in e2:
        c = concepts_by_name.get(a["concept"], {})
        cluster_str = ", ".join(f"`{m['notation']}`" for m in c.get("cluster", []))
        lines.append(f"- **{a['concept']}** · {cluster_str}")
        lines.append(f"  - {a.get('real_tree_presence', {}).get('finding', '')}")
    if not e2:
        lines.append("*None.*")
    lines.append("")

    lines.append("## Appendix B — E3 full list (polysemous names)")
    lines.append("")
    for a in e3:
        lines.append(f"- **{a['concept']}** — {a.get('polysemy', {}).get('finding', '')}")
    if not e3:
        lines.append("*None.*")
    lines.append("")

    lines.append("## Appendix C — uncertain / archaic cases")
    lines.append("")
    for a in uncertain:
        unc_sections = [s for s in ["real_tree_presence","real_tree_taxonomy","polysemy"]
                        if a.get(s, {}).get("flag") == "uncertain"]
        for s in unc_sections:
            lines.append(f"- **{a['concept']}** [{s}] — {a[s].get('finding','')}")
    if not uncertain:
        lines.append("*None.*")
    lines.append("")

    lines.append("## Appendix D — framing note (E4)")
    lines.append("")
    lines.append(
        "Iconclass mammal buckets under `25F2` are pre-Linnaean morphological categories — "
        "'hoofed', 'predatory', 'rodent-as-small-furry-quadruped', 'trunked', 'flying', "
        "'swimming', 'other'. Many E1 flags are symptoms of this bucket design rather "
        "than isolated editorial slips."
    )
    lines.append("")

    lines.append("## Methodology")
    lines.append("")
    lines.append(f"- Model: `{meta['model']}`, temperature 0")
    lines.append(f"- Run date: {meta['run_date']}")
    lines.append(f"- Branch: `{meta['branch']}`")
    lines.append(f"- iconclass.db schema_version: `{meta['db_schema_version']}`")
    lines.append(f"- iconclass.db row counts: `{meta['db_row_counts']}`")
    lines.append(f"- concepts.jsonl sha256: `{meta['concepts_jsonl_sha256']}`")
    lines.append(f"- Total API calls: `{meta['total_api_calls']}`")
    lines.append("")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestWriteReport -v
```
Expected: `2 passed`.

---

## Task 13: Top-level README index writer (Stage 3c)

Update `offline/audits/animal-taxonomy/README.md` with a one-line entry per branch run.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py`
- Modify: `offline/scripts/test_audit_animal_taxonomy.py`

- [ ] **Step 1: Write failing tests**

```python
# --- README index ---

class TestUpdateIndex:
    def test_creates_new_index(self, tmp_path) -> None:
        index_path = tmp_path / "README.md"
        row = {"branch": "25F2 mammals", "date": "2026-04-24", "concepts": 142,
               "e1": 18, "e2": 3, "e3": 7, "uncertain": 9,
               "report_href": "25F2-mammals/report.md"}
        aat.upsert_index_row(index_path, row)
        text = index_path.read_text()
        assert "| 25F2 mammals |" in text
        assert "| Branch |" in text  # header present
        assert "[report](25F2-mammals/report.md)" in text

    def test_replaces_existing_row_same_branch(self, tmp_path) -> None:
        index_path = tmp_path / "README.md"
        row_v1 = {"branch": "25F2 mammals", "date": "2026-04-01", "concepts": 10,
                  "e1": 1, "e2": 0, "e3": 0, "uncertain": 0,
                  "report_href": "25F2-mammals/report.md"}
        row_v2 = {**row_v1, "date": "2026-04-24", "concepts": 142, "e1": 18}
        aat.upsert_index_row(index_path, row_v1)
        aat.upsert_index_row(index_path, row_v2)
        text = index_path.read_text()
        # Only the newest row should remain for this branch
        assert text.count("| 25F2 mammals |") == 1
        assert "2026-04-01" not in text
        assert "2026-04-24" in text
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestUpdateIndex -v
```
Expected: fail with `AttributeError`.

- [ ] **Step 3: Implement `upsert_index_row`**

Append to `audit_animal_taxonomy.py`:

```python
# --- Stage 3c: README index --------------------------------------------

_INDEX_HEADER = (
    "# Animal Taxonomy Audit\n\n"
    "| Branch | Date | Concepts | E1 | E2 | E3 | Uncertain | Report |\n"
    "|---|---|---|---|---|---|---|---|\n"
)


def upsert_index_row(index_path: Path, row: dict) -> None:
    """Insert or replace the row for row['branch']; keep table sorted by branch."""
    existing_rows: dict[str, str] = {}
    if index_path.exists():
        text = index_path.read_text(encoding="utf-8")
        for line in text.splitlines():
            if not line.startswith("| ") or line.startswith("| Branch ") or line.startswith("|---"):
                continue
            parts = [p.strip() for p in line.strip("|").split("|")]
            if len(parts) >= 8:
                existing_rows[parts[0]] = line

    new_line = (
        f"| {row['branch']} | {row['date']} | {row['concepts']} | "
        f"{row['e1']} | {row['e2']} | {row['e3']} | {row['uncertain']} | "
        f"[report]({row['report_href']}) |"
    )
    existing_rows[row["branch"]] = new_line

    body = _INDEX_HEADER + "\n".join(existing_rows[k] for k in sorted(existing_rows)) + "\n"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(body, encoding="utf-8")
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestUpdateIndex -v
```
Expected: `2 passed`.

---

## Task 14: CLI wiring

Wire `main()` to invoke the pipeline end-to-end.

**Files:**
- Modify: `offline/scripts/audit_animal_taxonomy.py` (replace the stub `main`)

- [ ] **Step 1: Write failing integration test**

Append to `test_audit_animal_taxonomy.py`:

```python
# --- CLI end-to-end (dry-run) ---

class TestMainDryRun:
    def test_dry_run_completes_without_api(self, tmp_path, monkeypatch) -> None:
        # Redirect output root so we don't pollute offline/audits/.
        monkeypatch.setattr(aat, "AUDIT_ROOT", tmp_path / "audits")
        exit_code = aat.main(["--branch", "25F2", "--dry-run"])
        assert exit_code == 0
        concepts_jsonl = tmp_path / "audits" / "25F2-mammals" / "concepts.jsonl"
        assert concepts_jsonl.exists(), "Stage 1 must still run under --dry-run"
        # Stage 2/3 must NOT produce CSV/report under dry-run:
        assert not (tmp_path / "audits" / "25F2-mammals" / "findings.csv").exists()
```

- [ ] **Step 2: Run the test, confirm failure**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestMainDryRun -v
```
Expected: fail (current stub `main` prints `TODO:` and returns 0 without creating files; assertion on concepts.jsonl fails).

- [ ] **Step 3: Replace `main` with the real pipeline**

Replace the existing `main` in `audit_animal_taxonomy.py` with:

```python
# --- CLI wiring ---------------------------------------------------------

_BRANCH_SLUGS: dict[str, str] = {
    "25F1": "groups", "25F2": "mammals", "25F3": "birds", "25F4": "reptiles",
    "25F5": "amphibians", "25F6": "fishes", "25F7": "lower-animals",
    "25F8": "extinct", "25F9": "monsters",
}


def _branch_slug(branches: list[str]) -> str:
    """Human-friendly directory slug for one or more branches."""
    return "-".join(f"{b}-{_BRANCH_SLUGS.get(b, 'branch')}" for b in branches)


def _db_meta(db_path: Path) -> dict:
    con = sqlite3.connect(db_path)
    try:
        notation_count = con.execute("SELECT COUNT(*) FROM notations").fetchone()[0]
        schema = con.execute("SELECT value FROM version_info WHERE key = 'schema_version'").fetchone()
    finally:
        con.close()
    return {
        "db_row_counts": {"notations": notation_count},
        "db_schema_version": schema[0] if schema else "?",
    }


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", required=True,
                        help="Iconclass branch prefix (e.g. 25F2); comma-separate for joint (25F4,25F5).")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    branches = [b.strip() for b in args.branch.split(",") if b.strip()]
    out_dir = AUDIT_ROOT / _branch_slug(branches)
    out_dir.mkdir(parents=True, exist_ok=True)
    prompts_dir = out_dir / "prompts"
    concepts_path = out_dir / "concepts.jsonl"
    audit_cache_path = out_dir / "audit.jsonl"
    findings_path = out_dir / "findings.csv"
    report_path = out_dir / "report.md"
    index_path = AUDIT_ROOT / "README.md"

    # ── Stage 1 ──────────────────────────────────────────────────────
    print(f"[stage 1] building concepts for {branches}...", file=sys.stderr)
    raw_concepts: list[dict] = []
    for branch in branches:
        raw_concepts.extend(build_concepts(branch, concepts_path))
    # For joint runs (e.g. 25F4,25F5), two branches may share seed names.
    # Dedup by concept name, preserving first-seen order.
    seen: set[str] = set()
    all_concepts: list[dict] = []
    for c in raw_concepts:
        if c["concept"] not in seen:
            seen.add(c["concept"])
            all_concepts.append(c)
    # Re-write concepts.jsonl reflecting the full deduped union:
    with concepts_path.open("w", encoding="utf-8") as f:
        for c in all_concepts:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"[stage 1] {len(all_concepts)} concepts written to {concepts_path}", file=sys.stderr)

    if args.dry_run:
        # Still materialise prompts so user can inspect them without calling the API.
        system_prompt = system_prompt_for_branch(branches[0])
        prompts_dir.mkdir(parents=True, exist_ok=True)
        (prompts_dir / "batch-001.txt").write_text(
            f"SYSTEM:\n{system_prompt}\n\nUSER:\n{user_prompt_for_batch(all_concepts[:25])}\n",
            encoding="utf-8")
        print("[dry-run] skipped Stage 2 and 3", file=sys.stderr)
        return 0

    # ── Stage 2 ──────────────────────────────────────────────────────
    import anthropic  # local import so dry-run works without the SDK present
    if args.force and audit_cache_path.exists():
        audit_cache_path.unlink()
    cache = ResponseCache(audit_cache_path)
    client = anthropic.Anthropic()
    print(f"[stage 2] auditing with {args.model}...", file=sys.stderr)
    audit_records = run_audit(
        concepts=all_concepts, branch=branches[0], model=args.model,
        client=client, cache=cache, prompts_dir=prompts_dir,
    )
    print(f"[stage 2] {len(audit_records)} audit records", file=sys.stderr)

    # ── Stage 3 ──────────────────────────────────────────────────────
    write_findings_csv(all_concepts, audit_records, findings_path)
    db_meta = _db_meta(DB_PATH)
    meta = {
        "branch": args.branch,
        "model": args.model,
        "run_date": __import__("datetime").date.today().isoformat(),
        "concepts_jsonl_sha256": _sha256_of(concepts_path),
        "total_api_calls": sum(1 for _ in audit_cache_path.open() if _.strip()),
        **db_meta,
    }
    write_report_md(all_concepts, audit_records, report_path, meta)

    # Tally for index row
    def flag(rec: dict, section: str) -> str:
        return rec.get(section, {}).get("flag", "")
    e1 = sum(1 for a in audit_records if flag(a, "real_tree_taxonomy") == "E1")
    e2 = sum(1 for a in audit_records if flag(a, "real_tree_presence") == "E2")
    e3 = sum(1 for a in audit_records if flag(a, "polysemy") == "E3")
    unc = sum(1 for a in audit_records
              if any(flag(a, s) == "uncertain"
                     for s in ["real_tree_presence","real_tree_taxonomy","polysemy"]))
    upsert_index_row(index_path, {
        "branch": f"{args.branch} {_BRANCH_SLUGS.get(branches[0], 'branch')}",
        "date": meta["run_date"],
        "concepts": len(all_concepts),
        "e1": e1, "e2": e2, "e3": e3, "uncertain": unc,
        "report_href": f"{_branch_slug(branches)}/report.md",
    })

    print(f"[done] report: {report_path}", file=sys.stderr)
    return 0
```

- [ ] **Step 4: Run the dry-run test, confirm pass**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py::TestMainDryRun -v
```
Expected: `1 passed`.

- [ ] **Step 5: Run the entire test suite as a sanity check**

```bash
~/miniconda3/envs/embeddings/bin/pytest offline/scripts/test_audit_animal_taxonomy.py -v
```
Expected: all tests pass (total ~35 individual tests across 11 test classes).

---

## Task 15: End-to-end run on mammals

- [ ] **Step 1: Verify Anthropic API key is set**

```bash
[ -n "$ANTHROPIC_API_KEY" ] && echo "key present" || { echo "missing ANTHROPIC_API_KEY"; exit 1; }
```

If missing: set via `export ANTHROPIC_API_KEY=...` using the key in `~/.env` (per `memory/env-keys.md`).

- [ ] **Step 2: Dry-run first to inspect prompts**

```bash
~/miniconda3/envs/embeddings/bin/python offline/scripts/audit_animal_taxonomy.py --branch 25F2 --dry-run
```

Expected: stderr lines indicating Stage 1 completed and `[dry-run]` skipped subsequent stages. Inspect the first batch prompt:

```bash
head -80 offline/audits/animal-taxonomy/25F2-mammals/prompts/batch-001.txt
```

Expected: a `SYSTEM:` block followed by a `USER:` block containing few-shot examples and a JSON array of concepts starting with the alphabetically-first mammal.

- [ ] **Step 3: Real run**

```bash
~/miniconda3/envs/embeddings/bin/python offline/scripts/audit_animal_taxonomy.py --branch 25F2
```

Expected output (stderr): three `[stage N]` lines, then `[done] report: offline/audits/animal-taxonomy/25F2-mammals/report.md`. Runtime: a few minutes. Cost: single-digit dollars.

- [ ] **Step 4: Verify the three key hypotheses**

```bash
grep -A2 "^- \*\*wombat\*\*" offline/audits/animal-taxonomy/25F2-mammals/report.md
grep -A2 "^- \*\*salamander\*\*" offline/audits/animal-taxonomy/25F2-mammals/report.md
grep -A2 "^- \*\*rabbit\*\*" offline/audits/animal-taxonomy/25F2-mammals/report.md
grep -A2 "^- \*\*hare\*\*"  offline/audits/animal-taxonomy/25F2-mammals/report.md
```

Expected: wombat flagged E1 under rodents, salamander absent from mammal run (it lives in 25F5), rabbit and hare flagged E1 under rodents (lagomorphs, not rodents).

If salamander does NOT appear in the mammal run (expected — it's an amphibian, not a mammal), that's correct. The E2 test for salamander comes later when running `--branch 25F4,25F5`.

- [ ] **Step 5: Read the verdict**

```bash
sed -n '/^## Verdict/,/^## Most/p' offline/audits/animal-taxonomy/25F2-mammals/report.md
```

Expected: one paragraph stating counts and `systemic` / `mixed` / `isolated` classification. This is the scoping-exercise answer.

- [ ] **Step 6: Re-run to confirm caching works**

```bash
~/miniconda3/envs/embeddings/bin/python offline/scripts/audit_animal_taxonomy.py --branch 25F2
```

Expected: much faster (cache hits), same verdict paragraph, identical `findings.csv`. If re-run is slow, the cache layer is buggy — inspect `audit.jsonl` line count and `ResponseCache.__init__`.

- [ ] **Step 7: Summarise for the user**

Report back with: verdict classification, counts per flag, top 3 E1 cases, top 3 E2 cases (if any), and the path to the full report. If verdict is `systemic`, offer to run the next branch (`--branch 25F4,25F5` for reptiles+amphibians — likely to surface salamander E2).

---

## Self-review checklist

**Spec coverage** (walk each section of `docs/superpowers/specs/2026-04-24-iconclass-animal-taxonomy-audit-design.md`):
- §1 Context/purpose → Task 15 Step 4/5 verify the motivating examples (wombat, salamander, rabbit, hare).
- §2 Error classes (E1/E2/E3/E4) → Task 8 prompt + Task 12 report sections. E4 appendix included in Task 12 Step 3.
- §3 Architecture (single script, CLI, conda env) → Tasks 1, 14.
- §4 Concept-centric unit of analysis → Tasks 4, 6, 7 (name extraction, FTS expansion, concept assembly).
- §5 Pipeline Stage 1 → Tasks 4-7. Stage 2 → Tasks 8-10. Stage 3 → Tasks 11-13.
- §6 Output schemas (CSV columns, report.md structure, README index) → Tasks 11, 12, 13.
- §7 Extensibility (`--branch` CLI, joint runs, per-branch prompt) → Tasks 8, 14 (both support comma-separated branches).
- §8 Caching & reproducibility → Task 9 (cache) + Task 14 meta-building (SHA256 of concepts.jsonl, DB row counts in methodology section).
- §9 Out-of-scope enforcement — no Wikidata/GBIF code paths anywhere; no tests in `scripts/tests/`; plan explicitly avoids those.
- §10 Success criteria → Task 15 Step 4-7 (verify hypotheses, read verdict).

**Placeholder scan:** No "TBD", "TODO" (except the stub in Task 1 Step 2 which is immediately replaced in Task 14), "fill in", or "similar to" references. Every code block is runnable as shown.

**Type consistency:**
- `ClusterMember` TypedDict (Task 6) has six fields; same fields read by `write_findings_csv` (Task 11) and `write_report_md` (Task 12). ✓
- `audit_records` dict shape is: `{concept, cluster, real_animal, real_tree_presence, real_tree_taxonomy, polysemy, confidence}`. Defined by Haiku's schema in Task 8, consumed by Tasks 11, 12, 14. All match. ✓
- `ResponseCache.key(model, system, user)` — same signature used in Task 9 tests and Task 10 driver. ✓
- `_paired_branches` returns `(real, fab)` tuple — caller in Task 4 and in future `_seed_notations_by_name` (Task 7) unpacks it the same way. ✓
- `upsert_index_row` expects keys `{branch, date, concepts, e1, e2, e3, uncertain, report_href}` — exact same keys supplied by Task 14 `main`. ✓
