#!/usr/bin/env python3
"""
Replace iconclass.db's embeddings with EmbeddingGemma 2 vectors from an npz.

The npz holds object_number (= notation) and vec (float16, L2-normalised), as written
by scripts/generate-embeddings-modal.py or rijksmuseum-mcp-plus
scripts/embed-corpus-embeddinggemma2-modal.py --texts iconclass (same composite text).
Rewrites iconclass_embeddings and the embedding keys in version_info, and drops the
vec0 table older builds carried (the server ranks vectors in memory).

Usage:
    ~/miniconda3/envs/embeddings/bin/python scripts/import-gemma-embeddings.py \
        --npz data/iconclass-gemma.npz --db data/iconclass.db
"""

import argparse
import sqlite3
from datetime import datetime, timezone

import numpy as np
import sqlite_vec

MODEL = "google/embeddinggemma-2"
MODEL_REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
# Must match QUERY_MODEL_ID / QUERY_MODEL_REVISION in src/api/EmbeddingModel.ts.
QUERY_MODEL = "onnx-community/embeddinggemma-2-ONNX"
QUERY_MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
SCHEMA_VERSION = "4"  # v4 = EmbeddingGemma 2 vectors with a stored int8 scale, no vec0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True)
    ap.add_argument("--db", required=True)
    args = ap.parse_args()

    z = np.load(args.npz)
    notations = z["object_number"].tolist()
    vecs = z["vec"].astype(np.float32)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    dims = vecs.shape[1]
    # Gemma components peak ~0.35, so ×127 would use under half the int8 range.
    # Cosine is scale-invariant; the server quantises queries with the same scale.
    scale = float(np.floor(127 / np.abs(vecs).max()))
    q = np.clip(np.rint(vecs * scale), -127, 127).astype(np.int8)

    conn = sqlite3.connect(args.db)
    # Loaded only so DROP TABLE can remove a vec0 table left by an older build.
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)

    base = {r[0] for r in conn.execute("SELECT notation FROM notations WHERE is_key_expanded = 0")}
    missing, extra = base - set(notations), set(notations) - base
    if missing or extra:
        raise SystemExit(f"npz/base mismatch: {len(missing)} base notations missing, {len(extra)} unknown")

    with conn:
        conn.execute("DROP TABLE IF EXISTS vec_iconclass")
        conn.execute("DROP TABLE IF EXISTS iconclass_embeddings")
        conn.execute("""
            CREATE TABLE iconclass_embeddings (
                notation TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        """)
        conn.executemany(
            "INSERT INTO iconclass_embeddings (notation, embedding) VALUES (?, ?)",
            [(n, v.tobytes()) for n, v in zip(notations, q)],
        )
        conn.execute("DELETE FROM version_info WHERE key LIKE 'embedding%'")
        conn.executemany("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", [
            ("embedding_model", MODEL),
            ("embedding_model_revision", MODEL_REVISION),
            ("embedding_query_model", QUERY_MODEL),
            ("embedding_query_model_revision", QUERY_MODEL_REVISION),
            ("embedding_dimensions", str(dims)),
            ("embedding_int8_scale", str(int(scale))),
            ("embedding_count", str(len(notations))),
            ("embeddings_built_at", datetime.now(timezone.utc).isoformat()),
            ("schema_version", SCHEMA_VERSION),
        ])
    print(f"{len(notations):,} vectors, {dims}d, int8 scale {int(scale)}")
    print("VACUUM (reclaims the dropped tables' pages)...")
    conn.execute("VACUUM")
    conn.close()


if __name__ == "__main__":
    main()
