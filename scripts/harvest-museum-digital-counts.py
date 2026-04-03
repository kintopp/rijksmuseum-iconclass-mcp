#!/usr/bin/env python3
"""
Harvest artwork counts per Iconclass notation from museum-digital (global).

Fetches LIDO records via OAI-PMH from global.museum-digital.org, extracts
Iconclass notations from <lido:conceptID lido:source="iconclass"> elements,
and exports notation,count as CSV.

The endpoint has ~1.25M records at 40 per page (~31K pages). Approximately
57% of records carry Iconclass annotations. A full harvest takes ~4 hours.

The script is **resumable**: progress is checkpointed to a state file every
100 pages. If interrupted, re-run with the same arguments to continue from
the last checkpoint.

Usage:
    python scripts/harvest-museum-digital-counts.py
    python scripts/harvest-museum-digital-counts.py --output data/museum-digital-counts.csv
    python scripts/harvest-museum-digital-counts.py --fresh   # ignore checkpoint, start over

Source:
    OAI-PMH endpoint: https://global.museum-digital.org/oai/
    Metadata prefix:  lido
    License:          CC BY-NC-SA (varies per institution)
    Iconclass in:     lido:conceptID lido:source="iconclass" → http://iconclass.org/rkd/{notation}
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from collections import Counter
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

OAI_ENDPOINT = "https://global.museum-digital.org/oai/"
METADATA_PREFIX = "lido"

# museum-digital uses http://iconclass.org/rkd/{notation} — strip the /rkd/ prefix
ICONCLASS_RE = re.compile(r"http://iconclass\.org/(?:rkd/)?([^<\"]+)")
# md:term URI contains the internal tag_id for building browse URLs.
# Only md-de tags resolve on global.museum-digital.org (~96% of iconclass tags).
MD_TERM_RE = re.compile(r"https://term\.museum-digital\.de/md-de/tag/(\d+)")

MAX_RETRIES = 5
RETRY_DELAY = 10  # seconds (base delay, doubles on 429)
REQUEST_DELAY = 0.1  # seconds between pages (tested: no 429s even at 0s)
CHECKPOINT_INTERVAL = 100  # save state every N pages
CSV_SAVE_INTERVAL = 500  # write CSV every N pages

STATE_FILE = "data/.museum-digital-harvest-state.json"


def oai_request(url: str, timeout: int = 120) -> str:
    """Fetch an OAI-PMH URL with retries and exponential backoff."""
    req = Request(url, headers={"Accept": "application/xml"})
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except HTTPError as e:
            delay = RETRY_DELAY * (2 ** (attempt - 1)) if e.code == 429 else RETRY_DELAY
            label = "Rate limited (429)" if e.code == 429 else f"HTTP {e.code}"
            if attempt < MAX_RETRIES:
                print(f"\n  {label}, backing off {delay}s (attempt {attempt}/{MAX_RETRIES})...", flush=True)
                time.sleep(delay)
            else:
                raise
        except (URLError, TimeoutError) as e:
            if attempt < MAX_RETRIES:
                print(f"\n  Attempt {attempt} failed ({e}), retrying in {RETRY_DELAY}s...", flush=True)
                time.sleep(RETRY_DELAY)
            else:
                raise


def extract_notation_tag_pairs(chunk: str) -> list[tuple[str, str | None]]:
    """
    Extract (notation, tag_id) pairs from a single LIDO record chunk.

    Each <lido:subjectConcept> block may contain both an iconclass conceptID
    and an md:term conceptID. We pair them so we can build browse URLs.
    Returns deduplicated (notation, tag_id) tuples; tag_id may be None.
    """
    SUBJECT_RE = re.compile(
        r"<lido:subjectConcept>(.*?)</lido:subjectConcept>", re.DOTALL
    )
    pairs: list[tuple[str, str | None]] = []
    for block in SUBJECT_RE.findall(chunk):
        notations = ICONCLASS_RE.findall(block)
        tag_ids = MD_TERM_RE.findall(block)
        tag_id = tag_ids[0] if tag_ids else None
        for raw in notations:
            pairs.append((unquote(raw), tag_id))
    return pairs


def save_state(state_path: str, page: int, token: str | None, counts: Counter,
               tag_map: dict, records_with_ic: int, total_records: int):
    """Checkpoint harvest state to disk."""
    os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "page": page,
            "resumption_token": token,
            "counts": dict(counts),
            "tag_map": tag_map,
            "records_with_ic": records_with_ic,
            "total_records": total_records,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, f)
    os.replace(tmp, state_path)


def load_state(state_path: str) -> dict | None:
    """Load checkpoint if it exists."""
    if not os.path.exists(state_path):
        return None
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
        return state
    except (json.JSONDecodeError, KeyError):
        return None


def export_csv(counts: Counter, output_path: str):
    """Write notation,count CSV sorted by count descending."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    tmp = output_path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "count"])
        for notation, count in counts.most_common():
            writer.writerow([notation, count])
    os.replace(tmp, output_path)


def export_tag_map(tag_map: dict, output_path: str):
    """Write notation→tag_id mapping as CSV for building browse URLs."""
    map_path = output_path.replace("-counts.csv", "-tag-map.csv")
    os.makedirs(os.path.dirname(map_path) or ".", exist_ok=True)
    tmp = map_path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "tag_id", "browse_url"])
        for notation in sorted(tag_map):
            tag_id = tag_map[notation]
            url = f"https://global.museum-digital.org/objects?tag_id={tag_id}"
            writer.writerow([notation, tag_id, url])
    os.replace(tmp, map_path)
    return map_path


