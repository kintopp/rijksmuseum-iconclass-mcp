import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-base";

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
      const { pipeline } = await import("@huggingface/transformers");
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

    let vec = new Float32Array(output.data);

    // MRL truncation: when the DB was built at a lower dimension than the model
    // outputs, truncate and re-normalize so the query vector matches stored embeddings.
    if (this.targetDim > 0 && vec.length > this.targetDim) {
      vec = vec.slice(0, this.targetDim);
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 1e-10) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    return vec;
  }
}
