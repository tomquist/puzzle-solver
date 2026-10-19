/**
 * Comparison of two piece sides that may touch: their shape profiles and the colour strips just
 * inside them. Point by point, or with dynamic time warping (DTW) inside a narrow Sakoe-Chiba band,
 * which lets the two sequences shift and stretch against each other by a few samples – what a body
 * corner found a few pixels off along the outline does to a profile or a strip.
 */

/** Options of {@link dtwDistance}. */
export interface DtwOptions {
  /** Sakoe-Chiba band half-width in samples: the path stays within this many samples of the diagonal (0 = point by point). */
  band: number;
  /** Values per sample (interleaved; default 1). */
  dim?: number;
  /** Per-component weights of the squared cost (default 1 each). */
  weights?: readonly number[];
}

// Reused DP rows (the comparisons run for every pair of sides of a scan).
let rowPrev = new Float64Array(64);
let rowCur = new Float64Array(64);

/**
 * Banded DTW distance between sequences `a` (n samples) and `b` (m samples) of `dim` values each:
 * the smallest sum of weighted squared differences along a monotone path from the first to the last
 * sample pair (steps: both advance, or one of them), divided by the sample count max(n, m), square
 * root. Without warping (band 0, equal lengths) it is the RMS difference; it never exceeds it.
 * Infinity when a sequence is empty.
 */
export function dtwDistance(a: ArrayLike<number>, b: ArrayLike<number>, opts: DtwOptions): number {
  const dim = opts.dim ?? 1;
  const n = Math.floor(a.length / dim), m = Math.floor(b.length / dim);
  if (n === 0 || m === 0) return Infinity;
  const w0 = opts.weights?.[0] ?? 1, w1 = opts.weights?.[1] ?? 1, w2 = opts.weights?.[2] ?? 1;
  const w = opts.weights;
  // Squared weighted difference of samples i and j (inlined for 1 and 3 values per sample).
  const cost = (i: number, j: number): number => {
    if (dim === 1) {
      const d = a[i] - b[j];
      return w0 * d * d;
    }
    if (dim === 3) {
      const p = i * 3, q = j * 3;
      const d0 = a[p] - b[q], d1 = a[p + 1] - b[q + 1], d2 = a[p + 2] - b[q + 2];
      return w0 * d0 * d0 + w1 * d1 * d1 + w2 * d2 * d2;
    }
    let s = 0;
    for (let c = 0; c < dim; c++) {
      const d = a[i * dim + c] - b[j * dim + c];
      s += (w ? w[c] : 1) * d * d;
    }
    return s;
  };
  // The band follows the diagonal of the n × m grid; it is widened just enough to stay connected.
  const slope = n > 1 ? (m - 1) / (n - 1) : 0;
  const band = Math.max(opts.band, Math.ceil(slope) - 1, 0);
  if (rowPrev.length < m) {
    rowPrev = new Float64Array(m);
    rowCur = new Float64Array(m);
  }
  let prev = rowPrev, cur = rowCur;
  let pLo = 0, pHi = -1;
  for (let i = 0; i < n; i++) {
    const centre = i * slope;
    const lo = Math.max(0, Math.floor(centre - band + 1e-9)), hi = Math.min(m - 1, Math.ceil(centre + band - 1e-9));
    for (let j = lo; j <= hi; j++) {
      let best: number;
      if (i === 0) best = j === 0 ? 0 : j - 1 >= lo ? cur[j - 1] : Infinity;
      else {
        best = Infinity;
        if (j >= pLo && j <= pHi) best = prev[j];
        if (j - 1 >= pLo && j - 1 <= pHi && prev[j - 1] < best) best = prev[j - 1];
        if (j - 1 >= lo && cur[j - 1] < best) best = cur[j - 1];
      }
      cur[j] = best + cost(i, j);
    }
    const t = prev;
    prev = cur;
    cur = t;
    pLo = lo;
    pHi = hi;
  }
  const total = pHi === m - 1 ? prev[m - 1] : Infinity;
  return Math.sqrt(total / Math.max(n, m));
}

/** Side profiles are compared with this DTW band (samples; 2 of 32 ≈ 6 % of the side). */
export const PROFILE_DTW_BAND = 2;

// Reversed, negated partner profile and the de-trended profile (reused).
let flipped = new Float64Array(32);
let levelled = new Float64Array(32);

