/**
 * Placement of one photographed region (single piece or assembled patch) in the reference.
 *
 * Pipeline: normalise the region into a few similarity hypotheses (4 orientations from the corners
 * or the dominant outline orientation; scale from the body size) → masked multi-channel NCC (+ a
 * weak mean-colour term) at every position of the 4 px/cell prefilter level → stride-1 dense search
 * on the 8 px/cell level around the best 10 % → keep the best ~30 distinct peaks → refine the
 * position on the 16 and 32 px/cell levels → refine angle (±4°) / scale (±10 %) of the best few →
 * rank with priors (flat sides must face the border, placed cells) → confidence from score and
 * margin. The search is a sliding search for every cut style; grid cells only enter as priors and
 * when reporting row/col.
 *
 * Cells the user marked as placed are soft evidence, never an exclusion (users make mistakes when
 * marking): every candidate in such a cell scores {@link PLACED_PENALTY} less from the first search
 * on, so the shortlists keep free cells, but the best few places by the photo alone stay in the
 * shortlists too. When the photo alone places the region confidently in a marked cell, the photo
 * wins. The marks reorder the places, but lift a confidence by at most {@link PLACED_GAIN} over the
 * photo's own and never make a placement confident that the photo alone is unsure of
 * ({@link MARKED_UNSURE_CAP}). Whenever the photo's own best place is a marked cell, the match names
 * it in `placedConflict` (a wrong mark, or a piece that came off the board).
 */
import { findSimilarity, type Point } from '../../cv/geometry';
import { cellKey, type CellRef, type MatchStatus, type Placement, type PlacedConflict, type RefLattice, type RegionMatch, type SideKind, type UncertainReason } from '../../model/types';
import { buildTemplate, colourDistanceMap, DEFAULT_SCORE, makePhotoSource, scoreAt, scoreMap, scorePair, type ColorCorrection, type Mapping, type PhotoSource, type ScoreParams, type Template } from './template';
import { estimatePatchPitch } from '../pieces/patchPitch';
import { fitPatchLattice, latticeCells, latticeCoords, latticePoint, type LatticeCell, type PatchLattice } from '../pieces/patchLattice';
import { NOT_ONE_PIECE_CAP, onePieceArea } from './groups';
import type { MatchInput, MatchOptions, RefLevel, ReferenceIndex } from './types';
import { runSteps, type Steps } from '../steps';

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
  /** raw minus the priors of the photo alone (flat sides), without the placed-cell penalty. */
  photo: number;
  level: number;
}

/** The user's placed cells as a prior: candidates in them score `penalty` less. */
interface PlacedPrior {
  cells: Set<string>;
  penalty: number;
  /** Most the marks may lift a placement's confidence over the photo's own for that place. */
  gain: number;
}

const DEG = 180 / Math.PI;
const PRIOR_FLAT_INSIDE = 0.22;
const PRIOR_KNOB_AT_BORDER = 0.22;
/**
 * Score penalty of a place in a cell the user marked as placed (default; `MatchOptions.
 * placedPenalty`). On the candidates' softmax scale ({@link CANDIDATE_TAU}) it divides the place's
 * likelihood by about 6.5: a mark is trusted, but a clear photo still beats it. bench/placed.eval.ts
 * (simulated marks, a quarter of them wrong at worst): 0.05 helps less with right marks (top-3
 * 0.951 with every other cell marked), 0.1 and 0.2 cost more with wrong ones (top-1 0.903 / 0.896
 * with 30 % of the cells marked, a quarter wrongly, against 0.912 without marks); 0.075: 0.973 and
 * 0.910.
 */
export const PLACED_PENALTY = 0.075;
/** Best places by the photo alone (without the placed-cell penalty) that every shortlist keeps. */
const PHOTO_KEEP = 3;
/**
 * Most the placed marks may lift a placement's confidence over what the photo alone gives that
 * place (default; `MatchOptions.placedGain`). Marks take competitors away, which raises the share
 * and margin of what is left – also of a wrong place when the right one scores lower, or is marked
 * by mistake. The marks reorder the places freely; they make a placement confident only with the
 * photo's support.
 */
export const PLACED_GAIN = 0.2;
/**
 * Confidence (just below {@link CONFIDENT_THRESHOLD}) a placement the photo alone is unsure of gets
 * from the marks at most: they reorder and lift it by up to {@link PLACED_GAIN}, but never make it
 * 'confident'. The marks take competitors away; a wrong mark – on the piece's own cell, or a place
 * correctly marked while the true one is not found at all – would make a wrong place sure on the
 * user's word alone (scan scenes, every one, marks on 70 % of the cells: confident precision 0.994
 * against 0.999 without marks; private files: fb20 piece 0, own cell marked, confident one cell off).
 */
export const MARKED_UNSURE_CAP = 0.69;

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

/** Penalty of a place in a cell the user marked as placed. */
function placedPrior(index: ReferenceIndex, ref: Point, placed: PlacedPrior | undefined): number {
  return placed && placed.cells.has(cellKey(cellAt(index, ref))) ? placed.penalty : 0;
}

