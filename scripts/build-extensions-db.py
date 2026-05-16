#!/usr/bin/env python3
"""Build iconclass-extensions.db — sidecar of non-CC0 Iconclass extensions.

Consumes per-source CSVs produced by the offline harvest scripts:
  - offline/data/pharos-extensions.csv       (pharos-midas + pharos-rkd)
  - offline/data/rkd-extensions.csv          (rkd-direct)
  - offline/data/rijksmuseum-extensions.csv  (rijksmuseum; carries inline context_text)
  - offline/data/hertziana-context.csv       (optional join: notation → DE/IT/EN context)

Emits data/iconclass-extensions.db with tables:
  - extensions(notation, source_id, parent_template, syntax_family, bracket_text,
               context_text, work_count, link_url)
  - extensions_fts(bracket_text, context_text)  — FTS5 with unicode61 + diacritics
  - extension_sources(source_id, label, base_url, license, harvested_at, total_extensions)
  - version_info(key, value)

Usage:
    python scripts/build-extensions-db.py --release-tag extensions-latest
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sqlite3
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# Hertziana context_text can exceed Python's default 128 KB CSV field limit
# (max observed: ~1.4 MB for popular notations like 11D Christ). Bump to 16 MB.
csv.field_size_limit(16 * 1024 * 1024)

ROOT = Path(__file__).resolve().parent.parent

SOURCE_META: dict[str, dict[str, str | None]] = {
    "pharos-midas": {
        "label": "PHAROS / MIDAS via ArtResearch (Hertziana + Marburg merged)",
        "base_url": "https://artresearch.net/sparql",
        "license": "CC BY-SA-NC 4.0",
    },
    "pharos-rkd": {
        "label": "PHAROS / RKD slice via ArtResearch",
        "base_url": "https://artresearch.net/sparql",
        "license": "CC BY-SA-NC 4.0",
    },
    "rkd-direct": {
        "label": "RKD (research.rkd.nl SPARQL)",
        "base_url": "https://data.rkd.nl/sparql",
        "license": "CC BY",
    },
    "rijksmuseum": {
        "label": "Rijksmuseum (vocabulary.db join, type='classification')",
        "base_url": "https://www.rijksmuseum.nl/en/collection",
        "license": "CC0-1.0",
    },
}


def link_url_for(source_id: str, notation: str) -> str | None:
    """Pre-compute per-source link URL for a notation at build time."""
    if source_id in ("pharos-midas", "pharos-rkd"):
        # Double-encode: notation → percent-encoded notation → percent-encoded full IRI
        # so the SPA decodes back to the stored IRI form (which already has %28/%29 etc.)
        iri = "http://iconclass.org/" + urllib.parse.quote(notation, safe="")
        return "https://artresearch.net/resource/?uri=" + urllib.parse.quote(iri, safe="")
    if source_id == "rkd-direct":
        return (
            "https://research.rkd.nl/en/search?q="
            + urllib.parse.quote(notation, safe="")
            + "&filters[0][field]=db&filters[0][values][0]=rkdimages"
        )
    # rijksmuseum: NULL — caller should chain to rijksmuseum-mcp-plus search_artwork(iconclass=...)
    return None


def load_six_col_csv(path: Path) -> list[dict[str, str]]:
    """Load a CSV with the standard 6-column extension shape (no context_text)."""
    rows: list[dict[str, str]] = []
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    return rows


def load_seven_col_csv(path: Path) -> list[dict[str, str]]:
    """Load a CSV with extension shape + inline context_text (Rijksmuseum)."""
    return load_six_col_csv(path)  # DictReader handles either column set


def load_hertziana_context(path: Path) -> dict[str, str]:
    """Load notation → context_text dict from the Hertziana harvest output."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            n = (r.get("notation") or "").strip()
            ctx = (r.get("context_text") or "").strip()
            if n and ctx:
                out[n] = ctx
    return out


