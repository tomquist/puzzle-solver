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
import { supportAt, supportNear, type GradientField } from './field';
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

/** Unit-square endpoints of a line near side s whose ends are offset inwards by δa and δb. */
function sideLineEnds(s: number, da: number, db: number): [Point, Point] {
  switch (s) {
    case 0: return [{ x: 0, y: da }, { x: 1, y: db }];
    case 1: return [{ x: 1 - da, y: 0 }, { x: 1 - db, y: 1 }];
    case 2: return [{ x: 0, y: 1 - da }, { x: 1, y: 1 - db }];
    default: return [{ x: da, y: 0 }, { x: db, y: 1 }];
  }
}

/** Mean support along the image of unit segment p→q restricted to [a, b] of its length. */
function snapSupport(f: GradientField, H: Mat3, p: Point, q: Point, samples: number, r: number): number {
  const P = applyMat3(H, p), Q = applyMat3(H, q);
  const len = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (len < 1) return 0;
  const nx = -(Q.y - P.y) / len, ny = (Q.x - P.x) / len;
  let s = 0;
  for (let k = 0; k < samples; k++) {
    const t = 0.08 + 0.84 * ((k + 0.5) / samples);
    const m = applyMat3(H, { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    s += r > 0 ? supportNear(f, m.x, m.y, nx, ny, r) : supportAt(f, m.x, m.y, nx, ny);
  }
  return s / samples;
}

/**
 * Snap each side of `quad` to nearby edges: a coarse-to-fine search over lines whose two ends move
 * independently (±`range` of the quad size, in its rectified frame). Returns the best lines per
 * side (several local maxima), extended over the whole image.
 */
export function snapSideLines(f: GradientField, quad: Quad, range = 0.1, perSide = 2): Line[] {
  const H = unitSquareToQuad(quad);
  if (!H) return [];
  const sides = quadSides(quad);
  const out: Line[] = [];
  for (let s = 0; s < 4; s++) {
    const perp = s % 2 === 0 ? (sides[1] + sides[3]) / 2 : (sides[0] + sides[2]) / 2;
    const along = s % 2 === 0 ? (sides[0] + sides[2]) / 2 : (sides[1] + sides[3]) / 2;
    if (perp < 10 || along < 10) continue;
    const coarse = 4 / perp;
    const n = Math.max(1, Math.ceil(range / coarse));
    const dim = 2 * n + 1;
    const grid = new Float32Array(dim * dim);
    const samples = Math.max(16, Math.min(48, Math.round(along / 12)));
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        const [p, q] = sideLineEnds(s, (i - n) * coarse, (j - n) * coarse);
        grid[i * dim + j] = snapSupport(f, H, p, q, samples, 2);
      }
    }
    // Local maxima of the coarse grid.
    const maxima: { i: number; j: number; v: number }[] = [];
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        const v = grid[i * dim + j];
        if (v < 0.25) continue;
        let isMax = true;
        for (let di = -1; di <= 1 && isMax; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= dim || jj >= dim) continue;
            const u = grid[ii * dim + jj];
            if (u > v || (u === v && (di < 0 || (di === 0 && dj < 0)))) { isMax = false; break; }
          }
        }
        if (isMax) maxima.push({ i, j, v });
      }
    }
    maxima.sort((a, b) => b.v - a.v);
    const fine = 1 / perp;
    const fineSamples = Math.max(24, Math.min(96, Math.round(along / 6)));
    for (const m of maxima.slice(0, perSide)) {
      let bestA = (m.i - n) * coarse, bestB = (m.j - n) * coarse, bestV = -1;
      const a0 = bestA, b0 = bestB;
      for (let di = -3; di <= 3; di++) {
        for (let dj = -3; dj <= 3; dj++) {
          const da = a0 + di * fine, db = b0 + dj * fine;
          const [p, q] = sideLineEnds(s, da, db);
          const v = snapSupport(f, H, p, q, fineSamples, 0);
          if (v > bestV) { bestV = v; bestA = da; bestB = db; }
        }
      }
      const [p, q] = sideLineEnds(s, bestA, bestB);
      const P = applyMat3(H, p), Q = applyMat3(H, q);
      const len = Math.hypot(Q.x - P.x, Q.y - P.y);
      if (len > 1) out.push({ p: P, d: { x: (Q.x - P.x) / len, y: (Q.y - P.y) / len } });
    }
  }
  return out;
}

/**
 * Texture baseline of a quad's edges (0..1): for each side, the lowest edge support on parallel
 * lines 3–10 % inside and outside (a real boundary has a calm strip nearby – table, frame or a calm
 * part of the picture – while texture is busy everywhere); median over the sides that are not on
 * the photo border. High values mean the "edges" are just texture.
 */
