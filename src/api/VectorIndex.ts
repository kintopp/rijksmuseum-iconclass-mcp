/**
 * In-memory two-pass cosine KNN over int8 vectors: score every candidate on the
 * first `coarseDims` components (MRL prefix), then rescore the best
 * `COARSE_CANDIDATES` on the full vector. Small candidate sets skip the first pass.
 */

const COARSE_CANDIDATES = 500;
const EXACT_MAX = 2000;

export interface VectorHit {
  notation: string;
  similarity: number;
}

/** Rows with the k highest scores, unordered. O(n·k) worst case, but most
 *  scores fail the threshold check. */
function topK(k: number, n: number, score: (i: number) => number, row: (i: number) => number): number[] {
  const ids = new Int32Array(k);
  const sc = new Float64Array(k).fill(-Infinity);
  let min = -Infinity, minAt = 0;
  for (let i = 0; i < n; i++) {
    const s = score(i);
    if (s <= min) continue;
    ids[minAt] = row(i);
    sc[minAt] = s;
    min = Infinity;
    for (let j = 0; j < k; j++) if (sc[j] < min) { min = sc[j]; minAt = j; }
  }
  return Array.from(ids.subarray(0, Math.min(k, n)));
}

export class VectorIndex {
  private readonly full: Int8Array;
  private readonly inv: Float32Array;
  private readonly prefix: Int8Array;
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
    this.prefix = new Int8Array(n * coarseDims);
    this.prefixInv = new Float32Array(n);
    vectors.forEach((buf, i) => {
      const v = new Int8Array(buf.buffer, buf.byteOffset, dims);
      this.full.set(v, i * dims);
      this.prefix.set(v.subarray(0, coarseDims), i * coarseDims);
      let ss = 0, ps = 0;
      for (let j = 0; j < dims; j++) {
        ss += v[j] * v[j];
        if (j < coarseDims) ps += v[j] * v[j];
      }
      this.inv[i] = ss > 0 ? 1 / Math.sqrt(ss) : 0;
      this.prefixInv[i] = ps > 0 ? 1 / Math.sqrt(ps) : 0;
    });
  }

  get size(): number { return this.notations.length; }

  /** Top-k rows by cosine, over all rows or only the row indices in `candidates`. */
  search(q: Int8Array, k: number, candidates?: Int32Array): VectorHit[] {
    const n = candidates ? candidates.length : this.notations.length;
    if (k <= 0 || n === 0) return [];
    const row = candidates ? (i: number) => candidates[i] : (i: number) => i;

    let qq = 0;
    for (let j = 0; j < this.dims; j++) qq += q[j] * q[j];
    const qInv = qq > 0 ? 1 / Math.sqrt(qq) : 0;
    const { full, inv, prefix, prefixInv, dims, coarseDims } = this;
    const exact = (r: number): number => {
      let dot = 0;
      for (let j = 0, o = r * dims; j < dims; j++, o++) dot += full[o] * q[j];
      return dot * inv[r] * qInv;
    };

    let pool: number[];
    if (n <= EXACT_MAX) {
      pool = Array.from({ length: n }, (_, i) => row(i));
    } else {
      pool = topK(Math.max(COARSE_CANDIDATES, k * 8), n, (i) => {
        const r = row(i);
        let dot = 0;
        for (let j = 0, o = r * coarseDims; j < coarseDims; j++, o++) dot += prefix[o] * q[j];
        return dot * prefixInv[r];
      }, row);
    }
    return pool
      .map(r => ({ r, s: exact(r) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ r, s }) => ({ notation: this.notations[r], similarity: s }));
  }
}
