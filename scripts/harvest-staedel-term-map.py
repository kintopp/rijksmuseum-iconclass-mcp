#!/usr/bin/env python3
"""
Build a notation → term_id mapping for the Städel Museum by crawling artwork pages.

The Städel's collection search uses internal term IDs for filtering:
    https://sammlung.staedelmuseum.de/en/search?flags=allScopes&f=iconclass%3Aterm%28{term_id}%29

These IDs are only exposed in server-rendered artwork detail pages as <a> links
in the Iconclass section. This script crawls artwork pages to extract the mapping.

Requires staedel-counts.csv to exist (run harvest-staedel-counts.py first).

Usage:
    python scripts/harvest-staedel-term-map.py
    python scripts/harvest-staedel-term-map.py --output data/staedel-term-map.csv

Output CSV: notation,term_id,browse_url
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

SEARCH_API = "https://sammlung.staedelmuseum.de/api/search"
WORK_BASE = "https://sammlung.staedelmuseum.de/en/work"
BROWSE_TEMPLATE = "https://sammlung.staedelmuseum.de/en/search?flags=allScopes&f=iconclass%3Aterm%28{}%29"

TERM_RE = re.compile(r'f=iconclass%3Aterm%28(\d+)%29"[^>]*>([^<]+)</a>')

MAX_RETRIES = 3
RETRY_DELAY = 5
REQUEST_DELAY = 0.3  # between artwork page fetches
STATE_FILE = "data/.staedel-term-map-state.json"


def fetch(url: str, timeout: int = 30) -> str:
    """Fetch URL with retries."""
    req = Request(url, headers={"Accept": "text/html,application/json"})
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (URLError, HTTPError, TimeoutError) as e:
            if attempt < MAX_RETRIES:
                delay = RETRY_DELAY * (2 ** (attempt - 1)) if isinstance(e, HTTPError) and e.code == 429 else RETRY_DELAY
                print(f"\n  Retry {attempt}/{MAX_RETRIES} ({e}), waiting {delay}s...", flush=True)
                time.sleep(delay)
            else:
                raise


def load_target_notations(counts_csv: str) -> set[str]:
    """Load the set of notations we need term_ids for."""
    notations = set()
    with open(counts_csv, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if i == 0 and not row[1].isdigit():
                continue
            notations.add(row[0].strip())
    return notations


def save_state(term_map: dict, pages_done: int, offset: int):
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"term_map": term_map, "pages_done": pages_done, "offset": offset,
                    "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f)
    os.replace(tmp, STATE_FILE)


def load_state() -> dict | None:
    if not os.path.exists(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, KeyError):
        return None


def export_term_map(term_map: dict, output_path: str):
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    tmp = output_path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "term_id", "browse_url"])
        for notation in sorted(term_map):
            tid = term_map[notation]
            writer.writerow([notation, tid, BROWSE_TEMPLATE.format(tid)])
    os.replace(tmp, output_path)


def main():
    parser = argparse.ArgumentParser(
        description="Build Städel notation → term_id mapping by crawling artwork pages"
    )
    parser.add_argument("--output", default="data/staedel-term-map.csv")
    parser.add_argument("--counts-csv", default="data/staedel-counts.csv",
                        help="Input counts CSV (for list of notations to map)")
    parser.add_argument("--fresh", action="store_true", help="Ignore checkpoint")
    args = parser.parse_args()

    if not os.path.exists(args.counts_csv):
        print(f"Error: {args.counts_csv} not found. Run harvest-staedel-counts.py first.", file=sys.stderr)
        sys.exit(1)

    target_notations = load_target_notations(args.counts_csv)
    print(f"Target: {len(target_notations):,} notations to map")

    # Resume or start fresh
    term_map: dict[str, str] = {}
    offset = 0
    pages_done = 0
    if not args.fresh:
        state = load_state()
        if state:
            term_map = state["term_map"]
            offset = state["offset"]
            pages_done = state["pages_done"]
            covered = len(set(term_map) & target_notations)
            print(f"Resuming: {covered:,}/{len(target_notations):,} mapped, offset={offset}")

    remaining = target_notations - set(term_map)
    print(f"Remaining: {len(remaining):,} notations\n")

    page_size = 130  # max the API returns
    artworks_fetched = 0
    t0 = time.time()

    while remaining:
        # Get a batch of artwork URLs from the search API
        api_url = f"{SEARCH_API}?flags=allScopes&limit={page_size}&offset={offset}"
        try:
            data = fetch(api_url)
            docs = json.loads(data).get("documents", [])
        except Exception as e:
            print(f"\n  Search API error at offset {offset}: {e}")
            break

        if not docs:
            print(f"  No more artworks at offset {offset}")
            break

        for doc in docs:
            slug = doc["url"].split("/work/")[-1]
            work_url = f"{WORK_BASE}/{slug}"

            try:
                html = fetch(work_url)
            except Exception as e:
                print(f"  Skip {slug}: {e}")
                continue

            pairs = TERM_RE.findall(html)
            new = 0
            for tid, notation in pairs:
                if notation in remaining:
                    term_map[notation] = tid
                    remaining.discard(notation)
                    new += 1
                elif notation not in term_map:
                    term_map[notation] = tid

            artworks_fetched += 1
            if new > 0 or artworks_fetched % 50 == 0:
                covered = len(target_notations) - len(remaining)
                pct = 100 * covered / len(target_notations)
                elapsed = time.time() - t0
                print(f"  [{artworks_fetched:>5} artworks, {covered:,}/{len(target_notations):,} mapped ({pct:.1f}%), "
                      f"+{new} new, {elapsed:.0f}s]", flush=True)

            time.sleep(REQUEST_DELAY)

            if not remaining:
                break

        offset += page_size
        pages_done += 1

        # Checkpoint every 5 search pages (650 artworks)
        if pages_done % 5 == 0:
            save_state(term_map, pages_done, offset)
            export_term_map(term_map, args.output)
            print(f"  [checkpoint + CSV saved]")

    # Final save
    export_term_map(term_map, args.output)
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    elapsed = time.time() - t0
    covered = len(set(term_map) & target_notations)
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  Artworks crawled:  {artworks_fetched:,}")
    print(f"  Notations mapped:  {covered:,}/{len(target_notations):,} ({100*covered/len(target_notations):.1f}%)")
    print(f"  Total term_ids:    {len(term_map):,}")
    print(f"  Output: {args.output}")

    if remaining:
        print(f"\n  Unmapped notations ({len(remaining):,}):")
        for n in sorted(remaining)[:20]:
            print(f"    {n}")
        if len(remaining) > 20:
            print(f"    ... and {len(remaining)-20} more")


if __name__ == "__main__":
    main()
