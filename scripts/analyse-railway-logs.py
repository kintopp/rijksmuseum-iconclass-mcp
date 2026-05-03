#!/usr/bin/env python3
"""Analyse Railway deployment logs for the Iconclass MCP server.

Reads a JSONL file of Railway logs (produced by `railway logs --json`) and
generates a 7-section markdown report covering traffic, performance, errors,
sessions, tool-specific observations, caching patterns, and recommendations.

Adapted from rijksmuseum-mcp-plus's analyser. The shape contract is identical
({tool, ms, ok, input}), but tool list, search keys, session-gap, and per-tool
breakdowns are tuned to the six Iconclass tools.

Usage:
    python3 scripts/analyse-railway-logs.py logs.jsonl              # stdout
    python3 scripts/analyse-railway-logs.py logs.jsonl -o report.md # file
    python3 scripts/analyse-railway-logs.py logs.jsonl --period weekly -o report.md

Typically invoked via the wrapper:
    ./scripts/analyse-railway-logs.sh [--lines N] [--limit N] [--period weekly]
"""

import json
import re
import sys
import argparse
from datetime import datetime, timedelta, timezone
from collections import Counter, defaultdict
from pathlib import Path

# ─── Constants ───────────────────────────────────────────────────────────────

# Six Iconclass tools, ordered by expected frequency.
TOOL_ORDER = [
    "search",
    "browse",
    "resolve",
    "search_prefix",
    "expand_keys",
    "find_artworks",
]

# Iconclass traffic is much sparser than Rijks (single subject-classification
# server, fewer concurrent users). A 60-min gap groups conversation-level
# sessions more usefully than the main-server's 30-min default.
SESSION_GAP_MINUTES = 60
PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}

STARTUP_PATTERNS = [
    "Iconclass DB loaded",
    "Iconclass DB ready",
    "Counts DB attached",
    "Iconclass embeddings",
    "Embedding model loaded",
    "listening on",
    "Downloading",
    "Starting Container",
    "running on stdio",
]

# Input keys worth surfacing in summaries (display priority order).
SEARCH_KEYS = [
    "query", "semanticQuery", "notation",
    "parentNotation", "collectionId", "lang",
]


# ─── Data loading ────────────────────────────────────────────────────────────

def parse_ts(ts_str):
    """Parse ISO 8601 timestamp to timezone-aware UTC datetime."""
    ts = re.sub(r"(\.\d{6})\d*Z$", r"\1+00:00", ts_str)
    ts = ts.replace("Z", "+00:00")
    return datetime.fromisoformat(ts)


def load_logs(path):
    """Load a JSONL log file. Skips malformed lines."""
    logs = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            logs.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return logs


def extract_tool_calls(logs):
    """Extract and sort tool call entries from logs."""
    calls = []
    for log in logs:
        if "tool" not in log:
            continue
        try:
            ts = parse_ts(log["timestamp"])
        except (KeyError, ValueError):
            continue
        inp = log.get("input", {})
        if isinstance(inp, str):
            try:
                inp = json.loads(inp)
            except json.JSONDecodeError:
                inp = {}
        # Strip client-side server prefix (e.g. "Iconclass:search" → "search")
        tool_name = log["tool"]
        if ":" in tool_name:
            tool_name = tool_name.rsplit(":", 1)[-1]
        calls.append({
            "ts": ts,
            "tool": tool_name,
            "ms": int(float(log.get("ms", 0))),
            "ok": log.get("ok", True),
            "input": inp if isinstance(inp, dict) else {},
        })
    calls.sort(key=lambda c: c["ts"])
    return calls


def extract_startup_events(logs):
    """Extract startup-related log messages."""
    events = []
    for log in logs:
        msg = log.get("message", "")
        if any(p in msg for p in STARTUP_PATTERNS):
            try:
                events.append({"ts": parse_ts(log["timestamp"]), "message": msg})
            except (KeyError, ValueError):
                continue
    events.sort(key=lambda e: e["ts"])
    return events


# ─── Statistics ──────────────────────────────────────────────────────────────

def pct(values, p):
    """Percentile (p in 0-100). Returns 0 for empty list."""
    if not values:
        return 0
    vs = sorted(values)
    return vs[min(int(len(vs) * p / 100), len(vs) - 1)]


