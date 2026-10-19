/**
 * Gaussian mixture models of 3-channel colours (full covariance), the colour models of GrabCut-style
 * segmentation. Fitted deterministically: k-means (k-means++ start from a fixed-seed generator),
 * then hard-assignment EM rounds (each sample goes to its most likely component, which is refitted).
 * Evaluated as the negative log-likelihood of a colour.
 */

export interface ColourGmm {
  /** Number of components. */
  k: number;
  /** Means, 3 per component. */
  mean: Float64Array;
  /** Inverse covariances, 6 per component (xx, xy, xz, yy, yz, zz). */
  inv: Float64Array;
  /** log(weight) − ½·log det Σ − 1.5·log 2π per component. */
  logNorm: Float64Array;
}

export interface GmmOptions {
  /** Components (default 5; fewer when there are few samples). */
  k?: number;
  /** Added to the covariance diagonal (channel units², default 4): noise floor, keeps Σ invertible. */
  minVariance?: number;
  /** k-means iterations (default 5) and hard-EM rounds after them (default 1). */
  kmeansIterations?: number;
  emRounds?: number;
}

const LOG_2PI_15 = 1.5 * Math.log(2 * Math.PI);
/** Samples per component below which fewer components are fitted. */
const MIN_PER_COMPONENT = 12;
/** Most components of a mixture. */
const MAX_K = 16;

/**
 * Fit a mixture to `n` colours stored as consecutive triples in `samples`. Null without samples.
 */
export function fitColourGmm(samples: ArrayLike<number>, n: number, opts: GmmOptions = {}): ColourGmm | null {
  if (n <= 0) return null;
  const k = Math.max(1, Math.min(opts.k ?? 5, MAX_K, Math.floor(n / MIN_PER_COMPONENT)));
  const minVar = opts.minVariance ?? 4;
  const assign = new Int32Array(n);
  // k-means++ start from a fixed-seed generator (results must not vary between runs).
  let seed = 0x9e3779b9 ^ n;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const centres = new Float64Array(3 * k);
  const d2 = new Float64Array(n).fill(Infinity);
  let pick = Math.floor(rnd() * n);
  for (let c = 0; c < k; c++) {
    centres[3 * c] = samples[3 * pick];
    centres[3 * c + 1] = samples[3 * pick + 1];
    centres[3 * c + 2] = samples[3 * pick + 2];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dx = samples[3 * i] - centres[3 * c], dy = samples[3 * i + 1] - centres[3 * c + 1], dz = samples[3 * i + 2] - centres[3 * c + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < d2[i]) d2[i] = d;
      total += d2[i];
    }
    if (total <= 0) break;
    let t = rnd() * total;
    pick = n - 1;
    for (let i = 0; i < n; i++) {
      t -= d2[i];
      if (t <= 0) {
        pick = i;
        break;
      }
    }
  }
  const sums = new Float64Array(4 * k);
  for (let it = 0; it < (opts.kmeansIterations ?? 5); it++) {
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      const r = samples[3 * i], g = samples[3 * i + 1], b = samples[3 * i + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = r - centres[3 * c], dy = g - centres[3 * c + 1], dz = b - centres[3 * c + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
      sums[4 * best] += r;
      sums[4 * best + 1] += g;
      sums[4 * best + 2] += b;
      sums[4 * best + 3]++;
    }
    for (let c = 0; c < k; c++) {
      const m = sums[4 * c + 3];
      if (m === 0) continue;
      centres[3 * c] = sums[4 * c] / m;
      centres[3 * c + 1] = sums[4 * c + 1] / m;
      centres[3 * c + 2] = sums[4 * c + 2] / m;
    }
  }
  let gmm = fromAssignment(samples, n, assign, k, minVar);
  for (let round = 0; round < (opts.emRounds ?? 1); round++) {
    for (let i = 0; i < n; i++) assign[i] = likeliestComponent(gmm, samples[3 * i], samples[3 * i + 1], samples[3 * i + 2]);
    gmm = fromAssignment(samples, n, assign, k, minVar);
  }
  return gmm;
}

