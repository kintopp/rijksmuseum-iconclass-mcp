#!/usr/bin/env bash
# analyse-railway-logs.sh — Fetch Railway logs and produce analysis report.
#
# Fetches JSON logs from recent deployments via `railway logs`, saves the
# raw JSONL, and runs analyse-railway-logs.py to produce a 7-section
# markdown report for the Iconclass MCP server.
#
# Usage:
#   ./scripts/analyse-railway-logs.sh [OPTIONS]
#
# Options:
#   --service NAME Railway service to link (default: rijksmuseum-iconclass-mcp)
#   --lines N      Max log lines per deployment (default: 500)
#   --limit N      Max deployments to fetch (default: 20)
#   --output DIR   Output directory for logs + report (default: .)
#   --skip-fetch   Skip fetching; analyse existing logs from --output dir
#   --log-date D   With --skip-fetch: the YYYY-MM-DD file to analyse (default: today)
#   --since DATE   Only include calls on/after DATE (YYYY-MM-DD)
#   --until DATE   Only include calls on/before DATE (YYYY-MM-DD)
#   --period P     Sugar for --since: daily, weekly, monthly
#
# Output files (in --output dir):
#   iconclass--railway-logs-YYYY-MM-DD.jsonl       Raw merged log lines
#   iconclass--YYYY-MM-DD--railway-log-analysis.md Markdown report
#
# The 'iconclass--' prefix lets reports share offline/feedback/log-analysis/
# with the main rijksmuseum-mcp-plus reports without filename collisions.
#
# Exits 3 after writing the report if a deployment's logs could not be fetched;
# the report opens with a warning naming what is missing or cut off.

set -eu # No pipefail — avoids SIGPIPE on jq | sort | head chains

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATE=$(date +%Y-%m-%d)
SERVICE="rijksmuseum-iconclass-mcp"
LINES=500
DEPLOY_LIMIT=20
OUTPUT_DIR="."
SKIP_FETCH=false
PY_EXTRA_ARGS=()
FETCH_FAILED=()
FETCH_CAPPED=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --service)    SERVICE="$2"; shift 2 ;;
    --lines)      LINES="$2"; shift 2 ;;
    --limit)      DEPLOY_LIMIT="$2"; shift 2 ;;
    --output)     OUTPUT_DIR="$2"; shift 2 ;;
    --skip-fetch) SKIP_FETCH=true; shift ;;
    --log-date)   DATE="$2"; shift 2 ;;
    --since)     PY_EXTRA_ARGS+=(--since "$2"); shift 2 ;;
    --until)      PY_EXTRA_ARGS+=(--until "$2"); shift 2 ;;
    --period)     PY_EXTRA_ARGS+=(--period "$2"); shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

LOGFILE="${OUTPUT_DIR}/iconclass--railway-logs-${DATE}.jsonl"
REPORT="${OUTPUT_DIR}/iconclass--${DATE}--railway-log-analysis.md"

# ─── Prerequisites ───────────────────────────────────────────────────────────

if [[ "$SKIP_FETCH" == false ]]; then
  for cmd in railway jq; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "Error: $cmd is required but not found." >&2
      exit 1
    fi
  done
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required for report generation." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/analyse-railway-logs.py" ]]; then
  echo "Error: analyse-railway-logs.py not found in $SCRIPT_DIR" >&2
  exit 1
fi

# ─── Fetch logs ──────────────────────────────────────────────────────────────

if [[ "$SKIP_FETCH" == false ]]; then
  # -s on every call, not `railway link`: a failed link would leave another
  # service linked and report on it.
  echo "Fetching deployment list for $SERVICE (limit $DEPLOY_LIMIT)..." >&2
  DEPLOY_JSON=$(railway deployment list -s "$SERVICE" --json --limit "$DEPLOY_LIMIT") || {
    echo "Error: could not list deployments for $SERVICE (see above)." >&2
    exit 1
  }
  DEPLOYMENTS=$(jq -r '.[] | .id' <<< "$DEPLOY_JSON")
  if [[ -z "$DEPLOYMENTS" ]]; then
    echo "Error: $SERVICE has no deployments." >&2
    exit 1
  fi
  echo "Found $(wc -l <<< "$DEPLOYMENTS" | tr -d ' ') deployments." >&2

  # Fetched aside, so a failed run leaves an earlier log for this date intact.
  LOGFILE_TMP="$LOGFILE.tmp"
  ONE_DEPLOY_TMP="$LOGFILE.one.tmp"
  trap 'rm -f "$LOGFILE_TMP" "$ONE_DEPLOY_TMP"' EXIT
  : > "$LOGFILE_TMP"
  for id in $DEPLOYMENTS; do
    echo "  Fetching $id..." >&2
    if ! railway logs "$id" -s "$SERVICE" --json -n "$LINES" > "$ONE_DEPLOY_TMP"; then
      echo "  Warning: could not fetch logs for $id" >&2
      FETCH_FAILED+=("$id")
      continue
    fi
    if [[ "$(wc -l < "$ONE_DEPLOY_TMP" | tr -d ' ')" -ge "$LINES" ]]; then
      echo "  Warning: $id hit the $LINES-line limit; older lines are missing" >&2
      FETCH_CAPPED+=("$id")
    fi
    cat "$ONE_DEPLOY_TMP" >> "$LOGFILE_TMP"
  done

  TOTAL_LINES=$(wc -l < "$LOGFILE_TMP" | tr -d ' ')
  if [[ "$TOTAL_LINES" -eq 0 ]]; then
    echo "Error: no log lines fetched; $LOGFILE left as it was." >&2
    exit 1
  fi
  mv "$LOGFILE_TMP" "$LOGFILE"
  echo "Collected $TOTAL_LINES log lines → $LOGFILE" >&2
else
  if [[ ! -f "$LOGFILE" ]]; then
    echo "Error: --skip-fetch but $LOGFILE not found." >&2
    echo "Either fetch first or ensure the file exists." >&2
    exit 1
  fi
  echo "Skipping fetch, using existing $LOGFILE" >&2
fi

# ─── Analyse ─────────────────────────────────────────────────────────────────

# The ${x[@]+...} form: bash 3.2 under set -u treats an empty array as unbound.
python3 "$SCRIPT_DIR/analyse-railway-logs.py" "$LOGFILE" -o "$REPORT" ${PY_EXTRA_ARGS[@]+"${PY_EXTRA_ARGS[@]}"}

if [[ ${#FETCH_FAILED[@]} -gt 0 || ${#FETCH_CAPPED[@]} -gt 0 ]]; then
  REPORT_TMP="$REPORT.tmp"
  {
    if [[ ${#FETCH_FAILED[@]} -gt 0 ]]; then
      echo "> **Incomplete data:** logs could not be fetched for ${FETCH_FAILED[*]}."
      echo
    fi
    if [[ ${#FETCH_CAPPED[@]} -gt 0 ]]; then
      echo "> **Incomplete data:** older lines are missing for ${FETCH_CAPPED[*]}, which hit the $LINES-line limit (raise --lines)."
      echo
    fi
    cat "$REPORT"
  } > "$REPORT_TMP"
  mv "$REPORT_TMP" "$REPORT"
fi

echo "" >&2
echo "Done." >&2
echo "  Raw logs: $LOGFILE" >&2
echo "  Report:   $REPORT" >&2

if [[ ${#FETCH_FAILED[@]} -gt 0 ]]; then
  echo "Error: logs missing for ${#FETCH_FAILED[@]} deployment(s); the report is incomplete." >&2
  exit 3
fi
