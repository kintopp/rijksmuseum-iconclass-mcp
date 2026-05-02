# Modal Embedding Script Requires Undocumented Secret

Priority: P3
Area: Developer tooling / embedding generation
Source: `scripts/generate-embeddings-modal.py`

## Summary

The Modal embedding script always mounts a Modal secret named `huggingface-secret`:

```py
hf_secret = modal.Secret.from_name("huggingface-secret")
```

The technical guide only tells users to run `modal setup`, and the configured model is public. A fresh user following the documented setup can fail before generating embeddings because the required secret does not exist.

## Impact

Developers rebuilding semantic embeddings may hit an avoidable setup failure. The failure is confusing because the model does not appear to require authentication and the documentation does not mention creating a Modal secret.

## Affected Code

`scripts/generate-embeddings-modal.py`

```py
hf_secret = modal.Secret.from_name("huggingface-secret")

gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    ...
    .run_function(download_model, secrets=[hf_secret])
)

@app.cls(gpu="A10G", image=gpu_image, secrets=[hf_secret], scaledown_window=60, timeout=3600)
class Embedder:
    ...
```

Related docs:

`docs/technical-guide.md`

```bash
uv pip install modal sqlite-vec numpy
modal setup
modal run scripts/generate-embeddings-modal.py
```

## Reproduction

1. Use a Modal account with no secret named `huggingface-secret`.
2. Follow the documented setup in `docs/technical-guide.md`.
3. Run:

```bash
modal run scripts/generate-embeddings-modal.py
```

4. Observe that the run fails while resolving or mounting the missing secret.

## Recommended Fix

Choose one of these paths:

1. Make the Hugging Face secret optional, since `intfloat/multilingual-e5-base` is public.
2. Document the secret requirement explicitly and include the setup command.
3. Add a CLI/env switch such as `--hf-secret huggingface-secret` for private or rate-limited model usage.

The least surprising default is to run without a secret and only mount one when explicitly configured.

## Acceptance Criteria

- A fresh Modal user can run the documented embedding command without creating an undocumented secret.
- If a Hugging Face token is still supported, its setup is documented.
- The script fails with a clear message when a user explicitly asks for a missing secret.
- The technical guide and script behavior agree.
