import { logInfo, logWarn } from "../utils/log.js";

// EmbeddingGemma 2 query encoder, shared with rijksmuseum-mcp-plus. Pinned so a
// re-export upstream can't silently shift the query space away from the stored
// vectors; scripts/import-gemma-embeddings.py records the same pair in version_info.
export const QUERY_MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const QUERY_MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
const QUERY_PREFIX = "task: search result | query: ";

export class EmbeddingModel {
  // transformers.js model/tokenizer types are too broad to express usefully.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null;
  // Cached load promise. init() is called once at startup to KICK OFF the load
  // without awaiting it (so the ONNX load never gates app.listen() / a
  // scale-to-zero wake), and embed() awaits this same promise lazily.
  private initPromise: Promise<void> | null = null;

  /**
   * Begin loading the model; returns a promise that settles when it is ready
   * (loaded or failed). Idempotent — repeated calls return the same promise.
   */
  init(): Promise<void> {
    this.initPromise ??= this.load();
    return this.initPromise;
  }

  private async load(): Promise<void> {
    // onnxruntime sizes its pool from the visible cores, not the cgroup quota —
    // on Railway that oversubscribes and triples latency. Always set it.
    const threads = Number(process.env.EMBEDDING_THREADS ?? 2);
    // q8 ≈ +480 MB RSS / ~120 ms per query on Railway; fp32 ≈ +1 GB / ~28 ms.
    const dtype = process.env.EMBEDDING_MODEL_DTYPE ?? "q8";
    try {
      const { AutoConfig, AutoModel, AutoTokenizer, env } = await import("@huggingface/transformers");

      // transformers.js does NOT read HF_HOME (unlike Python's huggingface_hub) —
      // it only honors env.cacheDir, which defaults to node_modules/…/.cache, on
      // Railway's ephemeral image FS. Point it at the persistent volume.
      if (process.env.HF_HOME) {
        env.cacheDir = process.env.HF_HOME;
        logInfo(`Embedding model cache dir: ${env.cacheDir}`);
      }

      const opts = { revision: QUERY_MODEL_REVISION };
      // Text tower only: the feature-extraction pipeline would also load the
      // vision and audio encoders (~+325 MB RSS) that text queries never use.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = await AutoConfig.from_pretrained(QUERY_MODEL_ID, opts);
      config.vision_config = config.audio_config = null;
      this.model = await AutoModel.from_pretrained(QUERY_MODEL_ID, {
        ...opts,
        config,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dtype: dtype as any,
        device: "cpu",
        session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
      });
      this.tokenizer = await AutoTokenizer.from_pretrained(QUERY_MODEL_ID, opts);
      // onnxruntime defers ~300 ms of setup to the first run; pay it here, off the query path.
      await this.model(await this.tokenizer([QUERY_PREFIX]));
      logInfo(`Embedding model loaded: ${QUERY_MODEL_ID} (${dtype}, ${threads} threads)`);
    } catch (err) {
      // Same degraded state as an incomplete embeddings table: semantic search
      // is gone, FTS still serves. Kept at the same level as that path.
      logWarn("Failed to load embedding model", err);
      this.model = null;
    }
  }

  get available(): boolean { return this.model !== null; }

  /** Resolve once the load settles (whether it loaded or failed), starting it
   *  if init() was never called. Lets a query lazily wait for a model that is
   *  still loading in the background after a wake, or was never kicked off. */
  async whenReady(): Promise<void> {
    await this.init();
  }

  /** Embed a search query, L2-normalised. */
  async embed(text: string): Promise<Float32Array> {
    await this.whenReady();   // the model may still be loading in the background
    if (!this.available) throw new Error("Embedding model not initialized");
    const out = await this.model(await this.tokenizer([QUERY_PREFIX + text]));
    return new Float32Array(out.sentence_embedding.normalize(2, -1).data as ArrayLike<number>);
  }
}
