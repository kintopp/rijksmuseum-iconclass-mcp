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

# Built aside and moved into place, so a failed build leaves the old bundles.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A fixed mtime keeps an unchanged SKILL.md from producing a new binary diff.
cp "$SRC" "$TMP/SKILL.md"
TZ=UTC touch -t 202001010000 "$TMP/SKILL.md"
# -j stores the basename only (SKILL.md at the archive root, no docs/ prefix);
# -X strips uid/gid and Finder/resource-fork attributes so the archive carries
# no __MACOSX / AppleDouble junk (the hygiene problem in the old .skill bundle).
TZ=UTC zip -X -j "$TMP/bundle.zip" "$TMP/SKILL.md" >/dev/null

# Sanity check: the bundle must contain exactly one entry, SKILL.md at root.
entries="$(unzip -Z1 "$TMP/bundle.zip")"
if [ "$entries" != "SKILL.md" ]; then
  echo "error: bundle should contain only 'SKILL.md', got:" >&2
  printf '%s\n' "$entries" >&2
  exit 1
fi

cp "$TMP/bundle.zip" "$OUT_SKILL"
mv "$TMP/bundle.zip" "$OUT_ZIP"

echo "Built $(basename "$OUT_ZIP") + $(basename "$OUT_SKILL") from docs/skills/rijksmuseum-iconclass-mcp/SKILL.md:"
unzip -l "$OUT_ZIP"
