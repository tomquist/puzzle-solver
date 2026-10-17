/**
 * Region-based quad candidates: colour segmentation of the box against the table (modelled from
 * the photo border) and outer contours of connected Canny edge structures. Both are reduced to a
 * convex quad (hull → Douglas–Peucker → per-side line fit).
 */
import { rgbaToLab } from '../../cv/color';
import { orderQuad, type Point, type Quad } from '../../cv/geometry';
import { createGray, createMask, type Mask, type RGBAImage } from '../../cv/image';
import { fitLine, lineIntersection } from '../../cv/lines';
import { close, dilate, fillHoles, open } from '../../cv/morphology';
import { findOuterContours } from '../../cv/contour';
import { convexHull, polygonPerimeter, simplifyPolygon } from '../../cv/polygon';
import { resizeRGBA } from '../../cv/resize';
import { otsuThreshold } from '../../cv/threshold';
import { isConvexClockwise, quadArea } from './geometry';

/** Distance from p to segment a–b. */
function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/**
 * Reduce a closed outline to a convex quad: Douglas–Peucker on its hull with growing tolerance until
 * four vertices remain, then refit each side to the outline points near it (away from the corners)
 * and intersect adjacent sides.
 */
export function outlineToQuad(outline: Point[]): Quad | null {
  if (outline.length < 4) return null;
  const hull = convexHull(outline);
  if (hull.length < 4) return null;
  const per = polygonPerimeter(hull);
  let eps = 0.01 * per;
  let simp = simplifyPolygon(hull, eps);
  for (let it = 0; it < 20 && simp.length > 4; it++) {
    eps *= 1.3;
    simp = simplifyPolygon(hull, eps);
  }
  if (simp.length !== 4) return null;
  const q0 = orderQuad(simp);
  if (!isConvexClockwise(q0)) return null;
  // Per-side line fit on outline points close to the side (excluding the corner regions).
  const lines: { p: Point; d: Point }[] = [];
  for (let s = 0; s < 4; s++) {
    const a = q0[s], b = q0[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const tol = Math.max(2, 0.015 * len);
    const pts: Point[] = [];
    for (const p of outline) {
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len);
      if (t < 0.1 || t > 0.9) continue;
      if (segDist(p, a, b) <= tol) pts.push(p);
    }
    const fit = pts.length >= 8 ? fitLine(pts) : null;
    lines.push(fit ? { p: fit.point, d: fit.direction } : { p: a, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
  }
  const corners: Point[] = [];
  for (let s = 0; s < 4; s++) {
    const l1 = lines[(s + 3) % 4], l2 = lines[s];
    const c = lineIntersection(l1.p, l1.d, l2.p, l2.d);
    if (!c) return null;
    corners.push(c);
  }
  const q = corners as Quad;
  return isConvexClockwise(q) ? q : q0;
}

export interface SegmentResult {
  /** Quad of the largest non-table region (working coordinates), if any. */
  quad: Quad | null;
  /** Foreground (not table) mask at the segmentation resolution. */
  fg: Mask;
  /** Segmentation-to-working scale. */
  scale: number;
  /** Otsu separability of the table-distance histogram (0..1). */
  separability: number;
}

/**
 * Segment the box from the table: robust Lab colour model of the photo border, distance map,
 * Otsu threshold, morphology, largest component → quad.
 */
export function segmentBox(work: RGBAImage, maxSide = 320): SegmentResult {
  const f = Math.min(1, maxSide / Math.max(work.width, work.height));
  const w = Math.max(8, Math.round(work.width * f)), h = Math.max(8, Math.round(work.height * f));
  const small = f < 1 ? resizeRGBA(work, w, h) : work;
  const scale = work.width / w;
  const lab = rgbaToLab(small).data;
  const N = w * h;
  const bw = Math.max(2, Math.round(0.025 * Math.min(w, h)));
  // Border samples.
  const ls: number[] = [], as: number[] = [], bs: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bw && y >= bw && x < w - bw && y < h - bw) continue;
      const i = (y * w + x) * 3;
      ls.push(lab[i]);
      as.push(lab[i + 1]);
      bs.push(lab[i + 2]);
    }
  }
  const median = (v: number[]) => {
    const s = [...v].sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const mL = median(ls), mA = median(as), mB = median(bs);
  const dists = ls.map((l, k) => Math.hypot(l - mL, as[k] - mA, bs[k] - mB));
  const spread = Math.max(2.5, 1.4826 * median(dists));
  const dist = createGray(w, h);
  for (let i = 0; i < N; i++) {
    dist.data[i] = Math.min(50, Math.hypot(lab[i * 3] - mL, lab[i * 3 + 1] - mA, lab[i * 3 + 2] - mB) / spread);
  }
  const { threshold, separability } = otsuThreshold(dist);
  const t = Math.max(3, Math.min(10, threshold));
  let fg = createMask(w, h);
  for (let i = 0; i < N; i++) fg.data[i] = dist.data[i] > t ? 1 : 0;
  fg = fillHoles(close(open(fg, 1), 2));
  const comps = findOuterContours(fg, Math.round(0.03 * N));
  let best: { contour: Point[]; area: number } | null = null;
  for (const c of comps) if (!best || c.stats.area > best.area) best = { contour: c.contour, area: c.stats.area };
  let quad: Quad | null = null;
  if (best) {
    const q = outlineToQuad(best.contour);
    if (q && quadArea(q) > 0.03 * N) {
      // Contour pixels are pixel centres of the boundary; the region edge lies half a pixel outside.
      quad = q.map((p) => ({ x: (p.x + 0.5) * scale - 0.5, y: (p.y + 0.5) * scale - 0.5 })) as Quad;
    }
  }
  return { quad, fg, scale, separability };
}

/**
 * Quads from the outer outlines of large connected edge structures (the box outline usually forms
 * one connected structure with everything printed on it).
 */
export function contourQuads(edges: Mask, maxQuads = 3): Quad[] {
  const { width: w, height: h } = edges;
  const d = dilate(edges, 1);
  const comps = findOuterContours(d, Math.round(0.002 * w * h));
  const big = comps
    .filter((c) => c.stats.bbox.width >= 0.2 * w && c.stats.bbox.height >= 0.2 * h)
    .sort((a, b) => b.stats.bbox.width * b.stats.bbox.height - a.stats.bbox.width * a.stats.bbox.height)
    .slice(0, maxQuads);
  const out: Quad[] = [];
  for (const c of big) {
    const q = outlineToQuad(c.contour);
    if (q && quadArea(q) > 0.03 * w * h) out.push(q);
  }
  return out;
}
