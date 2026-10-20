/**
 * Fit hints between regions of one scan: by location (best placements in neighbouring cells), by
 * shape (complementary tab/blank profiles) or both.
 *
 * Two sides are compared by shape – point by point (default) or with DTW, see sideCompare.ts – and,
 * when the pieces' colour strips are given, by the colours just inside them. The comparison is
 * expressed in units of the point-wise profile RMS, so the thresholds below apply to every variant.
 */
import type { EdgeStrips } from './edgeStrips';
import { profileMismatchDtw, stripMismatch } from './sideCompare';
import {
  cellKey,
  type CellRef,
  type DetectedRegion,
  type FitHint,
  type GridSpec,
  type PieceShape,
  type PuzzleSide,
  type RegionMatch,
  type SideKind,
} from '../../model/types';

const SIDES: PuzzleSide[] = ['top', 'right', 'bottom', 'left'];
const DIRS: [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // (dRow, dCol) per puzzle side
/** Placements below this confidence are not used for location hints. */
const MIN_PLACEMENT_CONFIDENCE = 0.5;
/** Maximum RMS profile mismatch (fraction of side length) for a shape hint. */
const MAX_PROFILE_RMS = 0.035;
const MAX_LENGTH_RATIO = 1.1;
const MAX_HINTS_PER_REGION = 3;

/** How side shapes are compared: point-wise RMS, banded DTW, or banded DTW after removing a tilt ('dtw-levelled'). */
export type ShapeMetric = 'rms' | 'dtw' | 'dtw-levelled';

export interface FitOptions {
  /** Side shape comparison (default 'rms'). */
  shape?: ShapeMetric;
  /** DTW band in profile samples (default 1 for 'dtw', 2 for 'dtw-levelled'). */
  band?: number;
  /** Colour strips of single pieces by region id (see `sampleEdgeStrips`): colour then joins the side comparison. */
  strips?: ReadonlyMap<number, EdgeStrips>;
  /** Share of colour in the side distance when strips are given (default {@link COLOUR_SHARE}). */
  colourShare?: number;
  /**
   * Side distances by profile (the PieceShape's own arrays), filled and reused by every call with
   * these options: pass one for repeated calls on the same scan (DTW costs ~2 µs per pair of sides).
   */
  cache?: WeakMap<readonly number[], Map<readonly number[], number>>;
}

/**
 * Median distance of two unrelated complementary sides per comparison (synthetic scans,
 * bench/sides.eval.ts): the scale on which shape and colour are combined. True partners score
 * about 0.65 (RMS) or 0.45 (DTW, colour) of it.
 */
const TYPICAL_DISTANCE: Record<ShapeMetric | 'colour', number> = { rms: 0.057, dtw: 0.031, 'dtw-levelled': 0.02, colour: 17 };
/** Default share of colour in the combined side distance. */
export const COLOUR_SHARE = 0.5;

/** Puzzle side (0 top … 3 left) of local side `i` of a shape after rotating the region by `rotationDeg`. */
export function puzzleSideOf(shape: PieceShape, rotationDeg: number, i: number): number {
  return ((Math.round((rotationDeg + shape.angleDeg + 90 * i) / 90) % 4) + 4) % 4;
}

/** Local side index of `shape` that faces puzzle side `side` at rotation `rotationDeg`. */
function localSideAt(shape: PieceShape, rotationDeg: number, side: number): number {
  for (let i = 0; i < 4; i++) if (puzzleSideOf(shape, rotationDeg, i) === side) return i;
  return side;
}

function complementary(a: SideKind, b: SideKind): boolean | null {
  if (a === 'unknown' || b === 'unknown') return null;
  return (a === 'tab' && b === 'blank') || (a === 'blank' && b === 'tab');
}

/** RMS distance between profile A and the reversed, negated profile B (0 = perfect fit). */
export function profileMismatch(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Infinity;
  let s = 0;
  for (let k = 0; k < n; k++) {
    const d = a[k] + b[n - 1 - k];
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** One side of a single piece, as compared by {@link sideDistance}. */
interface SideOf {
  regionId: number;
  shape: PieceShape;
  i: number;
}

/**
 * Mismatch of two sides in units of the point-wise profile RMS (0 = perfect fit): their profiles
 * compared as `opts.shape` says and, when both colour strips are given, their strips, each relative
 * to its typical value for unrelated sides, mixed by the colour share. Plain RMS by default.
 */
export function sideMismatch(pa: readonly number[], pb: readonly number[], ca: Float32Array | undefined, cb: Float32Array | undefined, opts: Omit<FitOptions, 'strips'> = {}): number {
  const metric = opts.shape ?? 'rms';
  const shape =
    metric === 'rms' ? profileMismatch(pa, pb)
    : metric === 'dtw' ? profileMismatchDtw(pa, pb, opts.band ?? 1)
    : profileMismatchDtw(pa, pb, opts.band ?? 2, true);
  const unit = TYPICAL_DISTANCE.rms / TYPICAL_DISTANCE[metric];
  if (!ca || !cb) return shape * unit;
  const w = opts.colourShare ?? COLOUR_SHARE;
  return (1 - w) * shape * unit + w * stripMismatch(ca, cb) * (TYPICAL_DISTANCE.rms / TYPICAL_DISTANCE.colour);
}

/** {@link sideMismatch} of two sides of single pieces, with their strips from `opts.strips` (memoised in `opts.cache`). */
function sideDistance(a: SideOf, b: SideOf, opts: FitOptions): number {
  const pa = a.shape.sides[a.i].profile, pb = b.shape.sides[b.i].profile;
  let row = opts.cache?.get(pa);
  const known = row?.get(pb);
  if (known !== undefined) return known;
  const strip = (s: SideOf) => opts.strips?.get(s.regionId)?.sides[s.i];
  const d = sideMismatch(pa, pb, strip(a), strip(b), opts);
  if (opts.cache) {
    if (!row) opts.cache.set(pa, (row = new Map()));
    row.set(pb, d);
  }
  return d;
}

/** Shape agreement of two touching sides: 1 = perfect fit, 0 = incompatible, null = unknown. */
function sideFit(a: SideOf, b: SideOf, opts: FitOptions): number | null {
  const A = a.shape.sides[a.i], B = b.shape.sides[b.i];
  const comp = complementary(A.kind, B.kind);
  if (comp === null) return null;
  if (!comp) return 0;
  const ratio = Math.max(A.length, B.length) / Math.max(1e-6, Math.min(A.length, B.length));
  if (ratio > MAX_LENGTH_RATIO * 1.1) return 0.2;
  const rms = sideDistance(a, b, opts);
  return Math.max(0.2, Math.min(1, 1.5 - rms / (2 * MAX_PROFILE_RMS)));
}

/** A shape fit: local side `sideA` of single piece `a` fits local side `sideB` of piece `b` (a < b). */
export interface ShapeFit {
  a: number;
  sideA: number;
  b: number;
  sideB: number;
  /** Side distance (units of the point-wise profile RMS, see {@link sideMismatch}). */
  distance: number;
  /** Smaller of the two sides' second-best / best distance ratios (≥ 1.6). */
  ratio: number;
  /** 0..1: how close the sides match and how clearly they beat the alternatives. */
  confidence: number;
}

/**
 * Shape fits among single pieces, wherever they are placed: complementary sides of nearly equal
 * length whose distance is small and which are each other's best partner by a clear margin (the
 * second-best partner of either side at least 1.6× as far). Pieces with unsure corners take no
 * part. Partners are sought among the given regions only.
 */
export function shapeFits(regions: readonly DetectedRegion[], opts: FitOptions = {}): ShapeFit[] {
  interface SideRef { id: number; shape: PieceShape; i: number }
  const sides: SideRef[] = [];
  for (const r of regions) {
    const shape = r.kind === 'piece' ? r.shape : undefined;
    if (!shape || shape.confidence < 0.5) continue;
    for (let i = 0; i < 4; i++) if (shape.sides[i].kind === 'tab' || shape.sides[i].kind === 'blank') sides.push({ id: r.id, shape, i });
  }
  const best = new Map<SideRef, { other: SideRef; rms: number; second: number }>();
  for (const s of sides) {
    let b: SideRef | null = null, d1 = Infinity, d2 = Infinity;
    for (const o of sides) {
      if (o.id === s.id || !complementary(s.shape.sides[s.i].kind, o.shape.sides[o.i].kind)) continue;
      const la = s.shape.sides[s.i].length, lb = o.shape.sides[o.i].length;
      if (Math.max(la, lb) / Math.min(la, lb) > MAX_LENGTH_RATIO) continue;
      const d = sideDistance({ regionId: s.id, shape: s.shape, i: s.i }, { regionId: o.id, shape: o.shape, i: o.i }, opts);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        b = o;
      } else if (d < d2) d2 = d;
    }
    if (b) best.set(s, { other: b, rms: d1, second: d2 });
  }
  const out: ShapeFit[] = [];
  for (const [s, r] of best) {
    const back = best.get(r.other);
    if (!back || back.other !== s || s.id > r.other.id) continue;
    if (r.rms > MAX_PROFILE_RMS || r.second < 1.6 * r.rms || back.second < 1.6 * back.rms) continue;
    const ratio = Math.min(r.second, back.second) / Math.max(1e-6, r.rms);
    const confidence = Math.max(0, 1 - r.rms / MAX_PROFILE_RMS) * Math.min(1, (ratio - 1) / 2);
    out.push({ a: s.id, sideA: s.i, b: r.other.id, sideB: r.other.i, distance: r.rms, ratio, confidence });
  }
  return out;
}

interface Placed {
  region: DetectedRegion;
  cells: CellRef[];
  rotationDeg: number;
  confidence: number;
}

/**
 * Fit hints for one scan: location hints between regions whose confident placements are 4-adjacent
 * (pieces and patches via their covered cells), shape hints between single pieces with
 * complementary, closely matching sides (only when unambiguous), merged into 'location+shape' when
 * both agree. At most a few hints per region, best first.
 */
export function findFits(regions: DetectedRegion[], matches: RegionMatch[], grid: GridSpec, opts: FitOptions = {}): FitHint[] {
  const byId = new Map(matches.map((m) => [m.regionId, m]));
  const placed: Placed[] = [];
  for (const region of regions) {
    const m = byId.get(region.id);
    const c = m?.candidates[0];
    if (!m || !c || m.status === 'unmatched') continue;
    const cells = m.coveredCells && m.coveredCells.length > 0 ? m.coveredCells : [{ row: c.row, col: c.col }];
    if (cells.some((x) => x.row < 0 || x.col < 0 || x.row >= grid.rows || x.col >= grid.cols)) continue;
    placed.push({ region, cells, rotationDeg: c.rotationDeg, confidence: c.confidence });
  }
  const hints = new Map<string, FitHint>();
  const key = (a: number, b: number, sa: PuzzleSide) => `${a}|${b}|${sa}`;
  const opposite = (s: number) => (s + 2) % 4;

  // (a) Location: regions whose cells are 4-adjacent (and do not overlap).
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i], B = placed[j];
      if (A.confidence < MIN_PLACEMENT_CONFIDENCE || B.confidence < MIN_PLACEMENT_CONFIDENCE) continue;
      const bCells = new Set(B.cells.map(cellKey));
      if (A.cells.some((c) => bCells.has(cellKey(c)))) continue;
      let side = -1;
      for (const c of A.cells) {
        for (let s = 0; s < 4 && side < 0; s++) {
          if (bCells.has(cellKey({ row: c.row + DIRS[s][0], col: c.col + DIRS[s][1] }))) side = s;
        }
        if (side >= 0) break;
      }
      if (side < 0) continue;
      let conf = A.confidence * B.confidence;
      let reason: FitHint['reason'] = 'location';
      const sa = A.region.kind === 'piece' ? A.region.shape : undefined;
      const sb = B.region.kind === 'piece' ? B.region.shape : undefined;
      if (sa && sb) {
        const fit = sideFit(
          { regionId: A.region.id, shape: sa, i: localSideAt(sa, A.rotationDeg, side) },
          { regionId: B.region.id, shape: sb, i: localSideAt(sb, B.rotationDeg, opposite(side)) },
          opts,
        );
        if (fit !== null) {
          // Contradicting sides: either a placement or the side classification is wrong; two very
          // confident placements make a misread side more likely.
          if (fit < 0.3) conf *= Math.min(A.confidence, B.confidence) >= 0.9 ? 0.6 : 0.3;
          else if (fit > 0.7) {
            conf = 1 - (1 - conf) * (1 - 0.5 * fit);
            reason = 'location+shape';
          }
        }
      }
      const h: FitHint = { a: A.region.id, b: B.region.id, sideA: SIDES[side], sideB: SIDES[opposite(side)], confidence: conf, reason };
      hints.set(key(h.a, h.b, h.sideA), h);
    }
  }

  // (b) Shape: mutually best, unambiguous complementary sides of single pieces.
  const placedById = new Map(placed.map((p) => [p.region.id, p]));
  for (const f of shapeFits(placed.map((p) => p.region), opts)) {
    const A = placedById.get(f.a)!, B = placedById.get(f.b)!;
    const sa = puzzleSideOf(A.region.shape!, A.rotationDeg, f.sideA);
    const sb = puzzleSideOf(B.region.shape!, B.rotationDeg, f.sideB);
    const k = key(A.region.id, B.region.id, SIDES[sa]);
    const existing = hints.get(k);
    // Two confidently placed regions can only fit where their locations say so.
    const bothPlaced = A.confidence >= MIN_PLACEMENT_CONFIDENCE && B.confidence >= MIN_PLACEMENT_CONFIDENCE;
    if (bothPlaced && !existing) continue;
    let conf = f.confidence;
    if (sb !== opposite(sa)) conf *= 0.5; // the placements' rotations disagree with this fit
    conf = Math.min(0.9, conf);
    if (existing) {
      if (existing.reason === 'location') {
        existing.reason = 'location+shape';
        existing.confidence = 1 - (1 - existing.confidence) * (1 - conf);
      }
      continue;
    }
    if (conf < 0.2) continue;
    hints.set(k, { a: A.region.id, b: B.region.id, sideA: SIDES[sa], sideB: SIDES[sb], confidence: conf, reason: 'shape' });
  }

  // Limit hints per region, best first.
  const sorted = [...hints.values()].sort((x, y) => y.confidence - x.confidence);
  const count = new Map<number, number>();
  const out: FitHint[] = [];
  for (const h of sorted) {
    const ca = count.get(h.a) ?? 0, cb = count.get(h.b) ?? 0;
    if (ca >= MAX_HINTS_PER_REGION || cb >= MAX_HINTS_PER_REGION) continue;
    count.set(h.a, ca + 1);
    count.set(h.b, cb + 1);
    out.push(h);
  }
  return out;
}
