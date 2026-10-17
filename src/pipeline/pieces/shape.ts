/**
 * Piece shape analysis: body corners, side shapes (flat / tab / blank) and piece kind from an
 * outline, plus the dominant grid orientation of any outline (pieces and patches).
 *
 * Corners: the outline is resampled and smoothed; convex turning-angle maxima are corner
 * candidates; the 4-subset that forms the most rectangle-like, large, sharp-cornered quad wins.
 * Each corner is then refined by intersecting lines fitted to the straight side starts next to it.
 */
import type { Point } from '../../cv/geometry';
import { polygonArea, polygonPerimeter, resampleContour, smoothContour } from '../../cv/polygon';
import { polygonSignedArea } from '../../cv/geometry';
import { SIDE_PROFILE_SAMPLES, type PieceKind, type PieceShape, type SideKind, type SideShape } from '../../model/types';

export interface ShapeOptions {
  /** A side is flat when its largest deviation from the corner-to-corner line is below this fraction of its length (default 0.08). */
  flatTolerance?: number;
}

const DEG = 180 / Math.PI;
/** Side excursions deeper than this fraction of the side length are implausible for a knob. */
const DEEP_SIDE = 0.48;
/** Half-width (deg) of the window around the histogram peak used to refine the dominant orientation. */
const ALIGN_WINDOW = 20;
/** Half-width (deg) within which outline length counts as aligned with the dominant orientation. */
const ALIGNED_TOL = 7;
/** Minimum angular distance (deg) of a second orientation peak from the dominant one. */
const SECOND_PEAK_MIN_SEPARATION = 20;

/** Reduce an angle in degrees to (−45, 45]. */
export function reduceQuarter(deg: number): number {
  let a = deg % 90;
  if (a <= -45) a += 90;
  if (a > 45) a -= 90;
  return a;
}

/** Signed turning angle (radians, positive = clockwise on screen) at each sample with chord half-width k. */
function turningAngles(p: Point[], k: number): Float32Array {
  const n = p.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = p[(i - k + n) % n], b = p[i], c = p[(i + k) % n];
    const x1 = b.x - a.x, y1 = b.y - a.y, x2 = c.x - b.x, y2 = c.y - b.y;
    out[i] = Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2);
  }
  return out;
}

