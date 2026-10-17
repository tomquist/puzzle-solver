/**
 * Placement of one photographed region (single piece or assembled patch) in the reference.
 *
 * Pipeline: normalise the region into a few similarity hypotheses (4 orientations; scales) →
 * dense coarse search (masked multi-channel NCC + colour term) on the coarsest pyramid level →
 * keep the best ~30 distinct peaks → refine position on the finer levels → refine angle/scale on
 * the best few → rank, apply priors (flat sides at the border, placed cells) → confidence.
 */
import { findSimilarity, type Point } from '../../cv/geometry';
import { cellKey, type CellRef, type MatchStatus, type Placement, type RegionMatch, type SideKind } from '../../model/types';
import { buildTemplate, DEFAULT_SCORE, makePhotoSource, scoreAt, type ColorCorrection, type Mapping, type PhotoSource, type ScoreParams, type Template } from './template';
import type { MatchInput, MatchOptions, RefLevel, ReferenceIndex } from './types';

/** A similarity hypothesis to search. */
interface Hypothesis {
  map: Mapping;
  /** Orientation group (quarter-turn index) used for non-maximum suppression. */
  group: number;
  /** Upright side kinds top, right, bottom, left (grid prior), when known. */
  sides?: SideKind[];
  sideWeight: number;
}

interface Candidate {
  hyp: Hypothesis;
  map: Mapping;
  /** Pivot position in reference px. */
  ref: Point;
  /** Raw similarity at the current level. */
  raw: number;
  /** raw minus priors. */
  score: number;
  level: number;
}

const DEG = 180 / Math.PI;
const PRIOR_FLAT_INSIDE = 0.22;
const PRIOR_KNOB_AT_BORDER = 0.22;
const PLACED_PENALTY = 0.1;

function norm360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
}

/** Cell of a reference position (clamped to the grid). */
export function cellAt(index: ReferenceIndex, p: Point): CellRef {
  const col = Math.min(index.grid.cols - 1, Math.max(0, Math.floor((p.x + 0.5) / index.cellW)));
  const row = Math.min(index.grid.rows - 1, Math.max(0, Math.floor((p.y + 0.5) / index.cellH)));
  return { row, col };
}

function pivotRef(level: RefLevel, t: Template, X: number, Y: number): Point {
  return {
    x: (X + t.cx - level.pad + 0.5) / level.scaleX - 0.5,
    y: (Y + t.cy - level.pad + 0.5) / level.scaleY - 0.5,
  };
}

function fits(level: RefLevel, t: Template, X: number, Y: number): boolean {
  return X >= 0 && Y >= 0 && X + t.w <= level.stride && Y + t.h <= level.rows;
}

/** Penalty for violating the border constraints implied by flat sides. */
function gridPrior(index: ReferenceIndex, hyp: Hypothesis, ref: Point): number {
  if (index.cut !== 'grid' || !hyp.sides || hyp.sideWeight <= 0) return 0;
  const { row, col } = cellAt(index, ref);
  const border = [row === 0, col === index.grid.cols - 1, row === index.grid.rows - 1, col === 0];
  let pen = 0;
  for (let j = 0; j < 4; j++) {
    const k = hyp.sides[j];
    if (k === 'flat' && !border[j]) pen += PRIOR_FLAT_INSIDE;
    else if ((k === 'tab' || k === 'blank') && border[j]) pen += PRIOR_KNOB_AT_BORDER;
  }
  return pen * hyp.sideWeight;
}