def latency_stats(values):
    if not values:
        return {k: 0 for k in ("min", "p50", "p90", "p99", "max", "count")}
    vs = sorted(values)
    return {
        "min": vs[0], "p50": pct(vs, 50), "p90": pct(vs, 90),
        "p99": pct(vs, 99), "max": vs[-1], "count": len(vs),
    }


# ─── Session identification ─────────────────────────────────────────────────

def identify_sessions(calls):
    """Group calls into sessions separated by >SESSION_GAP_MINUTES silence."""
    if not calls:
        return []
    groups = [[calls[0]]]
    for c in calls[1:]:
        if (c["ts"] - groups[-1][-1]["ts"]) > timedelta(minutes=SESSION_GAP_MINUTES):
            groups.append([])
        groups[-1].append(c)

    sessions = []
    for i, group in enumerate(groups):
        tools = Counter(c["tool"] for c in group)
        duration = group[-1]["ts"] - group[0]["ts"]
        notations = Counter()
        for c in group:
            n = c["input"].get("notation")
            if isinstance(n, list):
                for v in n:
                    notations[v] += 1
            elif n:
                notations[n] += 1
        sessions.append({
            "index": i + 1,
            "calls": group,
            "start": group[0]["ts"],
            "end": group[-1]["ts"],
            "duration": duration,
            "count": len(group),
            "tools": tools,
            "slow": [c for c in group if c["ms"] > 1000],
            "errors": [c for c in group if not c["ok"]],
            "classification": _classify(group, tools, duration),
            "notations": notations,
            "topics": _extract_topics(group),
        })
    return sessions


def _classify(calls, tools, duration):
    """Auto-classify session type for the Iconclass server."""
    sem = sum(1 for c in calls
              if c["tool"] == "search" and "semanticQuery" in c["input"])
    if sem > 3:
        return "concept-search"
    if tools.get("browse", 0) + tools.get("expand_keys", 0) > 5:
        return "hierarchy-exploration"
    if tools.get("find_artworks", 0) > 3:
        return "collection-discovery"
    if tools.get("resolve", 0) > 5 and len(tools) <= 2:
        return "batch-resolution"
    if len(calls) <= 3 and duration < timedelta(minutes=2):
        return "quick-lookup"
    return "browsing"


def _extract_topics(calls):
    """Extract unique search topics from session calls."""
    seen, topics = set(), []

    def _add(t):
        if t not in seen:
            seen.add(t)
            topics.append(t)

    for c in calls:
        inp = c["input"]
        tool = c["tool"]
        if tool == "search":
            if "query" in inp:
                _add(f'query: "{inp["query"]}"')
            if "semanticQuery" in inp:
                _add(f'semantic: "{inp["semanticQuery"]}"')
            if "parentNotation" in inp:
                _add(f'under: {inp["parentNotation"]}')
        if tool == "browse" and "notation" in inp:
            _add(f'browse: {inp["notation"]}')
        if tool == "search_prefix" and "notation" in inp:
            _add(f'prefix: {inp["notation"]}')
        if tool == "expand_keys" and "notation" in inp:
            _add(f'keys: {inp["notation"]}')
        if tool == "find_artworks":
            n = inp.get("notation")
            if isinstance(n, list):
                _add(f'artworks: [{", ".join(n[:3])}{"..." if len(n) > 3 else ""}]')
            elif n:
                _add(f'artworks: {n}')
    return topics[:20]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def fmt_dur(td):
    s = int(td.total_seconds())
    if s >= 3600:
        return f"{s // 3600}h {(s % 3600) // 60}m"
    return f"{s // 60}m {s % 60}s"