/** A candidate's scores at `ref`: by the photo alone, and with the placed-cell penalty. */
function scored(index: ReferenceIndex, hyp: Hypothesis, ref: Point, raw: number, placed: PlacedPrior | undefined): { score: number; photo: number } {
  const photo = raw - gridPrior(index, hyp, ref);
  return { photo, score: photo - placedPrior(index, ref, placed) };
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

/**
 * A seam-pitch estimate (see {@link estimatePatchPitch}) counts for a patch when the patch spans at
 * least this many pieces at that pitch: the seams of 2–4 pieces form too short a comb (estimates
 * there scatter from a third to the full body size).
 */
const PITCH_MIN_PIECES = 6;
/** Body sizes searched around a seam-pitch estimate (the angle / scale refinement covers ±10 %). */
const PITCH_SCALES = [0.92, 1, 1.08];

/** Seam-pitch estimates per region mask (a scan matches a region up to twice). */
const pitchMemo = new WeakMap<MatchInput['mask'], number | null>();

/**
 * Body size of a patch from its own seams, for scans without a size reference (no single piece
 * with a detected shape, e.g. a photo of one large assembled block). Undefined when the scan gives
 * a body size, the region is no patch, or the seams show no reliable period.
 */
export function patchBodySize(input: MatchInput, aspect = 1): number | undefined {
  if (input.kind !== 'patch' || input.shape || (input.expectedBodySize ?? 0) > 0) return undefined;
  let pitch = pitchMemo.get(input.mask);
  if (pitch === undefined) {
    const est = estimatePatchPitch(input.image, input.mask, input.orientationDeg, aspect);
    let area = 0;
    for (let i = 0; i < input.mask.data.length; i++) area += input.mask.data[i];
    pitch = est && area >= PITCH_MIN_PIECES * est.pitch * est.pitch ? est.pitch : null;
    pitchMemo.set(input.mask, pitch);
  }
  return pitch ?? undefined;
}

/** Grids of at most this many cells: a patch without a size reference may be any of their sizes. */
const SMALL_PUZZLE_CELLS = 64;

/**
 * Piece counts tried for a patch without a size reference: a few pieces (a patch of a large
 * puzzle), and in a small puzzle every size up to the whole puzzle in steps of about 15 % in body
 * size (its seams, only a few, may not show the size: a lone block of an 18-piece puzzle).
 */
export function patchCounts(grid: { rows: number; cols: number }): number[] {
  const counts = [2, 3, 4, 6];
  const cells = grid.rows * grid.cols;
  if (cells > SMALL_PUZZLE_CELLS) return counts;
  for (let n = 8; n < cells; n = Math.max(n + 1, Math.round(n * 1.32))) counts.push(n);
  if (counts[counts.length - 1] < cells) counts.push(cells);
  return counts.filter((n) => n <= cells);
}

/** Build the similarity hypotheses for a region (`pitch`: the patch's own body size estimate, if any). */
function makeHypotheses(index: ReferenceIndex, input: MatchInput, src: PhotoSource, pitch?: number): { hyps: Hypothesis[]; bodySize: number } {
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
  // A patch without a size reference: a few pieces (by area), and the size its seams show.
  else if (input.kind === 'patch') bodySizes = [...patchCounts(index.grid).map((n) => Math.sqrt(src.area / n)), ...(pitch ? PITCH_SCALES.map((f) => f * pitch) : [])];
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
  const byPos = scoreMemo(t, sp);
  // The window's positions not scored yet, two at a time (any two: rows and columns alike).
  let pending = -1;
  for (let Y = Y0 - r; Y <= Y0 + r; Y++) {
    for (let X = X0 - r; X <= X0 + r; X++) {
      if (!fits(level, t, X, Y)) continue;
      const pos = Y * level.stride + X;
      if (byPos.has(pos)) continue;
      if (pending < 0) {
        pending = pos;
        continue;
      }
      scorePair(level, t, pending, pos - pending, sp, pairScores);
      byPos.set(pending, pairScores[0]);
      byPos.set(pos, pairScores[1]);
      pending = -1;
    }
  }
  if (pending >= 0) byPos.set(pending, scoreAt(level, t, pending % level.stride, Math.floor(pending / level.stride), sp));
  let best: { X: number; Y: number; raw: number } | null = null;
  for (let Y = Y0 - r; Y <= Y0 + r; Y++) {
    for (let X = X0 - r; X <= X0 + r; X++) {
      if (!fits(level, t, X, Y)) continue;
      const v = byPos.get(Y * level.stride + X)!;
      if (!best || v > best.raw) best = { X, Y, raw: v };
    }
  }
  return best;
}
const pairScores = new Float64Array(2);

function topLeftFor(level: RefLevel, t: Template, ref: Point): { X: number; Y: number } {
  return {
    X: Math.round((ref.x + 0.5) * level.scaleX - 0.5 + level.pad - t.cx),
    Y: Math.round((ref.y + 0.5) * level.scaleY - 0.5 + level.pad - t.cy),
  };
}

/** Fraction of prefilter positions whose neighbourhoods are evaluated on the coarse level. */
const PREFILTER_KEEP = 0.1;
/** Half-width (coarse px) of the neighbourhood evaluated around each kept prefilter position. */
const PRE_WIN = 1;

/** Range of top-left positions whose pivot lies inside the picture (± a small margin). */
function searchBounds(level: RefLevel, t: Template): { x0: number; x1: number; y0: number; y1: number } | null {
  const mx = 0.15 * level.ppc;
  const x0 = Math.max(0, Math.ceil(level.pad - mx - t.cx));
  const x1 = Math.min(level.stride - t.w, Math.floor(level.pad + level.width - 1 + mx - t.cx));
  const y0 = Math.max(0, Math.ceil(level.pad - mx - t.cy));
  const y1 = Math.min(level.rows - t.h, Math.floor(level.pad + level.height - 1 + mx - t.cy));
  return x1 < x0 || y1 < y0 ? null : { x0, x1, y0, y1 };
}

/**
 * Dense coarse search (stride 1) of one hypothesis on level `ci`; collects local maxima (priors
 * applied to them). When a prefilter level exists (index 0, below `ci`), only the neighbourhoods of
 * its best positions are evaluated on the coarse level.
 */
function coarseSearch(index: ReferenceIndex, ci: number, hyp: Hypothesis, cache: TemplateCache, sp: ScoreParams, out: Candidate[], placed?: PlacedPrior): void {
  const level = index.levels[ci];
  const t = cache.get(level, ci, hyp.map);
  if (!t || !searchBounds(level, t)) return;
  const pl = ci > 0 ? index.levels[0] : null;
  const t0 = pl ? cache.get(pl, 0, hyp.map) : null;
  // The local maxima depend on the template (photo source, level, mapping), the prefilter level and
  // the score parameters only: a second pass of the region (with the placed marks) finds the same.
  const memo = (t.coarse ??= new Map());
  const key = spKey(sp);
  let found = memo.get(key);
  if (!found || found.pl !== pl) memo.set(key, (found = { pl, maxima: coarseMaxima(level, t, pl, t0, sp) }));
  const m = found.maxima;
  for (let k = 0; k < m.length; k += 3) {
    const ref = pivotRef(level, t, m[k], m[k + 1]);
    out.push({ hyp, map: hyp.map, ref, raw: m[k + 2], ...scored(index, hyp, ref, m[k + 2], placed), level: ci });
  }
}

/**
 * The `k`-th smallest value (from 0) of `values` (no NaN), by quickselect on a copy: the value
 * sorting would put at `k`, in linear time.
 */
export function kthSmallest(values: Float32Array, k: number): number {
  const a = Float32Array.from(values);
  let lo = 0, hi = a.length - 1;
  while (hi > lo) {
    // Median of three as the pivot; then Hoare partition: [lo, j] ≤ p ≤ [i, hi], (j, i) all p.
    let x = a[lo], y = a[(lo + hi) >> 1], z = a[hi];
    if (x > y) [x, y] = [y, x];
    if (y > z) y = z;
    const p = x > y ? x : y;
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) {
        const tmp = a[i];
        a[i++] = a[j];
        a[j--] = tmp;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** The local maxima of {@link coarseSearch}'s score map: (X, Y, raw) triples, row by row. */
function coarseMaxima(level: RefLevel, t: Template, pl: RefLevel | null, t0: Template | null, sp: ScoreParams): number[] {
  const maxima: number[] = [];
  const b = searchBounds(level, t);
  if (!b) return maxima;
  const nx = b.x1 - b.x0 + 1, ny = b.y1 - b.y0 + 1;
  const map = new Float32Array(nx * ny);
  const b0 = pl && t0 ? searchBounds(pl, t0) : null;
  if (pl && t0 && b0) {
    const nx0 = b0.x1 - b0.x0 + 1, ny0 = b0.y1 - b0.y0 + 1;
    const pre = new Float32Array(nx0 * ny0);
    scoreMap(pl, t0, b0.x0, b0.x1, b0.y0, b0.y1, sp, pre);
    const thr = kthSmallest(pre, Math.max(0, Math.floor(pre.length * (1 - PREFILTER_KEEP)) - 1));
    const sel = new Uint8Array(nx * ny);
    const ax = level.scaleX / pl.scaleX, ay = level.scaleY / pl.scaleY;
    for (let j = 0; j < ny0; j++) {
      for (let i = 0; i < nx0; i++) {
        if (pre[j * nx0 + i] < thr) continue;
        // prefilter top-left -> pivot (level px) -> coarse top-left
        const px = (b0.x0 + i + t0.cx - pl.pad + 0.5) * ax - 0.5 + level.pad - t.cx - b.x0;
        const py = (b0.y0 + j + t0.cy - pl.pad + 0.5) * ay - 0.5 + level.pad - t.cy - b.y0;
        const cx = Math.round(px), cy = Math.round(py);
        for (let y = Math.max(0, cy - PRE_WIN); y <= Math.min(ny - 1, cy + PRE_WIN); y++) {
          for (let x = Math.max(0, cx - PRE_WIN); x <= Math.min(nx - 1, cx + PRE_WIN); x++) sel[y * nx + x] = 1;
        }
      }
    }
    map.fill(-Infinity);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; ) {
        if (!sel[y * nx + x]) {
          x++;
          continue;
        }
        let e = x;
        while (e + 1 < nx && sel[y * nx + e + 1]) e++;
        scoreMap(level, t, b.x0 + x, b.x0 + e, b.y0 + y, b.y0 + y, sp, map.subarray(y * nx + x, y * nx + e + 1));
        x = e + 1;
      }
    }
  } else {
    scoreMap(level, t, b.x0, b.x1, b.y0, b.y1, sp, map);
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = map[j * nx + i];
      if (v === -Infinity) continue;
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
      maxima.push(b.x0 + i, b.y0 + j, v);
    }
  }
  return maxima;
}

/**
 * Greedy non-maximum suppression: keeps candidates further than `radius` (ref px) from better ones
 * of the same group, best first by `key`.
 */
