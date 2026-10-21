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
 */
import { findSimilarity, type Point } from '../../cv/geometry';
import { cellKey, type CellRef, type MatchStatus, type Placement, type RefLattice, type RegionMatch, type SideKind } from '../../model/types';
import { buildTemplate, colourDistanceMap, DEFAULT_SCORE, makePhotoSource, scoreAt, scoreMap, type ColorCorrection, type Mapping, type PhotoSource, type ScoreParams, type Template } from './template';
import { estimatePatchPitch } from '../pieces/patchPitch';
import { fitPatchLattice, latticeCells, latticePoint, type LatticeCell, type PatchLattice } from '../pieces/patchLattice';
import { NOT_ONE_PIECE_CAP, onePieceArea } from './groups';
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
function coarseSearch(index: ReferenceIndex, ci: number, hyp: Hypothesis, cache: TemplateCache, sp: ScoreParams, out: Candidate[]): void {
  const level = index.levels[ci];
  const t = cache.get(level, ci, hyp.map);
  if (!t) return;
  const b = searchBounds(level, t);
  if (!b) return;
  const nx = b.x1 - b.x0 + 1, ny = b.y1 - b.y0 + 1;
  const map = new Float32Array(nx * ny);
  const pl = ci > 0 ? index.levels[0] : null;
  const t0 = pl ? cache.get(pl, 0, hyp.map) : null;
  const b0 = pl && t0 ? searchBounds(pl, t0) : null;
  if (pl && t0 && b0) {
    const nx0 = b0.x1 - b0.x0 + 1, ny0 = b0.y1 - b0.y0 + 1;
    const pre = new Float32Array(nx0 * ny0);
    scoreMap(pl, t0, b0.x0, b0.x1, b0.y0, b0.y1, sp, pre);
    const sorted = Float32Array.from(pre).sort();
    const thr = sorted[Math.max(0, Math.floor(sorted.length * (1 - PREFILTER_KEEP)) - 1)];
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
      const ref = pivotRef(level, t, b.x0 + i, b.y0 + j);
      out.push({ hyp, map: hyp.map, ref, raw: v, score: v - gridPrior(index, hyp, ref), level: ci });
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
    const key = `${li}|${m.pivot.x.toFixed(3)}|${m.pivot.y.toFixed(3)}|${m.phi.toFixed(5)}|${m.s.toFixed(6)}${m.ax === undefined && m.ay === undefined ? '' : `|${(m.ax ?? 1).toFixed(5)}|${(m.ay ?? 1).toFixed(5)}`}`;
    let t = this.cache.get(key);
    if (t === undefined) {
      t = buildTemplate(this.src, m, level, 0.6, level.ppc < 6 ? 5 : 12);
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
export interface MatchDetail {
  match: RegionMatch;
  best?: { map: Mapping; ref: Point };
  src?: PhotoSource;
  features?: MatchFeatures;
  /** Score parameters of the run (with the colour hinge for featureless regions), for {@link scorePlacement}. */
  params?: ScoreParams;
  /** Patches: the seam-fitted cell lattice in the photo crop at the best placement. */
  lattice?: PatchLattice;
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
  const maxCandidates = opts.maxCandidates ?? 5;
  const isPatch = input.kind === 'patch';
  let sp = ctx.score ?? DEFAULT_SCORE;
  const empty: MatchDetail = { match: { regionId: input.regionId, candidates: [], status: 'unmatched' } };
  // Body size estimate for the erosion radius and the seams. Without a scan-level size reference a
  // patch measures its own pieces (the square root of its area would be the size of the whole patch).
  const pitch = patchBodySize(input, index.cellW / index.cellH);
  const roughBody = input.shape?.bodySize ?? input.expectedBodySize ?? pitch ?? Math.sqrt(Math.max(1, input.mask.data.reduce((s, v) => s + v, 0)));
  const erode = Math.max(2, Math.round(roughBody * 0.045));
  // Assembled patches: ignore the seams and gaps between their pieces (not in the printed picture).
  const seams = isPatch ? { radius: Math.max(2, Math.round(roughBody * 0.035)), angleDeg: input.orientationDeg, body: roughBody } : undefined;
  const src = makePhotoSource(input.image, input.mask, input.origin, erode, index.channelWeights, ctx.correction, seams);
  if (src.area < 50) return empty;
  const { hyps } = makeHypotheses(index, input, src, pitch);
  if (hyps.length === 0) return empty;

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
  for (const h of hyps) coarseSearch(index, ci, h, cache, sp, coarse);
  if (coarse.length === 0) return empty;
  const nKeep = isPatch ? 24 : 30;
  let cands = suppress(coarse, 0.6 * cell, nKeep);

  // 2. Position refinement through the finer levels.
  for (let li = ci + 1; li < L; li++) {
    const r = Math.ceil((index.levels[li].ppc / index.levels[li - 1].ppc) * (li === ci + 1 ? 1.5 : 1)) + 1;
    const next: Candidate[] = [];
    for (const c of cands) {
      const rc = refinePosition(index, li, c, cache, r, sp);
      if (rc) next.push(rc);
    }
    cands = suppress(next, 0.3 * cell, nKeep);
  }
  if (cands.length === 0) return empty;

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
  const best = cands[0];
  const second = cands.find((c) => distinct(best, c));
  const margin = second ? best.score - second.score : 0.3;
  const features = informationFeatures(index, cache, Math.min(ci + 1, L - 1), best, cands, distinct, sp, input, !!ctx.correction);
  features.margin = margin;

  // Distinct places (one per cell, well apart; best rotation each) for the candidate list. The
  // likelihood shares of all places (listed or not) give the alternatives' confidences.
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

  let coveredCells: CellRef[] | undefined;
  let lattice: PatchLattice | undefined;
  if (isPatch) {
    // Patches report the top-most, then left-most covered cell as row/col.
    // One lattice for all candidates: it is the photo's own geometry, only its place on the grid differs.
    lattice = patchLatticeOf(index, input, best);
    const lat = lattice;
    chosen.forEach((c, i) => {
      const cells = patchCoveredCells(index, input, c, lat);
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
  return { match, best: { map: best.map, ref: best.ref }, src, features, params: sp, lattice };
}

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
  const { hyps } = makeHypotheses(index, input, detail.src, patchBodySize(input, index.cellW / index.cellH));
  const cache = new TemplateCache(detail.src);
  const L = index.levels.length;
  const ci = Math.max(0, index.levels.findIndex((l) => l.prefix && l.ppc >= 6));
  const li0 = Math.min(ci + 1, L - 1);
  const centre = { x: (cell.col + 0.5) * index.cellW - 0.5, y: (cell.row + 0.5) * index.cellH - 0.5 };
  let best: Candidate | null = null;
  for (const hyp of hyps) {
    if (angleDiff(norm360(hyp.map.phi * DEG), rotationDeg) > 45) continue;
    let c: Candidate | null = { hyp, map: hyp.map, ref: centre, raw: -Infinity, score: -Infinity, level: li0 };
    c = refinePosition(index, li0, c, cache, Math.ceil(0.3 * index.levels[li0].ppc), sp);
    for (let li = li0 + 1; li < L && c; li++) c = refinePosition(index, li, c, cache, Math.ceil(index.levels[li].ppc / index.levels[li - 1].ppc) + 1, sp);
    if (!c) continue;
    c = refineAngleScale(index, L - 1, c, cache, sp);
    if (!best || c.score > best.score) best = c;
  }
  if (!best) return null;
  const placed = new Set((opts.placedCells ?? []).map(cellKey));
  if (placed.has(cellKey(cell))) best.score -= PLACED_PENALTY;
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
  if (!detail.src || !detail.best) return null;
  const sp = detail.params ?? DEFAULT_SCORE;
  const cache = new TemplateCache(detail.src);
  const li = index.levels.length - 1;
  const base = detail.best.map;
  const ref = detail.best.ref;
  const c0 = opts.centre ?? Math.log(base.s);
  const hyp: Hypothesis = { map: base, group: 0, sideWeight: 0 };
  const scoreOf = (m: Mapping) => {
    const c = refinePosition(index, li, { hyp, map: m, ref, raw: -Infinity, score: -Infinity, level: li }, cache, 2, sp, m);
    return c ? c.raw : -Infinity;
  };
  const n = Math.round(SCALE_RANGE / SCALE_STEP);
  const raws: number[] = [];
  for (let k = -n; k <= n; k++) raws.push(scoreOf({ pivot: base.pivot, phi: base.phi, s: Math.exp(c0 + k * SCALE_STEP) }));
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
      worst = Math.min(worst, peak.raw - scoreAt(level, t, XX, YY, sp));
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
 * Reference cells of a patch's lattice cells at placement `c`. The lattice is rigid: its axes map
 * onto the grid's (to the nearest quarter turn) and every cell steps by exactly one grid cell, so
 * one integer offset places them all – the offset most of the cells' centres agree on through the
 * placement transform (whose drift over a large block is what the lattice is for).
 */
function latticeToGrid(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat: PatchLattice, cells: LatticeCell[]): (CellRef & LatticeCell)[] {
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
  if (!bestKey) return [];
  const [tr, tc] = bestKey.split(',').map(Number);
  const out: (CellRef & LatticeCell)[] = [];
  for (const q of cells) {
    const st = step(q.i, q.j);
    const row = tr + st.row, col = tc + st.col;
    if (row >= 0 && col >= 0 && row < index.grid.rows && col < index.grid.cols) out.push({ ...q, row, col });
  }
  return out.sort((p, q) => p.row - q.row || p.col - q.col);
}

/**
 * Cells of a patch at placement `c` (its similarity `map` with the pivot at reference point `ref`):
 * the covered cells of its seam-fitted lattice (by default fitted from this placement), on the grid.
 */
export function patchCoveredCells(index: ReferenceIndex, input: MatchInput, c: Pick<Candidate, 'map' | 'ref'>, lat = patchLatticeOf(index, input, c)): CellRef[] {
  return latticeToGrid(index, input, c, lat, latticeCells(lat, input.mask, input.table)).map(({ row, col }) => ({ row, col }));
}

