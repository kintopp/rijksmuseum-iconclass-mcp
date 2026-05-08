#!/usr/bin/env python3
"""
For each idiosyncratic notation in vocabulary.db (that doesn't exist in iconclass.db),
check whether it's likely a typo by inspecting hierarchical neighbors.

Strategy per code:
  1. Walk up the hierarchy by chopping trailing digits — find the deepest ancestor that exists.
  2. Generate Levenshtein-1 candidates (single-digit substitution / deletion / insertion at any position)
     and check which exist in iconclass.db.
  3. For each candidate, fetch the English label so a human can judge.
"""

import sqlite3
import sys

VOCAB_DB = "/Users/bosse0000/Documents/GitHub/rijksmuseum-mcp-plus/data/vocabulary.db"
ICONCLASS_DB = "/Users/bosse0000/Documents/GitHub/rijksmuseum-iconclass-mcp/data/iconclass.db"

CODES = [
    "48A7211", "48C14231", "46A341", "48C6253", "49G359", "43B314",
    "31A5163", "32B3212", "41A71222", "73C941", "43C133", "31A25315",
    "48O", "41D312", "31A5162", "25O",
]

def get_label(ic, notation):
    row = ic.execute(
        "SELECT text FROM texts WHERE notation = ? AND lang = 'en' LIMIT 1",
        (notation,),
    ).fetchone()
    return row[0] if row else None

def exists(ic, notation):
    row = ic.execute("SELECT 1 FROM notations WHERE notation = ?", (notation,)).fetchone()
    return row is not None

def chop_to_ancestor(ic, code):
    cur = code
    while cur:
        cur = cur[:-1]
        if not cur:
            return None, None
        if exists(ic, cur):
            return cur, get_label(ic, cur)
    return None, None

def levenshtein_1_candidates(code):
    """Generate all single-character substitution / deletion / insertion variants."""
    digits = "0123456789"
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    seen = set()
    out = []
    # Substitutions
    for i, ch in enumerate(code):
        pool = digits if ch.isdigit() else letters
        for r in pool:
            if r == ch:
                continue
            cand = code[:i] + r + code[i+1:]
            if cand not in seen:
                seen.add(cand)
                out.append(("sub", i, ch, r, cand))
    # Deletions
    for i in range(len(code)):
        cand = code[:i] + code[i+1:]
        if cand and cand not in seen:
            seen.add(cand)
            out.append(("del", i, code[i], "", cand))
    # Insertions (digits only — alpha insertions in numeric runs are usually wrong)
    for i in range(len(code) + 1):
        for r in digits:
            cand = code[:i] + r + code[i:]
            if cand not in seen:
                seen.add(cand)
                out.append(("ins", i, "", r, cand))
    return out

def main():
    ic = sqlite3.connect(f"file:{ICONCLASS_DB}?mode=ro", uri=True)

    for code in CODES:
        print(f"\n=== {code} ===")
        # Vocab label
        v = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
        row = v.execute(
            "SELECT label_en, COUNT(DISTINCT m.artwork_id) "
            "FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid "
            "WHERE v.notation = ? AND m.field_id = 12 GROUP BY v.label_en",
            (code,),
        ).fetchone()
        v.close()
        vocab_label = row[0] if row else None
        artwork_count = row[1] if row else 0
        print(f"  Rijksmuseum label: {vocab_label}")
        print(f"  Artworks: {artwork_count}")

        # Ancestor
        anc, anc_label = chop_to_ancestor(ic, code)
        print(f"  Deepest ancestor in iconclass.db: {anc} — {anc_label}")

        # Levenshtein-1 candidates that exist
        matches = []
        for kind, pos, before, after, cand in levenshtein_1_candidates(code):
            if exists(ic, cand):
                lbl = get_label(ic, cand)
                matches.append((kind, pos, before, after, cand, lbl))

        if matches:
            print(f"  Edit-distance-1 matches:")
            for kind, pos, before, after, cand, lbl in matches[:10]:
                op = f"{kind}@{pos}: '{before}'→'{after}'"
                print(f"    {cand:<12} ({op:<20}) — {lbl}")
        else:
            print("  No edit-distance-1 matches.")

    ic.close()

if __name__ == "__main__":
    main()