function suppressBy(cands: Candidate[], radius: number, limit: number, key: (c: Candidate) => number): Candidate[] {
  const sorted = [...cands].sort((a, b) => key(b) - key(a));
  const kept: Candidate[] = [];
  const r2 = radius * radius;
  for (const c of sorted) {
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

/**
 * The shortlist: the best `limit` distinct candidates by score (placed-cell penalty included) and,
 * with placed cells, also the best {@link PHOTO_KEEP} by the photo alone, so a wrong mark cannot
 * drop the photo's own best places. Sorted by score.
 */
function suppress(cands: Candidate[], radius: number, limit: number, placed?: PlacedPrior, photoKeep = PHOTO_KEEP): Candidate[] {
  const kept = suppressBy(cands, radius, limit, (c) => c.score);
  if (placed && placed.cells.size > 0 && placed.penalty > 0) {
    for (const c of suppressBy(cands, radius, photoKeep, (c) => c.photo)) if (!kept.includes(c)) kept.push(c);
    kept.sort((a, b) => b.score - a.score);
  }
  return kept;
}

/**
 * The templates of one match (one region, one pass), by rounded mapping: the first template built
 * under a key serves every mapping that rounds to it. Behind it, the templates of the photo source
 * by level and exact mapping, shared by every match of the source (the second pass with the placed
 * marks, scorePlacement, the scale measurement), with the scores computed on them (`Template.coarse`,
 * {@link scoreAtMemo}): a template is a pure function of the source, level and mapping, so reusing
 * one gives exactly what building it again gives.
 */
class TemplateCache {
  private readonly cache = new Map<string, Template | null>();
  private readonly shared: WeakMap<RefLevel, Map<string, Template | null>>;
  constructor(private readonly src: PhotoSource) {
    let shared = sharedTemplates.get(src);
    if (!shared) sharedTemplates.set(src, (shared = new WeakMap()));
    this.shared = shared;
  }
  get(level: RefLevel, li: number, m: Mapping): Template | null {
    const key = `${li}|${m.pivot.x.toFixed(3)}|${m.pivot.y.toFixed(3)}|${m.phi.toFixed(5)}|${m.s.toFixed(6)}${m.ax === undefined && m.ay === undefined ? '' : `|${(m.ax ?? 1).toFixed(5)}|${(m.ay ?? 1).toFixed(5)}`}`;
    let t = this.cache.get(key);
    if (t === undefined) {
      let byLevel = this.shared.get(level);
      if (!byLevel) this.shared.set(level, (byLevel = new Map()));
      // (Numbers print exactly: one key per mapping.)
      const exact = `${m.pivot.x}|${m.pivot.y}|${m.phi}|${m.s}|${m.ax}|${m.ay}`;
      t = byLevel.get(exact);
      if (t === undefined) {
        t = buildTemplate(this.src, m, level, 0.6, level.ppc < 6 ? 5 : 12);
        byLevel.set(exact, t);
      }
      this.cache.set(key, t);
    }
    return t;
  }
}
const sharedTemplates = new WeakMap<PhotoSource, WeakMap<RefLevel, Map<string, Template | null>>>();

/** Key of score parameters (scores computed with equal parameters are shared). */
function spKey(sp: ScoreParams): string {
  let k = spKeys.get(sp);
  if (k === undefined) spKeys.set(sp, (k = `${sp.eps}|${sp.beta}|${sp.cap}|${sp.hinge}`));
  return k;
}
const spKeys = new WeakMap<ScoreParams, string>();

/** The scores remembered on template `t` for parameters `sp`, by position (Y · stride + X). */
function scoreMemo(t: Template, sp: ScoreParams): Map<number, number> {
  const memo = (t.scores ??= new Map());
  const key = spKey(sp);
  let byPos = memo.get(key);
  if (!byPos) memo.set(key, (byPos = new Map()));
  return byPos;
}

/** {@link scoreAt}, remembered on the template (per score parameters and position). */
function scoreAtMemo(level: RefLevel, t: Template, X: number, Y: number, sp: ScoreParams): number {
  const byPos = scoreMemo(t, sp);
  const pos = Y * level.stride + X;
  let v = byPos.get(pos);
  if (v === undefined) byPos.set(pos, (v = scoreAt(level, t, X, Y, sp)));
  return v;
}

/** Re-search a candidate's position on level `li` around its current reference position. */
function refinePosition(index: ReferenceIndex, li: number, c: Candidate, cache: TemplateCache, r: number, sp: ScoreParams, map = c.map, placed?: PlacedPrior): Candidate | null {
  const level = index.levels[li];
  const t = cache.get(level, li, map);
  if (!t) return null;
  const { X, Y } = topLeftFor(level, t, c.ref);
  const best = searchWindow(level, t, X, Y, r, sp);
  if (!best) return null;
  const ref = pivotRef(level, t, best.X, best.Y);
  return { hyp: c.hyp, map, ref, raw: best.raw, ...scored(index, c.hyp, ref, best.raw, placed), level: li };
}

/** Coordinate-descent refinement of angle and scale on the finest level. */
function refineAngleScale(index: ReferenceIndex, li: number, c: Candidate, cache: TemplateCache, sp: ScoreParams, placed?: PlacedPrior): Candidate {
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
    const cand = refinePosition(index, li, best, cache, 1, sp, m, placed);
    if (cand && cand.score > best.score) best = cand;
  }
  return best;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Confidence that the best placement is right, from its score and the margin over the best distinct
 * alternative: a logistic fit on synthetic scans (Starry Night 20×16, Great Wave 40×25), made a bit
 * more conservative because real photos are harder. Use {@link informedConfidence} when the
 * information content of the region is known.
 */
export function matchConfidence(score: number, margin: number): number {
  return sigmoid(4.6 + 3 * score + 1.5 * Math.log(Math.max(1e-4, margin)));
}

/**
 * {@link matchConfidence} discounted by the information content of the region:
 * - A featureless piece (plain sky, gentle gradient: little texture once a linear ramp is removed)
 *   reaches high NCC wherever the colour ramp is similar (photo lighting adds its own ramp), so
 *   neither its score nor its margin is evidence. It stays ambiguous unless its correlation peak is
 *   sharp (it scores clearly worse a quarter cell away), it is a corner piece with a clear margin,
 *   or its colour occurs only at the best place (after colour correction). Textured pieces keep the
 *   plain score/margin confidence.
 *   Every piece is also capped by `share`, its likelihood share among all distinct places (softmax
 *   of the scores; cube root for textured pieces), so a plateau of similar places (plain areas,
 *   repetitive texture) keeps it ambiguous.
 * - A textured piece whose content correlates poorly at the best place (score well below what a
 *   correct match of a textured piece reaches) is suspicious: wrong flat sides, bad segmentation.
 * - Single pieces without a detected shape whose area does not look like one piece (fragments of a
 *   badly segmented piece, merged pieces) are not trusted.
 */
export function informedConfidence(
  f: Pick<MatchFeatures, 'score' | 'margin' | 'drop25' | 'detail' | 'areaRatio' | 'flats' | 'colourArea'>,
  opts: { hasShape: boolean; isPatch: boolean; share?: number },
): number {
  const base = matchConfidence(f.score, f.margin);
  const textured = sigmoid((f.detail - TEXTURE_DETAIL) / 1);
  const sharp = sigmoid((f.drop25 - 0.045) / 0.01);
  // Pinned down without texture: a corner piece (two flat sides) with a clear margin, or a colour
  // found nowhere else in the picture (only after the scan-level colour correction).
  const byCorner = f.flats >= 2 ? sigmoid((f.margin - 0.12) / 0.03) : 0;
  const byColour = sigmoid((1.5 - f.colourArea) / 0.3);
  let conf = base * (1 - (1 - textured) * (1 - sharp) * (1 - byCorner) * (1 - byColour));
  conf *= 1 - textured * (1 - sigmoid((f.score - 0.45) / 0.04));
  // Many similar places (repetitive texture, plain areas) cap the confidence: fully for featureless
  // pieces, softly (cube root of the share) for textured ones.
  if (opts.share !== undefined) conf = Math.min(conf, Math.pow(opts.share, 1 - (2 / 3) * textured));
  if (!opts.hasShape && !opts.isPatch) {
    const r = f.areaRatio;
    const out = r < AREA_RATIO_RANGE[0] ? AREA_RATIO_RANGE[0] - r : r > AREA_RATIO_RANGE[1] ? r - AREA_RATIO_RANGE[1] : 0;
    conf *= Math.exp(-((out / 0.05) ** 2));
  }
  return conf;
}

/** Template detail (weighted-Lab std after removing a linear ramp) above which a region counts as textured. */
const TEXTURE_DETAIL = 5;
/** Weight of the gross-colour-difference penalty for featureless regions (after colour correction). */
const FLAT_COLOUR_HINGE = 0.6;

/**
 * Confidence factor for doubts about the region's outline (segmentation issues, ragged mask): a
 * placement of a wrongly outlined region rests on a wrong template.
 */
export function outlineFactor(input: Pick<MatchInput, 'kind' | 'outline'>): number {
  const o = input.outline;
  if (!o) return 1;
  let f = 1;
  const issues = o.issues ?? [];
  // 'touching_pieces' is left out: a split pair's halves keep their content and match reliably.
  if (issues.includes('low_contrast')) f *= 0.9;
  if (input.kind === 'piece' && issues.includes('shape_uncertain')) f *= 0.95;
  if (input.kind === 'piece' && o.solidity !== undefined && o.solidity < 0.65) f *= 0.85;
  return f;
}

/** Patches of at most this many pieces (by area) that touch other pieces may be loose pieces lying together. */
const SMALL_TOUCHING_PATCH = 3.5;

/**
 * Cap of the confidence for a region whose size says it is not what it is matched as (in place,
 * at most ambiguous): a single piece far from one piece's area (two pieces merged, a piece with
 * table attached, half a piece), or a small patch flagged as touching pieces – two or three loose
 * pieces lying together, matched as if they were assembled. Their template is no piece of the
 * picture; a confident wrong place is worse than an ambiguous one. Uses the scan's body size.
 */
export function capForSize(detail: MatchDetail, input: Pick<MatchInput, 'kind' | 'mask' | 'outline' | 'expectedBodySize'>): void {
  const body = input.expectedBodySize;
  const c = detail.match.candidates[0];
  if (!c || !body || body <= 0) return;
  let area = 0;
  for (let i = 0; i < input.mask.data.length; i++) area += input.mask.data[i];
  const r = area / (body * body);
  const bad = input.kind === 'piece' ? !onePieceArea(r) : input.kind === 'patch' && r <= SMALL_TOUCHING_PATCH && (input.outline?.issues ?? []).includes('touching_pieces');
  if (!bad || c.confidence <= NOT_ONE_PIECE_CAP) return;
  c.confidence = NOT_ONE_PIECE_CAP;
  detail.reason = 'shape';
  for (const o of detail.match.candidates.slice(1)) o.confidence = Math.min(o.confidence, NOT_ONE_PIECE_CAP);
  if (detail.match.status === 'confident') detail.match.status = 'ambiguous';
}

/** Border-table excess above which one outline counts as including shadow / table. */
const BORDER_TABLE_LIMIT = 0.32;
/**
 * Median border-table excess of a scan's pieces above which the photo's outlines systematically
 * include cast shadows (clean synthetic light tables ≲ 0.06, a real wood table in diffuse light
 * 0.17 with correct placements, hard cast shadows ≳ 0.23).
 */
const BORDER_TABLE_SCAN_LIMIT = 0.2;

/**
 * Cap the confidence of a region whose outline probably includes cast shadow or table (at most
 * 'ambiguous'): its own border-table excess is high, or the scan's median (`scanMedian`, over its
 * pieces, when known) says most outlines in the photo include shadow.
 */
export function capForBorder(detail: MatchDetail, input: Pick<MatchInput, 'outline'>, scanMedian?: number): void {
  const bt = input.outline?.borderTable;
  const c = detail.match.candidates[0];
  if (bt === undefined || !c) return;
  const own = sigmoid((bt - BORDER_TABLE_LIMIT) / 0.02);
  const scan = scanMedian === undefined ? 0 : sigmoid((scanMedian - BORDER_TABLE_SCAN_LIMIT) / 0.01);
  const cap = 0.6 + 0.4 * (1 - Math.max(own, scan));
  if (c.confidence <= cap) return;
  c.confidence = cap;
  for (const o of detail.match.candidates.slice(1)) o.confidence = Math.min(o.confidence, cap);
  if (detail.match.status === 'confident' && cap < CONFIDENT_THRESHOLD) detail.match.status = 'ambiguous';
  if (cap < CONFIDENT_THRESHOLD) detail.reason = 'shape';
}

/** Plausible area of a single piece relative to its body area (4 blanks … 4 tabs, with tolerance). */
const AREA_RATIO_RANGE: [number, number] = [0.82, 1.45];
/** Minimum distance (cells) between listed candidates, so alternatives show different places. */
const CANDIDATE_SPREAD = 0.9;
/** Softmax temperature turning score differences into relative candidate likelihoods. */
const CANDIDATE_TAU = 0.04;

/** Confidence at or above which a match is reported as 'confident'. */
export const CONFIDENT_THRESHOLD = 0.7;
/** Best scores below this are reported as 'unmatched' (textured regions only). */
export const UNMATCHED_SCORE = 0.15;

/** Internal knobs of one matching run. */
export interface MatchContext {
  /** Colour correction applied to the photo (weighted Lab affine), e.g. from {@link estimateColorCorrection}. */
  correction?: ColorCorrection;
  score?: ScoreParams;
}

/** Evidence used for the confidence of the best placement. */
export interface MatchFeatures {
  score: number;
  /** Best score minus the best spatially distinct (or differently rotated) alternative. */
  margin: number;
  /** Std (weighted Lab) of the 16 px/cell template after removing a per-channel linear ramp. */
  detail: number;
  /** Std of the template including the ramp. */
  rawStd: number;
  /** Smallest score drop when the placement is shifted by 1/4 cell (worst of 8 directions). */
  drop25: number;
  /** Smallest score drop for a 1/2-cell shift. */
  drop50: number;
  /** Distinct candidates scoring within 0.05 / 0.1 of the best. */
  plateau05: number;
  plateau10: number;
  /** Number of known flat sides (shape). */
  flats: number;
  /** Likelihood share of the best place among all distinct places (softmax of the scores). */
  share: number;
  /** Region area / expected body area (single pieces: ≈ 0.8–1.3; fragments and merged pieces fall outside). */
  areaRatio: number;
  /**
   * Only with a scan-level colour correction: area (in cells) of the places whose mean colour is
   * about as close to the region's as the closest place, or Infinity when the closest colour is not
   * at the best placement (or no correction is active). Small = the colour pins the location down.
   */
  colourArea: number;
}

/** Match result plus the winning similarity (for scan-level post-processing). */
/** A candidate's placement: the similarity `map` with its pivot at reference point `ref` (patches: and their photo lattice). */
export interface CandidatePlacement {
  map: Mapping;
  ref: Point;
  lattice?: PatchLattice;
}

export interface MatchDetail {
  match: RegionMatch;
  best?: { map: Mapping; ref: Point };
  src?: PhotoSource;
  features?: MatchFeatures;
  /** Score parameters of the run (with the colour hinge for featureless regions), for {@link scorePlacement}. */
  params?: ScoreParams;
  /** Patches: the seam-fitted cell lattice in the photo crop at the best placement. */
  lattice?: PatchLattice;
  /** The placements behind `match.candidates` (same order; patches: with the lattice their cells come from). */
  placements?: CandidatePlacement[];
  /** Why the placement would be unsure (see {@link uncertainReasonOf}; set whatever the status, for later demotions). */
  reason?: UncertainReason;
}

/** Body size (photo px) below which a region counts as small: fewer pixels than the finest level's 32 px per cell, by a margin. */
const SMALL_BODY = 24;
/** Distinct places within 0.05 of the best from which a textured region's texture counts as repeating. */
const REPEATING_PLATEAU = 2;

/**
 * The main reason a placement is (or would be) unsure, from its evidence (see `UncertainReason`):
 * doubts about the outline ('shape': segmentation issues, a ragged outline, a shapeless single
 * piece whose area is not one piece's), a small region ('small'), featureless print ('plain'),
 * several distinct places that fit about equally well ('repeating') or a few similar ones
 * ('similar-spots'). The caps for cast shadow and for sizes that are not one piece set 'shape'
 * themselves; claims.ts says 'similar-spots' for a piece whose best spot another piece holds.
 */
export function uncertainReasonOf(f: Pick<MatchFeatures, 'detail' | 'plateau05' | 'areaRatio'>, input: Pick<MatchInput, 'kind' | 'outline' | 'shape'>, bodySize: number): UncertainReason {
  const shapelessPiece = !input.shape && input.kind !== 'patch';
  if (outlineFactor(input) < 1 || (shapelessPiece && (f.areaRatio < AREA_RATIO_RANGE[0] || f.areaRatio > AREA_RATIO_RANGE[1]))) return 'shape';
  if (bodySize < SMALL_BODY) return 'small';
  if (f.detail < TEXTURE_DETAIL) return 'plain';
  if (f.plateau05 >= REPEATING_PLATEAU) return 'repeating';
  return 'similar-spots';
}

/** Template std with and without a per-channel linear ramp (plane fit over template coordinates). */
function templateDetail(t: Template, stride: number): { detail: number; rawStd: number } {
  const n = t.n;
  let si = 0, sj = 0;
  const I = new Float64Array(n), J = new Float64Array(n);
  for (let q = 0; q < n; q++) {
    const j = Math.floor(t.off[q] / stride);
    I[q] = t.off[q] - j * stride;
    J[q] = j;
    si += I[q];
    sj += J[q];
  }
  si /= n;
  sj /= n;
  let aa = 0, ab = 0, bb = 0;
  for (let q = 0; q < n; q++) {
    const di = I[q] - si, dj = J[q] - sj;
    aa += di * di;
    ab += di * dj;
    bb += dj * dj;
  }
  const det = aa * bb - ab * ab;
  let explained = 0;
  for (let c = 0; c < 3; c++) {
    let pi = 0, pj = 0;
    for (let q = 0; q < n; q++) {
      const v = t.val[q * 3 + c];
      pi += (I[q] - si) * v;
      pj += (J[q] - sj) * v;
    }
    if (det > 1e-9) {
      const b = (bb * pi - ab * pj) / det, cc = (aa * pj - ab * pi) / det;
      explained += b * pi + cc * pj;
    }
  }
  return { detail: Math.sqrt(Math.max(0, t.energy - explained) / n), rawStd: Math.sqrt(t.variance) };
}

/** Locate one region in the reference. See module documentation. */
export function matchRegion(index: ReferenceIndex, input: MatchInput, opts: MatchOptions = {}): RegionMatch {
  const d = matchRegionDetailed(index, input, opts);
  capForBorder(d, input);
  return d.match;
}

/** {@link matchRegion} with internal options and the winning similarity. */
export function matchRegionDetailed(index: ReferenceIndex, input: MatchInput, opts: MatchOptions = {}, ctx: MatchContext = {}): MatchDetail {
  return runSteps(matchRegionDetailedSteps(index, input, opts, ctx));
}

/**
 * {@link matchRegionDetailed} in steps (pipeline/steps.ts): it yields after the set-up, each
 * rotation's coarse search and each candidate's refinement, so a background re-match of a large
 * patch (the grid probe) can let a new scan go first within a fraction of a second rather than
 * after the whole match.
 */
export function* matchRegionDetailedSteps(index: ReferenceIndex, input: MatchInput, opts: MatchOptions = {}, ctx: MatchContext = {}): Steps<MatchDetail> {
  const maxCandidates = opts.maxCandidates ?? 5;
  const isPatch = input.kind === 'patch';
  const placed = placedPriorOf(opts);
  let sp = ctx.score ?? DEFAULT_SCORE;
  const empty: MatchDetail = { match: { regionId: input.regionId, candidates: [], status: 'unmatched' } };
  // Body size estimate for the erosion radius and the seams. Without a scan-level size reference a
  // patch measures its own pieces (the square root of its area would be the size of the whole patch).
  const pitch = patchBodySize(input, index.cellW / index.cellH);
  const roughBody = input.shape?.bodySize ?? input.expectedBodySize ?? pitch ?? Math.sqrt(Math.max(1, input.mask.data.reduce((s, v) => s + v, 0)));
  const erode = Math.max(2, Math.round(roughBody * 0.045));
  // Assembled patches: ignore the seams and gaps between their pieces (not in the printed picture).
  const seams = isPatch ? { radius: Math.max(2, Math.round(roughBody * 0.035)), angleDeg: input.orientationDeg, body: roughBody } : undefined;
  const src = photoSourceOf(input, erode, index.channelWeights, ctx.correction, seams);
  if (src.area < 50) return empty;
  const { hyps } = makeHypotheses(index, input, src, pitch);
  if (hyps.length === 0) return empty;
  yield;

  const cache = new TemplateCache(src);
  const L = index.levels.length;
  const cell = Math.sqrt(index.cellW * index.cellH);

  // 1. Coarse dense search (on the first level with >= 6 px per cell, prefiltered by level 0).
  const ci = Math.max(0, index.levels.findIndex((l) => l.prefix && l.ppc >= 6));
  // A featureless region correlates only with noise and lighting ramps; once colours are corrected,
  // a clearly different mean colour rules a place out.
  if (ctx.correction) {
    const mid = Math.min(ci + 1, L - 1);
    const probe = cache.get(index.levels[mid], mid, hyps[0].map);
    const flatness = probe ? 1 - sigmoid((templateDetail(probe, index.levels[mid].stride).detail - TEXTURE_DETAIL) / 1) : 0;
    if (flatness > 0.01) sp = { ...sp, hinge: FLAT_COLOUR_HINGE * flatness };
  }
  const coarse: Candidate[] = [];
  for (const h of hyps) {
    coarseSearch(index, ci, h, cache, sp, coarse, placed);
    yield;
  }
  if (coarse.length === 0) return empty;
  const nKeep = isPatch ? 24 : 30;
  // The coarse shortlist keeps the photo's own best nKeep places too: at 8 px per cell the true place
  // of a piece whose own cell is wrongly marked can rank beyond the photo's best few, and with the
  // penalty beyond the shortlist (wave-neighbors-wood: a piece sure without marks, 0.44 against
  // 0.30, lost entirely with its own cell marked).
  let cands = suppress(coarse, 0.6 * cell, nKeep, placed, nKeep);

  // 2. Position refinement through the finer levels.
  for (let li = ci + 1; li < L; li++) {
    const r = Math.ceil((index.levels[li].ppc / index.levels[li - 1].ppc) * (li === ci + 1 ? 1.5 : 1)) + 1;
    const next: Candidate[] = [];
    for (const c of cands) {
      const rc = refinePosition(index, li, c, cache, r, sp, c.map, placed);
      if (rc) next.push(rc);
      yield;
    }
    cands = suppress(next, 0.3 * cell, nKeep, placed);
  }
  if (cands.length === 0) return empty;

  // 3. Angle / scale refinement of the best few on the finest level (and of the photo's own best
  // places, when placed cells push them down).
  cands.sort((a, b) => b.score - a.score);
  const fine = new Set(cands.slice(0, 6));
  if (placed) for (const c of [...cands].sort((a, b) => b.photo - a.photo).slice(0, 2)) fine.add(c);
  for (let i = 0; i < cands.length; i++) {
    if (!fine.has(cands[i])) continue;
    cands[i] = refineAngleScale(index, L - 1, cands[i], cache, sp, placed);
    yield;
  }

  // 4. Ranking (the placed-cell penalty is in the scores) and confidence. With placed cells, the
  // photo alone is heard first: when it places the region confidently in a marked cell, it wins.
  cands.sort((a, b) => b.score - a.score);
  const featureLevel = Math.min(ci + 1, L - 1);
  const rank = (list: Candidate[], n = maxCandidates) => rankCandidates(index, cache, featureLevel, list, sp, input, !!ctx.correction, n);
  let ranked: Ranking | undefined;
  let photoWins = false;
  let photoView: Ranking | undefined;
  if (placed) {
    // The photo alone: all its distinct places, with their confidences.
    photoView = rank(cands.map((c) => ({ ...c, score: c.photo })).sort((a, b) => b.score - a.score), Infinity);
    if (placed.cells.has(cellKey(cellAt(index, photoView.best.ref))) && photoView.conf >= CONFIDENT_THRESHOLD) {
      ranked = { ...photoView, chosen: photoView.chosen.slice(0, maxCandidates), confidences: photoView.confidences.slice(0, maxCandidates) };
      photoWins = true;
    }
  }
  ranked ??= rank(cands);
  if (photoView && !photoWins) capMarkedGain(ranked, photoView, placed!.gain, cell);
  yield;
  const { best, chosen, conf, confidences, features } = ranked;

  const candidates: Placement[] = chosen.map((c, i) => {
    const cellRef = cellAt(index, c.ref);
    return {
      row: cellRef.row,
      col: cellRef.col,
      x: c.ref.x,
      y: c.ref.y,
      rotationDeg: norm360(c.map.phi * DEG) % 360,
      score: c.score,
      confidence: confidences[i],
    };
  });

  const placements: CandidatePlacement[] = chosen.map((c) => ({ map: c.map, ref: c.ref }));
  let coveredCells: CellRef[] | undefined;
  let lattice: PatchLattice | undefined;
  if (isPatch) {
    // Patches report the top-most, then left-most covered cell as row/col.
    // One lattice for the candidates that see the photo at the best one's cell size and turn: it is
    // the photo's own geometry, only its place on the grid differs. A candidate at another cell size
    // (another piece-count hypothesis) or turn has cells of its own size in the photo; the best one's
    // lattice would put the wrong cells under it.
    lattice = patchLatticeOf(index, input, best);
    const lat = lattice;
    chosen.forEach((c, i) => {
      const own = i === 0 || sameLatticeGeometry(index, best, c) ? lat : patchLatticeOf(index, input, c);
      placements[i].lattice = own;
      const cells = patchCoveredCells(index, input, c, own);
      if (i === 0) coveredCells = cells;
      if (cells.length > 0) {
        const tl = cells.reduce((a, b) => (b.row < a.row || (b.row === a.row && b.col < a.col) ? b : a));
        candidates[i].row = tl.row;
        candidates[i].col = tl.col;
      }
    });
  }
  // 'unmatched' (hidden in the UI) only when textured content clearly matches nowhere; a featureless
  // region's score is noise, so it stays a (low-confidence) ambiguous match with alternatives.
  const status: MatchStatus =
    best.score < UNMATCHED_SCORE && features.detail >= TEXTURE_DETAIL ? 'unmatched' : conf >= CONFIDENT_THRESHOLD ? 'confident' : 'ambiguous';
  const match: RegionMatch = { regionId: input.regionId, candidates, coveredCells, status };
  if (lattice) match.lattice = refLattice(input, best, lattice);
  const conflict = placed && placedConflictOf(index, placed, photoView ?? ranked, candidates[0], coveredCells);
  if (conflict) match.placedConflict = conflict;
  const reason = uncertainReasonOf(features, input, roughBody);
  if (status === 'ambiguous') match.uncertainReason = reason;
  return { match, best: { map: best.map, ref: best.ref }, src, features, params: sp, lattice, reason, placements };
}

/** The placed-cell prior of a run (undefined without placed cells or with no penalty). */
function placedPriorOf(opts: MatchOptions): PlacedPrior | undefined {
  const penalty = opts.placedPenalty ?? PLACED_PENALTY;
  if (!opts.placedCells || opts.placedCells.length === 0 || penalty <= 0) return undefined;
  return { cells: new Set(opts.placedCells.map(cellKey)), penalty, gain: opts.placedGain ?? PLACED_GAIN };
}

/**
 * The marked cell the region seems to belong in (`RegionMatch.placedConflict`): a single piece's
 * best place by the photo alone, when the user marked that cell as placed – whether the photo won
 * there or the marks moved the piece elsewhere; a patch's placement when most of its covered cells
 * are marked.
 */
function placedConflictOf(index: ReferenceIndex, placed: PlacedPrior, photoView: Ranking, best: Placement | undefined, covered: CellRef[] | undefined): PlacedConflict | undefined {
  if (covered && covered.length > 0) {
    if (!best || 2 * covered.filter((c) => placed.cells.has(cellKey(c))).length <= covered.length) return undefined;
    return { row: best.row, col: best.col, rotationDeg: best.rotationDeg };
  }
  const own = cellAt(index, photoView.best.ref);
  if (!placed.cells.has(cellKey(own))) return undefined;
  return { row: own.row, col: own.col, rotationDeg: norm360(photoView.best.map.phi * DEG) % 360 };
}

/**
 * `RegionMatch.placedConflict` of a match made without the marks (the photo alone): its best place,
 * when that is a marked cell (patches: when most of their covered cells are marked).
 */
export function placedConflictOfMatch(match: RegionMatch, placedCells: readonly CellRef[]): PlacedConflict | undefined {
  const best = match.candidates[0];
  if (!best || match.status === 'unmatched') return undefined;
  const cells = new Set(placedCells.map(cellKey));
  const covered = match.coveredCells;
  if (covered && covered.length > 0) {
    if (2 * covered.filter((c) => cells.has(cellKey(c))).length <= covered.length) return undefined;
  } else if (!cells.has(cellKey(best))) return undefined;
  return { row: best.row, col: best.col, rotationDeg: best.rotationDeg };
}

/**
 * Limit what the placed marks add to the best placement's confidence (see {@link PLACED_GAIN}): at
 * most `gain` over the photo's own confidence for the same place (same position and quarter turn;
 * 0 when the photo does not list it), and never across the confident threshold
 * ({@link MARKED_UNSURE_CAP}). Alternatives are capped alike.
 */
function capMarkedGain(ranked: Ranking, photoView: Ranking, gain: number, cell: number): void {
  const rot = (c: Candidate) => norm360(c.map.phi * DEG);
  const own = (c: Candidate) => {
    const i = photoView.chosen.findIndex((p) => Math.hypot(p.ref.x - c.ref.x, p.ref.y - c.ref.y) < 0.5 * cell && angleDiff(rot(p), rot(c)) < 45);
    return i >= 0 ? photoView.confidences[i] : 0;
  };
  ranked.confidences = ranked.confidences.map((p, i) => {
    const o = own(ranked.chosen[i]);
    return Math.min(p, o + gain, o < CONFIDENT_THRESHOLD ? MARKED_UNSURE_CAP : Infinity);
  });
  ranked.conf = ranked.confidences[0];
}

/** The ranked candidates of a run with their confidences (see {@link rankCandidates}). */
interface Ranking {
  best: Candidate;
  chosen: Candidate[];
  conf: number;
  confidences: number[];
  features: MatchFeatures;
}

/**
 * Distinct candidates and confidence from candidates sorted best first by `score`: the margin over
 * the best distinct alternative, the information features of the best one, and the distinct places
 * (one per cell, well apart; best rotation each) for the candidate list, whose likelihood shares
 * (listed or not) give the alternatives' confidences.
 */
function rankCandidates(index: ReferenceIndex, cache: TemplateCache, li: number, cands: Candidate[], sp: ScoreParams, input: MatchInput, colourCorrected: boolean, maxCandidates: number): Ranking {
  const isPatch = input.kind === 'patch';
  const cell = Math.sqrt(index.cellW * index.cellH);
  const rot = (c: Candidate) => norm360(c.map.phi * DEG);
  const distinct = (a: Candidate, b: Candidate) =>
    Math.hypot(a.ref.x - b.ref.x, a.ref.y - b.ref.y) > 0.6 * cell || angleDiff(rot(a), rot(b)) > 45;
  const best = cands[0];
  const second = cands.find((c) => distinct(best, c));
  const margin = second ? best.score - second.score : 0.3;
  const features = informationFeatures(index, cache, li, best, cands, distinct, sp, input, colourCorrected);
  features.margin = margin;
  const places: Candidate[] = [];
  const usedCells = new Set<string>();
  for (const c of cands) {
    const key = isPatch || index.cut !== 'grid' ? '' : cellKey(cellAt(index, c.ref));
    if (key && usedCells.has(key)) continue;
    if (places.some((k) => Math.hypot(k.ref.x - c.ref.x, k.ref.y - c.ref.y) < CANDIDATE_SPREAD * cell)) continue;
    if (key) usedCells.add(key);
    places.push(c);
  }
  const chosen = places.slice(0, maxCandidates);
  const q = places.map((c) => Math.exp((c.score - best.score) / CANDIDATE_TAU));
  const qsum = q.reduce((a, v) => a + v, 0);
  for (let i = 0; i < q.length; i++) q[i] /= qsum;
  features.share = q[0];
  const conf = informedConfidence(features, { hasShape: !!input.shape, isPatch, share: q[0] }) * outlineFactor(input);
  const confidences = chosen.map((_, i) => {
    if (i === 0) return conf;
    // Less information than the scores suggest: scale every share down; otherwise the alternatives
    // share what the best one leaves.
    return conf <= q[0] ? (q[i] * conf) / q[0] : ((1 - conf) * q[i]) / Math.max(1e-9, 1 - q[0]);
  });
  return { best, chosen, conf, confidences, features };
}

/**
 * The region's photo source (template pyramid). It does not depend on the grid, so a region matched
 * again at other cell sizes (the grid probe: up to a dozen times) reuses it – for a large patch it
 * takes seconds. With a colour correction (one per scan, second pass only) it is kept with the
 * correction, as long as that lives: analyses of one scan that share its first pass (and so its
 * correction; colorCorrection.ts `FirstPass`) share these too.
 */
function photoSourceOf(input: MatchInput, erode: number, weights: readonly number[], correction: ColorCorrection | undefined, seams: { radius: number; angleDeg: number; body: number } | undefined): PhotoSource {
  const key = `${erode}|${weights.join(',')}|${seams ? `${seams.radius},${seams.angleDeg},${seams.body}` : ''}`;
  let sources = photoSources;
  if (correction) {
    let byInput = correctedSources.get(correction);
    if (!byInput) correctedSources.set(correction, (byInput = new WeakMap()));
    sources = byInput;
  }
  let byKey = sources.get(input);
  if (!byKey) sources.set(input, (byKey = new Map()));
  let src = byKey.get(key);
  if (!src) byKey.set(key, (src = makePhotoSource(input.image, input.mask, input.origin, erode, weights, correction, seams)));
  return src;
}
const photoSources = new WeakMap<MatchInput, Map<string, PhotoSource>>();
const correctedSources = new WeakMap<ColorCorrection, WeakMap<MatchInput, Map<string, PhotoSource>>>();

/** A patch's photo lattice carried into the reference through placement `c` (see `RefLattice`). */
export function refLattice(input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat: PatchLattice): RefLattice {
  const { pivot, phi, s } = c.map;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const toRef = (p: Point): Point => {
    const dx = (p.x + input.origin.x - pivot.x) * s, dy = (p.y + input.origin.y - pivot.y) * s;
    return { x: c.ref.x + cos * dx - sin * dy, y: c.ref.y + sin * dx + cos * dy };
  };
  const o = toRef(latticePoint(lat, 0, 0)), ea = toRef(latticePoint(lat, 1, 0)), eb = toRef(latticePoint(lat, 0, 1));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const cells: number[] = [];
  for (const q of latticeCells(lat, input.mask, input.table)) cells.push(q.i, q.j, Math.round(q.coverage * 100) / 100);
  return {
    at: { x: c.ref.x, y: c.ref.y },
    rotationDeg: norm360(phi * DEG) % 360,
    origin: { x: r3(o.x), y: r3(o.y) },
    a: { x: r3(ea.x - o.x), y: r3(ea.y - o.y) },
    b: { x: r3(eb.x - o.x), y: r3(eb.y - o.y) },
    cells,
  };
}

/**
 * The matcher's score of a region at a given cell and rotation (to the nearest quarter turn), on
 * the scale of its own candidates: the same photo source and score parameters as the run that
 * produced `detail`, the position searched within ±0.3 cell of the cell centre and refined like a
 * candidate (finer levels, then angle and scale), with the same priors (flat sides, placed cells).
 * Confidence is left at 0 for the caller to set. Null without the run's photo source, or when the
 * region cannot be laid there (template off the picture).
 */
export function scorePlacement(index: ReferenceIndex, input: MatchInput, detail: MatchDetail, cell: CellRef, rotationDeg: number, opts: MatchOptions = {}): Placement | null {
  if (!detail.src || !detail.params) return null;
  const sp = detail.params;
  const placed = placedPriorOf(opts);
  const { hyps } = makeHypotheses(index, input, detail.src, patchBodySize(input, index.cellW / index.cellH));
  const cache = new TemplateCache(detail.src);
  const L = index.levels.length;
  const ci = Math.max(0, index.levels.findIndex((l) => l.prefix && l.ppc >= 6));
  const li0 = Math.min(ci + 1, L - 1);
  const centre = { x: (cell.col + 0.5) * index.cellW - 0.5, y: (cell.row + 0.5) * index.cellH - 0.5 };
  let best: Candidate | null = null;
  for (const hyp of hyps) {
    if (angleDiff(norm360(hyp.map.phi * DEG), rotationDeg) > 45) continue;
    let c: Candidate | null = { hyp, map: hyp.map, ref: centre, raw: -Infinity, score: -Infinity, photo: -Infinity, level: li0 };
    c = refinePosition(index, li0, c, cache, Math.ceil(0.3 * index.levels[li0].ppc), sp, c.map, placed);
    for (let li = li0 + 1; li < L && c; li++) c = refinePosition(index, li, c, cache, Math.ceil(index.levels[li].ppc / index.levels[li - 1].ppc) + 1, sp, c.map, placed);
    if (!c) continue;
    c = refineAngleScale(index, L - 1, c, cache, sp, placed);
    if (!best || c.score > best.score) best = c;
  }
  if (!best) return null;
  return { row: cell.row, col: cell.col, x: best.ref.x, y: best.ref.y, rotationDeg: norm360(best.map.phi * DEG) % 360, score: best.score, confidence: 0 };
}

/** Result of {@link measureScale}. */
export interface ScaleMeasurement {
  /** Reference px per photo px at the score peak (geometric mean of the two axes). */
  s: number;
  /** Reference px per photo px along the picture's x and y axes (equal to `s` unless `aspect` was measured). */
  sx: number;
  sy: number;
  /** Raw score at the peak. */
  peak: number;
  /**
   * Curvature of the raw score over ln(scale) at the peak (score units per ln², ≥ 0): how sharply
   * the print pins the scale down.
   */
  curvature: number;
  /** True when the peak lies at the end of the searched range (the scale is outside it). */
  clipped: boolean;
}

/** Step (ln scale) and half-range of {@link measureScale}'s sweep, and of its aspect sweep. */
const SCALE_STEP = 0.01;
const SCALE_RANGE = 0.12;
const ASPECT_RANGE = 0.06;

/** Peak of sampled scores (step `step`, first sample at `x0`) with a parabola through the best three. */
function sweepPeak(raws: number[], x0: number, step: number): { x: number; peak: number; curvature: number; clipped: boolean } | null {
  let bi = -1;
  for (let i = 0; i < raws.length; i++) if (raws[i] > -Infinity && (bi < 0 || raws[i] > raws[bi])) bi = i;
  if (bi < 0) return null;
  const clipped = bi === 0 || bi === raws.length - 1;
  let off = 0, curvature = 0;
  if (!clipped && raws[bi - 1] > -Infinity && raws[bi + 1] > -Infinity) {
    const l = raws[bi - 1], r = raws[bi + 1], den = l - 2 * raws[bi] + r;
    if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
    curvature = Math.max(0, -den) / (step * step);
  }
  return { x: x0 + (bi + off) * step, peak: raws[bi], curvature, clipped };
}

/**
 * The scale (reference px per photo px) at which the region's print best matches its placement,
 * measured finer than the matcher's own refinement (2.5 % steps, enough to place a piece but not
 * to tell a 44- from a 45-column grid): the raw score at its best placement is swept over ±12 % of
 * the scale in 1 % steps on the finest level, the position re-searched ±2 px at each, and a parabola
 * through the best three gives the peak. The angle stays the placement's. With `aspect`, a second
 * sweep (±6 %) stretches the picture's x axis against its y axis at that scale: a photo taken a
 * little obliquely foreshortens one axis by a few per cent, which a large patch shows. Grid cells
 * play no part: the scale is a property of the photo and the picture, so it measures the cell size
 * whatever the grid (see `cellSize.ts`). `centre` (ln) shifts the sweep (default: the placement's
 * scale).
 */
export function measureScale(index: ReferenceIndex, detail: MatchDetail, opts: { centre?: number; aspect?: boolean } = {}): ScaleMeasurement | null {
  return runSteps(measureScaleSteps(index, detail, opts));
}

/** Scores of {@link measureScaleSteps}'s sweeps computed per step (a large patch: ~100 ms each on a desktop). */
const SWEEP_PER_STEP = 4;

/** {@link measureScale} in steps (pipeline/steps.ts): a few of its sweep's scores per step. */
export function* measureScaleSteps(index: ReferenceIndex, detail: MatchDetail, opts: { centre?: number; aspect?: boolean } = {}): Steps<ScaleMeasurement | null> {
  if (!detail.src || !detail.best) return null;
  // The same placement measured again (analyses sharing a first pass, colorCorrection.ts
  // `FirstPass`, share its details' placements): the measurement depends on nothing else.
  const memoKey = `${opts.centre ?? ''}|${opts.aspect ? 1 : 0}`;
  let memo = scaleMemo.get(detail.best);
  if (memo && (memo.index !== index || memo.src !== detail.src || memo.params !== detail.params)) memo = undefined;
  const known = memo?.results.get(memoKey);
  if (known !== undefined) return known && { ...known };
  const m = yield* measureScaleUncached(index, detail, opts);
  if (!memo) scaleMemo.set(detail.best, (memo = { index, src: detail.src, params: detail.params, results: new Map() }));
  memo.results.set(memoKey, m && { ...m });
  return m;
}

/** {@link measureScaleSteps}' results per placement (`MatchDetail.best`), with what they were measured on. */
const scaleMemo = new WeakMap<object, { index: ReferenceIndex; src: PhotoSource; params: ScoreParams | undefined; results: Map<string, ScaleMeasurement | null> }>();

function* measureScaleUncached(index: ReferenceIndex, detail: MatchDetail, opts: { centre?: number; aspect?: boolean }): Steps<ScaleMeasurement | null> {
  if (!detail.src || !detail.best) return null;
  const sp = detail.params ?? DEFAULT_SCORE;
  const cache = new TemplateCache(detail.src);
  const li = index.levels.length - 1;
  const base = detail.best.map;
  const ref = detail.best.ref;
  const c0 = opts.centre ?? Math.log(base.s);
  const hyp: Hypothesis = { map: base, group: 0, sideWeight: 0 };
  const scoreOf = (m: Mapping) => {
    const c = refinePosition(index, li, { hyp, map: m, ref, raw: -Infinity, score: -Infinity, photo: -Infinity, level: li }, cache, 2, sp, m);
    return c ? c.raw : -Infinity;
  };
  const n = Math.round(SCALE_RANGE / SCALE_STEP);
  const raws: number[] = [];
  for (let k = -n; k <= n; k++) {
    raws.push(scoreOf({ pivot: base.pivot, phi: base.phi, s: Math.exp(c0 + k * SCALE_STEP) }));
    if (raws.length % SWEEP_PER_STEP === 0) yield;
  }
  const iso = sweepPeak(raws, c0 - n * SCALE_STEP, SCALE_STEP);
  if (!iso) return null;
  const s = Math.exp(iso.x);
  let q = 0;
  if (opts.aspect && !iso.clipped) {
    const na = Math.round(ASPECT_RANGE / SCALE_STEP);
    const ar: number[] = [];
    for (let k = -na; k <= na; k++) {
      const h = (k * SCALE_STEP) / 2;
      ar.push(scoreOf({ pivot: base.pivot, phi: base.phi, s, ax: Math.exp(h), ay: Math.exp(-h) }));
      if (ar.length % SWEEP_PER_STEP === 0) yield;
    }
    const asp = sweepPeak(ar, -na * SCALE_STEP, SCALE_STEP);
    if (asp && !asp.clipped) q = asp.x;
  }
  return { s, sx: s * Math.exp(q / 2), sy: s * Math.exp(-q / 2), peak: iso.peak, curvature: iso.curvature, clipped: iso.clipped };
}

/** Information content of the best placement: texture detail, peak sharpness and plateau size. */
function informationFeatures(
  index: ReferenceIndex,
  cache: TemplateCache,
  li: number,
  best: Candidate,
  cands: Candidate[],
  distinct: (a: Candidate, b: Candidate) => boolean,
  sp: ScoreParams,
  input: MatchInput,
  colourCorrected: boolean,
): MatchFeatures {
  const f: MatchFeatures = {
    score: best.score, margin: 0, detail: 0, rawStd: 0, drop25: 0, drop50: 0, plateau05: 0, plateau10: 0,
    flats: input.shape ? input.shape.sides.filter((x) => x.kind === 'flat').length : 0,
    share: 1,
    areaRatio: 1,
    colourArea: Infinity,
  };
  if (colourCorrected) f.colourArea = colourUniqueness(index, cache, best);
  const body = input.shape?.bodySize ?? input.expectedBodySize;
  if (body && body > 0) f.areaRatio = input.mask.data.reduce((a, v) => a + v, 0) / (body * body);
  for (const c of cands) {
    if (!distinct(best, c)) continue;
    if (c.score >= best.score - 0.05) f.plateau05++;
    if (c.score >= best.score - 0.1) f.plateau10++;
  }
  const level = index.levels[li];
  const t = cache.get(level, li, best.map);
  if (!t) return f;
  Object.assign(f, templateDetail(t, level.stride));
  const { X, Y } = topLeftFor(level, t, best.ref);
  const peak = searchWindow(level, t, X, Y, 1, sp);
  if (!peak) return f;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
  for (const [k, frac] of [[0, 0.25], [1, 0.5]] as const) {
    let worst = Infinity;
    for (const [dx, dy] of dirs) {
      const XX = peak.X + Math.round(dx * frac * level.ppc), YY = peak.Y + Math.round(dy * frac * level.ppc);
      if (!fits(level, t, XX, YY)) continue;
      worst = Math.min(worst, peak.raw - scoreAtMemo(level, t, XX, YY, sp));
    }
    if (k === 0) f.drop25 = Number.isFinite(worst) ? worst : 0;
    else f.drop50 = Number.isFinite(worst) ? worst : 0;
  }
  return f;
}

/** Colour tolerance (weighted Lab) within which places count as having the region's colour. */
const COLOUR_TOLERANCE = 10;

/** See {@link MatchFeatures.colourArea}: computed on the prefilter level over the whole picture. */
function colourUniqueness(index: ReferenceIndex, cache: TemplateCache, best: Candidate): number {
  const level = index.levels[0];
  if (!level.prefix) return Infinity;
  const t = cache.get(level, 0, best.map);
  if (!t) return Infinity;
  const b = searchBounds(level, t);
  if (!b) return Infinity;
  const nx = b.x1 - b.x0 + 1, ny = b.y1 - b.y0 + 1;
  const map = new Float32Array(nx * ny);
  colourDistanceMap(level, t, b.x0, b.x1, b.y0, b.y1, map);
  let min = Infinity, mi = 0;
  for (let i = 0; i < map.length; i++) if (map[i] < min) { min = map[i]; mi = i; }
  const at = pivotRef(level, t, b.x0 + (mi % nx), b.y0 + Math.floor(mi / nx));
  const cell = Math.sqrt(index.cellW * index.cellH);
  if (Math.hypot(at.x - best.ref.x, at.y - best.ref.y) > 0.75 * cell || min > COLOUR_TOLERANCE) return Infinity;
  let close = 0;
  for (let i = 0; i < map.length; i++) if (map[i] <= min + COLOUR_TOLERANCE) close++;
  return close / (level.scaleX * index.cellW * level.scaleY * index.cellH);
}

/**
 * The patch's cell lattice in its photo crop, fitted to its seams (pieces/patchLattice.ts) from the
 * lattice the placement `c` implies: the reference grid's lines mapped into the photo, origin at the
 * grid crossing nearest the placement's pivot.
 */
export function patchLatticeOf(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>): PatchLattice {
  const { cellW, cellH } = index;
  const { pivot, phi, s } = c.map;
  const k = Math.round((c.ref.x + 0.5) / cellW), l = Math.round((c.ref.y + 0.5) / cellH);
  const x = k * cellW - 0.5 - c.ref.x, y = l * cellH - 0.5 - c.ref.y;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const prior: PatchLattice = {
    origin: { x: pivot.x + (cos * x + sin * y) / s - input.origin.x, y: pivot.y + (-sin * x + cos * y) / s - input.origin.y },
    angle: -phi,
    pa: cellW / s,
    pb: cellH / s,
    strength: [-1, -1],
  };
  return fitPatchLattice(input.image, input.mask, prior);
}

/**
 * Largest scale difference (|ln| of the ratio) and turn difference (degrees) between two placements
 * of a patch that still share one photo lattice: the range the lattice fit searches around its
 * prior (pieces/patchLattice.ts: ±6 % pitch, ±2.4°).
 */
const LATTICE_SHARE_SCALE = 0.06;
const LATTICE_SHARE_ANGLE = 2.4;

/**
 * Whether placement `c` sees the patch with the cells of placement `best` (see
 * {@link LATTICE_SHARE_SCALE}): about the same scale, and the same turn up to a quarter turn when
 * the cells are square (a half turn otherwise: a quarter turn swaps the cells' width and height).
 */
export function sameLatticeGeometry(index: Pick<ReferenceIndex, 'cellW' | 'cellH'>, best: Pick<Candidate, 'map'>, c: Pick<Candidate, 'map'>): boolean {
  if (Math.abs(Math.log(c.map.s / best.map.s)) > LATTICE_SHARE_SCALE) return false;
  const period = Math.abs(Math.log(index.cellW / index.cellH)) < 0.02 ? 90 : 180;
  const d = norm360((c.map.phi - best.map.phi) * DEG) % period;
  return Math.min(d, period - d) <= LATTICE_SHARE_ANGLE;
}

/**
 * Reference cells of a patch's lattice cells at placement `c`. The lattice is rigid: its axes map
 * onto the grid's (to the nearest quarter turn) and every cell steps by exactly one grid cell, so
 * one integer offset places them all – the offset most of the cells' centres agree on through the
 * placement transform (whose drift over a large block is what the lattice is for).
 */
function latticeToGrid(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat: PatchLattice, cells: LatticeCell[]): (CellRef & LatticeCell)[] {
  const place = latticeGridPlacer(index, input, c, lat, cells);
  if (!place) return [];
  const out: (CellRef & LatticeCell)[] = [];
  for (const q of cells) {
    const { row, col } = place(q.i, q.j);
    if (row >= 0 && col >= 0 && row < index.grid.rows && col < index.grid.cols) out.push({ ...q, row, col });
  }
  return out.sort((p, q) => p.row - q.row || p.col - q.col);
}

/** The grid cell of each lattice cell (i, j) at placement `c`, by the one offset `cells` vote for (see {@link latticeToGrid}); null without cells. */
function latticeGridPlacer(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat: PatchLattice, cells: LatticeCell[]): ((i: number, j: number) => CellRef) | null {
  const { cellW, cellH } = index;
  const { pivot, phi, s } = c.map;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  // Crop point -> continuous grid coordinates (col, row).
  const toGrid = (p: Point) => {
    const dx = (p.x + input.origin.x - pivot.x) * s, dy = (p.y + input.origin.y - pivot.y) * s;
    return { col: (cos * dx - sin * dy + c.ref.x + 0.5) / cellW, row: (sin * dx + cos * dy + c.ref.y + 0.5) / cellH };
  };
  const o = toGrid(latticePoint(lat, 0, 0)), ea = toGrid(latticePoint(lat, 1, 0)), eb = toGrid(latticePoint(lat, 0, 1));
  const da = { col: ea.col - o.col, row: ea.row - o.row }, db = { col: eb.col - o.col, row: eb.row - o.row };
  // Signed permutation: which grid axis each lattice axis runs along.
  const aOnCol = Math.abs(da.col) >= Math.abs(da.row);
  const sa = Math.sign(aOnCol ? da.col : da.row) || 1;
  const sb = Math.sign(aOnCol ? db.row : db.col) || 1;
  const step = (i: number, j: number) => (aOnCol ? { col: sa * i, row: sb * j } : { col: sb * j, row: sa * i });
  const votes = new Map<string, number>();
  for (const q of cells) {
    const g = toGrid(latticePoint(lat, q.i + 0.5, q.j + 0.5));
    const st = step(q.i, q.j);
    const key = `${Math.floor(g.row) - st.row},${Math.floor(g.col) - st.col}`;
    votes.set(key, (votes.get(key) ?? 0) + q.coverage);
  }
  let bestKey = '', bestN = 0;
  for (const [key, n] of votes) if (n > bestN) [bestKey, bestN] = [key, n];
  if (!bestKey) return null;
  const [tr, tc] = bestKey.split(',').map(Number);
  return (i, j) => {
    const st = step(i, j);
    return { row: tr + st.row, col: tc + st.col };
  };
}

/**
 * The grid cell the app shows photo point `p` (crop coordinates) of a patch in, at placement `c`
 * with lattice `lat`: of the patch's covered cells (on the grid, as {@link patchCoveredCells}), the
 * one holding the point, or the nearest one when the point lies in none (a lone piece whose lattice
 * is half a cell off, a part of the patch placed off the puzzle); with no covered cell, the point
 * through the placement transform (then possibly off the grid).
 */
export function patchCellAt(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat: PatchLattice, p: Point): CellRef {
  const cells = latticeToGrid(index, input, c, lat, latticeCells(lat, input.mask, input.table));
  if (cells.length === 0) {
    const { pivot, phi, s } = c.map;
    const dx = (p.x + input.origin.x - pivot.x) * s, dy = (p.y + input.origin.y - pivot.y) * s;
    return cellAt(index, { x: c.ref.x + Math.cos(phi) * dx - Math.sin(phi) * dy, y: c.ref.y + Math.sin(phi) * dx + Math.cos(phi) * dy });
  }
  const q = latticeCoords(lat, p);
  let best = cells[0], bestD = Infinity;
  for (const cell of cells) {
    const d = Math.hypot((q.a - cell.i - 0.5) * lat.pa, (q.b - cell.j - 0.5) * lat.pb);
    if (d < bestD) [best, bestD] = [cell, d];
  }
  return { row: best.row, col: best.col };
}

/**
 * Cells of a patch at placement `c` (its similarity `map` with the pivot at reference point `ref`):
 * the covered cells of its seam-fitted lattice (by default fitted from this placement), on the grid.
 */
export function patchCoveredCells(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat = patchLatticeOf(index, input, c)): CellRef[] {
  return latticeToGrid(index, input, c, lat, latticeCells(lat, input.mask, input.table)).map(({ row, col }) => ({ row, col }));
}

