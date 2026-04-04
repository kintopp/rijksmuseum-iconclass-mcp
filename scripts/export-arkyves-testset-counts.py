#!/usr/bin/env python3
"""
Export Iconclass notation counts from the Arkyves AI Test Set data.json.

The test set (https://iconclass.org/testset/) contains 87,744 images mapped
to Iconclass notations. This script extracts notation→image_count as a CSV
compatible with the sidecar DB build pipeline.

The data.json file can be extracted from the test set zip without downloading
the full 3.1 GB archive — see offline/arkyves-api-findings.md for the
range-request extraction method.

Usage:
    python scripts/export-arkyves-testset-counts.py
    python scripts/export-arkyves-testset-counts.py --input data/arkyves-testset-data.json --output data/arkyves-counts.csv

Source:
    URL:     https://iconclass.org/testset/779ba2ca9e977c58d818e3823a676973.zip
    File:    data.json (9.3 MB, extracted via HTTP range request)
    License: Open (CC0 images sampled from Arkyves)
    Stats:   87,744 images, 392,122 notation assignments, 34,721 unique notations
"""

import argparse
import csv
import json
import os
import sys
from collections import Counter


def main():
    parser = argparse.ArgumentParser(
        description="Export Iconclass counts from Arkyves AI Test Set data.json"
    )
    parser.add_argument(
        "--input",
        default="data/arkyves-testset-data.json",
        help="Input data.json path (default: data/arkyves-testset-data.json)",
    )
    parser.add_argument(
        "--output",
        default="data/arkyves-counts.csv",
        help="Output CSV path (default: data/arkyves-counts.csv)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: {args.input} not found.", file=sys.stderr)
        print(
            "Extract data.json from the Arkyves test set zip first.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Reading {args.input}...")
    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Count images per notation
    # Each entry is filename → [notation, notation, ...]
    # An image counts once per notation (deduplicate within each image)
    counts: Counter = Counter()
    for notations in data.values():
        for notation in set(notations):  # deduplicate within image
            counts[notation] += 1

    # Export CSV sorted by count descending
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["notation", "count"])
        for notation, count in counts.most_common():
            writer.writerow([notation, count])

    total_images = len(data)
    total_assignments = sum(len(v) for v in data.values())

    print(f"Done.")
    print(f"  Images:              {total_images:,}")
    print(f"  Total assignments:   {total_assignments:,}")
    print(f"  Unique notations:    {len(counts):,}")
    print(f"  Top 5:")
    for notation, count in counts.most_common(5):
        print(f"    {notation:30s} {count:>6,}")
    print(f"  Output: {args.output}")


if __name__ == "__main__":
    main()
