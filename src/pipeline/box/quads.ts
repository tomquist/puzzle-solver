/**
 * Quad hypotheses from pairs of roughly parallel lines, scored by edge support along all four
 * sides (with extra weight on the corner ends), geometric plausibility, size and photo-border use.
 */
import type { Point, Quad } from '../../cv/geometry';
import { lineIntersection } from '../../cv/lines';
import { maxCornerDistance, quadAngles, quadArea, quadSides } from './geometry';
import { paramOf, segmentSupport, signedDistance, type ScoredLine } from './lines';

export interface QuadCandidate {
  /** Working coordinates, TL, TR, BR, BL. */
  quad: Quad;
  /** Pool index of the line under each side (top, right, bottom, left). */
  lines: [number, number, number, number];
  /** Mean edge support per side. */
  sides: number[];
  /** Support near each corner (min of both incident side ends), TL, TR, BR, BL. */
  corners: number[];
  /** Combined edge support 0..1. */
  support: number;
  /** Geometric plausibility 0..1. */
  geom: number;
  areaFrac: number;
  borderSides: number;
  score: number;
}

export interface EvalContext {
  width: number;
  height: number;
  lines: ScoredLine[];
}

/** Support of side line `l` between corners a → b, plus the support of its two end pieces. */
function sideEval(l: ScoredLine, a: Point, b: Point): { s: number; ea: number; eb: number } {
  const ta = paramOf(l, a), tb = paramOf(l, b);
  const len = Math.abs(tb - ta);
  const lam = Math.max(3, 0.1 * len);
  const dir = tb >= ta ? 1 : -1;
  return {
    s: segmentSupport(l, ta, tb),
    ea: segmentSupport(l, ta, ta + dir * lam),
    eb: segmentSupport(l, tb - dir * lam, tb),
  };
}

const smooth = (x: number, a: number, b: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Geometric plausibility of a quad (angles, opposite-side ratios, aspect). 0 = reject. */
export function quadGeometry(q: Quad, minDim: number): number {
  const s = quadSides(q);
  if (Math.min(...s) < 0.1 * minDim) return 0;
  let g = 1;
  for (const a of quadAngles(q)) {
    const dev = Math.abs(a - 90);
    if (dev > 22) g *= Math.exp(-(((dev - 22) / 12) ** 2));
  }
  const r = Math.min(Math.min(s[0], s[2]) / Math.max(s[0], s[2]), Math.min(s[1], s[3]) / Math.max(s[1], s[3]));
  g *= smooth(r, 0.35, 0.65);
  let aspect = (s[0] + s[2]) / (s[1] + s[3]);
  if (aspect < 1) aspect = 1 / aspect;
  if (aspect > 3) g *= Math.exp(-(aspect - 3));
  return g;
}

/**
 * Evaluate the quad formed by four pool lines given in cyclic side order. Returns null for
 * non-convex / out-of-image / implausible configurations.
 */
export function evaluateQuad(ctx: EvalContext, sideLines: number[], cornersIn: Point[], maxBorderSides = 2): QuadCandidate | null {
  const { width: W, height: H, lines } = ctx;
  // Orientation: make clockwise (positive signed area in y-down coordinates).
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = cornersIn[i], b = cornersIn[(i + 1) % 4];
    area2 += a.x * b.y - b.x * a.y;
  }
  let corners = cornersIn;
  // side k runs corners[k] -> corners[k+1] on sideLines[k]
  let sl = sideLines;
  if (area2 < 0) {
    corners = [cornersIn[0], cornersIn[3], cornersIn[2], cornersIn[1]];
    sl = [sideLines[3], sideLines[2], sideLines[1], sideLines[0]];
  }
  // Convexity.
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return null;
  }
  const m = 0.01 * Math.min(W, H) + 0.5;
  for (const c of corners) if (c.x < -m - 0.5 || c.y < -m - 0.5 || c.x > W - 0.5 + m || c.y > H - 0.5 + m) return null;
  // Start at the top-left corner (min x + y), like orderQuad.
  let start = 0;
  for (let i = 1; i < 4; i++) if (corners[i].x + corners[i].y < corners[start].x + corners[start].y) start = i;
  const quad = [0, 1, 2, 3].map((k) => corners[(start + k) % 4]) as Quad;
  const lineIdx = [0, 1, 2, 3].map((k) => sl[(start + k) % 4]) as [number, number, number, number];
  const minDim = Math.min(W, H);
  const geom = quadGeometry(quad, minDim);
  if (geom < 0.05) return null;
  const areaFrac = quadArea(quad) / (W * H);
  if (areaFrac < 0.02) return null;
  let borderSides = 0;
  const sides: number[] = [], ends: number[] = [];
  for (let k = 0; k < 4; k++) {
    const l = lines[lineIdx[k]];
    if (l.border !== undefined) borderSides++;
    const e = sideEval(l, quad[k], quad[(k + 1) % 4]);
    sides.push(e.s);
    ends.push(e.ea, e.eb);
  }
  if (borderSides > maxBorderSides) return null;
  // Corner k joins the end of side k-1 and the start of side k.
  const cornerSup = [0, 1, 2, 3].map((k) => Math.min(ends[2 * ((k + 3) % 4) + 1], ends[2 * k]));
  const mean = (sides[0] + sides[1] + sides[2] + sides[3]) / 4;
  const min = Math.min(...sides);
  const E = (cornerSup[0] + cornerSup[1] + cornerSup[2] + cornerSup[3]) / 4;
  const support = (0.5 * mean + 0.5 * min) * (0.55 + 0.45 * E);
  const score = support * geom * Math.pow(areaFrac, 0.25) * Math.pow(0.92, borderSides);
  return { quad, lines: lineIdx, sides, corners: cornerSup, support, geom, areaFrac, borderSides, score };
}

