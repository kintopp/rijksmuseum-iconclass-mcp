#!/usr/bin/env python3
"""
Generate EmbeddingGemma 2 embeddings for Iconclass base notations on a Modal GPU.

Only base notations (~40K) are embedded — key-expanded notations (1.3M) are
searchable via FTS but not embedded, since their meaning is compositional
(base concept + key modifier) and FTS handles keyword matching.

  Phase 1 (local):     Build composite texts from iconclass.db (base notations only)
  Phase 2 (cloud GPU): Embed them as documents ("title: none | text: …") on an A10G
  Phase 3 (local):     Write float16 vectors to an npz; sanity-check a few queries

Then load the npz into the DB with scripts/import-gemma-embeddings.py, which
quantises to int8 and records the model revisions in version_info.

Usage:
    ~/miniconda3/envs/embeddings/bin/modal run scripts/generate-embeddings-modal.py
    ~/miniconda3/envs/embeddings/bin/modal run scripts/generate-embeddings-modal.py --limit 1000

Prerequisites:
    pip install modal numpy    # in the same Python env
    modal setup                # one-time auth
    A Modal secret named by HF_SECRET_NAME (default huggingface-secret) holding HF_TOKEN.

Output: data/iconclass-gemma.npz (object_number = notation, vec = float16 768d, L2-normalised)
"""

import os
import sqlite3
import time
from pathlib import Path

import modal
import numpy as np

# ─── Constants ──────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_ICONCLASS_DB = PROJECT_DIR / "data" / "iconclass.db"
DEFAULT_OUT = PROJECT_DIR / "data" / "iconclass-gemma.npz"

# Must match MODEL / MODEL_REVISION in scripts/import-gemma-embeddings.py.
MODEL_NAME = "google/embeddinggemma-2"
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
TEXT_MAX_TOKENS = 1024
MODAL_BATCH_SIZE = 512


# ─── Modal app ──────────────────────────────────────────────────────────

app = modal.App("iconclass-embeddings-gemma2")

HF_SECRET_NAME = os.environ.get("HF_SECRET_NAME", "huggingface-secret")
hf_secrets = [modal.Secret.from_name(HF_SECRET_NAME)]


def download_model():
    """Download model weights at image build time (cached in image layer)."""
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(MODEL_NAME, revision=REVISION, config_kwargs={"audio_config": None})


gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers==5.19.0",
        "sentence-transformers==6.1.0",
        "torch==2.10.0",
        "torchvision==0.25.0",
        "pillow",
        "numpy",
    )
    .run_function(download_model, secrets=hf_secrets)
    .env({"HF_HUB_OFFLINE": "1"})
)


@app.cls(gpu="A10G", image=gpu_image, secrets=hf_secrets, scaledown_window=60, timeout=3600)
class Embedder:
    @modal.enter()
    def load(self):
        import torch
        from sentence_transformers import SentenceTransformer
        # bf16, never fp16: the model's activations overflow fp16 into NaNs
        self.model = SentenceTransformer(MODEL_NAME, revision=REVISION, device="cuda",
                                         config_kwargs={"audio_config": None},
                                         model_kwargs={"torch_dtype": torch.bfloat16})
        self.model.max_seq_length = TEXT_MAX_TOKENS

    @modal.method()
    def embed_documents(self, texts: list[str]) -> np.ndarray:
        vecs = self.model.encode_document(texts, batch_size=64, normalize_embeddings=True, convert_to_numpy=True)
        return vecs.astype(np.float16)

    @modal.method()
    def embed_queries(self, texts: list[str]) -> np.ndarray:
        return self.model.encode_query(texts, normalize_embeddings=True, convert_to_numpy=True).astype(np.float32)


# ─── Local helpers (run on your Mac) ────────────────────────────────────


