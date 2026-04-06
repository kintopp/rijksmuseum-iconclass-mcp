#!/usr/bin/env python3
"""
Build iconclass-counts.db — a sidecar database with per-collection artwork counts.

This DB is separate from the main iconclass.db so that collection counts can be
updated independently without rebuilding the 3+ GB notation/text/embedding data.

Usage:
    python scripts/build-counts-db.py --counts-csv data/rijksmuseum-counts.csv
    python scripts/build-counts-db.py --counts-csv data/rijksmuseum-counts.csv --counts-csv data/met-counts.csv

CSV format: notation,count (with optional header row)
Collection ID and label are derived from the filename (e.g. "rijksmuseum-counts.csv" → "rijksmuseum").
"""

import argparse
import csv
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone


COLLECTION_META: dict[str, tuple[str, str | None]] = {
    "rijksmuseum": ("Rijksmuseum, Amsterdam", None),
}


def build_counts_db(output_path: str, count_csvs: list[str], release_tag: str = "dev"):
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    if os.path.exists(output_path):
        os.remove(output_path)

    conn = sqlite3.connect(output_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = OFF")

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
            collection_id        TEXT PRIMARY KEY,
            label                TEXT NOT NULL,
            counts_as_of         TEXT,
            total_notations      INTEGER DEFAULT 0,
            search_url_template  TEXT
        )
    """)

    conn.execute("""
        CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT)
    """)

    total_collections = 0
    total_notation_counts = 0

    for csv_path in count_csvs:
        if not os.path.exists(csv_path):
            print(f"  Warning: {csv_path} not found — skipping")
            continue

        basename = os.path.basename(csv_path)
        collection_id = basename.replace("-counts.csv", "").replace("_counts.csv", "").replace(".csv", "")
        meta = COLLECTION_META.get(collection_id)
        label = meta[0] if meta else collection_id.replace("-", " ").replace("_", " ").title()
        url_template = meta[1] if meta else None

        print(f"  Loading counts for '{collection_id}' from {csv_path}...")

        rows: list[tuple[str, str, int]] = []
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            for i, row in enumerate(reader):
                if len(row) < 2:
                    continue
                notation, count_str = row[0].strip(), row[1].strip()
                if i == 0 and not count_str.isdigit():
                    continue
                try:
                    count = int(count_str)
                    if count > 0:
                        rows.append((collection_id, notation, count))
                except ValueError:
                    continue

        conn.executemany(
            "INSERT OR REPLACE INTO collection_counts VALUES (?, ?, ?)",
            rows,
        )
        # Raw CSV row count — the server recomputes at runtime via JOIN against notations
        # to exclude malformed entries (POINT() coords, colon-composites, etc.)
        total_notations = len(rows)
        conn.execute(
            "INSERT OR REPLACE INTO collection_info VALUES (?, ?, ?, ?, ?)",
            (collection_id, label, datetime.now(timezone.utc).strftime("%Y-%m-%d"), total_notations, url_template),
        )

        total_collections += 1
        total_notation_counts += len(rows)
        print(f"  Loaded {len(rows):,} notation counts for '{collection_id}'")

    # Queries filter by notation, not collection_id — add a notation-first index
    conn.execute("CREATE INDEX idx_counts_notation ON collection_counts(notation, collection_id)")

    built_at = datetime.now(timezone.utc).isoformat()
    conn.executemany("INSERT INTO version_info VALUES (?, ?)", [
        ("schema_version", "3"),
        ("release_tag", release_tag),
        ("built_at", built_at),
        ("collection_count", str(total_collections)),
        ("total_notation_counts", str(total_notation_counts)),
    ])
    conn.commit()

    conn.execute("VACUUM")
    conn.close()

    size_kb = os.path.getsize(output_path) / 1024
    print(f"\nDone! {output_path} ({size_kb:.0f} KB)")
    print(f"  Collections: {total_collections}")
    print(f"  Notation counts: {total_notation_counts:,}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Build iconclass-counts.db sidecar from collection count CSVs"
    )
    parser.add_argument(
        "--output", default="data/iconclass-counts.db",
        help="Output path for counts sidecar DB",
    )
    parser.add_argument(
        "--counts-csv", action="append", default=[], required=True,
        help="Collection count CSV file (notation,count). Can be specified multiple times.",
    )
    # Default release tag from package.json version
    pkg_path = os.path.join(os.path.dirname(__file__), "..", "package.json")
    default_tag = "dev"
    if os.path.exists(pkg_path):
        with open(pkg_path) as f:
            default_tag = json.load(f).get("version", "dev")

    parser.add_argument(
        "--release-tag", default=default_tag,
        help=f"Release tag to embed in version_info (default: from package.json, currently '{default_tag}')",
    )
    args = parser.parse_args()

    build_counts_db(args.output, args.counts_csv, args.release_tag)
