#!/usr/bin/env python3
"""
Harvest artwork counts per Iconclass notation from the RKD Knowledge Graph.

Queries the RKD SPARQL endpoint (TriplyDB / Virtuoso) for all artworks with
Iconclass annotations, groups by notation, and exports notation,count as CSV.

The endpoint caps sorted results at 10,000 rows, so we paginate without
ORDER BY and sort client-side.

Usage:
    python scripts/harvest-rkd-counts.py [--output data/rkd-counts.csv]

Source:
    SPARQL endpoint: https://api.rkd.triply.cc/datasets/rkd/RKD-Knowledge-Graph/services/SPARQL/sparql
    Named graph:     https://data.rkd.nl/images
    License:         Open Data Commons Attribution 1.0
    Data model:      artwork → P65_shows_visual_item → E36_Visual_Item → P2_has_type → http://iconclass.org/{notation}
"""

import argparse
import csv
import os
import sys
import time
from urllib.parse import unquote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import json

SPARQL_ENDPOINT = "https://api.rkd.triply.cc/datasets/rkd/RKD-Knowledge-Graph/services/SPARQL/sparql"
NAMED_GRAPH = "https://data.rkd.nl/images"
ICONCLASS_PREFIX = "http://iconclass.org/"
PAGE_SIZE = 10000  # Virtuoso caps at 10,000 rows per query
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds


QUERY_TEMPLATE = """\
SELECT ?ic (COUNT(DISTINCT ?artwork) as ?count)
FROM <{graph}>
WHERE {{
  ?artwork <http://www.cidoc-crm.org/cidoc-crm/P65_shows_visual_item> ?vi .
  ?vi <http://www.cidoc-crm.org/cidoc-crm/P2_has_type> ?ic .
  FILTER(STRSTARTS(STR(?ic), '{prefix}'))
}}
GROUP BY ?ic
LIMIT {limit}
OFFSET {offset}"""


def sparql_query(query: str, timeout: int = 120) -> dict:
    """Execute a SPARQL SELECT query and return JSON results."""
    from urllib.parse import urlencode

    url = f"{SPARQL_ENDPOINT}?{urlencode({'query': query})}"
    req = Request(url, headers={"Accept": "application/sparql-results+json"})

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, HTTPError, TimeoutError) as e:
            if attempt < MAX_RETRIES:
                print(f"  Attempt {attempt} failed ({e}), retrying in {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
            else:
                raise


def harvest_counts() -> list[tuple[str, int]]:
    """Paginate through SPARQL results and return (notation, count) pairs."""
    all_rows: list[tuple[str, int]] = []
    offset = 0
    page = 1

    while True:
        query = QUERY_TEMPLATE.format(
            graph=NAMED_GRAPH,
            prefix=ICONCLASS_PREFIX,
            limit=PAGE_SIZE,
            offset=offset,
        )
        print(f"  Page {page}: fetching rows {offset}–{offset + PAGE_SIZE - 1}...", end=" ", flush=True)
        t0 = time.time()

        data = sparql_query(query)
        bindings = data.get("results", {}).get("bindings", [])

        for b in bindings:
            uri = b["ic"]["value"]
            notation = unquote(uri.removeprefix(ICONCLASS_PREFIX))
            count = int(b["count"]["value"])
            all_rows.append((notation, count))

        elapsed = time.time() - t0
        print(f"{len(bindings)} rows ({elapsed:.1f}s)")

        if len(bindings) < PAGE_SIZE:
            break  # last page
        offset += PAGE_SIZE
        page += 1

    # Sort descending by count (pagination was unsorted to avoid Virtuoso's 10K sorted cap)
    all_rows.sort(key=lambda r: r[1], reverse=True)
    return all_rows


def export_csv(rows: list[tuple[str, int]], output_path: str):
    """Write notation,count CSV matching the project convention."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "count"])
        for notation, count in rows:
            writer.writerow([notation, count])


def main():
    parser = argparse.ArgumentParser(
        description="Harvest artwork counts per Iconclass notation from the RKD Knowledge Graph"
    )
    parser.add_argument(
        "--output", default="data/rkd-counts.csv",
        help="Output CSV path (default: data/rkd-counts.csv)",
    )
    args = parser.parse_args()

    print(f"Harvesting Iconclass counts from RKD Knowledge Graph...")
    print(f"  Endpoint: {SPARQL_ENDPOINT}")
    print(f"  Graph:    {NAMED_GRAPH}")
    print()

    t0 = time.time()
    rows = harvest_counts()
    elapsed = time.time() - t0

    if not rows:
        print("Error: no rows returned from SPARQL endpoint", file=sys.stderr)
        sys.exit(1)

    export_csv(rows, args.output)

    total_annotations = sum(c for _, c in rows)
    print()
    print(f"Done in {elapsed:.1f}s")
    print(f"  Distinct notations: {len(rows):,}")
    print(f"  Total annotations:  {total_annotations:,}")
    print(f"  Top 5:")
    for notation, count in rows[:5]:
        print(f"    {notation:30s} {count:>6,}")
    print(f"  Output: {args.output}")


if __name__ == "__main__":
    main()