export function edgeBaseline(f: GradientField, quad: Quad, skipSide: boolean[] = []): number {
  const H = unitSquareToQuad(quad);
  if (!H) return 1;
  const sides = quadSides(quad);
  const vals: number[] = [];
  for (let s = 0; s < 4; s++) {
    if (skipSide[s]) continue;
    const perp = s % 2 === 0 ? (sides[1] + sides[3]) / 2 : (sides[0] + sides[2]) / 2;
    const along = s % 2 === 0 ? (sides[0] + sides[2]) / 2 : (sides[1] + sides[3]) / 2;
    if (perp < 10) continue;
    const samples = Math.max(16, Math.min(64, Math.round(along / 8)));
    let low = Infinity;
    for (const frac of [0.03, 0.06, 0.1]) {
      const d = Math.max(5 / perp, frac);
      for (const sign of [1, -1]) {
        const [p, q] = sideLineUnit(s, sign * d, 0.1, 0.9);
        const P = applyMat3(H, p), Q = applyMat3(H, q);
        const len = Math.hypot(Q.x - P.x, Q.y - P.y);
        if (len < 1) continue;
        const nx = -(Q.y - P.y) / len, ny = (Q.x - P.x) / len;
        let sum = 0, inside = 0;
        for (let k = 0; k < samples; k++) {
          const t = (k + 0.5) / samples;
          const m = applyMat3(H, { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
          if (m.x < 2 || m.y < 2 || m.x > f.width - 3 || m.y > f.height - 3) continue;
          sum += supportNear(f, m.x, m.y, nx, ny, 2);
          inside++;
        }
        // Lines that leave the photo say nothing about the texture there.
        if (inside >= 0.7 * samples) low = Math.min(low, sum / inside);
      }
    }
    if (Number.isFinite(low)) vals.push(low);
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
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
  /** Fraction of samples just outside the outer quad that share the frame colour (table, not frame). */
  outerSimilarity: number;
  /** Combined evidence 0..1. */
  evidence: number;
  /** Number of sides with a measurable band. */
  bandSides: number;
  /** Narrowest measurable band (fraction of the outer quad). */
  minBand: number;
}

/**
 * How much the band between `outer` and the nested quad (given by its band widths) looks like a
 * printed frame. Thin strips are sampled on both sides of every inner side that has a band: just
 * outside (frame: uniform colour, untextured; logos and text usually keep some distance from the
 * picture) and just inside (picture: different from the frame colour on every side).
 */
export function frameEvidence(img: RGBAImage, f: GradientField, outer: Quad, bands: [number, number, number, number]): FrameEvidence {
  const H = unitSquareToQuad(outer);
  const none: FrameEvidence = { uniformity: 0, flatness: 0, innerSimilarity: 1, outerSimilarity: 1, evidence: 0, bandSides: 0, minBand: 0 };
  if (!H) return none;
  const sides = quadSides(outer);
  const [bt, br, bb, bl] = bands;
  interface SideSamples { out: number[][]; flat: number; ins: number[][]; beyond: number[][] }
  const per: SideSamples[] = [];
  let minBand = Infinity;
  const read = (u: number, v: number, into: number[][]): number => {
    const p = applyMat3(H, { x: u, y: v });
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
    const o = (y * img.width + x) * 4;
    into.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
    return f.mag[y * img.width + x];
  };
  for (let s = 0; s < 4; s++) {
    const b = bands[s];
    const perp = s % 2 === 0 ? (sides[1] + sides[3]) / 2 : (sides[0] + sides[2]) / 2;
    const bandPx = b * perp;
    if (bandPx < 4) continue;
    const a0 = s % 2 === 0 ? bl : bt, a1 = s % 2 === 0 ? 1 - br : 1 - bb;
    // Depths in pixels from the inner side: outside (towards the outer quad) and inside.
    const outD = [2.5, Math.min(4, bandPx - 1.5)];
    const inD = [2.5, 4.5, 7];
    const ss: SideSamples = { out: [], flat: 0, ins: [], beyond: [] };
    for (let k = 0; k < 48; k++) {
      const a = a0 + ((k + 0.5) / 48) * (a1 - a0);
      for (const dp of outD) {
        const m = read(...uvAt(s, a, b - dp / perp), ss.out);
        if (m >= 0 && m < 2.5 * f.lo) ss.flat++;
      }
      for (const dp of inD) read(...uvAt(s, a, b + dp / perp), ss.ins);
      for (const dp of [2.5, 4]) read(...uvAt(s, a, -dp / perp), ss.beyond);
    }
    if (ss.out.length >= 8) {
      per.push(ss);
      minBand = Math.min(minBand, b);
    }
  }
  if (!per.length) return none;
  const all = per.flatMap((p) => p.out);
  const med = [0, 1, 2].map((c) => {
    const v = all.map((p) => p[c]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  });
  const close = (p: number[]) => Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) < 32;
  let uSum = 0, fSum = 0, minSide = 1, innerSimilarity = 0;
  const beyond = per.flatMap((p) => p.beyond);
  const outerSimilarity = beyond.length ? beyond.filter(close).length / beyond.length : 0;
  for (const p of per) {
    const u = p.out.filter(close).length / p.out.length;
    const fl = p.flat / p.out.length;
    uSum += u;
    fSum += fl;
    minSide = Math.min(minSide, u, fl);
    if (p.ins.length) innerSimilarity = Math.max(innerSimilarity, p.ins.filter(close).length / p.ins.length);
  }
  const uniformity = uSum / per.length, flatness = fSum / per.length;
  // Every band side must look like frame; the picture just inside must differ on every side; a band
  // that simply continues outside the outer quad is more likely table (or shadow) than frame.
  const evidence = minSide < 0.4 ? 0 : Math.min(uniformity, flatness) * (1 - innerSimilarity) * (1 - 0.6 * outerSimilarity);
  return { uniformity, flatness, innerSimilarity, outerSimilarity, evidence, bandSides: per.length, minBand };
}

/** Unit-square coordinates of position `a` along side s at inward depth d. */
function uvAt(s: number, a: number, d: number): [number, number] {
  return s === 0 ? [a, d] : s === 1 ? [1 - d, a] : s === 2 ? [a, 1 - d] : [d, a];
}
