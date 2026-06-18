import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-base";

/** MRL truncation: cut a vector to targetDim and re-normalize to unit length.
 *  No-op when targetDim is 0 or the vector is already <= targetDim. */
export function mrlTruncate(vec: Float32Array, targetDim: number): Float32Array {
  if (targetDim <= 0 || vec.length <= targetDim) return vec;
  const out = vec.slice(0, targetDim);
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 1e-10) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export class EmbeddingModel {
  private pipe: FeatureExtractionPipeline | null = null;
  private _modelId: string = "";
  private queryPrefix = "query: ";
  private targetDim = 0;

  /**
   * Initialize the model. Downloads from HuggingFace Hub on first use,
   * or loads from a local cache/path.
   *
   * @param modelId   - HuggingFace model ID or local path
   * @param targetDim - MRL truncation target dimension (0 = no truncation).
   */
  async init(modelId: string = DEFAULT_MODEL_ID, targetDim = 0): Promise<void> {
    this._modelId = modelId;
    this.targetDim = targetDim;

    // EmbeddingGemma uses a different prefix convention than E5 models.
    if (modelId.toLowerCase().includes("embeddinggemma")) {
      this.queryPrefix = "task: search result | query: ";
    }

    try {
      const { pipeline, env } = await import("@huggingface/transformers");

      // transformers.js does NOT read HF_HOME / TRANSFORMERS_CACHE (unlike Python's
      // huggingface_hub) — it only honors env.cacheDir, which defaults to
      // node_modules/@huggingface/transformers/.cache. On Railway that path is on the
      // ephemeral image filesystem, so the model re-downloads on every deploy. Redirect
      // the cache onto the persistent volume when HF_HOME is set so the q8 weights and
      // tokenizer survive restarts. FileCache.put() mkdir's the tree, so the dir need
      // not pre-exist — the volume just has to be mounted.
      if (process.env.HF_HOME) {
        env.cacheDir = process.env.HF_HOME;
        console.error(`Embedding model cache dir: ${env.cacheDir}`);
      }

      // pipeline()'s generic return type Promise<AllTasks[T]> is too wide for
      // tsc to evaluate at the call site (TS2590). Narrow the function shape
      // before calling so we get a concrete FeatureExtractionPipeline.
      type PipelineOpts = Parameters<typeof pipeline>[2];
      const featurePipeline = pipeline as (
        task: "feature-extraction",
        model: string,
        opts?: PipelineOpts,
      ) => Promise<FeatureExtractionPipeline>;
      this.pipe = await featurePipeline("feature-extraction", modelId, {
        dtype: "q8",   // int8 quantized ONNX
      });
      console.error(`Embedding model loaded: ${modelId}${targetDim > 0 ? ` (MRL ${targetDim}d)` : ""}`);
    } catch (err) {
      console.error(`Failed to load embedding model: ${err instanceof Error ? err.message : err}`);
      this.pipe = null;
    }
  }

  get available(): boolean { return this.pipe !== null; }
  get modelId(): string { return this._modelId; }

  /**
   * Embed a single query string. Returns a Float32Array.
   *
   * Applies the model-appropriate query prefix (E5: "query: ").
   * When targetDim is set and the model outputs more dimensions than
   * targetDim, truncates and re-normalizes (MRL truncation).
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) throw new Error("Embedding model not initialized");

    const output = await this.pipe(this.queryPrefix + text, {
      pooling: "mean",
      normalize: true,
    });

    // output.data is the pipeline's raw typed array (Float32Array for a normalized
    // feature-extraction run). The transformers DataArray union widens the static
    // type to include integer/bigint arrays, so coerce to a numeric ArrayLike for the
    // Float32Array constructor (TS's generic typed-array types reject the bare union).
    const vec = new Float32Array(output.data as ArrayLike<number>);

    // MRL truncation: when the DB was built at a lower dimension than the model
    // outputs, truncate and re-normalize so the query vector matches stored embeddings.
    return mrlTruncate(vec, this.targetDim);
  }
}
