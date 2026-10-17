/**
 * Robust homography estimation: RANSAC with 4-point samples, MSAC scoring, local optimisation of
 * new best models, adaptive iteration count and a final iterative least-squares refit.
 */
import { findHomography, type Mat3, type Point } from '../geometry';
import { createRng } from './random';

export interface RansacOptions {
  /** Inlier threshold on the reprojection error in destination pixels (default 3). */
  threshold?: number;
  /** Upper bound on sampling iterations (default 2000). */
  maxIterations?: number;
  /** Desired probability of drawing at least one outlier-free sample (default 0.995). */
  confidence?: number;
  /** PRNG seed; equal inputs and seed give equal results (default 1). */
  seed?: number;
}

export interface RansacResult {
  /** Homography mapping src -> dst (row-major, H[8] = 1). */
  H: Mat3;
  inliers: boolean[];
  inlierCount: number;
}

/** Twice the signed area of triangle (a, b, c). */
function cross3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

const TRIANGLES = [
  [0, 1, 2],
  [1, 2, 3],
  [2, 3, 0],
  [3, 0, 1],
];

/**
 * A 4-point sample is usable when no three points are (nearly) collinear in either set and every
 * triangle keeps its orientation (no mirroring/folding homography).
 */
function sampleOk(src: Point[], dst: Point[], idx: Int32Array): boolean {
  for (const [i, j, k] of TRIANGLES) {
    const a = src[idx[i]], b = src[idx[j]], c = src[idx[k]];
    const p = dst[idx[i]], q = dst[idx[j]], r = dst[idx[k]];
    const s1 = cross3(a.x, a.y, b.x, b.y, c.x, c.y);
    const s2 = cross3(p.x, p.y, q.x, q.y, r.x, r.y);
    const n1 = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y);
    const n2 = Math.hypot(q.x - p.x, q.y - p.y) * Math.hypot(r.x - p.x, r.y - p.y);
    if (Math.abs(s1) <= 0.02 * n1 + 1e-9 || Math.abs(s2) <= 0.02 * n2 + 1e-9) return false;
    if (s1 > 0 !== s2 > 0) return false;
  }
  return true;
}

/** Squared reprojection errors of all correspondences under H (Infinity behind the projection). */
function errors(H: Mat3, src: Point[], dst: Point[], out: Float64Array): void {
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const w = h6 * x + h7 * y + h8;
    if (!(w > 1e-12)) { out[i] = Infinity; continue; }
    const dx = (h0 * x + h1 * y + h2) / w - dst[i].x;
    const dy = (h3 * x + h4 * y + h5) / w - dst[i].y;
    out[i] = dx * dx + dy * dy;
  }
}

/** MSAC cost (sum of truncated squared errors) and inlier count. */
function score(err: Float64Array, t2: number): { cost: number; count: number } {
  let cost = 0, count = 0;
  for (let i = 0; i < err.length; i++) {
    const e = err[i];
    if (e < t2) { cost += e; count++; }
    else cost += t2;
  }
  return { cost, count };
}

function inlierSubset(src: Point[], dst: Point[], err: Float64Array, t2: number): { s: Point[]; d: Point[] } {
  const s: Point[] = [], d: Point[] = [];
  for (let i = 0; i < err.length; i++) if (err[i] < t2) { s.push(src[i]); d.push(dst[i]); }
  return { s, d };
}

/**
 * Estimate a homography with `H * src[i] ≈ dst[i]` from correspondences containing outliers.
 * Returns null when fewer than 4 points are given, no non-degenerate sample exists, or the
 * consensus is not larger than a minimal sample (unless exactly 4 points were given).
 */
export function ransacHomography(src: Point[], dst: Point[], opts: RansacOptions = {}): RansacResult | null {
  const n = src.length;
  if (n !== dst.length || n < 4) return null;
  const threshold = opts.threshold ?? 3;
  const t2 = threshold * threshold;
  const maxIterations = Math.max(1, opts.maxIterations ?? 2000);
  const confidence = Math.min(0.999999, Math.max(0, opts.confidence ?? 0.995));
  const rng = createRng(opts.seed ?? 1);

  const err = new Float64Array(n);
  const idx = new Int32Array(4);
  let bestH: Mat3 | null = null;
  let bestCost = Infinity;
  let bestCount = 0;
  let limit = maxIterations;
  const updateLimit = (count: number) => {
    const w = count / n;
    const pAllIn = Math.pow(w, 4);
    if (pAllIn >= 1 - 1e-12) { limit = 0; return; }
    if (pAllIn <= 1e-12) return;
    const k = Math.ceil(Math.log(1 - confidence) / Math.log(1 - pAllIn));
    limit = Math.min(limit, Math.max(1, k));
  };

  for (let it = 0; it < limit; it++) {
    // Draw 4 distinct indices.
    for (let k = 0; k < 4; k++) {
      let r: number;
      let dup: boolean;
      do {
        r = Math.floor(rng() * n);
        dup = false;
        for (let q = 0; q < k; q++) if (idx[q] === r) dup = true;
      } while (dup);
      idx[k] = r;
    }
    if (!sampleOk(src, dst, idx)) continue;
    const H = findHomography([src[idx[0]], src[idx[1]], src[idx[2]], src[idx[3]]], [dst[idx[0]], dst[idx[1]], dst[idx[2]], dst[idx[3]]]);
    if (!H) continue;
    errors(H, src, dst, err);
    let { cost, count } = score(err, t2);
    if (cost >= bestCost) continue;
    let model = H;
    // Local optimisation: refit on the consensus set while it improves the cost.
    for (let lo = 0; lo < 3 && count > 4; lo++) {
      const { s, d } = inlierSubset(src, dst, err, t2);
      const Hr = findHomography(s, d);
      if (!Hr) break;
      errors(Hr, src, dst, err);
      const sc = score(err, t2);
      if (sc.cost >= cost) break;
      model = Hr;
      cost = sc.cost;
      count = sc.count;
    }
    bestH = model;
    bestCost = cost;
    bestCount = count;
    updateLimit(count);
  }
  if (!bestH) return null;

  // Final refit on the inliers until the consensus set stops changing.
  let H = bestH;
  errors(H, src, dst, err);
  let prevCount = -1;
  for (let it = 0; it < 5; it++) {
    const { s, d } = inlierSubset(src, dst, err, t2);
    if (s.length < 4 || s.length === prevCount) break;
    prevCount = s.length;
    const Hr = findHomography(s, d);
    if (!Hr) break;
    const tmp = new Float64Array(n);
    errors(Hr, src, dst, tmp);
    if (score(tmp, t2).cost > score(err, t2).cost) break;
    H = Hr;
    err.set(tmp);
  }
  const inliers = new Array<boolean>(n);
  let inlierCount = 0;
  for (let i = 0; i < n; i++) {
    inliers[i] = err[i] < t2;
    if (inliers[i]) inlierCount++;
  }
  if (inlierCount < 4 || (n > 4 && inlierCount <= 4) || bestCount < 4) return null;
  return { H, inliers, inlierCount };
}