/** Total-least-squares line through points: centroid + unit direction; null when degenerate. */
function fitLine(pts: Point[]): { p: Point; d: Point } | null {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (const q of pts) { mx += q.x; my += q.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const q of pts) {
    const dx = q.x - mx, dy = q.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (sxx + syy < 1e-9) return null;
  return { p: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function intersect(l1: { p: Point; d: Point }, l2: { p: Point; d: Point }): Point | null {
  const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(den) < 0.2) return null; // nearly parallel (< ~11°)
  const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
  return { x: l1.p.x + t * l1.d.x, y: l1.p.y + t * l1.d.y };
}

/** Points of the closed curve `c` between indices a and b (inclusive, wrapping forward). */
function arc(c: Point[], a: number, b: number): Point[] {
  const n = c.length;
  const out: Point[] = [];
  const len = ((b - a) % n + n) % n;
  for (let i = 0; i <= len; i++) out.push(c[(a + i) % n]);
  return out;
}

interface SideEval {
  side: SideShape;
  /** 0..1 how clearly the kind was decided. */
  clarity: number;
  /** Number of separate large excursions (a real side has at most one knob). */
  lobes: number;
  /** Largest |deviation| / length. */
  extent: number;
}

/**
 * Side profile per the SideShape contract: deviation of `path` (start corner → end corner of a
 * clockwise outline) from the baseline A→B, sampled at SIDE_PROFILE_SAMPLES positions, divided by
 * the length, positive outward; where the path overhangs, the most extreme deviation is used.
 */
export function sideProfile(path: readonly Point[], A: Point, B: Point): { length: number; profile: number[] } {
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (L < 1e-9) return { length: 0, profile: new Array<number>(SIDE_PROFILE_SAMPLES).fill(0) };
  const dx = (B.x - A.x) / L, dy = (B.y - A.y) / L;
  const m = path.length;
  const u = new Float64Array(m), v = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const px = path[i].x - A.x, py = path[i].y - A.y;
    u[i] = (px * dx + py * dy) / L;
    v[i] = (px * dy - py * dx) / L; // outward normal (dy, −dx) for clockwise outlines
  }
  // Every path segment updates the samples whose position it spans (most extreme value wins).
  const S = SIDE_PROFILE_SAMPLES;
  const best = new Float64Array(S);
  const found = new Uint8Array(S);
  for (let i = 0; i + 1 < m; i++) {
    const u0 = u[i], u1 = u[i + 1];
    const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
    const kLo = Math.max(0, Math.ceil(lo * (S - 1) - 1e-12)), kHi = Math.min(S - 1, Math.floor(hi * (S - 1) + 1e-12));
    for (let k = kLo; k <= kHi; k++) {
      const t = k / (S - 1);
      const f = u1 === u0 ? 0 : (t - u0) / (u1 - u0);
      const val = v[i] + f * (v[i + 1] - v[i]);
      if (!found[k] || Math.abs(val) > Math.abs(best[k])) best[k] = val;
      found[k] = 1;
    }
  }
  const profile: number[] = [];
  for (let k = 0; k < S; k++) {
    if (!found[k]) {
      // Position not reached by the path (corner slightly off the outline): nearest point's deviation.
      const t = k / (S - 1);
      let nearest = Infinity;
      for (let i = 0; i < m; i++) {
        const du = Math.abs(u[i] - t);
        if (du < nearest) { nearest = du; best[k] = v[i]; }
      }
    }
    profile.push(best[k]);
  }
  return { length: L, profile };
}

function evalSide(path: Point[], A: Point, B: Point, flatTol: number): SideEval {
  const { length, profile } = sideProfile(path, A, B);
  let pos = 0, neg = 0;
  for (const v of profile) {
    if (v > pos) pos = v;
    if (-v > neg) neg = -v;
  }
  // Count separate excursions beyond 1.5× the flat tolerance (hysteresis at 0.5×).
  let lobes = 0, inLobe = 0;
  for (const v of profile) {
    if (inLobe === 0 && Math.abs(v) > 1.5 * flatTol) { lobes++; inLobe = Math.sign(v); }
    else if (inLobe !== 0 && (Math.abs(v) < 0.5 * flatTol || Math.sign(v) !== inLobe)) {
      inLobe = 0;
      if (Math.abs(v) > 1.5 * flatTol) { lobes++; inLobe = Math.sign(v); }
    }
  }
  const ext = Math.max(pos, neg);
  let kind: SideKind;
  let clarity: number;
  if (ext < flatTol) {
    kind = 'flat';
    clarity = Math.min(1, (flatTol - ext) / (0.5 * flatTol));
  } else if (lobes >= 2) {
    kind = 'unknown';
    clarity = 0;
  } else {
    const big = Math.max(pos, neg), small = Math.min(pos, neg);
    kind = pos >= neg ? 'tab' : 'blank';
    // Knobs reach ≈ 0.2–0.35 of the side; both directions large means the corners are wrong.
    clarity = Math.min(1, (big - flatTol) / (0.75 * flatTol)) * Math.min(1, Math.max(0, (big - 1.2 * small) / big) * 1.5);
    if (big > DEEP_SIDE) clarity *= 0.4;
    if (clarity < 0.15) kind = 'unknown';
  }
  return { side: { kind, length, profile }, clarity, lobes, extent: ext };
}

interface QuadCandidate {
  idx: [number, number, number, number];
  cost: number;
}

/**
 * Cost of a corner quad (lower = more rectangle-like): corner angles, opposite side lengths, aspect
 * ratio, area relative to the outline area and sharpness of the outline turns at the corners.
 */
function quadCost(P: Point[], turn: number[], outlineArea: number): number {
  const len = [0, 0, 0, 0];
  let angErr = 0;
  for (let j = 0; j < 4; j++) {
    const a = P[(j + 3) % 4], b = P[j], c = P[(j + 1) % 4];
    const x1 = b.x - a.x, y1 = b.y - a.y, x2 = c.x - b.x, y2 = c.y - b.y;
    const cr = x1 * y2 - y1 * x2;
    if (cr <= 0) return Infinity; // not convex / not clockwise
    len[j] = Math.hypot(c.x - b.x, c.y - b.y);
    const turnAt = Math.atan2(cr, x1 * x2 + y1 * y2) * DEG; // exterior angle, 90 for a rectangle
    angErr += Math.abs(turnAt - 90);
  }
  const minL = Math.min(...len), maxL = Math.max(...len);
  if (minL < 0.35 * maxL) return Infinity;
  const ePar = Math.abs(len[0] - len[2]) / (len[0] + len[2]) + Math.abs(len[1] - len[3]) / (len[1] + len[3]);
  const aspect = Math.abs(Math.log((len[0] + len[2]) / (len[1] + len[3])));
  const eAsp = Math.max(0, aspect - Math.log(1.3));
  // Shoelace area of the quad.
  let qa = 0;
  for (let j = 0; j < 4; j++) {
    const a = P[j], b = P[(j + 1) % 4];
    qa += a.x * b.y - b.x * a.y;
  }
  qa = Math.abs(qa) / 2;
  const rb = qa / outlineArea;
  const eArea = Math.max(0, 0.72 - rb) + Math.max(0, rb - 1.25);
  let eSharp = 0;
  for (const t of turn) eSharp += Math.min(1, Math.abs(t - 90) / 60);
  eSharp /= 4;
  return (2 * angErr) / 4 / 90 + 2.5 * ePar + 2 * eAsp + 3 * eArea + 0.8 * eSharp;
}

/**
 * Analyse the outline of a single piece (photo coordinates, any start, clockwise preferred).
 * Returns the body corners in the piece's local frame (see PieceShape), side shapes, kind,
 * body size and a confidence; null when no plausible 4-corner body is found.
 */
export function analyzePieceShape(contour: Point[], opts: ShapeOptions = {}): PieceShape | null {
  const flatTol = opts.flatTolerance ?? 0.08;
  if (contour.length < 16) return null;
  let pts = contour;
  if (polygonSignedArea(pts) < 0) pts = [...pts].reverse();
  const area = polygonArea(pts);
  if (area < 150) return null;
  const Lest = Math.sqrt(area);
  const perim = polygonPerimeter(pts);
  const N = Math.max(96, Math.min(1200, Math.round(perim / Math.max(0.75, Lest / 140))));
  const ds = perim / N;
  const dense = resampleContour(pts, N);
  const fine = smoothContour(dense, Math.max(0.6, 0.7 / ds));
  const coarse = smoothContour(dense, Math.max(0.8, (0.025 * Lest) / ds));
  const k = Math.max(2, Math.round((0.08 * Lest) / ds));
  const turn = turningAngles(coarse, k);

  // Corner candidates: convex turning-angle maxima (non-maximum suppression over ±0.7 k).
  const nms = Math.max(1, Math.round(0.7 * k));
  let cand: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = turn[i];
    if (t < (35 * Math.PI) / 180) continue;
    let isMax = true;
    for (let j = -nms; j <= nms && isMax; j++) {
      if (j === 0) continue;
      const q = turn[(i + j + N) % N];
      if (q > t || (q === t && j < 0)) isMax = false;
    }
    if (isMax) cand.push(i);
  }
  if (cand.length < 4) return null;
  if (cand.length > 16) {
    cand = cand.sort((a, b) => turn[b] - turn[a]).slice(0, 16).sort((a, b) => a - b);
  }
  const turnDeg = cand.map((i) => turn[i] * DEG);
  const P = cand.map((i) => coarse[i]);

  // Exhaustive search over 4-subsets (in contour order => clockwise quads).
  const quads: QuadCandidate[] = [];
  const m = cand.length;
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      for (let c = b + 1; c < m; c++) {
        for (let d = c + 1; d < m; d++) {
          const cost = quadCost([P[a], P[b], P[c], P[d]], [turnDeg[a], turnDeg[b], turnDeg[c], turnDeg[d]], area);
          if (Number.isFinite(cost)) quads.push({ idx: [cand[a], cand[b], cand[c], cand[d]], cost });
        }
      }
    }
  }
  if (quads.length === 0) return null;
  quads.sort((p, q) => p.cost - q.cost);

  // Re-rank the best few by their side shapes (a real side has at most one knob, ends near the corners).
  let best: { q: QuadCandidate; total: number; corners: Point[]; sides: SideEval[]; idx: number[] } | null = null;
  let second = Infinity;
  const evaluated: { idx: number[]; total: number }[] = [];
  for (const q of quads.slice(0, 5)) {
    const refined = refineCorners(fine, q.idx, Lest, ds);
    const sides: SideEval[] = [];
    let sidePenalty = 0;
    for (let j = 0; j < 4; j++) {
      const a = refined.idx[j], b = refined.idx[(j + 1) % 4];
      const path = arc(fine, a, b);
      path[0] = refined.corners[j];
      path[path.length - 1] = refined.corners[(j + 1) % 4];
      const s = evalSide(path, refined.corners[j], refined.corners[(j + 1) % 4], flatTol);
      sides.push(s);
      if (s.lobes >= 2) sidePenalty += 0.6;
      if (s.side.kind === 'unknown') sidePenalty += 0.3;
      // Knobs reach ≈ 0.2–0.4 of the side: deeper excursions mean a corner sits on a knob.
      if (s.extent > DEEP_SIDE) sidePenalty += 0.5 + 2 * (s.extent - DEEP_SIDE);
    }
    const total = q.cost + sidePenalty;
    evaluated.push({ idx: q.idx, total });
    if (!best || total < best.total) best = { q, total, corners: refined.corners, sides, idx: refined.idx };
  }
  if (!best) return null;
  // Second best among quads that differ by a clearly different corner.
  for (const e of evaluated) {
    if (e.idx === best.q.idx) continue;
    const differs = e.idx.some((i) => best!.q.idx.every((j) => Math.min(Math.abs(i - j), N - Math.abs(i - j)) > k));
    if (differs && e.total < second) second = e.total;
  }

  // Local frame: start at the corner whose outgoing side points right (direction in (−45, 45]).
  const dirs = [0, 1, 2, 3].map((j) => {
    const a = best!.corners[j], b = best!.corners[(j + 1) % 4];
    return Math.atan2(b.y - a.y, b.x - a.x) * DEG;
  });
  let start = 0, bestAbs = Infinity;
  for (let j = 0; j < 4; j++) {
    const d = dirs[j];
    const inRange = d > -45 && d <= 45;
    const score = inRange ? Math.abs(d) : 1000 + Math.abs(d);
    if (score < bestAbs) { bestAbs = score; start = j; }
  }
  const order = [0, 1, 2, 3].map((j) => (start + j) % 4);
  const corners = order.map((j) => ({ x: best!.corners[j].x, y: best!.corners[j].y })) as [Point, Point, Point, Point];
  const sideEvals = order.map((j) => best!.sides[j]);
  const sides = sideEvals.map((s) => s.side) as [SideShape, SideShape, SideShape, SideShape];
  let angleDeg = dirs[start];
  if (!(angleDeg > -45 && angleDeg <= 45)) angleDeg = reduceQuarter(angleDeg);

  const flats = sides.map((s) => s.kind === 'flat');
  const nFlat = flats.filter(Boolean).length;
  let kind: PieceKind;
  if (nFlat === 0) kind = 'interior';
  else if (nFlat === 1) kind = 'edge';
  else if (nFlat === 2) kind = flats.some((f, j) => f && flats[(j + 1) % 4]) ? 'corner' : 'unknown';
  else kind = 'unknown';

  const bodySize = sides.reduce((s, x) => s + x.length, 0) / 4;
  const center = {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
    y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
  };
  // Confidence: rectangle quality (logistic in the cost; typical good bodies cost 0.3–0.8), side
  // clarity and uniqueness of the corner choice (cost margin to a clearly different quad).
  const rectConf = 1 / (1 + Math.exp((best.total - 1.0) / 0.15));
  const sideConf = sideEvals.reduce((s, e) => s * (0.6 + 0.4 * e.clarity), 1);
  const margin = Number.isFinite(second) ? Math.max(0, Math.min(1, (second - best.total) / 0.4)) : 1;
  let confidence = rectConf * sideConf * (0.5 + 0.5 * margin);
  if (kind === 'unknown') confidence *= 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  return { corners, sides, angleDeg, bodySize, center, kind, confidence };
}