def summarize_input(c):
    """Concise human-readable summary of a tool call's input."""
    inp, tool = c["input"], c["tool"]
    if tool == "search":
        parts = []
        for key in SEARCH_KEYS:
            if key in inp:
                v = inp[key]
                parts.append(f'{key}:"{v}"' if isinstance(v, str) else f'{key}:{v}')
        if inp.get("onlyWithArtworks"):
            parts.append("onlyWithArtworks")
        if inp.get("maxResults", 25) != 25:
            parts.append(f'max:{inp["maxResults"]}')
        return ", ".join(parts) or json.dumps(inp)[:100]
    if tool == "browse":
        n = inp.get("notation", "?")
        extras = []
        if inp.get("depth", 1) != 1:
            extras.append(f'd:{inp["depth"]}')
        if inp.get("includeKeys"):
            extras.append("keys")
        return f"{n} ({', '.join(extras)})" if extras else n
    if tool == "resolve":
        n = inp.get("notation")
        if isinstance(n, list):
            return f'[{", ".join(n[:3])}{"..." if len(n) > 3 else ""}] (n={len(n)})'
        return str(n) if n else "?"
    if tool in ("expand_keys", "search_prefix"):
        n = inp.get("notation", "?")
        if inp.get("offset"):
            return f'{n} offset:{inp["offset"]}'
        return n
    if tool == "find_artworks":
        n = inp.get("notation")
        if isinstance(n, list):
            return f'[{", ".join(n[:3])}{"..." if len(n) > 3 else ""}] (n={len(n)})'
        return str(n) if n else "?"
    return json.dumps(inp)[:100]


def _brief_input(tool, inp):
    """Very short input summary for cache table."""
    if tool == "search":
        for k in ("query", "semanticQuery"):
            if k in inp:
                return f'("{inp[k][:25]}")'
    if tool in ("browse", "resolve", "expand_keys", "search_prefix", "find_artworks"):
        n = inp.get("notation")
        if isinstance(n, list):
            return f'([{n[0]}...] n={len(n)})'
        if n:
            return f"({n})"
    return ""


# ─── Section 1: Traffic Summary ─────────────────────────────────────────────

def section_1(calls, sessions):
    out = ["## 1. Traffic Summary\n"]
    out.append("| Tool | Calls | Errors | Min ms | Median ms | Max ms |")
    out.append("|------|-------|--------|--------|-----------|--------|")
    total_calls = total_errors = 0
    for tool in TOOL_ORDER:
        tc = [c for c in calls if c["tool"] == tool]
        if not tc:
            continue
        ms = [c["ms"] for c in tc]
        errs = sum(1 for c in tc if not c["ok"])
        total_calls += len(tc)
        total_errors += errs
        out.append(
            f"| `{tool}` | {len(tc)} | {errs} "
            f"| {min(ms):,} | ~{pct(ms, 50):,} | {max(ms):,} |"
        )
    rate = f"{100 * total_errors / total_calls:.2f}" if total_calls else "0.00"
    out.append(
        f"\n**{total_calls:,} tool calls total, {total_errors} "
        f"error{'s' if total_errors != 1 else ''}.** Error rate: {rate}%.\n"
    )
    out.append(f"Sessions: {len(sessions)} (>{SESSION_GAP_MINUTES}-minute gap).\n")
    return "\n".join(out)


# ─── Section 2: Performance ─────────────────────────────────────────────────

