/**
 * Straight-line candidates for box detection. Every line carries a prefix-summed edge-support
 * profile along its whole extent inside the working image, so the support of any segment (a quad
 * side between two corners) is an O(1) lookup.
 */
import { canny } from '../../cv/edges';
import type { Point } from '../../cv/geometry';
import type { Mask } from '../../cv/image';
import { fitLine, houghLines, lineFromPolar } from '../../cv/lines';
import { supportNear, type GradientField } from './field';

export type LineSource = 'hough' | 'segment' | 'contour' | 'border' | 'directed';

export interface Line {
  /** A point on the line. */
  p: Point;
  /** Unit direction. */
  d: Point;
}

export interface ScoredLine extends Line {
  /** Unit normal (d rotated by +90°). */
  n: Point;
  /** Parameter (along d from p) of the first sample; samples at t0 + k, k = 0..count-1. */
  t0: number;
  count: number;
  /** prefix[k] = sum of support of samples 0..k-1 (length count + 1). */
  prefix: Float32Array;
  source: LineSource;
  /** For photo-border lines: 0 top, 1 right, 2 bottom, 3 left. */
  border?: number;
}

/** Parameter range of the part of the line inside [-0.5, w-0.5] × [-0.5, h-0.5], or null. */
export function clipLine(l: Line, w: number, h: number): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  const clip = (p: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return p >= lo && p <= hi;
    let a = (lo - p) / d, b = (hi - p) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  if (!clip(l.p.x, l.d.x, -0.5, w - 0.5)) return null;
  if (!clip(l.p.y, l.d.y, -0.5, h - 0.5)) return null;
  return t1 - t0 >= 2 ? [t0, t1] : null;
}

/** Normalise a line: unit direction, canonical sign, p = foot of the perpendicular from the image centre. */
export function normalizeLine(p: Point, d: Point, cx: number, cy: number): Line {
  const len = Math.hypot(d.x, d.y);
  let dx = d.x / len, dy = d.y / len;
  if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) { dx = -dx; dy = -dy; }
  const t = (cx - p.x) * dx + (cy - p.y) * dy;
  return { p: { x: p.x + t * dx, y: p.y + t * dy }, d: { x: dx, y: dy } };
}

/** Build the support profile of a line over the working image (null when it misses the image). */
export function scoreLine(f: GradientField, line: Line, source: LineSource, r = 2): ScoredLine | null {
  const l = normalizeLine(line.p, line.d, (f.width - 1) / 2, (f.height - 1) / 2);
  const range = clipLine(l, f.width, f.height);
  if (!range) return null;
  const n = { x: -l.d.y, y: l.d.x };
  const t0 = range[0];
  const count = Math.max(1, Math.floor(range[1] - range[0]) + 1);
  const prefix = new Float32Array(count + 1);
  for (let k = 0; k < count; k++) {
    const t = t0 + k;
    const v = supportNear(f, l.p.x + t * l.d.x, l.p.y + t * l.d.y, n.x, n.y, r);
    prefix[k + 1] = prefix[k] + v;
  }
  return { ...l, n, t0, count, prefix, source };
}

/** Lines along the four photo borders with a constant (prior) support value. */
export function borderLines(w: number, h: number, support: number): ScoredLine[] {
  const make = (p: Point, d: Point, len: number, border: number): ScoredLine => {
    const count = Math.floor(len) + 1;
    const prefix = new Float32Array(count + 1);
    for (let k = 0; k < count; k++) prefix[k + 1] = prefix[k] + support;
    const l = normalizeLine(p, d, (w - 1) / 2, (h - 1) / 2);
    const range = clipLine(l, w, h) ?? [0, len];
    return { ...l, n: { x: -l.d.y, y: l.d.x }, t0: range[0], count, prefix, source: 'border', border };
  };
  return [
    make({ x: -0.5, y: -0.5 }, { x: 1, y: 0 }, w, 0),
    make({ x: w - 0.5, y: -0.5 }, { x: 0, y: 1 }, h, 1),
    make({ x: -0.5, y: h - 0.5 }, { x: 1, y: 0 }, w, 2),
    make({ x: -0.5, y: -0.5 }, { x: 0, y: 1 }, h, 3),
  ];
}

/** Integral of the support over parameters [ta, tb] (outside the image counts as 0). */
function integral(l: ScoredLine, t: number): number {
  const k = t - l.t0 + 0.5;
  if (k <= 0) return 0;
  if (k >= l.count) return l.prefix[l.count];
  const i = Math.floor(k), fr = k - i;
  return l.prefix[i] + fr * (l.prefix[i + 1] - l.prefix[i]);
}

/** Mean support of the segment between parameters ta and tb. */
export function segmentSupport(l: ScoredLine, ta: number, tb: number): number {
  if (tb < ta) [ta, tb] = [tb, ta];
  const len = tb - ta;
  if (len < 1e-6) return 0;
  return (integral(l, tb) - integral(l, ta)) / len;
}

