/**
 * Nested structure of a box lid: the picture printed inside a frame. Works in the rectified
 * coordinates of a base quad (unit square), where the frame's inner and outer edges are parallel.
 *
 * - `directedLines` scans lines parallel to each side (inwards and outwards) and returns the
 *   offsets with strong edge support, so the picture edge inside a lid (or the lid around a
 *   picture) becomes a line candidate even when the global Hough transform missed it.
 * - `nestedBands` / `frameEvidence` decide whether the band between two nested quads looks like a
 *   printed frame (uniform colour, little texture) rather than part of the picture.
 */
import { applyMat3, mat3Invert, type Mat3, type Point, type Quad } from '../../cv/geometry';
import type { RGBAImage } from '../../cv/image';
import { supportAt, type GradientField } from './field';
import type { Line } from './lines';
import { quadSides, unitSquareToQuad } from './geometry';

/** Unit-square line for side s at inward offset δ: returns two points (u, v) on it. */
function sideLineUnit(s: number, delta: number, a: number, b: number): [Point, Point] {
  switch (s) {
    case 0: return [{ x: a, y: delta }, { x: b, y: delta }];
    case 1: return [{ x: 1 - delta, y: a }, { x: 1 - delta, y: b }];
    case 2: return [{ x: a, y: 1 - delta }, { x: b, y: 1 - delta }];
    default: return [{ x: delta, y: a }, { x: delta, y: b }];
  }
}