def section_2(calls, startup_events):
    out = ["## 2. Performance\n"]

    out.append("### Latency Percentiles\n")
    out.append("| Tool | p50 | p90 | p99 | Max | Count |")
    out.append("|------|-----|-----|-----|-----|-------|")
    for tool in TOOL_ORDER:
        ms = [c["ms"] for c in calls if c["tool"] == tool]
        if not ms:
            continue
        s = latency_stats(ms)
        out.append(
            f"| `{tool}` | {s['p50']:,} | {s['p90']:,} "
            f"| {s['p99']:,} | {s['max']:,} | {s['count']} |"
        )
    out.append("")

    # Semantic search breakdown
    sem = [c for c in calls
           if c["tool"] == "search" and "semanticQuery" in c["input"]]
    if sem:
        out.append("### Semantic Search Breakdown\n")
        out.append(f"{len(sem)} calls total.\n")
        cold = sorted([c for c in sem if c["ms"] > 5000], key=lambda c: c["ts"])
        warm = [c for c in sem if c["ms"] <= 5000]
        if warm:
            ws = [c["ms"] for c in warm]
            out.append(
                f"- **Warm** ({len(warm)}): "
                f"p50 = {pct(ws, 50):,}ms, max = {max(ws):,}ms"
            )
        if cold:
            out.append(
                f"- **Cold outliers >5s** ({len(cold)}): "
                "likely first-after-restart\n"
            )
            out.append("| Time | ms | Query |")
            out.append("|------|-----|-------|")
            for c in cold:
                q = c["input"].get("semanticQuery", "")[:60]
                out.append(
                    f'| {c["ts"].strftime("%b %d %H:%M")} '
                    f'| {c["ms"]:,} | "{q}" |'
                )
        out.append("")

    # Slow queries (>2s — Iconclass is mostly SQLite reads, so this threshold
    # is much lower than the main server's >5s cutoff).
    slow = sorted([c for c in calls if c["ms"] > 2000], key=lambda c: -c["ms"])
    if slow:
        out.append("### Slow Queries (>2s)\n")
        out.append("| Tool | ms | Input |")
        out.append("|------|-----|-------|")
        for c in slow[:15]:
            out.append(
                f"| `{c['tool']}` | {c['ms']:,} | {summarize_input(c)} |"
            )
        out.append("")

    # Startup health
    starts = [e for e in startup_events if "Starting Container" in e["message"]]
    listens = [e for e in startup_events if "listening on" in e["message"]]

    out.append("### Startup Health\n")
    out.append(f"{len(starts)} container starts observed.\n")

    if starts and listens:
        boot_times = []
        for s in starts:
            for l in listens:
                if l["ts"] > s["ts"]:
                    boot_times.append((l["ts"] - s["ts"]).total_seconds())
                    break
        if boot_times:
            out.append(
                f"- Start → listening: {min(boot_times):.0f}–{max(boot_times):.0f}s"
            )

    downloads = [e for e in startup_events if "Downloading" in e["message"]]
    if downloads:
        out.append(f"- DB downloads: {len(downloads)} (cold start with download)")
    else:
        out.append("- No DB downloads (databases already on volume)")

    if len(starts) > 1:
        first, last = starts[0]["ts"], starts[-1]["ts"]
        span_h = (last - first).total_seconds() / 3600
        if span_h > 0:
            out.append(
                f"- Container cycling: ~1 every {span_h / (len(starts) - 1):.1f}h"
            )

    out.append("")
    return "\n".join(out)


# ─── Section 3: Errors ──────────────────────────────────────────────────────

def section_3(calls):
    out = ["## 3. Errors\n"]
    errors = [c for c in calls if not c["ok"]]
    if not errors:
        out.append(f"**Zero errors** across {len(calls):,} tool calls.\n")
        return "\n".join(out)

    out.append(
        f"**{len(errors)} error{'s' if len(errors) != 1 else ''}** "
        f"in {len(calls):,} calls ({100 * len(errors) / len(calls):.2f}%).\n"
    )
    for c in errors:
        out.append(
            f"- `{c['tool']}` at {c['ts'].strftime('%b %d %H:%M')}: "
            f"{summarize_input(c)}"
        )
    out.append("")
    return "\n".join(out)


# ─── Section 4: Usage Patterns & Sessions ────────────────────────────────────

def section_4(sessions):
    out = [
        "## 4. Usage Patterns & Sessions\n",
        f"{len(sessions)} distinct sessions identified by "
        f">{SESSION_GAP_MINUTES}-minute gaps.\n",
        "_Session classification is automated. "
        "Add narrative descriptions for notable sessions._\n",
    ]

    current_date = None
    for s in sessions:
        date_str = s["start"].strftime("%b %d")
        if date_str != current_date:
            current_date = date_str
            day_sessions = [
                x for x in sessions if x["start"].strftime("%b %d") == date_str
            ]
            day_calls = sum(x["count"] for x in day_sessions)
            out.append(
                f"### {date_str} "
                f"({len(day_sessions)} session{'s' if len(day_sessions) != 1 else ''}, "
                f"{day_calls} calls)\n"
            )

        cls_label = s["classification"].replace("-", " ").title()
        if s["start"].date() != s["end"].date():
            time_range = (
                f'{s["start"].strftime("%b %d %H:%M")}–'
                f'{s["end"].strftime("%b %d %H:%M")} UTC'
            )
        else:
            time_range = (
                f'{s["start"].strftime("%H:%M")}–'
                f'{s["end"].strftime("%H:%M")} UTC'
            )
        out.append(
            f"**{s['index']}. {cls_label}** "
            f"({time_range}, {s['count']} calls, {fmt_dur(s['duration'])})"
        )

        tool_str = ", ".join(f"{t}:{n}" for t, n in s["tools"].most_common())
        out.append(f"\nTools: {tool_str}")

        if s["slow"]:
            out.append(f"Slow (>1s): {len(s['slow'])} calls")
        if s["errors"]:
            out.append(f"Errors: {len(s['errors'])}")
        if s["notations"]:
            top = ", ".join(
                f"{n} ({k})" for n, k in s["notations"].most_common(5)
            )
            out.append(f"Notations: {top}")

        if s["topics"]:
            out.append("\nKey queries:")
            for t in s["topics"][:10]:
                out.append(f"- {t}")

        out.append("")

    return "\n".join(out)


