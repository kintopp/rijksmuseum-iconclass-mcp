#!/usr/bin/env python3
"""
Harvest artwork counts per Iconclass notation from the Städel Museum (Frankfurt).

Fetches LIDO records via OAI-PMH from sammlung.staedelmuseum.de, extracts
Iconclass notations from <lido:conceptID> elements pointing to iconclass.org,
and exports notation,count as CSV.

The endpoint returns ~32K records (many deleted/tombstones) with 100 per page.
Only non-deleted records with Iconclass annotations are counted.

Usage:
    python scripts/harvest-staedel-counts.py [--output data/staedel-counts.csv]

Source:
    OAI-PMH endpoint: https://sammlung.staedelmuseum.de/api/oai
    Metadata prefix:  lido
    License:          CC0 (metadata)
    Iconclass in:     lido:subjectConcept > lido:conceptID → http://iconclass.org/{notation}
"""

import argparse
import csv
import os
import re
import sys
import time
from collections import Counter
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

OAI_ENDPOINT = "https://sammlung.staedelmuseum.de/api/oai"
METADATA_PREFIX = "lido"
ICONCLASS_RE = re.compile(r"http://iconclass\.org/([^<\"]+)")
MAX_RETRIES = 5
RETRY_DELAY = 10  # seconds (base delay, doubles on 429)
REQUEST_DELAY = 1.0  # seconds between pages to avoid rate-limiting


def oai_request(url: str, timeout: int = 120) -> str:
    """Fetch an OAI-PMH URL with retries and exponential backoff on 429."""
    req = Request(url, headers={"Accept": "application/xml"})
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except HTTPError as e:
            if e.code == 429:
                # Exponential backoff for rate limiting
                delay = RETRY_DELAY * (2 ** (attempt - 1))
                print(f"\n  Rate limited (429), backing off {delay}s (attempt {attempt}/{MAX_RETRIES})...")
                time.sleep(delay)
            elif attempt < MAX_RETRIES:
                print(f"  Attempt {attempt} failed ({e}), retrying in {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
            else:
                raise
        except (URLError, TimeoutError) as e:
            if attempt < MAX_RETRIES:
                print(f"  Attempt {attempt} failed ({e}), retrying in {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
            else:
                raise


def harvest_counts() -> tuple[Counter, int]:
    """
    Paginate through all LIDO records via OAI-PMH.
    Returns (notation_counter, total_records_with_iconclass).
    """
    counts: Counter = Counter()
    records_with_ic = 0
    total_records = 0
    page = 1
    resumption_token = None

    while True:
        if resumption_token:
            url = f"{OAI_ENDPOINT}?verb=ListRecords&resumptionToken={quote(resumption_token)}"
        else:
            url = f"{OAI_ENDPOINT}?verb=ListRecords&metadataPrefix={METADATA_PREFIX}"

        print(f"  Page {page}: fetching...", end=" ", flush=True)
        t0 = time.time()
        xml = oai_request(url)
        elapsed = time.time() - t0

        # Count records on this page (skip deleted)
        records_on_page = len(re.findall(r"<record>", xml))
        deleted_on_page = len(re.findall(r'status="deleted"', xml))
        active_on_page = records_on_page - deleted_on_page
        total_records += active_on_page

        # Extract Iconclass notations from non-deleted record content
        # Split by <record> to process individually (so deleted records are skipped)
        record_chunks = xml.split("<record>")[1:]  # skip preamble
        page_ic = 0
        for chunk in record_chunks:
            if 'status="deleted"' in chunk.split("</header>")[0]:
                continue
            notations = ICONCLASS_RE.findall(chunk)
            if notations:
                page_ic += 1
                # Deduplicate within a single record (same notation listed twice = 1 artwork)
                for notation in set(unquote(n) for n in notations):
                    counts[notation] += 1

        records_with_ic += page_ic
        print(
            f"{active_on_page} active records, {page_ic} with Iconclass ({elapsed:.1f}s)"
        )

        # Check for resumptionToken
        token_match = re.search(
            r"<resumptionToken[^>]*>(.*?)</resumptionToken>", xml
        )
        if token_match and token_match.group(1).strip():
            resumption_token = token_match.group(1).strip()
            page += 1
            time.sleep(REQUEST_DELAY)  # throttle to avoid 429
        else:
            break

    return counts, records_with_ic


def export_csv(counts: Counter, output_path: str):
    """Write notation,count CSV sorted by count descending."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "count"])
        for notation, count in counts.most_common():
            writer.writerow([notation, count])


def main():
    parser = argparse.ArgumentParser(
        description="Harvest artwork counts per Iconclass notation from the Städel Museum"
    )
    parser.add_argument(
        "--output",
        default="data/staedel-counts.csv",
        help="Output CSV path (default: data/staedel-counts.csv)",
    )
    args = parser.parse_args()

    print("Harvesting Iconclass counts from Städel Museum...")
    print(f"  Endpoint: {OAI_ENDPOINT}")
    print(f"  Format:   {METADATA_PREFIX}")
    print()

    t0 = time.time()
    counts, records_with_ic = harvest_counts()
    elapsed = time.time() - t0

    if not counts:
        print("Error: no Iconclass notations found", file=sys.stderr)
        sys.exit(1)

    export_csv(counts, args.output)

    total_annotations = sum(counts.values())
    print()
    print(f"Done in {elapsed:.1f}s")
    print(f"  Records with Iconclass: {records_with_ic:,}")
    print(f"  Distinct notations:     {len(counts):,}")
    print(f"  Total annotations:      {total_annotations:,}")
    print(f"  Top 10:")
    for notation, count in counts.most_common(10):
        print(f"    {notation:30s} {count:>6,}")
    print(f"  Output: {args.output}")


if __name__ == "__main__":
    main()