def build(
    output_path: Path,
    pharos_csv: Path,
    rkd_csv: Path,
    rijksmuseum_csv: Path,
    hertziana_ctx_csv: Path | None,
    release_tag: str,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    conn = sqlite3.connect(str(output_path))
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = OFF")

    conn.execute(
        """
        CREATE TABLE extensions (
            notation         TEXT NOT NULL,
            source_id        TEXT NOT NULL,
            parent_template  TEXT,
            syntax_family    TEXT NOT NULL,
            bracket_text     TEXT,
            context_text     TEXT,
            work_count       INTEGER NOT NULL DEFAULT 0,
            link_url         TEXT,
            PRIMARY KEY (notation, source_id)
        )
        """
    )
    conn.execute("CREATE INDEX idx_extensions_notation ON extensions(notation)")
    conn.execute("CREATE INDEX idx_extensions_parent ON extensions(parent_template)")

    conn.execute(
        """
        CREATE VIRTUAL TABLE extensions_fts USING fts5(
            bracket_text,
            context_text,
            content='extensions',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE extension_sources (
            source_id          TEXT PRIMARY KEY,
            label              TEXT NOT NULL,
            base_url           TEXT,
            license            TEXT NOT NULL,
            harvested_at       TEXT NOT NULL,
            total_extensions   INTEGER NOT NULL
        )
        """
    )

    conn.execute("CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT)")

    # Load Hertziana context join (notation → context_text)
    hertziana_ctx = (
        load_hertziana_context(hertziana_ctx_csv) if hertziana_ctx_csv else {}
    )
    print(
        f"  Hertziana context: {len(hertziana_ctx):,} notations with DE/IT/EN text",
        file=sys.stderr,
    )

    # Aggregate rows from all sources
    all_rows: list[tuple[str, str, str | None, str, str | None, str | None, int, str | None]] = []
    per_source_counts: dict[str, int] = {}

    # PHAROS (6-col + optional Hertziana context for pharos-midas rows)
    if pharos_csv.exists():
        for r in load_six_col_csv(pharos_csv):
            notation = (r["notation"] or "").strip()
            source_id = (r["source_id"] or "").strip()
            if not notation or not source_id:
                continue
            parent = (r.get("parent_template") or "").strip() or None
            shape = (r.get("syntax_family") or "").strip()
            bracket = (r.get("bracket_text") or "").strip() or None
            try:
                count = int((r.get("work_count") or "0").strip())
            except ValueError:
                count = 0
            ctx = hertziana_ctx.get(notation) if source_id == "pharos-midas" else None
            link = link_url_for(source_id, notation)
            all_rows.append((notation, source_id, parent, shape, bracket, ctx, count, link))
            per_source_counts[source_id] = per_source_counts.get(source_id, 0) + 1

    # RKD-direct (6-col)
    if rkd_csv.exists():
        for r in load_six_col_csv(rkd_csv):
            notation = (r["notation"] or "").strip()
            source_id = (r["source_id"] or "").strip()
            if not notation or not source_id:
                continue
            parent = (r.get("parent_template") or "").strip() or None
            shape = (r.get("syntax_family") or "").strip()
            bracket = (r.get("bracket_text") or "").strip() or None
            try:
                count = int((r.get("work_count") or "0").strip())
            except ValueError:
                count = 0
            link = link_url_for(source_id, notation)
            all_rows.append((notation, source_id, parent, shape, bracket, None, count, link))
            per_source_counts[source_id] = per_source_counts.get(source_id, 0) + 1

    # Rijksmuseum (7-col with inline context_text)
    if rijksmuseum_csv.exists():
        for r in load_seven_col_csv(rijksmuseum_csv):
            notation = (r["notation"] or "").strip()
            source_id = (r["source_id"] or "").strip()
            if not notation or not source_id:
                continue
            parent = (r.get("parent_template") or "").strip() or None
            shape = (r.get("syntax_family") or "").strip()
            bracket = (r.get("bracket_text") or "").strip() or None
            ctx = (r.get("context_text") or "").strip() or None
            try:
                count = int((r.get("work_count") or "0").strip())
            except ValueError:
                count = 0
            link = link_url_for(source_id, notation)
            all_rows.append((notation, source_id, parent, shape, bracket, ctx, count, link))
            per_source_counts[source_id] = per_source_counts.get(source_id, 0) + 1

    # Bulk insert (dedupe enforced by PRIMARY KEY; later rows for same (notation, source_id) replace)
    conn.executemany(
        "INSERT OR REPLACE INTO extensions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        all_rows,
    )

    # Populate FTS5 from the content table
    conn.execute("INSERT INTO extensions_fts(extensions_fts) VALUES('rebuild')")

    # Source metadata (only registered sources that have rows)
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for source_id, meta in SOURCE_META.items():
        total = per_source_counts.get(source_id, 0)
        if total == 0:
            continue
        conn.execute(
            "INSERT INTO extension_sources VALUES (?, ?, ?, ?, ?, ?)",
            (
                source_id,
                meta["label"],
                meta["base_url"],
                meta["license"],
                now_iso,
                total,
            ),
        )

    # version_info
    built_at = datetime.now(timezone.utc).isoformat()
    license_summary = (
        "Mixed; PHAROS/Hertziana context is CC BY-SA-NC 4.0, "
        "other sources CC0 / CC BY — see extension_sources.license"
    )
    conn.executemany(
        "INSERT INTO version_info VALUES (?, ?)",
        [
            ("schema_version", "1"),
            ("release_tag", release_tag),
            ("built_at", built_at),
            ("total_extensions", str(len(all_rows))),
            ("license_summary", license_summary),
            ("hertziana_context_notations", str(len(hertziana_ctx))),
        ],
    )
    conn.commit()

    conn.execute("VACUUM")
    conn.close()

    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"\nDone! {output_path.relative_to(ROOT)} ({size_mb:.1f} MB)")
    print(f"  Total extension rows: {len(all_rows):,}")
    for source_id, n in per_source_counts.items():
        print(f"    {source_id:<16} {n:>8,}")
    if size_mb > 150:
        print(f"\n  WARNING: DB > 150 MB. Revisit context_text safety-cap decision.", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build iconclass-extensions.db sidecar")
    parser.add_argument("--output", default=str(ROOT / "data" / "iconclass-extensions.db"))
    parser.add_argument("--pharos-csv", default=str(ROOT / "offline" / "data" / "pharos-extensions.csv"))
    parser.add_argument("--rkd-csv", default=str(ROOT / "offline" / "data" / "rkd-extensions.csv"))
    parser.add_argument(
        "--rijksmuseum-csv",
        default=str(ROOT / "offline" / "data" / "rijksmuseum-extensions.csv"),
    )
    parser.add_argument(
        "--hertziana-context-csv",
        default=str(ROOT / "offline" / "data" / "hertziana-context.csv"),
    )
    pkg_path = ROOT / "package.json"
    default_tag = "extensions-latest"
    if pkg_path.exists():
        with pkg_path.open() as f:
            default_tag = f"v{json.load(f).get('version', 'dev')}"
    parser.add_argument("--release-tag", default="extensions-latest",
                        help="Release tag for version_info (default: extensions-latest, rolling)")
    args = parser.parse_args()

    build(
        Path(args.output),
        Path(args.pharos_csv),
        Path(args.rkd_csv),
        Path(args.rijksmuseum_csv),
        Path(args.hertziana_context_csv) if os.path.exists(args.hertziana_context_csv) else None,
        args.release_tag,
    )