# ─── Section 5: Tool-Specific Observations ──────────────────────────────────

def section_5(calls):
    out = ["## 5. Tool-Specific Observations\n"]

    # search — keyword vs semantic split
    search_calls = [c for c in calls if c["tool"] == "search"]
    if search_calls:
        out.append(f"### search ({len(search_calls)} calls)\n")
        kw = [c for c in search_calls if "query" in c["input"]]
        sem = [c for c in search_calls if "semanticQuery" in c["input"]]
        out.append(f"- Keyword (FTS): {len(kw)}, semantic: {len(sem)}")

        if kw:
            queries = Counter(c["input"].get("query", "") for c in kw)
            top = queries.most_common(10)
            if top:
                out.append("- Top FTS queries: "
                           + ", ".join(f'"{q}" ({n})' for q, n in top))
        if sem:
            squeries = Counter(c["input"].get("semanticQuery", "") for c in sem)
            top = squeries.most_common(10)
            if top:
                out.append("- Top semantic queries: "
                           + ", ".join(f'"{q}" ({n})' for q, n in top))

        scoped = [c for c in search_calls if "parentNotation" in c["input"]]
        if scoped:
            parents = Counter(c["input"]["parentNotation"] for c in scoped)
            out.append(
                f"- Scoped (parentNotation): {len(scoped)} — "
                + ", ".join(f"{p} ({n})" for p, n in parents.most_common(5))
            )
        ofa = sum(1 for c in search_calls if c["input"].get("onlyWithArtworks"))
        if ofa:
            out.append(f"- onlyWithArtworks filter: {ofa} calls")
        cf = [c["input"]["collectionId"] for c in search_calls
              if c["input"].get("collectionId")]
        if cf:
            cc = Counter(cf)
            out.append("- collectionId filter: "
                       + ", ".join(f"{c} ({n})" for c, n in cc.most_common()))
        out.append("")

    # browse
    br = [c for c in calls if c["tool"] == "browse"]
    if br:
        out.append(f"### browse ({len(br)} calls)\n")
        notations = Counter(c["input"].get("notation", "?") for c in br)
        out.append(f"- {len(notations)} unique notations browsed")
        top = notations.most_common(10)
        if top:
            out.append("- Most browsed: "
                       + ", ".join(f"{n} ({k})" for n, k in top))
        depths = Counter(c["input"].get("depth", 1) for c in br)
        out.append("- Depth distribution: "
                   + ", ".join(f"d{d}({n})" for d, n in sorted(depths.items())))
        with_keys = sum(1 for c in br if c["input"].get("includeKeys"))
        if with_keys:
            out.append(f"- includeKeys: {with_keys} calls")
        out.append("")

    # resolve
    rs = [c for c in calls if c["tool"] == "resolve"]
    if rs:
        out.append(f"### resolve ({len(rs)} calls)\n")
        # Batch sizes
        sizes = []
        for c in rs:
            n = c["input"].get("notation")
            if isinstance(n, list):
                sizes.append(len(n))
            elif n:
                sizes.append(1)
        if sizes:
            out.append(
                f"- Batch sizes: min {min(sizes)}, "
                f"median {pct(sizes, 50)}, max {max(sizes)}"
            )
            single = sum(1 for s in sizes if s == 1)
            out.append(
                f"- Single-notation calls: {single} "
                f"({100 * single // len(sizes)}% of resolves)"
            )
        out.append("")

    # search_prefix
    sp = [c for c in calls if c["tool"] == "search_prefix"]
    if sp:
        out.append(f"### search_prefix ({len(sp)} calls)\n")
        prefixes = Counter(c["input"].get("notation", "?") for c in sp)
        top = prefixes.most_common(10)
        if top:
            out.append("- Top prefixes: "
                       + ", ".join(f"{p} ({n})" for p, n in top))
        # Prefix length — short prefixes mean broad subtree scans
        lengths = Counter(len(c["input"].get("notation", "")) for c in sp)
        out.append(
            "- Prefix length: "
            + ", ".join(f"{ln}-char({n})" for ln, n in sorted(lengths.items()))
        )
        paged = sum(1 for c in sp if c["input"].get("offset"))
        if paged:
            out.append(f"- Paginated calls (offset>0): {paged}")
        out.append("")

    # expand_keys
    ek = [c for c in calls if c["tool"] == "expand_keys"]
    if ek:
        out.append(f"### expand_keys ({len(ek)} calls)\n")
        bases = Counter(c["input"].get("notation", "?") for c in ek)
        top = bases.most_common(10)
        if top:
            out.append("- Top base notations: "
                       + ", ".join(f"{n} ({k})" for n, k in top))
        out.append("")

    # find_artworks
    fa = [c for c in calls if c["tool"] == "find_artworks"]
    if fa:
        out.append(f"### find_artworks ({len(fa)} calls)\n")
        sizes = []
        all_notations = Counter()
        for c in fa:
            n = c["input"].get("notation")
            if isinstance(n, list):
                sizes.append(len(n))
                for v in n:
                    all_notations[v] += 1
            elif n:
                sizes.append(1)
                all_notations[n] += 1
        if sizes:
            out.append(
                f"- Batch sizes: min {min(sizes)}, "
                f"median {pct(sizes, 50)}, max {max(sizes)}"
            )
        top = all_notations.most_common(10)
        if top:
            out.append("- Top notations queried: "
                       + ", ".join(f"{n} ({k})" for n, k in top))
        out.append("")

    return "\n".join(out)


