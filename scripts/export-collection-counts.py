#!/usr/bin/env python3
"""
Export Rijksmuseum per-notation artwork counts from vocabulary.db to CSV.

Usage:
    python scripts/export-collection-counts.py [--vocab-db path/to/vocabulary.db] [--output data/rijksmuseum-counts.csv]

Output CSV format:
    notation,count
    73D82,147
    25F23,89
    ...
"""

import argparse
import csv
import os
import sqlite3
import sys


def export_counts(vocab_db_path: str, output_path: str):
    if not os.path.exists(vocab_db_path):
        print(f"Error: vocabulary.db not found at {vocab_db_path}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(f"file:{vocab_db_path}?mode=ro", uri=True)

    # Detect schema
    cols = {row[1] for row in conn.execute("PRAGMA table_info(mappings)").fetchall()}
    has_int = "field_id" in cols

    if has_int:
        fid_row = conn.execute("SELECT id FROM field_lookup WHERE name = 'subject'").fetchone()
        subject_fid = fid_row[0] if fid_row else -1
        rows = conn.execute("""
            SELECT v.notation, COUNT(DISTINCT m.artwork_id) as cnt
            FROM mappings m
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            WHERE m.field_id = ? AND v.notation IS NOT NULL AND v.notation != ''
            GROUP BY v.notation
            ORDER BY cnt DESC
        """, (subject_fid,)).fetchall()
    else:
        rows = conn.execute("""
            SELECT v.notation, COUNT(DISTINCT m.object_number) as cnt
            FROM mappings m
            JOIN vocabulary v ON m.vocab_id = v.id
            WHERE m.field = 'subject' AND v.notation IS NOT NULL AND v.notation != ''
            GROUP BY v.notation
            ORDER BY cnt DESC
        """).fetchall()

    conn.close()

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "count"])
        for notation, count in rows:
            writer.writerow([notation, count])

    total_links = sum(c for _, c in rows)
    print(f"Exported {len(rows)} notation counts ({total_links:,} artwork-notation links) to {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export Rijksmuseum artwork counts per Iconclass notation")
    parser.add_argument("--vocab-db", default="../rijksmuseum-mcp-plus/data/vocabulary.db",
                        help="Path to vocabulary.db")
    parser.add_argument("--output", default="data/rijksmuseum-counts.csv",
                        help="Output CSV path")
    args = parser.parse_args()

    export_counts(args.vocab_db, args.output)