/** Enumerate quads from all compatible pairs of line pairs; best first after duplicate suppression. */
export function enumerateQuads(ctx: EvalContext, maxResults = 60): QuadCandidate[] {
  const { width: W, height: H, lines } = ctx;
  const L = lines.length;
  const minDim = Math.min(W, H);
  const minSep = 0.1 * minDim;
  const cosPar = Math.cos((35 * Math.PI) / 180);
  const cosPerp = Math.cos((45 * Math.PI) / 180);
  // Pairwise intersections.
  const X: (Point | null)[] = new Array(L * L).fill(null);
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      const p = lineIntersection(lines[i].p, lines[i].d, lines[j].p, lines[j].d);
      X[i * L + j] = X[j * L + i] = p;
    }
  }
  // Roughly parallel, well separated pairs.
  const pairs: { i: number; j: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      const a = lines[i], b = lines[j];
      const c = a.d.x * b.d.x + a.d.y * b.d.y;
      if (Math.abs(c) < cosPar) continue;
      if (a.border !== undefined && b.border !== undefined) continue;
      const sep = Math.min(Math.abs(signedDistance(a, b.p)), Math.abs(signedDistance(b, a.p)));
      if (sep < minSep) continue;
      // Opposite sides must not cross inside the image.
      const x = X[i * L + j];
      if (x && x.x > -0.5 && x.y > -0.5 && x.x < W - 0.5 && x.y < H - 0.5) continue;
      const s = c >= 0 ? 1 : -1;
      const dx = a.d.x + s * b.d.x, dy = a.d.y + s * b.d.y;
      const n = Math.hypot(dx, dy);
      pairs.push({ i, j, dx: dx / n, dy: dy / n });
    }
  }
  const out: QuadCandidate[] = [];
  for (let p = 0; p < pairs.length; p++) {
    const A = pairs[p];
    for (let q = p + 1; q < pairs.length; q++) {
      const B = pairs[q];
      if (Math.abs(A.dx * B.dx + A.dy * B.dy) > cosPerp) continue;
      if (A.i === B.i || A.i === B.j || A.j === B.i || A.j === B.j) continue;
      const c1 = X[A.i * L + B.i], c2 = X[A.i * L + B.j], c3 = X[A.j * L + B.j], c4 = X[A.j * L + B.i];
      if (!c1 || !c2 || !c3 || !c4) continue;
      // Sides: A.i (c1→c2), B.j (c2→c3), A.j (c3→c4), B.i (c4→c1).
      const cand = evaluateQuad(ctx, [A.i, B.j, A.j, B.i], [c1, c2, c3, c4]);
      if (cand) out.push(cand);
    }
  }
  out.sort((a, b) => b.score - a.score);
  return suppressDuplicates(out, Math.max(3, 0.005 * Math.hypot(W, H)), maxResults);
}

/** Greedy non-maximum suppression on corner distance. */
export function suppressDuplicates(sorted: QuadCandidate[], tol: number, max: number): QuadCandidate[] {
  const kept: QuadCandidate[] = [];
  for (const c of sorted) {
    if (kept.length >= max) break;
    if (kept.some((k) => maxCornerDistance(k.quad, c.quad) < tol)) continue;
    kept.push(c);
  }
  return kept;
}