# ─── Section 6: Caching & Performance Patterns ──────────────────────────────

def section_6(calls):
    out = ["## 6. Caching & Performance Patterns\n"]

    # Repeat-call speedup (OS page cache + better-sqlite3 prepared-stmt cache)
    groups = defaultdict(list)
    for c in calls:
        key = (c["tool"], json.dumps(c["input"], sort_keys=True))
        groups[key].append(c["ms"])

    cache_hits = []
    for (tool, inp_str), times in groups.items():
        if len(times) >= 2 and times[0] > 20:
            ratio = times[0] / max(times[1], 1)
            if ratio > 2:
                cache_hits.append(
                    (tool, json.loads(inp_str), times[0], times[1], ratio)
                )
    cache_hits.sort(key=lambda x: -x[4])

    if cache_hits:
        out.append("### Repeat-Call Speedup\n")
        out.append("| Pattern | First | Repeat | Speedup |")
        out.append("|---------|-------|--------|---------|")
        for tool, inp, first, repeat, ratio in cache_hits[:10]:
            label = f"`{tool}` {_brief_input(tool, inp)}"
            out.append(f"| {label} | {first:,}ms | {repeat:,}ms | {ratio:.0f}× |")
        out.append("")

    # Semantic search cold vs warm
    sem = [c for c in calls
           if c["tool"] == "search" and "semanticQuery" in c["input"]]
    if sem:
        cold = [c for c in sem if c["ms"] > 5000]
        warm = [c for c in sem if c["ms"] <= 5000]
        if cold or warm:
            out.append("### Semantic Search: Cold vs Warm\n")
            out.append("| Category | Calls | p50 | Max |")
            out.append("|----------|-------|-----|-----|")
            for label, group in [
                ("First after restart (cold, >5s)", cold),
                ("Warm", warm),
            ]:
                if group:
                    ms = [c["ms"] for c in group]
                    out.append(
                        f"| {label} | {len(group)} "
                        f"| {pct(ms, 50):,}ms | {max(ms):,}ms |"
                    )
            out.append("")

    return "\n".join(out)


# ─── Section 7: Recommendations ─────────────────────────────────────────────

