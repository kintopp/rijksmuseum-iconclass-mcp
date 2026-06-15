#!/usr/bin/env bash
#
# build-skill.sh — rebuild the distributable skill bundle from docs/SKILL.md.
#
# A ".skill" bundle is just a zip with SKILL.md at its root. We ship a single
# bundle (docs/rijksmuseum-iconclass-mcp.skill.zip) generated from the one
# canonical source (docs/SKILL.md). Run this whenever SKILL.md changes so the
# bundle can never drift from the source — the failure mode this guards
# against is git 98d2931, where SKILL.md was bumped to 0.41 but the packaged
# bundle was left at 0.4.0 and shipped stale.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/docs/SKILL.md"
OUT="$ROOT/docs/rijksmuseum-iconclass-mcp.skill.zip"

[ -f "$SRC" ] || { echo "error: source not found: $SRC" >&2; exit 1; }

rm -f "$OUT"
# -j stores the basename only (SKILL.md at the archive root, no docs/ prefix);
# -X strips uid/gid and Finder/resource-fork attributes so the archive carries
# no __MACOSX / AppleDouble junk (the hygiene problem in the old .skill bundle).
zip -X -j "$OUT" "$SRC" >/dev/null

# Sanity check: the bundle must contain exactly one entry, SKILL.md at root.
entries="$(unzip -Z1 "$OUT")"
if [ "$entries" != "SKILL.md" ]; then
  echo "error: bundle should contain only 'SKILL.md', got:" >&2
  printf '%s\n' "$entries" >&2
  exit 1
fi

echo "Built $(basename "$OUT") from docs/SKILL.md:"
unzip -l "$OUT"
