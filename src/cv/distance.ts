import { createGray, type GrayImage, type Mask } from './image';

/**
 * Exact squared Euclidean distance transform (Felzenszwalb–Huttenlocher, O(n) for any distance).
 *
 * For every pixel returns the squared distance (in pixels, between pixel centers) to the nearest
 * pixel whose mask value equals `target` (nonzero counts as 1). Pixels outside the image are not
 * considered unless `outsideIsTarget` is set, in which case the image is treated as surrounded by
 * target pixels. When no target pixel exists the result is `Infinity`.
 */
export function squaredDistanceTransform(m: Mask, target: 0 | 1, outsideIsTarget = false): Float32Array {
  const { width: w, height: h, data } = m;
  const n = w * h;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const want = target === 1;
  const INF = Infinity;
  // Pass 1: vertical 1-D distance to the nearest target pixel in the same column, computed with
  // row-wise sweeps (cache friendly).
  const col = out; // reuse output buffer for the column distances
  for (let x = 0; x < w; x++) col[x] = (data[x] !== 0) === want ? 0 : outsideIsTarget ? 1 : INF;
  for (let y = 1; y < h; y++) {
    const row = y * w, prev = row - w;
    for (let x = 0; x < w; x++) col[row + x] = (data[row + x] !== 0) === want ? 0 : col[prev + x] + 1;
  }
  {
    const last = (h - 1) * w;
    if (outsideIsTarget) for (let x = 0; x < w; x++) if (col[last + x] > 1) col[last + x] = 1;
    for (let y = h - 2; y >= 0; y--) {
      const row = y * w, next = row + w;
      for (let x = 0; x < w; x++) {
        const v = col[next + x] + 1;
        if (v < col[row + x]) col[row + x] = v;
      }
    }
  }
  // Pass 2: per row, lower envelope of parabolas f(q) + (x - q)^2 with f = col^2.
  // With outsideIsTarget, virtual target columns at x = -1 and x = w are added (f = 0).
  const ext = outsideIsTarget ? 2 : 0;
  const len = w + ext;
  const f = new Float64Array(len);
  const pos = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // Collect finite parabolas (positions in increasing order).
    let m2 = 0;
    if (outsideIsTarget) { pos[m2] = -1; f[m2] = 0; m2++; }
    for (let x = 0; x < w; x++) {
      const c = col[row + x];
      if (c !== INF) { pos[m2] = x; f[m2] = c * c; m2++; }
    }
    if (outsideIsTarget) { pos[m2] = w; f[m2] = 0; m2++; }
    if (m2 === 0) {
      for (let x = 0; x < w; x++) out[row + x] = INF;
      continue;
    }
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < m2; q++) {
      const pq = pos[q], fq = f[q] + pq * pq;
      let s: number;
      for (;;) {
        // z[0] = -Infinity terminates this loop at k = 0 at the latest.
        const pv = pos[v[k]];
        s = (fq - (f[v[k]] + pv * pv)) / (2 * (pq - pv));
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let x = 0; x < w; x++) {
      while (z[k + 1] < x) k++;
      const d = x - pos[v[k]];
      out[row + x] = d * d + f[v[k]];
    }
  }
  return out;
}

export interface DistanceTransformOptions {
  /** Treat everything outside the image as unset (distances then never exceed the border distance). Default false. */
  outsideIsUnset?: boolean;
}

/**
 * Exact Euclidean distance of each SET pixel to the nearest UNSET pixel (0 for unset pixels).
 * By default only pixels inside the image count as unset; when the mask has no unset pixel at all
 * the result is `Infinity` everywhere (use `outsideIsUnset` to avoid that).
 */
export function distanceTransform(m: Mask, opts: DistanceTransformOptions = {}): GrayImage {
  const sq = squaredDistanceTransform(m, 0, opts.outsideIsUnset ?? false);
  const out = createGray(m.width, m.height);
  for (let i = 0; i < sq.length; i++) out.data[i] = Math.sqrt(sq[i]);
  return out;
}