def section_7(calls, startup_events):
    out = ["## 7. Recommendations\n"]
    recs_high, recs_med, recs_low = [], [], []

    # Cold semantic outliers
    sem_cold = [c for c in calls
                if c["tool"] == "search"
                and "semanticQuery" in c["input"]
                and c["ms"] > 5000]
    if sem_cold:
        recs_high.append(
            f"**Pre-warm embeddings DB mmap pages** — {len(sem_cold)} semantic "
            f"search calls exceeded 5s. A dummy semantic query during startup "
            f"would eliminate these cold spikes."
        )

    # Container cycling
    starts = [e for e in startup_events if "Starting Container" in e["message"]]
    if len(starts) > 3:
        span_h = (starts[-1]["ts"] - starts[0]["ts"]).total_seconds() / 3600
        avg = span_h / (len(starts) - 1) if len(starts) > 1 else 0
        if avg < 12:
            recs_med.append(
                f"**Monitor container cycling** — {len(starts)} restarts "
                f"(~1 every {avg:.1f}h). Investigate idle-timeout vs resource cause."
            )

    # Errors
    errors = [c for c in calls if not c["ok"]]
    if errors:
        top = Counter(c["tool"] for c in errors).most_common(1)[0]
        recs_high.append(
            f"**Investigate `{top[0]}` errors** — {top[1]} failures. "
            f"Check error messages in raw logs."
        )

    # Tool coverage — flag any of the six that never get called organically
    tool_counts = Counter(c["tool"] for c in calls)
    unused = [t for t in TOOL_ORDER if t not in tool_counts]
    if unused:
        recs_med.append(
            f"**Unused tools:** {', '.join('`' + t + '`' for t in unused)}. "
            f"Either traffic is too sparse or tool descriptions don't surface "
            f"these capabilities — review against the conversation patterns."
        )

    # Broad prefix scans
    sp = [c for c in calls if c["tool"] == "search_prefix"]
    short = [c for c in sp if len(c["input"].get("notation", "")) <= 2]
    if short and len(short) > len(sp) // 2:
        recs_low.append(
            f"**Broad prefix scans** — {len(short)}/{len(sp)} `search_prefix` "
            f"calls use 1–2 char prefixes, which match thousands of notations. "
            f"Tool description already warns about this — check whether "
            f"clients are paginating exhaustively rather than narrowing."
        )

    # find_artworks usage as a workflow signal
    fa = [c for c in calls if c["tool"] == "find_artworks"]
    if calls and not fa:
        recs_low.append(
            f"**No `find_artworks` calls** — clients aren't using the "
            f"collection-presence link-out. Worth checking whether the tool "
            f"description's ArtResearch.net guidance is reaching the model."
        )

    if not errors:
        recs_low.append("**Error rate at 0%** — no action needed.")

    idx = 1
    if recs_high:
        out.append("### High impact\n")
        for r in recs_high:
            out.append(f"{idx}. {r}\n")
            idx += 1
    if recs_med:
        out.append("### Medium impact\n")
        for r in recs_med:
            out.append(f"{idx}. {r}\n")
            idx += 1
    if recs_low:
        out.append("### Low impact / monitoring\n")
        for r in recs_low:
            out.append(f"{idx}. {r}\n")
            idx += 1

    return "\n".join(out)


# ─── Appendix ────────────────────────────────────────────────────────────────

def section_appendix(calls, logs, sessions):
    out = ["## Appendix: Raw Statistics\n", "```"]

    timestamps = []
    for log in logs:
        try:
            timestamps.append(parse_ts(log["timestamp"]))
        except (KeyError, ValueError):
            continue
    if timestamps:
        out.append(
            f"Time range: {min(timestamps).strftime('%Y-%m-%dT%H:%M:%SZ')} to "
            f"{max(timestamps).strftime('%Y-%m-%dT%H:%M:%SZ')}"
        )
    out.append(f"Total log lines: {len(logs):,}")
    out.append(f"Tool call lines: {len(calls):,}")
    errors = sum(1 for c in calls if not c["ok"])
    out.append(f"Error rate: {100 * errors / max(len(calls), 1):.2f}% ({errors}/{len(calls)})")
    out.append(f"Sessions: {len(sessions)}")
    out.append("")
    out.append("Tool call distribution:")
    tool_counts = Counter(c["tool"] for c in calls)
    for tool in TOOL_ORDER:
        if tool in tool_counts:
            p = 100 * tool_counts[tool] / len(calls)
            out.append(f"  {tool_counts[tool]:>5} {tool:<20s} ({p:.1f}%)")

    all_notations = set()
    for c in calls:
        n = c["input"].get("notation")
        if isinstance(n, list):
            all_notations.update(n)
        elif n:
            all_notations.add(n)
    out.append(f"\nUnique notations referenced: {len(all_notations)}")

    out.append("```")
    return "\n".join(out)


