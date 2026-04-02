#!/usr/bin/env python3
"""
Build iconclass.db from the CC0 Iconclass data dump (1.3M notations).

Usage:
    python scripts/build-iconclass-db.py [--data-dir /tmp/iconclass-data] [--output data/iconclass.db]
    python scripts/build-iconclass-db.py --counts-csv data/rijksmuseum-counts.csv  # add collection counts

Inputs:
    - Iconclass CC0 data dump (https://github.com/iconclass/data)
    - iconclass Python library (pip install iconclass)
    - Optional: collection count CSV files (notation,count per line)

Output:
    - iconclass.db with FTS5 search, 1.3M notations, 13 languages, collection count overlays
"""

import argparse
import csv
import gzip
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


# ─── Languages ───────────────────────────────────────────────────────

# Languages supported by the iconclass Python library (text composition + keywords)
LIBRARY_LANGS = {"en", "de", "fr", "it", "pt", "jp"}

# All languages in the CC0 dump text files
ALL_TEXT_LANGS = {"cz", "de", "en", "es", "fi", "fr", "hu", "it", "jp", "nl", "pl", "pt", "zh"}

# Languages that must be loaded from CC0 dump files (not in library)
DUMP_ONLY_LANGS = ALL_TEXT_LANGS - LIBRARY_LANGS

# All languages in the CC0 dump keyword files
ALL_KW_LANGS = {"cz", "de", "en", "es", "fi", "fr", "it", "nl", "pt", "zh"}
DUMP_ONLY_KW_LANGS = ALL_KW_LANGS - LIBRARY_LANGS


# ─── CC0 dump parsing ────────────────────────────────────────────────

