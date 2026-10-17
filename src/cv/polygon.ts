/**
 * Polygon / contour utilities. Polygons are point lists without a duplicate closing point.
 * Orientation convention (see geometry.ts): clockwise on screen (y down) = positive
 * `polygonSignedArea`.
 */
import { gaussianKernel } from './filter';
import { orderQuad, polygonSignedArea, type Point, type Quad } from './geometry';

/** Distance from p to the segment a–b. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas–Peucker on the index chain s..e (indices taken modulo n), marking kept points. */
function douglasPeucker(pts: Point[], s: number, e: number, epsilon: number, keep: Uint8Array): void {
  const n = pts.length;
  const stack: number[] = [s, e];
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    if (b - a < 2) continue;
    const pa = pts[a % n], pb = pts[b % n];
    let best = -1, bestD = epsilon;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(pts[i % n], pa, pb);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best < 0) continue;
    keep[best % n] = 1;
    stack.push(a, best, best, b);
  }
}

/**
 * Douglas–Peucker simplification: keeps the points needed so that no dropped point is farther
 * than `epsilon` from the simplified polyline. For closed polygons (default) the curve is split at
 * two mutually distant vertices, so the result does not depend on where the input starts (beyond
 * those anchors) and the wrap-around segment is simplified like any other. Order is preserved.
 */
export function simplifyPolygon(pts: Point[], epsilon: number, closed = true): Point[] {
  const n = pts.length;
  if (n <= 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(n);
  if (!closed) {
    keep[0] = keep[n - 1] = 1;
    douglasPeucker(pts, 0, n - 1, epsilon, keep);
  } else {
    const farthest = (from: Point): number => {
      let bi = 0, bd = -1;
      for (let i = 0; i < n; i++) {
        const d = (pts[i].x - from.x) ** 2 + (pts[i].y - from.y) ** 2;
        if (d > bd) { bd = d; bi = i; }
      }
      return bi;
    };
    const a = farthest(pts[0]);
    const b = farthest(pts[a]);
    if (a === b) return [{ x: pts[0].x, y: pts[0].y }];
    const i1 = Math.min(a, b), i2 = Math.max(a, b);
    keep[i1] = keep[i2] = 1;
    douglasPeucker(pts, i1, i2, epsilon, keep);
    douglasPeucker(pts, i2, i1 + n, epsilon, keep);
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: pts[i].x, y: pts[i].y });
  return out;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (Andrew's monotone chain), clockwise on screen, collinear points removed. */
export function convexHull(pts: Point[]): Point[] {
  const sorted = pts.map((p) => ({ x: p.x, y: p.y })).sort((p, q) => p.x - q.x || p.y - q.y);
  const uniq: Point[] = [];
  for (const p of sorted) {
    const last = uniq[uniq.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;
  const lower: Point[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  if (polygonSignedArea(hull) < 0) hull.reverse();
  return hull;
}

/** Absolute polygon area (shoelace). */
export function polygonArea(pts: Point[]): number {
  return Math.abs(polygonSignedArea(pts));
}

/** Total edge length; includes the closing edge unless `closed` is false. */
export function polygonPerimeter(pts: Point[], closed = true): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    s += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return s;
}

/** Area centroid of a simple polygon; falls back to the vertex mean for degenerate (zero-area) input. */
export function polygonCentroid(pts: Point[]): Point {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  const ox = pts[0].x, oy = pts[0].y;
  let a = 0, cx = 0, cy = 0, mx = 0, my = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = pts[j].x - ox, yj = pts[j].y - oy, xi = pts[i].x - ox, yi = pts[i].y - oy;
    const c = xj * yi - xi * yj;
    a += c;
    cx += (xj + xi) * c;
    cy += (yj + yi) * c;
    mx += xi;
    my += yi;
  }
  if (Math.abs(a) < 1e-12) return { x: ox + mx / n, y: oy + my / n };
  return { x: ox + cx / (3 * a), y: oy + cy / (3 * a) };
}

export interface RotatedRect {
  center: Point;
  /** Extent along `angle` (the longer side; ties resolve to the side closest to the x axis). */
  width: number;
  /** Extent perpendicular to `angle`. */
  height: number;
  /** Direction of the `width` side in radians, clockwise from +x, in (-pi/2, pi/2]. */
  angle: number;
  /** Corners ordered TL, TR, BR, BL via `orderQuad`. */
  corners: Quad;
}

function normalizeHalfTurn(a: number): number {
  while (a <= -Math.PI / 2) a += Math.PI;
  while (a > Math.PI / 2) a -= Math.PI;
  return a;
}

/**
 * Minimum-area enclosing rectangle of a point set (rotating calipers over the convex hull edges).
 * Convention: `width >= height`, `angle` is the direction of the width side in (-pi/2, pi/2].
 * Degenerate input gives zero extents (a segment has height 0).
 */
export function minAreaRect(pts: Point[]): RotatedRect {
  const hull = convexHull(pts);
  const make = (center: Point, du: number, dn: number, ux: number, uy: number): RotatedRect => {
    let width = du, height = dn, dx = ux, dy = uy;
    if (dn > du) { width = dn; height = du; dx = -uy; dy = ux; }
    let angle = normalizeHalfTurn(Math.atan2(dy, dx));
    if (Math.abs(width - height) <= 1e-9 * Math.max(1, width) && Math.abs(angle) > Math.PI / 4) {
      angle = normalizeHalfTurn(angle + Math.PI / 2);
    }
    const c = Math.cos(angle), s = Math.sin(angle);
    const hw = width / 2, hh = height / 2;
    const corners = orderQuad([
      { x: center.x - c * hw + s * hh, y: center.y - s * hw - c * hh },
      { x: center.x + c * hw + s * hh, y: center.y + s * hw - c * hh },
      { x: center.x + c * hw - s * hh, y: center.y + s * hw + c * hh },
      { x: center.x - c * hw - s * hh, y: center.y - s * hw + c * hh },
    ]);
    return { center, width, height, angle, corners };
  };
  if (hull.length === 0) return make({ x: 0, y: 0 }, 0, 0, 1, 0);
  if (hull.length === 1) return make({ x: hull[0].x, y: hull[0].y }, 0, 0, 1, 0);
  const ox = hull[0].x, oy = hull[0].y;
  let bestArea = Infinity;
  let best = { cu: 0, cn: 0, du: 0, dn: 0, ux: 1, uy: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    let minU = Infinity, maxU = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of hull) {
      const px = p.x - ox, py = p.y - oy;
      const u = px * ux + py * uy, v = -px * uy + py * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minN) minN = v;
      if (v > maxN) maxN = v;
    }
    const area = (maxU - minU) * (maxN - minN);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      best = { cu: (minU + maxU) / 2, cn: (minN + maxN) / 2, du: maxU - minU, dn: maxN - minN, ux, uy };
    }
  }
  const { cu, cn, du, dn, ux, uy } = best;
  const center = { x: ox + cu * ux - cn * uy, y: oy + cu * uy + cn * ux };
  return make(center, du, dn, ux, uy);
}

