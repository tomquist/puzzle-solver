/**
 * Fit hints between regions of one scan: by location (best placements in neighbouring cells), by
 * shape (complementary tab/blank profiles) or both.
 */
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

/** Shape agreement of two touching sides: 1 = perfect fit, 0 = incompatible, null = unknown. */
function sideFit(sa: PieceShape, ia: number, sb: PieceShape, ib: number): number | null {
  const A = sa.sides[ia], B = sb.sides[ib];
  const comp = complementary(A.kind, B.kind);
  if (comp === null) return null;
  if (!comp) return 0;
  const ratio = Math.max(A.length, B.length) / Math.max(1e-6, Math.min(A.length, B.length));
  if (ratio > MAX_LENGTH_RATIO * 1.1) return 0.2;
  const rms = profileMismatch(A.profile, B.profile);
  return Math.max(0.2, Math.min(1, 1.5 - rms / (2 * MAX_PROFILE_RMS)));
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
export function findFits(regions: DetectedRegion[], matches: RegionMatch[], grid: GridSpec): FitHint[] {
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
        const fit = sideFit(sa, localSideAt(sa, A.rotationDeg, side), sb, localSideAt(sb, B.rotationDeg, opposite(side)));
        if (fit !== null) {
          if (fit < 0.3) conf *= 0.3;
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
  interface SideRef { p: Placed; shape: PieceShape; i: number }
  const sides: SideRef[] = [];
  for (const p of placed) {
    const shape = p.region.kind === 'piece' ? p.region.shape : undefined;
    if (!shape || shape.confidence < 0.5) continue;
    for (let i = 0; i < 4; i++) if (shape.sides[i].kind === 'tab' || shape.sides[i].kind === 'blank') sides.push({ p, shape, i });
  }
  const best = new Map<SideRef, { other: SideRef; rms: number; second: number }>();
  for (const s of sides) {
    let b: SideRef | null = null, d1 = Infinity, d2 = Infinity;
    for (const o of sides) {
      if (o.p === s.p || !complementary(s.shape.sides[s.i].kind, o.shape.sides[o.i].kind)) continue;
      const la = s.shape.sides[s.i].length, lb = o.shape.sides[o.i].length;
      if (Math.max(la, lb) / Math.min(la, lb) > MAX_LENGTH_RATIO) continue;
      const d = profileMismatch(s.shape.sides[s.i].profile, o.shape.sides[o.i].profile);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        b = o;
      } else if (d < d2) d2 = d;
    }
    if (b) best.set(s, { other: b, rms: d1, second: d2 });
  }
  for (const [s, r] of best) {
    const back = best.get(r.other);
    if (!back || back.other !== s || s.p.region.id > r.other.p.region.id) continue;
    if (r.rms > MAX_PROFILE_RMS || r.second < 1.6 * r.rms || back.second < 1.6 * back.rms) continue;
    const A = s.p, B = r.other.p;
    const sa = puzzleSideOf(s.shape, A.rotationDeg, s.i);
    const sb = puzzleSideOf(r.other.shape, B.rotationDeg, r.other.i);
    const k = key(A.region.id, B.region.id, SIDES[sa]);
    const existing = hints.get(k);
    // Two confidently placed regions can only fit where their locations say so.
    const bothPlaced = A.confidence >= MIN_PLACEMENT_CONFIDENCE && B.confidence >= MIN_PLACEMENT_CONFIDENCE;
    if (bothPlaced && !existing) continue;
    let conf = Math.max(0, 1 - r.rms / MAX_PROFILE_RMS) * Math.min(1, (Math.min(r.second, back.second) / Math.max(1e-6, r.rms) - 1) / 2);
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
