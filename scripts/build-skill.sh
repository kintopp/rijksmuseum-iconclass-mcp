#!/usr/bin/env bash
#
# build-skill.sh — rebuild the distributable skill bundles from SKILL.md.
#
# A ".skill" bundle is just a zip with SKILL.md at its root. We ship two
# byte-identical bundles next to the source — a bare ".skill" and a ".skill.zip"
# (some clients/browsers only accept a .zip extension) — both generated from the
# one canonical source (docs/skills/rijksmuseum-iconclass-mcp/SKILL.md). Run this
# whenever SKILL.md changes so the bundles can never drift from the source — the
# failure mode this guards against is git 98d2931, where SKILL.md was bumped to
# 0.41 but the packaged bundle was left at 0.4.0 and shipped stale.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/docs/skills/rijksmuseum-iconclass-mcp/SKILL.md"
OUT_ZIP="$ROOT/docs/skills/rijksmuseum-iconclass-mcp.skill.zip"
OUT_SKILL="$ROOT/docs/skills/rijksmuseum-iconclass-mcp.skill"

[ -f "$SRC" ] || { echo "error: source not found: $SRC" >&2; exit 1; }

rm -f "$OUT_ZIP" "$OUT_SKILL"
# -j stores the basename only (SKILL.md at the archive root, no docs/ prefix);
# -X strips uid/gid and Finder/resource-fork attributes so the archive carries
# no __MACOSX / AppleDouble junk (the hygiene problem in the old .skill bundle).
zip -X -j "$OUT_ZIP" "$SRC" >/dev/null
cp "$OUT_ZIP" "$OUT_SKILL"

# Sanity check: each bundle must contain exactly one entry, SKILL.md at root.
for OUT in "$OUT_ZIP" "$OUT_SKILL"; do
  entries="$(unzip -Z1 "$OUT")"
  if [ "$entries" != "SKILL.md" ]; then
    echo "error: $(basename "$OUT") should contain only 'SKILL.md', got:" >&2
    printf '%s\n' "$entries" >&2
    exit 1
  fi
done

echo "Built $(basename "$OUT_ZIP") + $(basename "$OUT_SKILL") from docs/skills/rijksmuseum-iconclass-mcp/SKILL.md:"
unzip -l "$OUT_ZIP"