/** Weights, means and covariances of the components from a hard assignment (empty components dropped). */
function fromAssignment(samples: ArrayLike<number>, n: number, assign: Int32Array, k: number, minVar: number): ColourGmm {
  // Per component: count, sums (3) and sums of products (6).
  const acc = new Float64Array(10 * k);
  for (let i = 0; i < n; i++) {
    const o = 10 * assign[i];
    const r = samples[3 * i], g = samples[3 * i + 1], b = samples[3 * i + 2];
    acc[o]++;
    acc[o + 1] += r; acc[o + 2] += g; acc[o + 3] += b;
    acc[o + 4] += r * r; acc[o + 5] += r * g; acc[o + 6] += r * b;
    acc[o + 7] += g * g; acc[o + 8] += g * b; acc[o + 9] += b * b;
  }
  const live: number[] = [];
  for (let c = 0; c < k; c++) if (acc[10 * c] > 0) live.push(c);
  const m = live.length;
  const out: ColourGmm = { k: m, mean: new Float64Array(3 * m), inv: new Float64Array(6 * m), logNorm: new Float64Array(m) };
  live.forEach((c, q) => {
    const o = 10 * c, cnt = acc[o];
    const mr = acc[o + 1] / cnt, mg = acc[o + 2] / cnt, mb = acc[o + 3] / cnt;
    out.mean[3 * q] = mr; out.mean[3 * q + 1] = mg; out.mean[3 * q + 2] = mb;
    const a = acc[o + 4] / cnt - mr * mr + minVar, bxy = acc[o + 5] / cnt - mr * mg, cxz = acc[o + 6] / cnt - mr * mb;
    const d = acc[o + 7] / cnt - mg * mg + minVar, e = acc[o + 8] / cnt - mg * mb, f = acc[o + 9] / cnt - mb * mb + minVar;
    // Inverse of the symmetric matrix [[a, b, c], [b, d, e], [c, e, f]] by cofactors.
    const A = d * f - e * e, B = cxz * e - bxy * f, C = bxy * e - cxz * d;
    const det = Math.max(1e-9, a * A + bxy * B + cxz * C);
    const inv = out.inv;
    inv[6 * q] = A / det;
    inv[6 * q + 1] = B / det;
    inv[6 * q + 2] = C / det;
    inv[6 * q + 3] = (a * f - cxz * cxz) / det;
    inv[6 * q + 4] = (bxy * cxz - a * e) / det;
    inv[6 * q + 5] = (a * d - bxy * bxy) / det;
    out.logNorm[q] = Math.log(cnt / n) - 0.5 * Math.log(det) - LOG_2PI_15;
  });
  return out;
}

/** Weighted log-density of component `c` at colour (r, g, b): log(weight · N(x; μ, Σ)). */
function componentLog(gmm: ColourGmm, c: number, r: number, g: number, b: number): number {
  const m = gmm.mean, v = gmm.inv;
  const x = r - m[3 * c], y = g - m[3 * c + 1], z = b - m[3 * c + 2];
  const o = 6 * c;
  const q = v[o] * x * x + v[o + 3] * y * y + v[o + 5] * z * z + 2 * (v[o + 1] * x * y + v[o + 2] * x * z + v[o + 4] * y * z);
  return gmm.logNorm[c] - 0.5 * q;
}

/** Index of the component most likely to have produced colour (r, g, b). */
export function likeliestComponent(gmm: ColourGmm, r: number, g: number, b: number): number {
  let best = 0, bl = -Infinity;
  for (let c = 0; c < gmm.k; c++) {
    const l = componentLog(gmm, c, r, g, b);
    if (l > bl) {
      bl = l;
      best = c;
    }
  }
  return best;
}

/**
 * −log of the likeliest component's weighted density at (r, g, b): GrabCut's data term (each pixel
 * takes its best component), cheaper than the full mixture and within log k of it.
 */
export function gmmNegLogLikBest(gmm: ColourGmm, r: number, g: number, b: number): number {
  let best = -Infinity;
  for (let c = 0; c < gmm.k; c++) {
    const l = componentLog(gmm, c, r, g, b);
    if (l > best) best = l;
  }
  return -best;
}

/** Per-component log-densities of one colour (scratch; at most MAX_K components). */
const scratch = new Float64Array(MAX_K);

/** −log p(r, g, b) under the mixture (log-sum-exp over the components). */
export function gmmNegLogLik(gmm: ColourGmm, r: number, g: number, b: number): number {
  const k = gmm.k;
  let max = -Infinity;
  for (let c = 0; c < k; c++) {
    const l = componentLog(gmm, c, r, g, b);
    scratch[c] = l;
    if (l > max) max = l;
  }
  if (k === 1) return -max;
  let s = 0;
  for (let c = 0; c < k; c++) s += Math.exp(scratch[c] - max);
  return -(max + Math.log(s));
}
