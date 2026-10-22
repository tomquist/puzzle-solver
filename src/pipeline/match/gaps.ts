/**
 * Gaps next to placed pieces. A free cell that borders cells the user marked as placed is a gap;
 * a scan piece whose placement is ambiguous between a few cells may be told apart by what is known
 * around a gap:
 * - prior: a small bonus per placed neighbour (people fill the holes next to what they have built);
 * - continuity: the box picture just across the cut, in the placed neighbour's cell, continues the
 *   colours just inside the piece's side that faces it (the piece's outline mapped into the
 *   picture through the candidate's placement, see {@link continuityMismatch});
 * - border: the gap's position must agree with the piece's sides as far as they are read clearly
 *   (flat towards the puzzle border, a knob everywhere else; see `clearReading` in fits.ts).
 *
 * The marks are soft evidence (users make mistakes): only candidates whose photo score is within a
 * slack of the best are reordered, never a place the photo clearly disfavours; a piece whose best
 * place is a marked cell (it beat the marks' penalty) is left alone; and the reordered
 * best place's confidence rises at most to the placed gain above the photo's own (`PLACED_GAIN`),
 * never to 'confident' (only ambiguous matches are reordered).
 */
import { rgbToLab } from '../../cv/color';
import type { Point } from '../../cv/geometry';
import type { Mask, RGBAImage } from '../../cv/image';
import { cellKey, type CellRef, type DetectedRegion, type GridSpec, type PieceShape, type RegionMatch } from '../../model/types';
import { cornerPositions, cumulative, outlineArc, pathBetween, pointOnPath } from './edgeStrips';
import { clearReading, puzzleSideOf } from './fits';
import { PLACED_GAIN, type MatchDetail } from './matchRegion';
import type { ColorCorrection } from './template';
import type { MatchInput, ReferenceIndex } from './types';

