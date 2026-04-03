#!/usr/bin/env bash
# Split a gzipped database into chunks and upload them as GitHub release assets.
#
# Usage:
#   scripts/split-for-release.sh <tag> [gz-file]
#
# Examples:
#   scripts/split-for-release.sh v0.1.0                          # uses data/iconclass.db.gz
#   scripts/split-for-release.sh v0.1.0 data/iconclass.db.gz     # explicit path
#
# The script splits the .gz file into 200 MB chunks (.part-aa, .part-ab, ...)
# and uploads each chunk to the given GitHub release. Failed uploads are
# retried up to 3 times. On the server side, ensureDb() in src/utils/db.ts
# detects the chunks, downloads them in sequence, and reassembles the file.

set -euo pipefail

CHUNK_SIZE="200m"
MAX_RETRIES=3

tag="${1:?Usage: split-for-release.sh <tag> [gz-file]}"
gz_file="${2:-data/iconclass.db.gz}"

if [[ ! -f "$gz_file" ]]; then
  echo "Error: $gz_file not found" >&2
  echo "Compress the database first:  gzip -k data/iconclass.db" >&2
  exit 1
fi

echo "Splitting $gz_file into ${CHUNK_SIZE} chunks..."
split -b "$CHUNK_SIZE" "$gz_file" "${gz_file}.part-"

chunks=("${gz_file}.part-"*)
echo "Created ${#chunks[@]} chunks"

uploaded=0
failed=0

for chunk in "${chunks[@]}"; do
  name="$(basename "$chunk")"
  attempt=1
  while (( attempt <= MAX_RETRIES )); do
    echo "Uploading $name (attempt $attempt)..."
    if gh release upload "$tag" "$chunk" --clobber; then
      uploaded=$((uploaded + 1))
      break
    fi
    attempt=$((attempt + 1))
    if (( attempt <= MAX_RETRIES )); then
      echo "  retrying in 5s..."
      sleep 5
    fi
  done
  if (( attempt > MAX_RETRIES )); then
    echo "FAILED: $name after $MAX_RETRIES attempts" >&2
    failed=$((failed + 1))
  fi
done

# Clean up chunk files
rm -f "${gz_file}.part-"*

echo ""
echo "Done: $uploaded uploaded, $failed failed (out of ${#chunks[@]} chunks)"
if (( failed > 0 )); then
  echo "Re-run the script to retry failed chunks (--clobber overwrites existing assets)" >&2
  exit 1
fi