/** Parameter of the projection of p onto the line. */
export function paramOf(l: Line, p: Point): number {
  return (p.x - l.p.x) * l.d.x + (p.y - l.p.y) * l.d.y;
}

/** Signed distance of p from the line (along n = d rotated +90°). */
export function signedDistance(l: Line, p: Point): number {
  return -(p.x - l.p.x) * l.d.y + (p.y - l.p.y) * l.d.x;
}

/** Total support of a line (sum over its profile). */
export function totalSupport(l: ScoredLine): number {
  return l.prefix[l.count];
}

/** True when two lines are nearly the same (angle and offset within tolerance over the image). */
export function sameLine(a: Line, b: Line, angTolRad: number, distTol: number): boolean {
  const c = Math.abs(a.d.x * b.d.x + a.d.y * b.d.y);
  if (c < Math.cos(angTolRad)) return false;
  return Math.abs(signedDistance(a, b.p)) <= distTol && Math.abs(signedDistance(b, a.p)) <= distTol;
}

/**
 * Keep only edge pixels that continue straight along their tangent (removes texture and curved
 * edges before the Hough transform, which also makes it much faster).
 */
export function straightEdges(edges: Mask, f: GradientField): Mask {
  const { width: w, height: h } = edges;
  const out = new Uint8Array(w * h);
  const e = edges.data, gx = f.gx, gy = f.gy, mag = f.mag;
  const cosTol = Math.cos((15 * Math.PI) / 180);
  const steps = [-12, -8, -4, 4, 8, 12];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!e[i]) continue;
      const m = mag[i];
      if (m <= 0) continue;
      const ux = gx[i] / m, uy = gy[i] / m;
      const tx = -uy, ty = ux;
      let misses = 0;
      for (let k = 0; k < steps.length && misses < 2; k++) {
        const s = steps[k];
        let found = false;
        // The continuation pixel and its neighbours across the edge.
        for (let o = -1; o <= 1 && !found; o++) {
          const xx = Math.round(x + s * tx + o * ux), yy = Math.round(y + s * ty + o * uy);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (e[j] && Math.abs(gx[j] * ux + gy[j] * uy) >= cosTol * mag[j]) found = true;
        }
        if (!found) misses++;
      }
      if (misses < 2) out[i] = 1;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Refit a rough line to nearby edge pixels whose gradient is aligned with the line normal
 * (two passes with shrinking tolerance). Returns null when too few pixels support it.
 */
export function refitToEdges(edges: Mask, f: GradientField, line: Line, minPts: number): Line | null {
  let cur = line;
  for (const tol of [2.5, 1.5]) {
    const range = clipLine(cur, f.width, f.height);
    if (!range) return null;
    const nx = -cur.d.y, ny = cur.d.x;
    const pts: Point[] = [];
    const seen = new Set<number>();
    const r = Math.ceil(tol);
    for (let t = range[0]; t <= range[1]; t += 1) {
      const bx = cur.p.x + t * cur.d.x, by = cur.p.y + t * cur.d.y;
      for (let o = -r; o <= r; o++) {
        const x = Math.round(bx + o * nx), y = Math.round(by + o * ny);
        if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
        const i = y * f.width + x;
        if (!edges.data[i] || seen.has(i)) continue;
        const dist = Math.abs(-(x - cur.p.x) * cur.d.y + (y - cur.p.y) * cur.d.x);
        if (dist > tol) continue;
        const m = f.mag[i];
        if (Math.abs(f.gx[i] * nx + f.gy[i] * ny) < 0.94 * m) continue;
        seen.add(i);
        pts.push({ x, y });
      }
    }
    if (pts.length < minPts) return null;
    const fit = fitLine(pts);
    if (!fit) return null;
    cur = { p: fit.point, d: fit.direction };
  }
  return cur;
}

export interface EdgeCandidates {
  edges: Mask;
  lines: Line[];
}

/** Canny edges and Hough line candidates (refined against the edge pixels) on the working image. */
export function houghCandidates(gray: { width: number; height: number; data: Float32Array }, f: GradientField, maxLines = 36): EdgeCandidates {
  const { width: w, height: h } = gray;
  const minDim = Math.min(w, h);
  const edges = canny(gray, f.lo * 1.2, f.lo * 2.8, 0);
  const straight = straightEdges(edges, f);
  const hl = houghLines(straight, {
    thetaSteps: 180,
    rhoStep: 1,
    threshold: Math.max(20, Math.round(0.06 * minDim)),
    maxLines,
    minSeparationDeg: 2,
    minSeparationRho: 4,
  });
  const lines: Line[] = [];
  const minPts = Math.max(12, Math.round(0.04 * minDim));
  for (const hlLine of hl) {
    const pl = lineFromPolar(hlLine.rho, hlLine.theta);
    const ref = refitToEdges(edges, f, { p: pl.point, d: pl.direction }, minPts);
    if (ref) lines.push(ref);
  }
  return { edges, lines };
}