/** Gaussian smoothing of a closed curve along its index (sigma in samples); endpoints wrap around. */
export function smoothContour(pts: Point[], sigma: number): Point[] {
  const n = pts.length;
  if (n < 3 || sigma <= 0) return pts.map((p) => ({ x: p.x, y: p.y }));
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let j = -r; j <= r; j++) {
      const p = pts[(((i + j) % n) + n) % n];
      sx += k[j + r] * p.x;
      sy += k[j + r] * p.y;
    }
    out[i] = { x: sx, y: sy };
  }
  return out;
}

/**
 * `n` points at equal arc-length spacing along the curve, starting at pts[0]. Closed curves
 * (default) are sampled over the full loop (the closing edge included, no duplicate end point);
 * open curves include both end points.
 */
export function resampleContour(pts: Point[], n: number, closed = true): Point[] {
  const m = pts.length;
  if (m === 0 || n <= 0) return [];
  const segs = closed ? m : m - 1;
  const cum = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = cum[segs];
  if (m === 1 || total === 0) return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
  const step = closed ? total / n : n > 1 ? total / (n - 1) : 0;
  const out: Point[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (seg < segs - 1 && cum[seg + 1] < target) seg++;
    const a = pts[seg], b = pts[(seg + 1) % m];
    const len = cum[seg + 1] - cum[seg];
    let t = len > 0 ? (target - cum[seg]) / len : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/** Even-odd point-in-polygon test (points exactly on an edge may go either way). */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