def load_iconclass_texts(db_path: str) -> list[tuple[str, str]]:
    """Build composite texts from iconclass.db for embedding.

    Only base notations (is_key_expanded = 0) are included.

    For each notation, builds:
      [Description] {EN text} [Description NL] {NL text} [Keywords] {kw1, kw2, ...}
      [Category] {root label} > {parent label} > ... > {current label}

    Returns list of (notation, composite_text) tuples.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # 1. Base notations only
    print("  Loading base notations...")
    notations = conn.execute(
        "SELECT notation, path FROM notations WHERE is_key_expanded = 0"
    ).fetchall()
    notation_paths = {row["notation"]: row["path"] for row in notations}
    print(f"    {len(notations):,} base notations (key-expanded excluded)")

    # 2. Texts per notation (EN + NL)
    print("  Loading texts...")
    text_rows = conn.execute(
        "SELECT notation, lang, text FROM texts WHERE lang IN ('en', 'nl')"
    ).fetchall()
    texts_map: dict[str, dict[str, str]] = {}
    for row in text_rows:
        texts_map.setdefault(row["notation"], {})[row["lang"]] = row["text"]
    print(f"    {len(text_rows):,} text entries")

    # 3. Keywords per notation (EN + NL, deduplicated)
    print("  Loading keywords...")
    kw_rows = conn.execute(
        "SELECT notation, lang, keyword FROM keywords WHERE lang IN ('en', 'nl')"
    ).fetchall()
    kw_map: dict[str, list[str]] = {}
    for row in kw_rows:
        kw_map.setdefault(row["notation"], []).append(row["keyword"])
    print(f"    {len(kw_rows):,} keyword entries")

    # 4. EN text lookup for path label resolution
    en_text_map: dict[str, str] = {}
    for notation, langs in texts_map.items():
        if "en" in langs:
            en_text_map[notation] = langs["en"]
        elif "nl" in langs:
            en_text_map[notation] = langs["nl"]

    # 5. Build composite texts (base notations only)
    print("  Building composite texts...")
    import json

    results: list[tuple[str, str]] = []
    skipped = 0

    for row in notations:
        notation = row["notation"]
        langs = texts_map.get(notation, {})

        if not langs and notation not in kw_map:
            skipped += 1
            continue

        parts: list[str] = []

        # Description (EN)
        if "en" in langs:
            parts.append(f"[Description] {langs['en']}")

        # Description (NL)
        if "nl" in langs:
            parts.append(f"[Description NL] {langs['nl']}")

        # Keywords (deduplicated)
        keywords = kw_map.get(notation, [])
        if keywords:
            unique_kw = list(dict.fromkeys(keywords))
            parts.append(f"[Keywords] {', '.join(unique_kw)}")

        # Category path
        path_notations = json.loads(notation_paths.get(notation, "[]"))
        if path_notations:
            path_labels = [en_text_map.get(a, a) for a in path_notations]
            current_label = en_text_map.get(notation, notation)
            path_labels.append(current_label)
            parts.append(f"[Category] {' > '.join(path_labels)}")

        if parts:
            results.append((notation, " ".join(parts)))
        else:
            skipped += 1

    conn.close()
    print(f"    {len(results):,} composite texts built, {skipped} skipped")
    if results:
        avg_len = sum(len(t) for _, t in results) / len(results)
        print(f"    Average composite text length: {avg_len:.0f} chars")

    return results


def validate(db_path: str, notations: list[str], vecs: np.ndarray, embedder) -> None:
    """Print the top 5 notations for a few test queries (exact cosine over the npz)."""
    queries = [
        "dogs and domestic animals",
        "crucifixion of Christ",
        "Kreuzigung Christi",
        "ships and naval vessels",
        "portrait of a woman",
        "mythological creatures",
    ]
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    docs = vecs.astype(np.float32)
    for query, q in zip(queries, embedder.embed_queries.remote(queries)):
        sims = docs @ q
        print(f'\n  Query: "{query}"')
        for i in np.argsort(-sims)[:5]:
            label = conn.execute(
                "SELECT text FROM texts WHERE notation = ? AND lang = 'en' LIMIT 1", (notations[i],)
            ).fetchone()
            print(f"    [{sims[i]:.3f}] {notations[i]} — {label[0] if label else notations[i]}")
    conn.close()


# ─── Entrypoint ─────────────────────────────────────────────────────────


@app.local_entrypoint()
def main(limit: int = 0, batch_size: int = MODAL_BATCH_SIZE, out: str = str(DEFAULT_OUT)):
    start = time.time()
    db_path = str(DEFAULT_ICONCLASS_DB)
    print(f"Iconclass embeddings via Modal: {MODEL_NAME}@{REVISION[:7]}")

    if not os.path.exists(db_path):
        print(f"ERROR: iconclass.db not found at {db_path}")
        print("Run scripts/build-iconclass-db.py first.")
        return

    print("\nPhase 1: Building composite texts from iconclass.db...")
    all_texts = load_iconclass_texts(db_path)
    if limit > 0:
        all_texts = all_texts[:limit]
        print(f"  --limit {limit}: using first {len(all_texts):,} notations")

    chunks = [all_texts[i:i + batch_size] for i in range(0, len(all_texts), batch_size)]
    print(f"\nPhase 2: Embedding {len(all_texts):,} texts in {len(chunks)} batches...")
    embedder = Embedder()
    parts = list(embedder.embed_documents.map([[t for _, t in c] for c in chunks]))
    vecs = np.concatenate(parts)
    notations = [n for n, _ in all_texts]
    if np.isnan(vecs).any():
        raise SystemExit("NaN in embeddings — check the model dtype (must be bf16, not fp16)")

    np.savez(out, art_id=np.full(len(notations), -1), object_number=np.array(notations), vec=vecs)
    print(f"\nPhase 3: wrote {out} ({len(notations):,} × {vecs.shape[1]}d) in {time.time() - start:.0f}s")
    validate(db_path, notations, vecs, embedder)
    print(f"\nNext: python scripts/import-gemma-embeddings.py --npz {out} --db {db_path}")


if __name__ == "__main__":
    print("Use: modal run scripts/generate-embeddings-modal.py [--limit N]")
    print("Not: python scripts/generate-embeddings-modal.py")
