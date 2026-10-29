/**
 * In-memory two-pass cosine KNN over int8 vectors: score every candidate on the
 * first `coarseDims` components (MRL prefix), then rescore the best
 * `COARSE_CANDIDATES` on the full vector. Small candidate sets skip the first pass.
 * Queries stay float: cosine divides out both norms, so the stored int8 scale never matters.
 */

const COARSE_CANDIDATES = 500;
const EXACT_MAX = 2000;

export interface VectorHit {
  notation: string;
  similarity: number;
}

/** Indices of the k highest scores, unordered. O(n·k) worst case, but most
 *  scores fail the threshold check. */
function topK(scores: Float32Array, k: number): number[] {
  const ids = new Int32Array(k);
  const sc = new Float64Array(k).fill(-Infinity);
  let min = -Infinity, minAt = 0;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (s <= min) continue;
    ids[minAt] = i;
    sc[minAt] = s;
    min = Infinity;
    for (let j = 0; j < k; j++) if (sc[j] < min) { min = sc[j]; minAt = j; }
  }
  return Array.from(ids.subarray(0, Math.min(k, scores.length)));
}

export class VectorIndex {
  private readonly full: Int8Array;
  private readonly inv: Float32Array;
  private readonly prefixInv: Float32Array;

  constructor(
    readonly notations: string[],
    vectors: Buffer[],
    private readonly dims: number,
    private readonly coarseDims: number,
  ) {
    const n = notations.length;
    this.full = new Int8Array(n * dims);
    this.inv = new Float32Array(n);
    this.prefixInv = new Float32Array(n);
    vectors.forEach((buf, i) => {
      // A short buffer would read past its end; a long one would rank on a prefix.
      if (buf?.length !== dims) throw new Error(`Embedding for ${notations[i]} is ${buf?.length ?? "NULL"} bytes, expected ${dims}`);
      const v = new Int8Array(buf.buffer, buf.byteOffset, dims);
      this.full.set(v, i * dims);
      let ss = 0;
      for (let j = 0; j < coarseDims; j++) ss += v[j] * v[j];
      this.prefixInv[i] = ss > 0 ? 1 / Math.sqrt(ss) : 0;
      for (let j = coarseDims; j < dims; j++) ss += v[j] * v[j];
      this.inv[i] = ss > 0 ? 1 / Math.sqrt(ss) : 0;
    });
  }

  /** Top-k rows by cosine, over all rows or only the row indices in `candidates`. */
  search(q: ArrayLike<number>, k: number, candidates?: Int32Array): VectorHit[] {
    const { full, inv, prefixInv, dims, coarseDims } = this;
    const n = candidates ? candidates.length : this.notations.length;
    if (k <= 0 || n === 0) return [];

    let pool: number[];
    if (n <= EXACT_MAX) {
      pool = candidates ? Array.from(candidates) : Array.from({ length: n }, (_, i) => i);
    } else {
      const coarse = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const r = candidates ? candidates[i] : i;
        let dot = 0;
        for (let j = 0, o = r * dims; j < coarseDims; j++, o++) dot += full[o] * q[j];
        coarse[i] = dot * prefixInv[r];
      }
      pool = topK(coarse, Math.max(COARSE_CANDIDATES, k * 8));
      if (candidates) pool = pool.map(i => candidates[i]);
    }

    let qq = 0;
    for (let j = 0; j < dims; j++) qq += q[j] * q[j];
    const qInv = qq > 0 ? 1 / Math.sqrt(qq) : 0;
    return pool
      .map(r => {
        let dot = 0;
        for (let j = 0, o = r * dims; j < dims; j++, o++) dot += full[o] * q[j];
        return { r, s: dot * inv[r] * qInv };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ r, s }) => ({ notation: this.notations[r], similarity: s }));
  }
}