const DIRS: [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // (dRow, dCol) per puzzle side

/**
 * Per puzzle side (top, right, bottom, left) of `cell`: whether the neighbouring cell is marked as
 * placed. Null when `cell` itself is marked (no gap) or lies off the grid.
 */
export function placedSides(grid: GridSpec, placed: ReadonlySet<string>, cell: CellRef): boolean[] | null {
  if (cell.row < 0 || cell.col < 0 || cell.row >= grid.rows || cell.col >= grid.cols || placed.has(cellKey(cell))) return null;
  return DIRS.map(([dr, dc]) => placed.has(cellKey({ row: cell.row + dr, col: cell.col + dc })));
}

/**
 * Whether a piece with `shape`, turned by `rotationDeg` into `cell`, agrees with the cell's position
 * as far as its sides are read clearly: no clear knob facing the puzzle border, no clear flat side
 * facing another cell. Unclear readings never disagree.
 */
export function borderAgrees(shape: PieceShape, rotationDeg: number, cell: CellRef, grid: GridSpec): boolean {
  for (let i = 0; i < 4; i++) {
    const side = puzzleSideOf(shape, rotationDeg, i);
    const r = clearReading(shape.sides[i]);
    if (r === null) continue;
    const row = cell.row + DIRS[side][0], col = cell.col + DIRS[side][1];
    const border = row < 0 || col < 0 || row >= grid.rows || col >= grid.cols;
    if ((r === 'knob') === border) return false;
  }
  return true;
}

/** Samples per side for the continuity check. */
const SIDE_SAMPLES = 16;
/** Photo band just inside the outline (fractions of the body size; as the fit hints' colour strips). */
const INSIDE: [number, number] = [0.02, 0.035];
/** Picture band just across the cut (fractions of the cell size). */
const ACROSS: [number, number] = [0.02, 0.05];
/** The photo band starts at least this many px inside the outline (anti-aliasing, cardboard rim). */
const MIN_INSET_PX = 2;

/** The piece's sides as sampled for {@link continuityMismatch}. */
export interface SideSamples {
  /** Per local side (as `PieceShape.sides`): samples from its start corner to its end corner. */
  sides: {
    /** Outline point of each sample (photo coordinates). */
    at: Point[];
    /** Inward unit normal of the outline there. */
    normal: Point[];
    /** Weighted (and colour-corrected) Lab just inside the outline, 3 per sample; NaN when no piece pixel was found. */
    colour: Float32Array;
  }[];
}

/**
 * Sample the four sides of a single piece: the outline between the body corners of `shape`, and the
 * photo colour just inside it, in the matcher's colour space (Lab weighted by `weights`, then
 * `correction` when given). `image` and `mask` are crops whose pixel (0, 0) is photo pixel
 * `origin`. Null for a degenerate outline.
 */
export function sampleSides(
  image: RGBAImage,
  mask: Mask,
  origin: Point,
  contour: readonly Point[],
  shape: Pick<PieceShape, 'corners' | 'bodySize'>,
  weights: readonly number[],
  correction?: ColorCorrection,
): SideSamples | null {
  if (contour.length < 3) return null;
  const arc = outlineArc(contour);
  const corners = cornerPositions(arc, shape);
  const d0 = Math.max(MIN_INSET_PX, INSIDE[0] * shape.bodySize), d1 = Math.max(d0 + 1, INSIDE[1] * shape.bodySize);
  const depths = [d0, (d0 + d1) / 2, d1];
  const { width: w, height: h, data } = image;
  const pixel = (x: number, y: number): [number, number, number] | null => {
    const ix = Math.round(x - origin.x), iy = Math.round(y - origin.y);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h || !mask.data[iy * w + ix]) return null;
    const i = (iy * w + ix) * 4;
    return rgbToLab(data[i], data[i + 1], data[i + 2]);
  };
  const sides: SideSamples['sides'] = [];
  for (let s = 0; s < 4; s++) {
    const path = pathBetween(arc, corners[s], corners[(s + 1) % 4]);
    if (path.length < 2) return null;
    const cum = cumulative(path);
    const total = cum[path.length - 1];
    if (total <= 0) return null;
    const step = total / SIDE_SAMPLES;
    const half = Math.max(1.5, 0.03 * total);
    const at: Point[] = [], normal: Point[] = [];
    const colour = new Float32Array(SIDE_SAMPLES * 3).fill(NaN);
    for (let k = 0; k < SIDE_SAMPLES; k++) {
      const u = (k + 0.5) * step;
      const p = pointOnPath(path, cum, u);
      const p0 = pointOnPath(path, cum, u - half), p1 = pointOnPath(path, cum, u + half);
      const tl = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const n = tl > 1e-9 ? { x: -(p1.y - p0.y) / tl, y: (p1.x - p0.x) / tl } : { x: 0, y: 0 };
      at.push(p);
      normal.push(n);
      let l = 0, a = 0, b = 0, cnt = 0;
      for (const along of [-0.3 * step, 0, 0.3 * step]) {
        const q = pointOnPath(path, cum, u + along);
        for (const d of depths) {
          const lab = pixel(q.x + n.x * d, q.y + n.y * d);
          if (!lab) continue;
          l += lab[0];
          a += lab[1];
          b += lab[2];
          cnt++;
        }
      }
      if (cnt === 0) continue;
      let v0 = (l / cnt) * weights[0], v1 = (a / cnt) * weights[1], v2 = (b / cnt) * weights[2];
      if (correction) {
        const M = correction.m;
        [v0, v1, v2] = [M[0] * v0 + M[1] * v1 + M[2] * v2 + M[3], M[4] * v0 + M[5] * v1 + M[6] * v2 + M[7], M[8] * v0 + M[9] * v1 + M[10] * v2 + M[11]];
      }
      colour[k * 3] = v0;
      colour[k * 3 + 1] = v1;
      colour[k * 3 + 2] = v2;
    }
    sides.push({ at, normal, colour });
  }
  return { sides };
}

/** A candidate placement: the similarity (photo → reference) with its pivot at reference point `ref`. */
export interface PlacementMap {
  map: { pivot: Point; phi: number; s: number };
  ref: Point;
}

/** Weighted Lab of the reference's finest level at reference point `p` (bilinear; clamped to the padded level). */
function referenceColour(index: ReferenceIndex, p: Point): [number, number, number] {
  const level = index.levels[index.levels.length - 1];
  const x = Math.max(0, Math.min(level.stride - 1.001, (p.x + 0.5) * level.scaleX - 0.5 + level.pad));
  const y = Math.max(0, Math.min(level.rows - 1.001, (p.y + 0.5) * level.scaleY - 0.5 + level.pad));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const D = level.data, S = level.stride;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const i00 = (y0 * S + x0) * 3 + c;
    out[c] = (1 - fy) * ((1 - fx) * D[i00] + fx * D[i00 + 3]) + fy * ((1 - fx) * D[i00 + S * 3] + fx * D[i00 + S * 3 + 3]);
  }
  return out;
}