/**
 * Refine corner positions by intersecting lines fitted to the outline just before and after each
 * corner (the straight starts of the adjacent sides). Falls back to the outline point.
 */
function refineCorners(c: Point[], idx: readonly number[], Lest: number, ds: number): { corners: Point[]; idx: number[] } {
  const n = c.length;
  const s0 = Math.max(1, Math.round((0.03 * Lest) / ds));
  const s1 = Math.max(s0 + 3, Math.round((0.2 * Lest) / ds));
  const corners: Point[] = [];
  const outIdx: number[] = [];
  for (let j = 0; j < 4; j++) {
    const i = idx[j];
    const prevGap = ((i - idx[(j + 3) % 4]) % n + n) % n;
    const nextGap = ((idx[(j + 1) % 4] - i) % n + n) % n;
    const e1 = Math.min(s1, Math.floor(prevGap / 2.5)), e2 = Math.min(s1, Math.floor(nextGap / 2.5));
    let corner = c[i];
    if (e1 > s0 + 2 && e2 > s0 + 2) {
      const before: Point[] = [], after: Point[] = [];
      for (let t = s0; t <= e1; t++) before.push(c[(i - t + n) % n]);
      for (let t = s0; t <= e2; t++) after.push(c[(i + t) % n]);
      const l1 = fitLine(before), l2 = fitLine(after);
      const x = l1 && l2 ? intersect(l1, l2) : null;
      if (x && Math.hypot(x.x - c[i].x, x.y - c[i].y) < 0.1 * Lest) corner = x;
    }
    // Outline index closest to the refined corner (within the neighbourhood).
    let bi = i, bd = Infinity;
    const r = s1;
    for (let t = -r; t <= r; t++) {
      const q = c[(i + t + n) % n];
      const d = (q.x - corner.x) ** 2 + (q.y - corner.y) ** 2;
      if (d < bd) { bd = d; bi = (i + t + n) % n; }
    }
    corners.push(corner);
    outIdx.push(bi);
  }
  return { corners, idx: outIdx };
}