/** Build the similarity hypotheses for a region. */
function makeHypotheses(index: ReferenceIndex, input: MatchInput, src: PhotoSource): { hyps: Hypothesis[]; bodySize: number } {
  const { cellW, cellH } = index;
  const cellGeo = Math.sqrt(cellW * cellH);
  const shape = input.shape;
  if (shape && input.kind !== 'patch') {
    const hyps: Hypothesis[] = [];
    const dst = [
      { x: -cellW / 2, y: -cellH / 2 },
      { x: cellW / 2, y: -cellH / 2 },
      { x: cellW / 2, y: cellH / 2 },
      { x: -cellW / 2, y: cellH / 2 },
    ];
    const anyKnown = shape.sides.some((s) => s.kind !== 'unknown');
    for (let k = 0; k < 4; k++) {
      const srcPts = [0, 1, 2, 3].map((i) => shape.corners[(i + k) % 4]);
      const sim = findSimilarity(srcPts, dst);
      if (!sim) continue;
      const sides = [0, 1, 2, 3].map((j) => shape.sides[(j + k) % 4].kind);
      hyps.push({
        map: { pivot: { ...shape.center }, phi: sim.theta, s: sim.scale },
        group: k,
        sides: anyKnown ? sides : undefined,
        sideWeight: Math.max(0, Math.min(1, shape.confidence)),
      });
    }
    return { hyps, bodySize: shape.bodySize };
  }
  // No shape: dominant orientation, scale from the expected body size (or the region area).
  let bodySizes: number[];
  if (shape) bodySizes = [shape.bodySize];
  else if (input.expectedBodySize && input.expectedBodySize > 0) bodySizes = [input.expectedBodySize];
  else if (input.kind === 'patch') bodySizes = [2, 3, 4, 6].map((n) => Math.sqrt(src.area / n));
  else {
    const b = Math.sqrt(src.area);
    bodySizes = [b * 0.88, b, b * 1.12];
  }
  const hyps: Hypothesis[] = [];
  const base = shape && input.kind === 'patch' ? shape.angleDeg : input.orientationDeg;
  for (let k = 0; k < 4; k++) {
    for (const bs of bodySizes) {
      hyps.push({
        map: { pivot: { ...src.centroid }, phi: -((base + 90 * k) / DEG), s: cellGeo / bs },
        group: k,
        sideWeight: 0,
      });
    }
  }
  const sorted = [...bodySizes].sort((a, b) => a - b);
  return { hyps, bodySize: sorted[Math.floor(sorted.length / 2)] };
}

/** Exhaustive search of top-left positions in a window; returns the best. */
function searchWindow(level: RefLevel, t: Template, X0: number, Y0: number, r: number, sp: ScoreParams): { X: number; Y: number; raw: number } | null {
  let best: { X: number; Y: number; raw: number } | null = null;
  for (let Y = Y0 - r; Y <= Y0 + r; Y++) {
    for (let X = X0 - r; X <= X0 + r; X++) {
      if (!fits(level, t, X, Y)) continue;
      const v = scoreAt(level, t, X, Y, sp);
      if (!best || v > best.raw) best = { X, Y, raw: v };
    }
  }
  return best;
}

function topLeftFor(level: RefLevel, t: Template, ref: Point): { X: number; Y: number } {
  return {
    X: Math.round((ref.x + 0.5) * level.scaleX - 0.5 + level.pad - t.cx),
    Y: Math.round((ref.y + 0.5) * level.scaleY - 0.5 + level.pad - t.cy),
  };
}