/**
 * Colour mismatch between a piece's sides and the box picture just across them, at a placement:
 * every sample of the piece's local sides `sides` is carried into the picture through the
 * placement, and the photo colour just inside the outline is compared with the picture's just
 * outside it (in the neighbouring cell). Root mean square weighted-Lab distance over the samples,
 * after removing the mean difference when `zeroMean` (a lighting offset the colour correction left);
 * null without a valid sample.
 */
export function continuityMismatch(index: ReferenceIndex, samples: SideSamples, placement: PlacementMap, sides: readonly number[], zeroMean = false): number | null {
  const { pivot, phi, s } = placement.map;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const cell = Math.sqrt(index.cellW * index.cellH);
  const across = [ACROSS[0] * cell, ((ACROSS[0] + ACROSS[1]) / 2) * cell, ACROSS[1] * cell];
  const diffs: number[] = [];
  for (const i of sides) {
    const side = samples.sides[i];
    for (let k = 0; k < side.at.length; k++) {
      const c0 = side.colour[k * 3];
      if (Number.isNaN(c0)) continue;
      const dx = (side.at[k].x - pivot.x) * s, dy = (side.at[k].y - pivot.y) * s;
      const o = { x: placement.ref.x + cos * dx - sin * dy, y: placement.ref.y + sin * dx + cos * dy };
      const n = { x: cos * side.normal[k].x - sin * side.normal[k].y, y: sin * side.normal[k].x + cos * side.normal[k].y };
      let r0 = 0, r1 = 0, r2 = 0;
      for (const d of across) {
        const r = referenceColour(index, { x: o.x - n.x * d, y: o.y - n.y * d });
        r0 += r[0];
        r1 += r[1];
        r2 += r[2];
      }
      diffs.push(c0 - r0 / 3, side.colour[k * 3 + 1] - r1 / 3, side.colour[k * 3 + 2] - r2 / 3);
    }
  }
  const n = diffs.length / 3;
  if (n === 0) return null;
  const mean = [0, 0, 0];
  if (zeroMean) for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) mean[c] += diffs[k * 3 + c] / n;
  let ss = 0;
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) ss += (diffs[k * 3 + c] - mean[c]) ** 2;
  return Math.sqrt(ss / n);
}

/** Knobs of {@link preferFittingGaps} (defaults below). */
export interface GapOptions {
  /** Score bonus per placed neighbour of a candidate's cell (default {@link GAP_PRIOR}; 0 = off). */
  prior?: number;
  /** Score weight of the continuity evidence (default {@link GAP_CONTINUITY}; 0 = off). */
  continuity?: number;
  /** Continuity measured on every side of every candidate, not only towards placed cells (an A/B control). */
  continuityAllSides?: boolean;
  /** Gap evidence only for candidates whose cell agrees with the piece's clear side readings (default on). */
  border?: boolean;
  /** Candidates within this score of the best are reordered (default {@link GAP_SLACK}). */
  slack?: number;
  /** Most the evidence may lift a confidence over the photo's own (default `PLACED_GAIN`). */
  gain?: number;
}

/** Default score bonus per placed neighbour (see {@link GapOptions.prior}). */
export const GAP_PRIOR = 0;
/** Default weight of the continuity evidence (see {@link GapOptions.continuity}). */
export const GAP_CONTINUITY = 0;
/** Default score slack of the reordering (see {@link GapOptions.slack}). */
export const GAP_SLACK = 0.03;
/** Weighted-Lab distance of the continuity evidence's scale: a mismatch this much below the candidates' mean is worth `continuity` in score. */
const CONTINUITY_UNIT = 10;

/** What {@link preferFittingGaps} changed. */
export interface GapChange {
  regionId: number;
  from: CellRef;
  to: CellRef;
  /** Placed neighbours of the new cell. */
  neighbours: number;
}

/**
 * Reorder ambiguous single pieces' candidates by the gap evidence (see module documentation):
 * among the candidates scoring within the slack of the best, the one with the best score plus gap
 * evidence goes first. Its confidence becomes at most the former best's and at most its photo
 * confidence plus the gain; the former best takes its place's confidence. `details` and `inputs`
 * are aligned (as matched); `regions` give the outlines. Changes the details' matches in place
 * (call before the cell claims, while `MatchDetail.placements` still lines up with the candidates).
 */