def parse_text_files(txt_dir: str, langs: set[str]) -> dict[str, dict[str, str]]:
    """Parse txt/{lang}/txt_{lang}_*.txt for specified languages.
    Returns {notation: {lang: text}}. Skips key text files (handled separately)."""
    texts: dict[str, dict[str, str]] = {}
    for lang_dir in sorted(Path(txt_dir).iterdir()):
        if not lang_dir.is_dir():
            continue
        lang = lang_dir.name
        if lang not in langs:
            continue
        for txt_file in sorted(lang_dir.glob("txt_*.txt")):
            # Skip key text files — we compose those ourselves
            if "_keys" in txt_file.name:
                continue
            with open(txt_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.rstrip("\n")
                    if "|" not in line:
                        continue
                    notation, text = line.split("|", 1)
                    if notation and text:
                        texts.setdefault(notation, {})[lang] = text
    return texts


def parse_key_texts(txt_dir: str, langs: set[str]) -> dict[str, dict[str, str]]:
    """Parse txt/{lang}/txt_{lang}_keys.txt for specified languages.
    Returns {key_text_id: {lang: text}}, e.g. {'11k1': {'nl': 'Drieëenheid'}}."""
    key_texts: dict[str, dict[str, str]] = {}
    for lang_dir in sorted(Path(txt_dir).iterdir()):
        if not lang_dir.is_dir():
            continue
        lang = lang_dir.name
        if lang not in langs:
            continue
        keys_file = lang_dir / f"txt_{lang}_keys.txt"
        if not keys_file.exists():
            continue
        with open(keys_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if "|" not in line:
                    continue
                key_id, text = line.split("|", 1)
                if key_id and text:
                    key_texts.setdefault(key_id, {})[lang] = text
    return key_texts


def parse_keyword_files(kw_dir: str, langs: set[str]) -> dict[str, dict[str, list[str]]]:
    """Parse kw/{lang}/kw_{lang}_*.txt for specified languages.
    Returns {notation: {lang: [keyword, ...]}}."""
    keywords: dict[str, dict[str, list[str]]] = {}
    for lang_dir in sorted(Path(kw_dir).iterdir()):
        if not lang_dir.is_dir():
            continue
        lang = lang_dir.name
        if lang not in langs:
            continue
        for kw_file in sorted(lang_dir.glob("kw_*.txt")):
            with open(kw_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.rstrip("\n")
                    if "|" not in line:
                        continue
                    notation, keyword = line.split("|", 1)
                    if notation and keyword:
                        keywords.setdefault(notation, {}).setdefault(lang, []).append(keyword)
    return keywords


# ─── Build ───────────────────────────────────────────────────────────

def build(data_dir: str, output_path: str, count_csvs: list[str]):
    start = time.time()

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    if os.path.exists(output_path):
        os.remove(output_path)

    conn = sqlite3.connect(output_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA cache_size = -200000")  # 200 MB page cache for bulk inserts

    # ── Phase 1: Load all notation codes + structure via library ───
    print("Phase 1: Loading notation structure (1.3M notations)...")

    from iconclass import Iconclass
    ic = Iconclass()
    # Load all library-supported languages
    for lang in sorted(LIBRARY_LANGS):
        ic.load(lang)
        print(f"  Loaded library language: {lang}")

    # Read all notation codes from all_notations.gz
    all_notations_path = os.path.join(data_dir, "all_notations.gz")
    all_codes: list[str] = []
    with gzip.open(all_notations_path, "rt") as f:
        for line in f:
            code = line.strip()
            if code:
                all_codes.append(code)
    print(f"  Loaded {len(all_codes):,} notation codes from all_notations.gz")

    # Get structure for each notation via library obj()
    t0 = time.time()
    notation_data: list[tuple] = []  # (notation, path, children, refs, base_notation, key_id, is_key_expanded)
    skipped = 0
    for code in all_codes:
        try:
            obj = ic.obj(code)
        except Exception:
            skipped += 1
            continue

        # Path: obj['p'] includes self — we want ancestors only (exclude self)
        path = obj.get("p", [])
        if path and path[-1] == code:
            path = path[:-1]

        children_raw = obj.get("c", [])
        refs = obj.get("r", [])
        base = obj.get("b", None)
        key_source = obj.get("k", None)  # e.g. '25Fk46'
        is_key_expanded = 1 if "(" in code and "+" in code else 0

        # Extract key_id from key_source: '25Fk46' → '+46'
        key_id = None
        if key_source and is_key_expanded:
            # key_source format: '{prefix}k{sub_id}', e.g. '25Fk46', '11k1'
            # We need to extract the sub_id part after 'k'
            k_idx = key_source.rfind("k")
            if k_idx >= 0:
                sub_id = key_source[k_idx + 1:]
                key_id = f"+{sub_id}"

        # Children differ by notation type:
        # - Key-expanded: 'l' gives available sub-keys → child key-expanded notations
        # - Base: 'c' gives direct hierarchy children (filter out (...) placeholders)
        children = []
        sub_keys = obj.get("l", [])
        if is_key_expanded and sub_keys and base:
            for sk in sub_keys:
                sk_idx = sk.rfind("k")
                if sk_idx >= 0:
                    sub_id = sk[sk_idx + 1:]
                    children.append(f"{base}(+{sub_id})")
        else:
            children = [c for c in children_raw if "..." not in c]

        notation_data.append((
            code,
            json.dumps(path),
            json.dumps(children),
            json.dumps(refs),
            base if is_key_expanded else None,
            key_id,
            is_key_expanded,
        ))

    elapsed_struct = time.time() - t0
    print(f"  Resolved {len(notation_data):,} notations in {elapsed_struct:.1f}s (skipped {skipped})")

    # Create table and insert
    conn.execute("""
        CREATE TABLE notations (
            notation       TEXT PRIMARY KEY,
            path           TEXT NOT NULL,
            children       TEXT NOT NULL,
            refs           TEXT NOT NULL,
            base_notation  TEXT,
            key_id         TEXT,
            is_key_expanded INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID
    """)

    conn.executemany(
        "INSERT INTO notations VALUES (?, ?, ?, ?, ?, ?, ?)",
        notation_data,
    )
    conn.execute("CREATE INDEX idx_notations_prefix ON notations(notation)")
    conn.execute("CREATE INDEX idx_notations_base ON notations(base_notation) WHERE base_notation IS NOT NULL")
    conn.commit()

    base_count = sum(1 for _, _, _, _, _, _, ke in notation_data if not ke)
    key_count = sum(1 for _, _, _, _, _, _, ke in notation_data if ke)
    print(f"  Inserted: {base_count:,} base + {key_count:,} key-expanded = {len(notation_data):,} total")

    # ── Phase 2: Texts (library languages + CC0 dump languages) ───
    print("Phase 2: Loading texts (13 languages)...")

    conn.execute("""
        CREATE TABLE texts (
            notation TEXT NOT NULL,
            lang     TEXT NOT NULL,
            text     TEXT NOT NULL
        )
    """)

    # 2a: Library languages — use text_() for all 1.3M (handles key composition)
    text_count = 0
    text_batch: list[tuple[str, str, str]] = []

    for lang in sorted(LIBRARY_LANGS):
        lang_count = 0
        for code in all_codes:
            try:
                text = ic.text_(code, lang)
                if text:
                    text_batch.append((code, lang, text))
                    lang_count += 1
            except Exception:
                pass

            # Batch insert every 100K
            if len(text_batch) >= 100_000:
                conn.executemany("INSERT INTO texts VALUES (?, ?, ?)", text_batch)
                conn.commit()
                text_count += len(text_batch)
                text_batch = []

        print(f"  {lang}: {lang_count:,} texts (library)")

    # Flush remaining
    if text_batch:
        conn.executemany("INSERT INTO texts VALUES (?, ?, ?)", text_batch)
        conn.commit()
        text_count += len(text_batch)
        text_batch = []

    # 2b: Dump-only languages — parse CC0 text files + compose key-expanded
    txt_dir = os.path.join(data_dir, "txt")
    dump_texts = parse_text_files(txt_dir, DUMP_ONLY_LANGS)
    dump_key_texts = parse_key_texts(txt_dir, DUMP_ONLY_LANGS)

    # Build notation → key_text_id mapping for key-expanded notations
    # We already know base_notation and key_source from Phase 1
    notation_key_source: dict[str, str] = {}
    for code in all_codes:
        try:
            obj = ic.obj(code)
            ks = obj.get("k")
            if ks:
                notation_key_source[code] = ks
        except Exception:
            pass

    for lang in sorted(DUMP_ONLY_LANGS):
        lang_count = 0
        for code in all_codes:
            text = None
            if "(" in code and "+" in code:
                # Key-expanded: compose from base text + key text
                base = code.split("(")[0]
                base_text = dump_texts.get(base, {}).get(lang)
                if base_text:
                    key_source = notation_key_source.get(code)
                    key_text = dump_key_texts.get(key_source, {}).get(lang) if key_source else None
                    if key_text:
                        text = f"{base_text} (+ {key_text})"
                    else:
                        text = base_text  # No key text for this lang — use base only
            else:
                text = dump_texts.get(code, {}).get(lang)

            if text:
                text_batch.append((code, lang, text))
                lang_count += 1

            if len(text_batch) >= 100_000:
                conn.executemany("INSERT INTO texts VALUES (?, ?, ?)", text_batch)
                conn.commit()
                text_count += len(text_batch)
                text_batch = []

        print(f"  {lang}: {lang_count:,} texts (CC0 dump{' + key composition' if lang in {l for l in DUMP_ONLY_LANGS if any(dump_key_texts.get(k, {}).get(lang) for k in dump_key_texts)} else ''})")

    if text_batch:
        conn.executemany("INSERT INTO texts VALUES (?, ?, ?)", text_batch)
        conn.commit()
        text_count += len(text_batch)
        text_batch = []

    conn.execute("CREATE INDEX idx_texts_notation_lang ON texts(notation, lang)")
    conn.commit()
    print(f"  Total: {text_count:,} text entries")

    # FTS5 for texts
    conn.execute("""
        CREATE VIRTUAL TABLE texts_fts USING fts5(
            text,
            content=texts,
            content_rowid=rowid
        )
    """)
    conn.execute("INSERT INTO texts_fts(texts_fts) VALUES('rebuild')")
    conn.commit()
    print("  Built texts_fts index")

    # ── Phase 3: Keywords (library languages + CC0 dump languages) ─
    print("Phase 3: Loading keywords...")

    conn.execute("""
        CREATE TABLE keywords (
            notation TEXT NOT NULL,
            lang     TEXT NOT NULL,
            keyword  TEXT NOT NULL
        )
    """)

    kw_count = 0
    kw_batch: list[tuple[str, str, str]] = []

    # 3a: Library languages
    for lang in sorted(LIBRARY_LANGS):
        lang_count = 0
        for code in all_codes:
            try:
                kws = ic.kw(code, lang)
                for kw in kws:
                    kw_batch.append((code, lang, kw))
                    lang_count += 1
            except Exception:
                pass

            if len(kw_batch) >= 100_000:
                conn.executemany("INSERT INTO keywords VALUES (?, ?, ?)", kw_batch)
                conn.commit()
                kw_count += len(kw_batch)
                kw_batch = []

        print(f"  {lang}: {lang_count:,} keywords (library)")

    if kw_batch:
        conn.executemany("INSERT INTO keywords VALUES (?, ?, ?)", kw_batch)
        conn.commit()
        kw_count += len(kw_batch)
        kw_batch = []

    # 3b: Dump-only keyword languages
    kw_dir = os.path.join(data_dir, "kw")
    dump_keywords = parse_keyword_files(kw_dir, DUMP_ONLY_KW_LANGS)

    for lang in sorted(DUMP_ONLY_KW_LANGS):
        lang_count = 0
        for code in all_codes:
            kws_for_lang = dump_keywords.get(code, {}).get(lang, [])
            for kw in kws_for_lang:
                kw_batch.append((code, lang, kw))
                lang_count += 1

            if len(kw_batch) >= 100_000:
                conn.executemany("INSERT INTO keywords VALUES (?, ?, ?)", kw_batch)
                conn.commit()
                kw_count += len(kw_batch)
                kw_batch = []

        print(f"  {lang}: {lang_count:,} keywords (CC0 dump)")

    if kw_batch:
        conn.executemany("INSERT INTO keywords VALUES (?, ?, ?)", kw_batch)
        conn.commit()
        kw_count += len(kw_batch)

    conn.execute("CREATE INDEX idx_keywords_notation_lang ON keywords(notation, lang)")
    conn.commit()
    print(f"  Total: {kw_count:,} keyword entries")

    # FTS5 for keywords
    conn.execute("""
        CREATE VIRTUAL TABLE keywords_fts USING fts5(
            keyword,
            content=keywords,
            content_rowid=rowid
        )
    """)
    conn.execute("INSERT INTO keywords_fts(keywords_fts) VALUES('rebuild')")
    conn.commit()
    print("  Built keywords_fts index")

    # ── Phase 4: Collection counts (optional CSV overlays) ────────
    print("Phase 4: Collection counts...")

    conn.execute("""
        CREATE TABLE collection_counts (
            collection_id TEXT NOT NULL,
            notation      TEXT NOT NULL,
            count         INTEGER NOT NULL,
            PRIMARY KEY (collection_id, notation)
        ) WITHOUT ROWID
    """)

    conn.execute("""
        CREATE TABLE collection_info (
            collection_id  TEXT PRIMARY KEY,
            label          TEXT NOT NULL,
            counts_as_of   TEXT,
            total_artworks INTEGER DEFAULT 0
        )
    """)

    if count_csvs:
        for csv_path in count_csvs:
            load_collection_counts(conn, csv_path)
    else:
        print("  No collection count CSVs provided — skipping")

    conn.commit()

    # ── Phase 5: Version info + VACUUM ────────────────────────────
    print("Phase 5: Finalizing...")

    conn.execute("""
        CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT)
    """)

    built_at = datetime.now(timezone.utc).isoformat()
    iconclass_commit = get_iconclass_commit(data_dir)

    conn.executemany("INSERT INTO version_info VALUES (?, ?)", [
        ("built_at", built_at),
        ("iconclass_data_commit", iconclass_commit),
        ("notation_count", str(len(notation_data))),
        ("base_notation_count", str(base_count)),
        ("key_expanded_count", str(key_count)),
        ("text_languages", ",".join(sorted(ALL_TEXT_LANGS))),
        ("keyword_languages", ",".join(sorted(ALL_KW_LANGS | LIBRARY_LANGS))),
        ("schema_version", "2"),  # v2 = expanded schema with key columns + collection_counts
    ])
    conn.commit()

    print("  Running VACUUM...")
    conn.execute("VACUUM")
    conn.close()

    elapsed = time.time() - start
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\nDone! {output_path} ({size_mb:.1f} MB) in {elapsed:.1f}s")
    print(f"  Notations: {len(notation_data):,} ({base_count:,} base + {key_count:,} key-expanded)")
    print(f"  Texts: {text_count:,} entries across {len(ALL_TEXT_LANGS)} languages")
    print(f"  Keywords: {kw_count:,} entries across {len(ALL_KW_LANGS | LIBRARY_LANGS)} languages")
    print(f"  Iconclass commit: {iconclass_commit[:7]}")


# ─── Collection count loading ────────────────────────────────────────

def load_collection_counts(conn: sqlite3.Connection, csv_path: str):
    """Load a collection count CSV: notation,count (with optional header).
    Collection ID and label are derived from the filename."""
    if not os.path.exists(csv_path):
        print(f"  Warning: {csv_path} not found — skipping")
        return

    # Derive collection_id from filename: "rijksmuseum-counts.csv" → "rijksmuseum"
    basename = os.path.basename(csv_path)
    collection_id = basename.replace("-counts.csv", "").replace("_counts.csv", "").replace(".csv", "")
    label = collection_id.replace("-", " ").replace("_", " ").title()

    print(f"  Loading counts for '{collection_id}' from {csv_path}...")

    rows: list[tuple[str, str, int]] = []
    total_artworks = 0
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if len(row) < 2:
                continue
            notation, count_str = row[0].strip(), row[1].strip()
            # Skip header row
            if i == 0 and not count_str.isdigit():
                continue
            try:
                count = int(count_str)
                rows.append((collection_id, notation, count))
                total_artworks = max(total_artworks, count)  # approximate
            except ValueError:
                continue

    conn.executemany(
        "INSERT OR REPLACE INTO collection_counts VALUES (?, ?, ?)",
        rows,
    )

    # Insert/update collection info
    conn.execute(
        "INSERT OR REPLACE INTO collection_info VALUES (?, ?, ?, ?)",
        (collection_id, label, datetime.now(timezone.utc).strftime("%Y-%m-%d"), 0),
    )

    matched = len(rows)
    print(f"  Loaded {matched:,} notation counts for '{collection_id}'")


# ─── Helpers ─────────────────────────────────────────────────────────

def get_iconclass_commit(data_dir: str) -> str:
    """Get git commit hash of the iconclass data repo."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=data_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


# ─── CLI ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Build iconclass.db from CC0 data dump (1.3M notations)"
    )
    parser.add_argument(
        "--data-dir", default="/tmp/iconclass-data",
        help="Path to iconclass/data clone (default: /tmp/iconclass-data)",
    )
    parser.add_argument(
        "--output", default="data/iconclass.db",
        help="Output path for iconclass.db",
    )
    parser.add_argument(
        "--counts-csv", action="append", default=[],
        help="Collection count CSV file (notation,count). Can be specified multiple times.",
    )
    args = parser.parse_args()

    # Verify data dir exists
    all_notations = os.path.join(args.data_dir, "all_notations.gz")
    if not os.path.exists(all_notations):
        print(f"Error: {all_notations} not found. Clone https://github.com/iconclass/data first.", file=sys.stderr)
        sys.exit(1)

    # Verify iconclass library is installed
    try:
        import iconclass
    except ImportError:
        print("Error: 'iconclass' library not installed. Run: pip install iconclass", file=sys.stderr)
        sys.exit(1)

    build(args.data_dir, args.output, args.counts_csv)