/** Dense coarse search of one hypothesis; returns local maxima. */
function coarseSearch(index: ReferenceIndex, level: RefLevel, hyp: Hypothesis, t: Template, stride: number, sp: ScoreParams, out: Candidate[]): void {
  const mx = 0.15 * level.ppc;
  const xMin = Math.max(0, Math.ceil(level.pad - mx - t.cx));
  const xMax = Math.min(level.stride - t.w, Math.floor(level.pad + level.width - 1 + mx - t.cx));
  const yMin = Math.max(0, Math.ceil(level.pad - mx - t.cy));
  const yMax = Math.min(level.rows - t.h, Math.floor(level.pad + level.height - 1 + mx - t.cy));
  if (xMax < xMin || yMax < yMin) return;
  const nx = Math.floor((xMax - xMin) / stride) + 1, ny = Math.floor((yMax - yMin) / stride) + 1;
  const map = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const Y = yMin + j * stride;
    for (let i = 0; i < nx; i++) {
      const X = xMin + i * stride;
      let v = scoreAt(level, t, X, Y, sp);
      if (hyp.sides) v -= gridPrior(index, hyp, pivotRef(level, t, X, Y));
      map[j * nx + i] = v;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = map[j * nx + i];
      let isMax = true;
      for (let dj = -1; dj <= 1 && isMax; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const w = map[jj * nx + ii];
          if (w > v || (w === v && (dj < 0 || (dj === 0 && di < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      const X = xMin + i * stride, Y = yMin + j * stride;
      const ref = pivotRef(level, t, X, Y);
      out.push({ hyp, map: hyp.map, ref, raw: v + (hyp.sides ? gridPrior(index, hyp, ref) : 0), score: v, level: 0 });
    }
  }
}

/** Greedy non-maximum suppression: keeps candidates further than `radius` (ref px) from better ones of the same group. */
function suppress(cands: Candidate[], radius: number, limit: number): Candidate[] {
  cands.sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  const r2 = radius * radius;
  for (const c of cands) {
    if (kept.length >= limit) break;
    let dup = false;
    for (const k of kept) {
      if (k.hyp.group !== c.hyp.group) continue;
      const dx = k.ref.x - c.ref.x, dy = k.ref.y - c.ref.y;
      if (dx * dx + dy * dy < r2) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
  }
  return kept;
}

class TemplateCache {
  private readonly cache = new Map<string, Template | null>();
  constructor(private readonly src: PhotoSource) {}
  get(level: RefLevel, li: number, m: Mapping): Template | null {
    const key = `${li}|${m.pivot.x.toFixed(3)}|${m.pivot.y.toFixed(3)}|${m.phi.toFixed(5)}|${m.s.toFixed(6)}`;
    let t = this.cache.get(key);
    if (t === undefined) {
      t = buildTemplate(this.src, m, level);
      this.cache.set(key, t);
    }
    return t;
  }
}

/** Re-search a candidate's position on level `li` around its current reference position. */
function refinePosition(index: ReferenceIndex, li: number, c: Candidate, cache: TemplateCache, r: number, sp: ScoreParams, map = c.map): Candidate | null {
  const level = index.levels[li];
  const t = cache.get(level, li, map);
  if (!t) return null;
  const { X, Y } = topLeftFor(level, t, c.ref);
  const best = searchWindow(level, t, X, Y, r, sp);
  if (!best) return null;
  const ref = pivotRef(level, t, best.X, best.Y);
  return { hyp: c.hyp, map, ref, raw: best.raw, score: best.raw - gridPrior(index, c.hyp, ref), level: li };
}

/** Coordinate-descent refinement of angle and scale on the finest level. */
function refineAngleScale(index: ReferenceIndex, li: number, c: Candidate, cache: TemplateCache, sp: ScoreParams): Candidate {
  let best = c;
  const steps: [number, number][] = [
    [2 / DEG, 0], [-2 / DEG, 0], [4 / DEG, 0], [-4 / DEG, 0],
    [0, 0.05], [0, -0.05], [0, 0.1], [0, -0.1],
    [1 / DEG, 0], [-1 / DEG, 0], [0, 0.025], [0, -0.025],
  ];
  const base = c.map;
  for (const [dphi, ds] of steps) {
    if (Math.abs(best.map.phi + dphi - base.phi) > 4.5 / DEG) continue;
    if (Math.abs(best.map.s * (1 + ds) / base.s - 1) > 0.11) continue;
    const m: Mapping = { pivot: best.map.pivot, phi: best.map.phi + dphi, s: best.map.s * (1 + ds) };
    const cand = refinePosition(index, li, best, cache, 1, sp, m);
    if (cand && cand.score > best.score) best = cand;
  }
  return best;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Calibrated confidence from the best score and the margin to the best distinct alternative
 * (fitted on synthetic scans; see match.test.ts).
 */
export function matchConfidence(score: number, margin: number): number {
  return sigmoid(9 * (score - 0.42)) * (1 - Math.exp(-Math.max(0, margin) / 0.045));
}

/** Internal knobs of one matching run. */
export interface MatchContext {
  /** Colour correction applied to the photo (weighted Lab affine), e.g. from {@link estimateColorCorrection}. */
  correction?: ColorCorrection;
  score?: ScoreParams;
}

/** Match result plus the winning similarity (for scan-level post-processing). */
export interface MatchDetail {
  match: RegionMatch;
  best?: { map: Mapping; ref: Point };
  src?: PhotoSource;
}

/** Locate one region in the reference. See module documentation. */
export function matchRegion(index: ReferenceIndex, input: MatchInput, opts: MatchOptions = {}): RegionMatch {
  return matchRegionDetailed(index, input, opts).match;
}

/** {@link matchRegion} with internal options and the winning similarity. */
export function matchRegionDetailed(index: ReferenceIndex, input: MatchInput, opts: MatchOptions = {}, ctx: MatchContext = {}): MatchDetail {
  const maxCandidates = opts.maxCandidates ?? 5;
  const isPatch = input.kind === 'patch';
  const sp = ctx.score ?? DEFAULT_SCORE;
  const empty: MatchDetail = { match: { regionId: input.regionId, candidates: [], status: 'unmatched' } };
  // Body size estimate for the erosion radius.
  const roughBody = input.shape?.bodySize ?? input.expectedBodySize ?? Math.sqrt(Math.max(1, input.mask.data.reduce((s, v) => s + v, 0)));
  const erode = Math.max(2, Math.round(roughBody * 0.035));
  const src = makePhotoSource(input.image, input.mask, input.origin, erode, index.channelWeights, ctx.correction);
  if (src.area < 50) return empty;
  const { hyps } = makeHypotheses(index, input, src);
  if (hyps.length === 0) return empty;

  const cache = new TemplateCache(src);
  const L = index.levels.length;
  const cell = Math.sqrt(index.cellW * index.cellH);

  // 1. Coarse dense search.
  const coarse: Candidate[] = [];
  const level0 = index.levels[0];
  for (const h of hyps) {
    const t = cache.get(level0, 0, h.map);
    if (!t) continue;
    coarseSearch(index, level0, h, t, level0.ppc >= 6 ? 2 : 1, sp, coarse);
  }
  if (coarse.length === 0) return empty;
  const nKeep = isPatch ? 24 : 30;
  let cands = suppress(coarse, 0.6 * cell, nKeep);

  // 2. Position refinement through the finer levels.
  for (let li = 1; li < L; li++) {
    const r = Math.ceil((index.levels[li].ppc / index.levels[li - 1].ppc) * (li === 1 ? 1.5 : 1)) + 1;
    const next: Candidate[] = [];
    for (const c of cands) {
      const rc = refinePosition(index, li, c, cache, r, sp);
      if (rc) next.push(rc);
    }
    cands = suppress(next, 0.3 * cell, nKeep);
  }

  // 3. Angle / scale refinement of the best few on the finest level.
  const nFine = Math.min(cands.length, 6);
  cands.sort((a, b) => b.score - a.score);
  for (let i = 0; i < nFine; i++) cands[i] = refineAngleScale(index, L - 1, cands[i], cache, sp);

  // 4. Placed-cell penalty and ranking.
  const placed = new Set((opts.placedCells ?? []).map(cellKey));
  for (const c of cands) if (placed.size && placed.has(cellKey(cellAt(index, c.ref)))) c.score -= PLACED_PENALTY;
  cands.sort((a, b) => b.score - a.score);

  // 5. Distinct candidates and confidence.
  const rot = (c: Candidate) => norm360(c.map.phi * DEG);
  const distinct = (a: Candidate, b: Candidate) =>
    Math.hypot(a.ref.x - b.ref.x, a.ref.y - b.ref.y) > 0.6 * cell || angleDiff(rot(a), rot(b)) > 45;
  const chosen: Candidate[] = [];
  const usedCells = new Set<string>();
  for (const c of cands) {
    if (chosen.length >= maxCandidates) break;
    const key = isPatch || index.cut !== 'grid' ? '' : `${cellKey(cellAt(index, c.ref))}|${Math.round(rot(c) / 90) % 4}`;
    if (key && usedCells.has(key)) continue;
    if (chosen.some((k) => !distinct(k, c))) continue;
    if (key) usedCells.add(key);
    chosen.push(c);
  }
  const best = chosen[0];
  const second = cands.find((c) => distinct(best, c));
  const margin = second ? best.score - second.score : 0.3;
  const conf = matchConfidence(best.score, margin);
  const tau = 0.03;
  const weights = chosen.map((c) => Math.exp((c.score - best.score) / tau));
  const wsum = weights.reduce((s, v) => s + v, 0);

  const candidates: Placement[] = chosen.map((c, i) => {
    const cellRef = cellAt(index, c.ref);
    const share = weights[i] / wsum;
    return {
      row: cellRef.row,
      col: cellRef.col,
      x: c.ref.x,
      y: c.ref.y,
      rotationDeg: norm360(c.map.phi * DEG) % 360,
      score: c.score,
      confidence: i === 0 ? conf : Math.min(share, 1 - conf) * sigmoid(9 * (c.score - 0.42)),
    };
  });

  let coveredCells: CellRef[] | undefined;
  if (isPatch) {
    coveredCells = coveredCellsOf(index, input, best);
    if (coveredCells.length > 0) {
      const tl = coveredCells.reduce((a, b) => (b.row < a.row || (b.row === a.row && b.col < a.col) ? b : a));
      candidates[0].row = tl.row;
      candidates[0].col = tl.col;
    }
  }
  const status: MatchStatus = best.score < 0.2 ? 'unmatched' : conf >= 0.6 ? 'confident' : 'ambiguous';
  return { match: { regionId: input.regionId, candidates, coveredCells, status }, best: { map: best.map, ref: best.ref }, src };
}

/** Cells whose body area is mostly covered by the region mask at the given placement. */
function coveredCellsOf(index: ReferenceIndex, input: MatchInput, c: Candidate): CellRef[] {
  const { cellW, cellH } = index;
  const { pivot, phi, s } = c.map;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const m = input.mask;
  const inside = (rx: number, ry: number) => {
    const x = rx - c.ref.x, y = ry - c.ref.y;
    const px = pivot.x + (cos * x + sin * y) / s - input.origin.x;
    const py = pivot.y + (-sin * x + cos * y) / s - input.origin.y;
    const ix = Math.round(px), iy = Math.round(py);
    return ix >= 0 && iy >= 0 && ix < m.width && iy < m.height && m.data[iy * m.width + ix] === 1;
  };
  // Reference-space extent of the region.
  const ext = Math.hypot(m.width, m.height) / s;
  const r0 = Math.max(0, Math.floor((c.ref.y - ext) / cellH)), r1 = Math.min(index.grid.rows - 1, Math.ceil((c.ref.y + ext) / cellH));
  const c0 = Math.max(0, Math.floor((c.ref.x - ext) / cellW)), c1 = Math.min(index.grid.cols - 1, Math.ceil((c.ref.x + ext) / cellW));
  const out: CellRef[] = [];
  const K = 6;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      let hit = 0;
      for (let j = 0; j < K; j++) {
        for (let i = 0; i < K; i++) {
          const rx = (col + 0.1 + (0.8 * (i + 0.5)) / K) * cellW - 0.5;
          const ry = (row + 0.1 + (0.8 * (j + 0.5)) / K) * cellH - 0.5;
          if (inside(rx, ry)) hit++;
        }
      }
      if (hit >= 0.7 * K * K) out.push({ row, col });
    }
  }
  return out;
}