/**
 * Grid orientation of a piece body in degrees, (−45, 45]: circular mean (period 90°) of the
 * directions of its four corner-to-corner sides. Less sensitive to an irregular cut than
 * `angleDeg`, which follows side 0 only.
 */
export function bodyOrientation(shape: PieceShape): number {
  let cx = 0, cy = 0;
  for (let j = 0; j < 4; j++) {
    const a = shape.corners[j], b = shape.corners[(j + 1) % 4];
    const r = 4 * Math.atan2(b.y - a.y, b.x - a.x);
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    cx += w * Math.cos(r);
    cy += w * Math.sin(r);
  }
  return reduceQuarter((Math.atan2(cy, cx) * DEG) / 4);
}

/**
 * Dominant grid orientation of an outline in degrees, (−45, 45]: the direction (mod 90°) shared by
 * most of its straight parts. Works for single pieces and assembled patches (piece sides and
 * borders dominate). Returns 0 for degenerate input.
 */
export function dominantOrientation(contour: Point[]): number {
  return orientationHistogram(contour).angle;
}

/**
 * Orientation analysis behind {@link dominantOrientation}: the dominant angle, the fraction of the
 * straight outline length aligned with it (±7°), and the height of the strongest other orientation
 * peak (≥ 20° away) relative to the dominant one (high for clusters of differently rotated pieces).
 */