/** Mean support along the image of a unit-square segment (no lateral search). */
function unitSegmentSupport(f: GradientField, H: Mat3, p: Point, q: Point, samples: number): number {
  const P = applyMat3(H, p), Q = applyMat3(H, q);
  const len = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (len < 1) return 0;
  const nx = -(Q.y - P.y) / len, ny = (Q.x - P.x) / len;
  let s = 0;
  for (let k = 0; k < samples; k++) {
    const t = (k + 0.5) / samples;
    // Perspective-correct position along the segment.
    const r = applyMat3(H, { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    s += supportAt(f, r.x, r.y, nx, ny);
  }
  return s / samples;
}

/**
 * Lines parallel (in the quad's rectified frame) to each side of `quad` with strong edge support,
 * at offsets from −`outward` to +`inward` (fractions of the quad size).
 */
export function directedLines(f: GradientField, quad: Quad, inward = 0.3, outward = 0.2): Line[] {
  const H = unitSquareToQuad(quad);
  if (!H) return [];
  const sides = quadSides(quad);
  const out: Line[] = [];
  for (let s = 0; s < 4; s++) {
    // Pixel extent perpendicular to side s.
    const perp = s % 2 === 0 ? (sides[1] + sides[3]) / 2 : (sides[0] + sides[2]) / 2;
    const along = s % 2 === 0 ? (sides[0] + sides[2]) / 2 : (sides[1] + sides[3]) / 2;
    if (perp < 10) continue;
    const step = 0.7 / perp;
    const samples = Math.max(20, Math.min(120, Math.round(along / 6)));
    const deltas: number[] = [];
    const prof: number[] = [];
    for (let d = -outward; d <= inward; d += step) {
      const [p, q] = sideLineUnit(s, d, 0.12, 0.88);
      deltas.push(d);
      prof.push(unitSegmentSupport(f, H, p, q, samples));
    }
    // Light smoothing, local maxima.
    const sm = prof.map((v, i) => 0.25 * (prof[i - 1] ?? v) + 0.5 * v + 0.25 * (prof[i + 1] ?? v));
    const peaks: { i: number; v: number }[] = [];
    for (let i = 1; i < sm.length - 1; i++) {
      if (sm[i] >= 0.3 && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) peaks.push({ i, v: sm[i] });
    }
    peaks.sort((a, b) => b.v - a.v);
    const kept: number[] = [];
    for (const pk of peaks) {
      if (kept.length >= 6) break;
      if (kept.some((k) => Math.abs(k - pk.i) * step * perp < 3)) continue;
      kept.push(pk.i);
      const [p, q] = sideLineUnit(s, deltas[pk.i], 0, 1);
      const P = applyMat3(H, p), Q = applyMat3(H, q);
      const len = Math.hypot(Q.x - P.x, Q.y - P.y);
      if (len > 1) out.push({ p: P, d: { x: (Q.x - P.x) / len, y: (Q.y - P.y) / len } });
    }
  }
  return out;
}

export interface NestedBands {
  /** Band widths top, right, bottom, left as fractions of the outer quad (unit square). */
  bands: [number, number, number, number];
}

/**
 * When `inner` lies inside `outer` with sides parallel in the outer's rectified frame, return the
 * band widths; null otherwise.
 */
export function nestedBands(outer: Quad, inner: Quad, maxBand = 0.32, parTol = 0.025): NestedBands | null {
  const H = unitSquareToQuad(outer);
  if (!H) return null;
  let Hi: Mat3;
  try {
    Hi = mat3Invert(H);
  } catch {
    return null;
  }
  const u = inner.map((p) => applyMat3(Hi, p));
  const [tl, tr, br, bl] = u;
  if (Math.abs(tl.y - tr.y) > parTol || Math.abs(bl.y - br.y) > parTol) return null;
  if (Math.abs(tl.x - bl.x) > parTol || Math.abs(tr.x - br.x) > parTol) return null;
  const bands: [number, number, number, number] = [
    (tl.y + tr.y) / 2,
    1 - (tr.x + br.x) / 2,
    1 - (bl.y + br.y) / 2,
    (tl.x + bl.x) / 2,
  ];
  for (const b of bands) if (b < -0.006 || b > maxBand) return null;
  return { bands };
}

export interface FrameEvidence {
  /** Fraction of samples just outside the inner quad close to the frame's dominant colour. */
  uniformity: number;
  /** Fraction of those samples without a significant gradient. */
  flatness: number;
  /** Worst side: fraction of samples just inside the inner quad that share the frame colour. */
  innerSimilarity: number;
  /** Combined evidence 0..1. */
  evidence: number;
  /** Number of sides with a measurable band. */
  bandSides: number;
}

/**
 * How much the band between `outer` and the nested quad (given by its band widths) looks like a
 * printed frame. Thin strips are sampled on both sides of every inner side that has a band: just
 * outside (frame: uniform colour, untextured; logos and text usually keep some distance from the
 * picture) and just inside (picture: different from the frame colour on every side).
 */
export function frameEvidence(img: RGBAImage, f: GradientField, outer: Quad, bands: [number, number, number, number]): FrameEvidence {
  const H = unitSquareToQuad(outer);
  const none: FrameEvidence = { uniformity: 0, flatness: 0, innerSimilarity: 1, evidence: 0, bandSides: 0 };
  if (!H) return none;
  const sides = quadSides(outer);
  const outside: number[][] = [];
  const inside: number[][][] = [];
  let flatCount = 0, bandSides = 0;
  const [bt, br, bb, bl] = bands;
  const read = (u: number, v: number, into: number[][], countFlat: boolean) => {
    const p = applyMat3(H, { x: u, y: v });
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    into.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
    if (countFlat && f.mag[y * img.width + x] < 1.5 * f.lo) flatCount++;
  };
  for (let s = 0; s < 4; s++) {
    const b = bands[s];
    const perp = s % 2 === 0 ? (sides[1] + sides[3]) / 2 : (sides[0] + sides[2]) / 2;
    const bandPx = b * perp;
    if (bandPx < 4) continue;
    bandSides++;
    const a0 = s % 2 === 0 ? bl : bt, a1 = s % 2 === 0 ? 1 - br : 1 - bb;
    // Depths in pixels from the inner side: outside (towards the outer quad) and inside.
    const outD = [2.5, Math.min(4.5, bandPx - 1.5)];
    const inD = [2.5, 4.5, 7];
    const ins: number[][] = [];
    for (let k = 0; k < 48; k++) {
      const a = a0 + ((k + 0.1 + 0.8 * (k % 2)) / 48) * (a1 - a0);
      for (const dp of outD) {
        const d = b - dp / perp;
        read(...uvAt(s, a, d), outside, true);
      }
      for (const dp of inD) read(...uvAt(s, a, b + dp / perp), ins, false);
    }
    inside.push(ins);
  }
  if (outside.length < 20) return none;
  const med = [0, 1, 2].map((c) => {
    const v = outside.map((p) => p[c]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  });
  const close = (p: number[]) => Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) < 32;
  const uniformity = outside.filter(close).length / outside.length;
  const flatness = flatCount / outside.length;
  let innerSimilarity = 0;
  for (const ins of inside) if (ins.length) innerSimilarity = Math.max(innerSimilarity, ins.filter(close).length / ins.length);
  const evidence = Math.max(0, Math.min(uniformity, flatness) * (1 - innerSimilarity));
  return { uniformity, flatness, innerSimilarity, evidence, bandSides };
}

/** Unit-square coordinates of position `a` along side s at inward depth d. */
function uvAt(s: number, a: number, d: number): [number, number] {
  return s === 0 ? [a, d] : s === 1 ? [1 - d, a] : s === 2 ? [a, 1 - d] : [d, a];
}