# ─── Main ────────────────────────────────────────────────────────────────────

def _resolve_date(s):
    if len(s) == 10:
        return datetime.fromisoformat(s + "T00:00:00+00:00")
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def main():
    parser = argparse.ArgumentParser(
        description="Analyse Iconclass MCP Railway logs → markdown report."
    )
    parser.add_argument("input", help="Path to JSONL log file")
    parser.add_argument(
        "-o", "--output", help="Write report to file (default: stdout)"
    )
    parser.add_argument(
        "--since", help="Only include calls on/after DATE (YYYY-MM-DD)"
    )
    parser.add_argument(
        "--until", help="Only include calls on/before DATE (YYYY-MM-DD)"
    )
    parser.add_argument(
        "--period", choices=["daily", "weekly", "monthly"],
        help="Sugar for --since: daily=1d, weekly=7d, monthly=30d ago"
    )
    args = parser.parse_args()

    if args.period and args.since:
        print("Cannot use both --period and --since", file=sys.stderr)
        sys.exit(1)

    since_dt = None
    until_dt = None
    if args.period:
        since_dt = datetime.now(tz=timezone.utc) - timedelta(days=PERIOD_DAYS[args.period])
    elif args.since:
        since_dt = _resolve_date(args.since)
    if args.until:
        until_dt = _resolve_date(args.until)
        if len(args.until) == 10:
            until_dt = until_dt + timedelta(hours=23, minutes=59, seconds=59)

    print(f"Loading {args.input}...", file=sys.stderr)
    logs = load_logs(args.input)
    if not logs:
        print(f"No log lines found in {args.input}", file=sys.stderr)
        sys.exit(1)

    calls = extract_tool_calls(logs)
    if not calls:
        print(
            f"No tool calls found in {len(logs)} log lines. "
            "Only startup/infrastructure logs present.",
            file=sys.stderr,
        )
        sys.exit(1)

    if since_dt or until_dt:
        before = len(calls)
        if since_dt:
            calls = [c for c in calls if c["ts"] >= since_dt]
        if until_dt:
            calls = [c for c in calls if c["ts"] <= until_dt]
        since_s = since_dt.strftime("%Y-%m-%d") if since_dt else "..."
        until_s = until_dt.strftime("%Y-%m-%d") if until_dt else "..."
        print(f"  Filtered {before} → {len(calls)} calls "
              f"({since_s} to {until_s})", file=sys.stderr)
        if not calls:
            print("No calls in date range.", file=sys.stderr)
            sys.exit(1)

    startup = extract_startup_events(logs)
    if since_dt or until_dt:
        if since_dt:
            startup = [e for e in startup if e["ts"] >= since_dt]
        if until_dt:
            startup = [e for e in startup if e["ts"] <= until_dt]

    sessions = identify_sessions(calls)
    print(
        f"  {len(calls)} tool calls, {len(sessions)} sessions, "
        f"{len(startup)} startup events",
        file=sys.stderr,
    )

    first_ts, last_ts = calls[0]["ts"], calls[-1]["ts"]
    span = last_ts - first_ts
    span_days = span.days + span.seconds / 86400

    header = "\n".join([
        f"# Iconclass MCP — Railway Log Analysis: "
        f"{first_ts.strftime('%Y-%m-%d')} to {last_ts.strftime('%Y-%m-%d')}\n",
        f"**Coverage:** {first_ts.strftime('%Y-%m-%dT%H:%MZ')} to "
        f"{last_ts.strftime('%Y-%m-%dT%H:%MZ')} (~{span_days:.1f} days)",
        f"**Source:** `railway logs --json` via analyse-railway-logs.sh",
        f"**Next analysis should start from:** "
        f"{last_ts.strftime('%Y-%m-%dT%H:%MZ')}\n",
        "---\n",
    ])

    sections = [
        header,
        section_1(calls, sessions),
        "---\n",
        section_2(calls, startup),
        "---\n",
        section_3(calls),
        "---\n",
        section_4(sessions),
        "---\n",
        section_5(calls),
        "---\n",
        section_6(calls),
        "---\n",
        section_7(calls, startup),
        "---\n",
        section_appendix(calls, logs, sessions),
    ]

    report = "\n".join(sections)

    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