def harvest_counts(output_path: str, state_path: str, fresh: bool) -> tuple[Counter, dict, int]:
    """
    Paginate through all LIDO records via OAI-PMH.
    Resumable: loads checkpoint from state_path if available.
    Returns (notation_counter, notation_to_tag_id_map, total_records_with_iconclass).
    """
    counts: Counter = Counter()
    tag_map: dict[str, str] = {}  # notation → tag_id (first seen wins)
    records_with_ic = 0
    total_records = 0
    page = 1
    resumption_token = None
    complete_list_size = None

    # Resume from checkpoint?
    if not fresh:
        state = load_state(state_path)
        if state:
            page = state["page"]
            resumption_token = state["resumption_token"]
            counts = Counter(state["counts"])
            tag_map = state.get("tag_map", {})
            records_with_ic = state["records_with_ic"]
            total_records = state["total_records"]
            print(f"  Resuming from checkpoint: page {page}, "
                  f"{records_with_ic:,} IC records, {len(counts):,} notations, "
                  f"{len(tag_map):,} tag mappings "
                  f"(saved {state.get('saved_at', '?')})")
            print()

    while True:
        if resumption_token:
            url = f"{OAI_ENDPOINT}?verb=ListRecords&resumptionToken={quote(resumption_token)}"
        else:
            url = f"{OAI_ENDPOINT}?verb=ListRecords&metadataPrefix={METADATA_PREFIX}"

        # Progress display
        if complete_list_size:
            est_page_total = (complete_list_size + 39) // 40
            pct = 100 * page / est_page_total
            print(f"  Page {page}/{est_page_total} ({pct:.1f}%): fetching...", end=" ", flush=True)
        else:
            print(f"  Page {page}: fetching...", end=" ", flush=True)

        t0 = time.time()
        xml = oai_request(url)
        elapsed = time.time() - t0

        # Extract completeListSize on first page
        if complete_list_size is None:
            size_match = re.search(r'completeListSize="(\d+)"', xml)
            if size_match:
                complete_list_size = int(size_match.group(1))

        # Process records (museum-digital has no deleted records per their Identify response)
        record_chunks = xml.split("<record>")[1:]
        page_ic = 0
        for chunk in record_chunks:
            # Skip deleted just in case
            if 'status="deleted"' in chunk.split("</header>")[0]:
                continue
            total_records += 1
            pairs = extract_notation_tag_pairs(chunk)
            if pairs:
                page_ic += 1
                seen: set[str] = set()
                for notation, tid in pairs:
                    if notation not in seen:
                        seen.add(notation)
                        counts[notation] += 1
                    if tid and notation not in tag_map:
                        tag_map[notation] = tid

        records_with_ic += page_ic
        print(f"{len(record_chunks)} records, {page_ic} IC ({elapsed:.1f}s)")

        # Checkpoint
        if page % CHECKPOINT_INTERVAL == 0:
            # Get next token before saving so we can resume from the right spot
            token_match = re.search(
                r"<resumptionToken[^>]*>(.*?)</resumptionToken>", xml
            )
            next_token = token_match.group(1).strip() if token_match and token_match.group(1).strip() else None
            save_state(state_path, page + 1, next_token, counts, tag_map, records_with_ic, total_records)
            print(f"  [checkpoint saved: {len(counts):,} notations, {len(tag_map):,} tag mappings]")

        # Periodic CSV save
        if page % CSV_SAVE_INTERVAL == 0:
            export_csv(counts, output_path)
            print(f"  [CSV saved: {output_path}]")

        # Check for resumptionToken
        token_match = re.search(
            r"<resumptionToken[^>]*>(.*?)</resumptionToken>", xml
        )
        if token_match and token_match.group(1).strip():
            resumption_token = token_match.group(1).strip()
            page += 1
            time.sleep(REQUEST_DELAY)
        else:
            break

    # Clean up state file on successful completion
    if os.path.exists(state_path):
        os.remove(state_path)

    return counts, tag_map, records_with_ic

def main():
    parser = argparse.ArgumentParser(
        description="Harvest artwork counts per Iconclass notation from museum-digital"
    )
    parser.add_argument(
        "--output",
        default="data/museum-digital-counts.csv",
        help="Output CSV path (default: data/museum-digital-counts.csv)",
    )
    parser.add_argument(
        "--state",
        default=STATE_FILE,
        help=f"State file for resumable harvesting (default: {STATE_FILE})",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Ignore checkpoint and start fresh",
    )
    args = parser.parse_args()

    print("Harvesting Iconclass counts from museum-digital (global)...")
    print(f"  Endpoint: {OAI_ENDPOINT}")
    print(f"  Format:   {METADATA_PREFIX}")
    print(f"  Output:   {args.output}")
    print(f"  State:    {args.state}")
    print()

    t0 = time.time()
    counts, tag_map, records_with_ic = harvest_counts(args.output, args.state, args.fresh)
    elapsed = time.time() - t0

    if not counts:
        print("Error: no Iconclass notations found", file=sys.stderr)
        sys.exit(1)

    export_csv(counts, args.output)
    map_path = export_tag_map(tag_map, args.output)

    total_annotations = sum(counts.values())
    hours = elapsed / 3600
    print()
    print(f"Done in {hours:.1f}h ({elapsed:.0f}s)")
    print(f"  Records with Iconclass: {records_with_ic:,}")
    print(f"  Distinct notations:     {len(counts):,}")
    print(f"  Total annotations:      {total_annotations:,}")
    print(f"  Tag mappings:           {len(tag_map):,}")
    print(f"  Top 10:")
    for notation, count in counts.most_common(10):
        tid = tag_map.get(notation, "?")
        print(f"    {notation:30s} {count:>6,}  (tag_id={tid})")
    print(f"  Counts CSV:  {args.output}")
    print(f"  Tag map CSV: {map_path}")


if __name__ == "__main__":
    main()
