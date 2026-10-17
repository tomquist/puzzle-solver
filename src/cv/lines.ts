/**
 * Straight lines: Hough transform on edge masks, total-least-squares fitting, intersections.
 *
 * Hough lines use the normal form x·cos θ + y·sin θ = ρ in pixel-center coordinates, with
 * θ in [0, π) (clockwise from +x, the direction of the line's normal) and ρ possibly negative.
 */
import type { Point } from './geometry';
import type { Mask } from './image';

export interface HoughLine {
  rho: number;
  theta: number;
  votes: number;
}

export interface HoughOptions {
  /** Angular bins over [0, π). Default 180 (1°). */
  thetaSteps?: number;
  /** ρ bin size in pixels. Default 1. */
  rhoStep?: number;
  /** Minimum votes. Default max(10, round(0.2 · min(width, height))). */
  threshold?: number;
  /** Maximum number of lines returned (strongest first). Default 20. */
  maxLines?: number;
  /** Lines closer than this in angle AND `minSeparationRho` in ρ are duplicates. Default 3°. */
  minSeparationDeg?: number;
  /** Default 10 px. */
  minSeparationRho?: number;
}

/**
 * Standard Hough transform for lines with peak detection (3×3 local maxima, θ wraps around with ρ
 * mirrored) and greedy duplicate suppression. Returns lines sorted by votes, strongest first.
 */
export function houghLines(edges: Mask, opts: HoughOptions = {}): HoughLine[] {
  const { width: w, height: h, data } = edges;
  const nTheta = Math.max(1, Math.round(opts.thetaSteps ?? 180));
  const rhoStep = opts.rhoStep ?? 1;
  const threshold = opts.threshold ?? Math.max(10, Math.round(0.2 * Math.min(w, h)));
  const maxLines = opts.maxLines ?? 20;
  const minSepTheta = ((opts.minSeparationDeg ?? 3) * Math.PI) / 180;
  const minSepRho = opts.minSeparationRho ?? 10;

  let nPts = 0;
  for (let i = 0; i < data.length; i++) if (data[i] !== 0) nPts++;
  if (nPts === 0) return [];
  const xs = new Float32Array(nPts), ys = new Float32Array(nPts);
  for (let y = 0, k = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (data[y * w + x] !== 0) { xs[k] = x; ys[k] = y; k++; }
  }
  const offset = Math.ceil(Math.hypot(w, h) / rhoStep) + 1;
  const nRho = 2 * offset + 1;
  const acc = new Int32Array(nTheta * nRho);
  const invStep = 1 / rhoStep;
  for (let t = 0; t < nTheta; t++) {
    const th = (t * Math.PI) / nTheta;
    const c = Math.cos(th) * invStep, s = Math.sin(th) * invStep;
    const base = t * nRho + offset;
    for (let k = 0; k < nPts; k++) acc[base + Math.round(xs[k] * c + ys[k] * s)]++;
  }
  // Accumulator lookup with θ wrap-around: (ρ, θ - π) ≡ (-ρ, θ).
  const get = (t: number, r: number): number => {
    if (t < 0) { t += nTheta; r = 2 * offset - r; }
    else if (t >= nTheta) { t -= nTheta; r = 2 * offset - r; }
    if (r < 0 || r >= nRho) return 0;
    return acc[t * nRho + r];
  };
  const peaks: HoughLine[] = [];
  for (let t = 0; t < nTheta; t++) {
    for (let r = 0; r < nRho; r++) {
      const v = acc[t * nRho + r];
      if (v < threshold) continue;
      let isMax = true;
      for (let dt = -1; dt <= 1 && isMax; dt++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (dt === 0 && dr === 0) continue;
          const u = get(t + dt, r + dr);
          // Ties: only the first cell in scan order survives.
          if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ rho: (r - offset) * rhoStep, theta: (t * Math.PI) / nTheta, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  const out: HoughLine[] = [];
  for (const p of peaks) {
    if (out.length >= maxLines) break;
    let dup = false;
    for (const q of out) {
      let dTheta = Math.abs(p.theta - q.theta);
      let dRho = Math.abs(p.rho - q.rho);
      if (dTheta > Math.PI / 2) {
        dTheta = Math.PI - dTheta;
        dRho = Math.abs(p.rho + q.rho);
      }
      if (dTheta < minSepTheta && dRho < minSepRho) { dup = true; break; }
    }
    if (!dup) out.push(p);
  }
  return out;
}

/** Point/direction form of the Hough line x·cos θ + y·sin θ = ρ (unit direction). */
export function lineFromPolar(rho: number, theta: number): { point: Point; direction: Point } {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { point: { x: rho * c, y: rho * s }, direction: { x: -s, y: c } };
}

/**
 * Total-least-squares line through points (principal axis of their covariance). `direction` is a
 * unit vector with x > 0 (or y > 0 for vertical lines). Null for < 2 distinct points.
 */
export function fitLine(pts: Point[]): { point: Point; direction: Point } | null {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx + syy < 1e-18) return null;
  // Major-axis angle of the 2×2 covariance matrix.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(angle), dy = Math.sin(angle);
  if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) { dx = -dx; dy = -dy; }
  return { point: { x: mx, y: my }, direction: { x: dx, y: dy } };
}

/** Intersection of the lines p1 + t·d1 and p2 + s·d2; null when (nearly) parallel. */
export function lineIntersection(p1: Point, d1: Point, p2: Point, d2: Point): Point | null {
  const den = d1.x * d2.y - d1.y * d2.x;
  const scale = Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y);
  if (scale === 0 || Math.abs(den) <= 1e-10 * scale) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}