export function orientationHistogram(contour: Point[]): { angle: number; alignment: number; secondPeak: number } {
  if (contour.length < 3) return { angle: 0, alignment: 0, secondPeak: 0 };
  const perim = polygonPerimeter(contour);
  if (!(perim > 0)) return { angle: 0, alignment: 0, secondPeak: 0 };
  const N = Math.max(32, Math.min(4096, Math.round(perim / 1.5)));
  const pts = smoothContour(resampleContour(contour, N), 1.5);
  const step = perim / N;
  const h = Math.max(2, Math.round(3 / step));
  const BINS = 180; // 0.5° bins over [0, 90)
  const hist = new Float64Array(BINS);
  const ang = new Float32Array(N), wt = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = pts[(i - h + N) % N], b = pts[(i + h) % N];
    const a2 = pts[(i - 2 * h + N) % N], b2 = pts[(i + 2 * h) % N];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    // Straightness: change of direction between the two halves of a wider window.
    const d1 = Math.atan2(pts[i].y - a2.y, pts[i].x - a2.x), d2 = Math.atan2(b2.y - pts[i].y, b2.x - pts[i].x);
    let dd = Math.abs(d2 - d1);
    if (dd > Math.PI) dd = 2 * Math.PI - dd;
    const w = Math.exp(-(((dd * DEG) / 12) ** 2));
    let deg = (t1 * DEG) % 90;
    if (deg < 0) deg += 90;
    ang[i] = deg;
    wt[i] = w;
    hist[Math.min(BINS - 1, Math.floor(deg * 2))] += w;
  }
  // Circular Gaussian smoothing (σ = 2°).
  const sm = new Float64Array(BINS);
  const R = 12;
  for (let i = 0; i < BINS; i++) {
    let s = 0;
    for (let j = -R; j <= R; j++) s += hist[(i + j + BINS) % BINS] * Math.exp(-((j * 0.5) ** 2) / (2 * 2 * 2));
    sm[i] = s;
  }
  let peak = 0;
  for (let i = 1; i < BINS; i++) if (sm[i] > sm[peak]) peak = i;
  const peakDeg = (peak + 0.5) / 2;
  // Refine with a weighted circular mean (period 90°) near the peak, re-centred once.
  let mean = peakDeg;
  let total = 0, aligned = 0;
  for (let iter = 0; iter < 2; iter++) {
    let cx = 0, cy = 0;
    total = 0;
    aligned = 0;
    for (let i = 0; i < N; i++) {
      let d = ang[i] - mean;
      d -= 90 * Math.round(d / 90);
      total += wt[i];
      if (Math.abs(d) <= ALIGNED_TOL) aligned += wt[i];
      if (Math.abs(d) <= ALIGN_WINDOW) {
        const r = (ang[i] * 4 * Math.PI) / 180;
        cx += wt[i] * Math.cos(r);
        cy += wt[i] * Math.sin(r);
      }
    }
    if (cx === 0 && cy === 0) break;
    mean = (Math.atan2(cy, cx) * DEG) / 4;
  }
  // Strongest histogram peak clearly away from the dominant one, relative to it.
  let second = 0;
  for (let i = 0; i < BINS; i++) {
    let d = Math.abs((i + 0.5) / 2 - peakDeg);
    d = Math.min(d, 90 - d);
    if (d < SECOND_PEAK_MIN_SEPARATION) continue;
    const isPeak = sm[i] >= sm[(i + 1) % BINS] && sm[i] >= sm[(i - 1 + BINS) % BINS];
    if (isPeak && sm[i] > second) second = sm[i];
  }
  return { angle: reduceQuarter(mean), alignment: total > 0 ? aligned / total : 0, secondPeak: sm[peak] > 0 ? second / sm[peak] : 0 };
}
