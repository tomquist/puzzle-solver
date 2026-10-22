/**
 * Colour strips along piece sides: the Lab colour of a thin band just inside the outline, sampled
 * from each side's start corner to its end corner. Two pieces that fit show the same printed
 * colours on both sides of their common cut, so the strips of mating sides agree (one reversed);
 * see `stripMismatch` in sideCompare.ts.
 *
 * Positions along a side are fractions of its outline length (not of the corner-to-corner
 * baseline): both pieces follow the same cut curve, knobs included.
 */
import { rgbToLab } from '../../cv/color';
import { polygonSignedArea, type Point } from '../../cv/geometry';
import type { Mask, RGBAImage } from '../../cv/image';
import type { PieceShape } from '../../model/types';

/** Samples per strip. */
export const STRIP_SAMPLES = 32;
/**
 * Default band inside the outline, as fractions of the piece body size (start, end of the inset).
 * Close to the cut is best: print colours change within a few pixels (bench/sides.eval.ts: partner
 * top-1 by colour 0.44 at 0.02–0.035, 0.28 at 0.04–0.1, 0.20 at 0.06–0.14).
 */
const STRIP_INSET: [number, number] = [0.02, 0.035];
/** The band starts at least this many px inside the outline (anti-aliasing, cardboard rim, halo). */
const MIN_INSET_PX = 2;

/** Lab strips of the four sides of a piece, in the order of `PieceShape.sides`. */
export interface EdgeStrips {
  /** Interleaved L*, a*, b* per sample, from the side's start corner to its end corner. */
  sides: [Float32Array, Float32Array, Float32Array, Float32Array];
}

export interface EdgeStripOptions {
  /** Samples per strip (default {@link STRIP_SAMPLES}). */
  samples?: number;
  /** Band inside the outline as fractions of the body size (default 0.02–0.035). */
  inset?: [number, number];
}

/** A closed outline with cumulative arc lengths (clockwise on screen). */
export interface OutlineArc {
  pts: Point[];
  /** cum[i] = arc length from pts[0] to pts[i]; cum[n] = total (closing segment included). */
  cum: Float64Array;
  total: number;
}

/** Arc-length parametrisation of a closed outline, made clockwise on screen. */
export function outlineArc(contour: readonly Point[]): OutlineArc {
  const pts = polygonSignedArea(contour as Point[]) < 0 ? [...contour].reverse() : [...contour];
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { pts, cum, total: cum[n] };
}

/** Arc position (0 … total) of the outline point closest to `p`. */
export function arcPositionOf(arc: OutlineArc, p: Point): number {
  const { pts, cum } = arc;
  const n = pts.length;
  let best = Infinity, at = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const qx = a.x + t * dx - p.x, qy = a.y + t * dy - p.y;
    const d = qx * qx + qy * qy;
    if (d < best) {
      best = d;
      at = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return at;
}

/** Outline point at arc position `s` (wraps around). */
export function pointAtArc(arc: OutlineArc, s: number): Point {
  const { pts, cum, total } = arc;
  const n = pts.length;
  let u = s % total;
  if (u < 0) u += total;
  // Binary search for the segment containing u.
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= u) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo], b = pts[(lo + 1) % n];
  const len = cum[lo + 1] - cum[lo];
  const t = len > 0 ? (u - cum[lo]) / len : 0;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** The outline from arc position `s0` forward (clockwise) to `s1`, both ends included. */
export function pathBetween(arc: OutlineArc, s0: number, s1: number): Point[] {
  const { pts, cum, total } = arc;
  const n = pts.length;
  let len = (s1 - s0) % total;
  if (len < 0) len += total;
  const out: Point[] = [pointAtArc(arc, s0)];
  const start = ((s0 % total) + total) % total;
  // Vertices strictly between the two positions, in order.
  let i = 0;
  while (i < n && cum[i] <= start) i++;
  for (let k = 0; k < n; k++) {
    const idx = (i + k) % n;
    let d = cum[idx] - start;
    if (d <= 0) d += total;
    if (d >= len) break;
    out.push(pts[idx]);
  }
  out.push(pointAtArc(arc, s0 + len));
  return out;
}

/** Arc positions of the four body corners of `shape` on the outline. */
export function cornerPositions(arc: OutlineArc, shape: Pick<PieceShape, 'corners'>): [number, number, number, number] {
  return shape.corners.map((c) => arcPositionOf(arc, c)) as [number, number, number, number];
}

/** Cumulative lengths of an open polyline. */
function cumulative(path: readonly Point[]): Float64Array {
  const cum = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return cum;
}

function pointOnPath(path: readonly Point[], cum: Float64Array, s: number): Point {
  const n = path.length;
  if (s <= 0) return path[0];
  if (s >= cum[n - 1]) return path[n - 1];
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const len = cum[lo + 1] - cum[lo];
  const t = len > 0 ? (s - cum[lo]) / len : 0;
  return { x: path[lo].x + t * (path[lo + 1].x - path[lo].x), y: path[lo].y + t * (path[lo + 1].y - path[lo].y) };
}

/**
 * Where the samples of a strip along `path` (outline from a side's start corner to its end corner,
 * clockwise outline, screen coordinates) are taken: sample k covers the k-th of `samples` equal
 * parts of the path, read at a small grid of points – 3 depths between `inset[0]` and `inset[1]` px
 * inside the outline × 3 positions along the part. Null for a degenerate path.
 */