/**
 * DTW counterpart of the point-wise profile mismatch: profile `a` against the reversed, negated
 * profile `b` (how the partner's side runs along the same cut), band in samples. 0 = perfect fit;
 * never more than the point-wise RMS.
 *
 * With `detrend`, the best straight line through the point-wise difference is removed from `a`
 * first: a corner that slid along the neighbouring side moves this side's end off its true
 * position across the side, which tilts the whole profile (a ramp no warping can absorb).
 */
export function profileMismatchDtw(a: readonly number[], b: readonly number[], band = PROFILE_DTW_BAND, detrend = false): number {
  const n = a.length, m = b.length;
  if (flipped.length < m) flipped = new Float64Array(m);
  const f = flipped.subarray(0, m);
  for (let k = 0; k < m; k++) f[k] = -b[m - 1 - k];
  if (!detrend || n !== m || n < 3) return dtwDistance(a, f, { band });
  // Least-squares line c0 + c1·t (t = 0 … 1) through a − f.
  let st = 0, sd = 0, stt = 0, std = 0;
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1), d = a[k] - f[k];
    st += t;
    sd += d;
    stt += t * t;
    std += t * d;
  }
  const den = n * stt - st * st;
  const c1 = den > 1e-12 ? (n * std - st * sd) / den : 0;
  const c0 = (sd - c1 * st) / n;
  if (levelled.length < n) levelled = new Float64Array(n);
  const l = levelled.subarray(0, n);
  for (let k = 0; k < n; k++) l[k] = a[k] - c0 - (c1 * k) / (n - 1);
  return dtwDistance(l, f, { band });
}

/** Options of {@link stripMismatch}. */
export interface StripCompareOptions {
  /** DTW band in samples (0 = point by point; default {@link STRIP_DTW_BAND}). */
  band?: number;
  /** Weights of the squared L*, a*, b* differences (default {@link STRIP_WEIGHTS}: chroma counts more). */
  weights?: readonly [number, number, number];
  /**
   * Largest lighting gain (as a factor on L*a*b*, ≥ 1) compensated between the two strips before
   * comparing: lamp gradients and shading make one piece a little brighter than its partner
   * (default {@link STRIP_MAX_GAIN}; 1 = none).
   */
  maxGain?: number;
}

/** Colour strips are compared with this DTW band (samples). */
export const STRIP_DTW_BAND = 2;
/** L*, a*, b* weights for strip comparison: lightness differs most with lighting, so it counts less. */
export const STRIP_WEIGHTS: readonly [number, number, number] = [0.5, 1, 1];
/** Lighting gain compensated between two strips at most (L*a*b* scale roughly with the cube root of the light). */
export const STRIP_MAX_GAIN = 1.15;

// Reversed, gain-corrected partner strip (reused).
let flippedStrip = new Float64Array(96);

/**
 * Colour mismatch of two sides' strips (Lab triples from each side's start corner to its end
 * corner, see `sampleEdgeStrips`): strip `a` against the reversed strip `b`, after compensating a
 * small lighting gain between them; weighted Lab distance per sample (DTW-aligned), RMS. 0 = the
 * same colours along the cut.
 */
export function stripMismatch(a: ArrayLike<number>, b: ArrayLike<number>, opts: StripCompareOptions = {}): number {
  const n = Math.floor(a.length / 3), m = Math.floor(b.length / 3);
  if (n === 0 || m === 0) return Infinity;
  const maxGain = opts.maxGain ?? STRIP_MAX_GAIN;
  // Lightness ratio of the two strips (clamped): Lab values scale together with the light.
  let la = 0, lb = 0;
  for (let k = 0; k < n; k++) la += a[k * 3];
  for (let k = 0; k < m; k++) lb += b[k * 3];
  la /= n;
  lb /= m;
  const gain = la > 1 && lb > 1 ? Math.max(1 / maxGain, Math.min(maxGain, la / lb)) : 1;
  if (flippedStrip.length < m * 3) flippedStrip = new Float64Array(m * 3);
  const f = flippedStrip.subarray(0, m * 3);
  for (let k = 0; k < m; k++) {
    const s = (m - 1 - k) * 3;
    f[k * 3] = b[s] * gain;
    f[k * 3 + 1] = b[s + 1] * gain;
    f[k * 3 + 2] = b[s + 2] * gain;
  }
  return dtwDistance(a, f, { band: opts.band ?? STRIP_DTW_BAND, dim: 3, weights: opts.weights ?? STRIP_WEIGHTS });
}