export function preferFittingGaps(
  index: ReferenceIndex,
  regions: readonly DetectedRegion[],
  inputs: readonly MatchInput[],
  details: readonly MatchDetail[],
  placedCells: readonly CellRef[],
  opts: GapOptions = {},
): GapChange[] {
  const prior = opts.prior ?? GAP_PRIOR, weight = opts.continuity ?? GAP_CONTINUITY;
  if (placedCells.length === 0 || (prior <= 0 && weight <= 0)) return [];
  const slack = opts.slack ?? GAP_SLACK, gain = opts.gain ?? PLACED_GAIN, border = opts.border ?? true;
  const placed = new Set(placedCells.map(cellKey));
  const regionById = new Map(regions.map((r) => [r.id, r]));
  const changes: GapChange[] = [];
  details.forEach((d, idx) => {
    const m: RegionMatch = d.match, input = inputs[idx];
    const region = regionById.get(m.regionId);
    if (!region || input.kind !== 'piece' || m.status !== 'ambiguous' || m.candidates.length < 2 || !d.placements) return;
    const best = m.candidates[0];
    // A best place in a marked cell won against the marks' penalty: the photo insists (a wrong
    // mark, or a piece that came off the board); the marks must not push it out a second time.
    if (placed.has(cellKey(best))) return;
    const near = m.candidates.map((_, i) => i).filter((i) => i < d.placements!.length && best.score - m.candidates[i].score <= slack);
    if (near.length < 2) return;
    const shape = input.shape;
    // Gap evidence of each near candidate.
    const sidesOf = near.map((i) => placedSides(index.grid, placed, m.candidates[i]));
    if (!sidesOf.some((s) => s && s.some(Boolean))) return;
    const allowed = near.map((i, j) => !!sidesOf[j] && (!border || !shape || borderAgrees(shape, m.candidates[i].rotationDeg, m.candidates[i], index.grid)));
    const bonus = near.map((_, j) => (allowed[j] ? prior * sidesOf[j]!.filter(Boolean).length : 0));
    if (weight > 0 && shape && region.contour.length >= 3) {
      const samples = sampleSides(input.image, input.mask, input.origin, region.contour, shape, index.channelWeights, d.correction);
      if (samples) {
        const local = (rot: number, puzzleSides: boolean[]) => [0, 1, 2, 3].filter((k) => puzzleSides[puzzleSideOf(shape, rot, k)]);
        const mism = near.map((i, j) => {
          const c = m.candidates[i];
          const facing = opts.continuityAllSides ? [true, true, true, true] : sidesOf[j];
          if (!facing || !facing.some(Boolean) || (!opts.continuityAllSides && !allowed[j])) return null;
          return continuityMismatch(index, samples, d.placements![i], local(c.rotationDeg, facing));
        });
        const known = mism.filter((v): v is number => v !== null);
        if (known.length > 0) {
          // Relative to the candidates' mean: evidence for the better continuing places, against the worse.
          const mean = opts.continuityAllSides ? known.reduce((a, v) => a + v, 0) / known.length : Math.max(...known);
          mism.forEach((v, j) => {
            if (v !== null) bonus[j] += (weight * (mean - v)) / CONTINUITY_UNIT;
          });
        }
      }
    }
    let top = 0;
    for (let j = 1; j < near.length; j++) if (m.candidates[near[j]].score + bonus[j] > m.candidates[near[top]].score + bonus[top]) top = j;
    if (top === 0) return;
    const i = near[top];
    const moved = m.candidates[i];
    const photo = d.photoConfidences?.[i] ?? moved.confidence;
    const conf = Math.max(moved.confidence, Math.min(best.confidence, photo + gain));
    const was = best.confidence;
    m.candidates.splice(i, 1);
    m.candidates.unshift({ ...moved, confidence: conf });
    m.candidates[1] = { ...m.candidates[1], confidence: Math.min(was, moved.confidence) };
    const [p] = d.placements.splice(i, 1);
    d.placements.unshift(p);
    if (d.photoConfidences) {
      const [pc] = d.photoConfidences.splice(i, 1);
      d.photoConfidences.unshift(pc);
    }
    changes.push({ regionId: m.regionId, from: { row: best.row, col: best.col }, to: { row: moved.row, col: moved.col }, neighbours: sidesOf[top]?.filter(Boolean).length ?? 0 });
  });
  return changes;
}