export function stripPoints(path: readonly Point[], inset: [number, number], samples = STRIP_SAMPLES): Point[][] | null {
  if (path.length < 2) return null;
  const cum = cumulative(path);
  const total = cum[path.length - 1];
  if (total <= 0) return null;
  const step = total / samples;
  const half = Math.max(1.5, 0.03 * total); // tangent from ±3 % of the side (smooths pixel steps)
  const depths = [inset[0], (inset[0] + inset[1]) / 2, inset[1]];
  const along = [-0.33 * step, 0, 0.33 * step];
  const out: Point[][] = [];
  for (let k = 0; k < samples; k++) {
    const s = (k + 0.5) * step;
    const p0 = pointOnPath(path, cum, s - half), p1 = pointOnPath(path, cum, s + half);
    const tl = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const pts: Point[] = [];
    out.push(pts);
    if (tl < 1e-9) continue;
    const nx = -(p1.y - p0.y) / tl, ny = (p1.x - p0.x) / tl; // inward normal of a clockwise outline
    for (const a of along) {
      const p = pointOnPath(path, cum, s + a);
      for (const d of depths) pts.push({ x: p.x + nx * d, y: p.y + ny * d });
    }
  }
  return out;
}

/**
 * Lab strip along one side (sample positions per {@link stripPoints}): each sample is the mean
 * colour of the piece pixels (`mask` = 1) at its points. Samples without any piece pixel take the
 * nearest valid sample's colour; null when none is valid. `image` and `mask` are crops whose pixel
 * (0, 0) is photo pixel `origin`.
 */
export function sampleSideStrip(image: RGBAImage, mask: Mask, origin: Point, path: readonly Point[], inset: [number, number], samples = STRIP_SAMPLES): Float32Array | null {
  const points = stripPoints(path, inset, samples);
  if (!points) return null;
  const out = new Float32Array(samples * 3);
  const valid = new Uint8Array(samples);
  const { width: w, height: h, data } = image;
  for (let k = 0; k < samples; k++) {
    let sl = 0, sa = 0, sb = 0, cnt = 0;
    for (const q of points[k]) {
      const x = q.x - origin.x, y = q.y - origin.y;
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h || !mask.data[iy * w + ix]) continue;
      // Bilinear RGB.
      const x0 = Math.max(0, Math.min(w - 2, Math.floor(x))), y0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
      const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
      const ch = (c: number) => (1 - fy) * ((1 - fx) * data[i00 + c] + fx * data[i10 + c]) + fy * ((1 - fx) * data[i01 + c] + fx * data[i11 + c]);
      const [L, A, B] = rgbToLab(ch(0), ch(1), ch(2));
      sl += L;
      sa += A;
      sb += B;
      cnt++;
    }
    if (cnt === 0) continue;
    out[k * 3] = sl / cnt;
    out[k * 3 + 1] = sa / cnt;
    out[k * 3 + 2] = sb / cnt;
    valid[k] = 1;
  }
  // Fill gaps from the nearest valid sample.
  let any = -1;
  for (let k = 0; k < samples; k++) if (valid[k]) { any = k; break; }
  if (any < 0) return null;
  for (let k = 0; k < samples; k++) {
    if (valid[k]) continue;
    let best = any, bd = Infinity;
    for (let j = 0; j < samples; j++) if (valid[j] && Math.abs(j - k) < bd) { bd = Math.abs(j - k); best = j; }
    out.set(out.subarray(best * 3, best * 3 + 3), k * 3);
  }
  return out;
}

/**
 * Colour strips of the four sides of a single piece (see {@link EdgeStrips}): the sides run along
 * the outline `contour` (photo coordinates) between the body corners of `shape`. Null when a strip
 * cannot be sampled.
 */
export function sampleEdgeStrips(
  image: RGBAImage,
  mask: Mask,
  origin: Point,
  contour: readonly Point[],
  shape: Pick<PieceShape, 'corners' | 'bodySize'>,
  opts: EdgeStripOptions = {},
): EdgeStrips | null {
  if (contour.length < 3) return null;
  const arc = outlineArc(contour);
  return edgeStripsAt(image, mask, origin, arc, cornerPositions(arc, shape), shape.bodySize, opts);
}

/** {@link sampleEdgeStrips} with the corners given as arc positions on `arc` (clockwise order). */
export function edgeStripsAt(
  image: RGBAImage,
  mask: Mask,
  origin: Point,
  arc: OutlineArc,
  corners: readonly number[],
  bodySize: number,
  opts: EdgeStripOptions = {},
): EdgeStrips | null {
  const [f0, f1] = opts.inset ?? STRIP_INSET;
  const d0 = Math.max(MIN_INSET_PX, f0 * bodySize);
  const inset: [number, number] = [d0, Math.max(d0 + 1, f1 * bodySize)];
  const sides: Float32Array[] = [];
  for (let i = 0; i < 4; i++) {
    const strip = sampleSideStrip(image, mask, origin, pathBetween(arc, corners[i], corners[(i + 1) % 4]), inset, opts.samples ?? STRIP_SAMPLES);
    if (!strip) return null;
    sides.push(strip);
  }
  return { sides: sides as EdgeStrips['sides'] };
}
