/**
 * One cell, one piece. A loose piece placed confidently in a cell that an assembled patch's
 * placement also covers is a contradiction: a piece lying beside the patch cannot be part of it.
 * Left alone, the fit hints silently drop the pair (their cells overlap), so the piece shows no
 * connection at all although it may belong exactly into one of the patch's holes.
 *
 * The weaker placement gives way: when the piece is at least as confident as the patch, the cell is
 * taken off the patch's covered cells (the patch is placed by its print as a whole, and one cell
 * at its outline or at a hole is its least certain part); otherwise the piece is no longer
 * confident (its confidence halved). Patches cover only the cells where their mask has print
 * (segmentation opens the table they enclose), so this is the guard for what is left.
 *
 * The same holds between two loose pieces (`uniqueCells`): the less confident one moves to its next
 * free candidate when that one scores nearly as well, or is no longer confident.
 */
import { cellKey, type CellRef, type DetectedRegion, type GridSpec, type Placement, type RegionMatch } from '../../model/types';
import { CONFIDENT_THRESHOLD } from './matchRegion';

/** What {@link resolveCellClaims} changed. */
export interface CellClaimChange {
  /** The loose piece's region and the patch's region. */
  piece: number;
  patch: number;
  cell: { row: number; col: number };
  /** 'cell-dropped': the patch no longer covers the cell; 'piece-demoted': the piece's confidence was lowered. */
  action: 'cell-dropped' | 'piece-demoted';
}

/** Resolve confident loose pieces lying on cells a patch covers (in place; see module documentation). */
export function resolveCellClaims(regions: readonly DetectedRegion[], matches: RegionMatch[]): CellClaimChange[] {
  const kind = new Map(regions.map((r) => [r.id, r.kind]));
  const patches = matches.filter((m) => kind.get(m.regionId) === 'patch' && m.status !== 'unmatched' && (m.coveredCells?.length ?? 0) > 0 && m.candidates.length > 0);
  const pieces = matches.filter((m) => kind.get(m.regionId) === 'piece' && m.status === 'confident' && m.candidates.length > 0);
  const changes: CellClaimChange[] = [];
  // Most confident pieces first: a demoted piece no longer claims its cell.
  pieces.sort((a, b) => b.candidates[0].confidence - a.candidates[0].confidence);
  for (const q of pieces) {
    const best = q.candidates[0];
    const key = cellKey(best);
    for (const p of patches) {
      if (q.status !== 'confident') break;
      const i = p.coveredCells!.findIndex((c) => cellKey(c) === key);
      if (i < 0) continue;
      if (best.confidence >= p.candidates[0].confidence) {
        p.coveredCells!.splice(i, 1);
        // A patch reports its top-most, then left-most covered cell.
        if (p.coveredCells!.length > 0) {
          const tl = p.coveredCells!.reduce((a, b) => (b.row < a.row || (b.row === a.row && b.col < a.col) ? b : a));
          p.candidates[0].row = tl.row;
          p.candidates[0].col = tl.col;
        }
        changes.push({ piece: q.regionId, patch: p.regionId, cell: { row: best.row, col: best.col }, action: 'cell-dropped' });
      } else {
        for (const c of q.candidates) c.confidence *= 0.5;
        if (best.confidence < CONFIDENT_THRESHOLD) {
          q.status = 'ambiguous';
          q.uncertainReason = 'similar-spots';
        }
        changes.push({ piece: q.regionId, patch: p.regionId, cell: { row: best.row, col: best.col }, action: 'piece-demoted' });
      }
    }
  }
  return changes;
}

/**
 * Most cells left free for {@link placeByElimination} (a nearly finished or small puzzle; with more
 * free cells the matcher's own ranking is all there is to go by).
 */
const ELIMINATION_MAX_FREE = 3;
/** Confidence of a placement by elimination: one region for one free cell / several. */
const ELIMINATION_SURE = 0.75;
const ELIMINATION_SHARED = 0.4;

/** What {@link placeByElimination} placed. */
export interface EliminationChange {
  regionId: number;
  cell: CellRef;
  rotationDeg: number;
  /** Free cells and regions without a confident place. */
  free: number;
  open: number;
}

/**
 * The last free cells. When the scan's confident placements (pieces and patches) and the cells the
 * user has placed already account for all cells of the grid but a few, and the scan holds no more
 * single pieces without a confident place than cells are left, those pieces belong in those cells,
 * whatever the matcher made of their print: typically the corner under a box picture's badge (the
 * "18" of a children's puzzle covers most of a cell, so the piece from there matches nowhere and
 * the matcher does not even list that cell), or the last pieces of a puzzle. `score` gives the
 * matcher's score of a region at a cell and rotation (null: cannot be laid there); every free cell
 * is tried in the four quarter turns, and the best pairs are assigned first. A single region for a
 * single cell becomes confident – unless its own best place is a cell the user marked as placed
 * (the marks may be wrong, and then the free cell is not the piece's) –; otherwise the new
 * candidates stay ambiguous. Changes `matches` in place.
 */
export function placeByElimination(
  regions: readonly DetectedRegion[],
  matches: RegionMatch[],
  grid: GridSpec,
  placedCells: readonly CellRef[],
  score: (regionId: number, cell: CellRef, rotationDeg: number) => Placement | null,
): EliminationChange[] {
  const kind = new Map(regions.map((r) => [r.id, r.kind]));
  const claimed = new Set(placedCells.map(cellKey));
  for (const m of matches) {
    if (m.status !== 'confident' || m.candidates.length === 0) continue;
    if (kind.get(m.regionId) === 'patch') for (const c of m.coveredCells ?? []) claimed.add(cellKey(c));
    else if (kind.get(m.regionId) === 'piece') claimed.add(cellKey(m.candidates[0]));
  }
  const free: CellRef[] = [];
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) if (!claimed.has(cellKey({ row, col }))) free.push({ row, col });
  const open = matches.filter((m) => kind.get(m.regionId) === 'piece' && m.status !== 'confident');
  if (free.length === 0 || free.length > ELIMINATION_MAX_FREE || open.length === 0 || open.length > free.length) return [];
  const pairs: { m: RegionMatch; cell: CellRef; p: Placement }[] = [];
  for (const m of open) {
    for (const cell of free) {
      let best: Placement | null = null;
      for (const rot of [0, 90, 180, 270]) {
        const p = score(m.regionId, cell, rot);
        if (p && (!best || p.score > best.score)) best = p;
      }
      if (best) pairs.push({ m, cell, p: best });
    }
  }
  pairs.sort((a, b) => b.p.score - a.p.score);
  // The user's marks may be wrong: when the piece's own best place is a cell the user marked as
  // placed, the photo and the marks disagree, and the last free cell is no certainty.
  const marked = new Set(placedCells.map(cellKey));
  const sure = open.length === 1 && free.length === 1 && !(open[0].candidates.length > 0 && marked.has(cellKey(open[0].candidates[0])));
  const done = new Set<RegionMatch>(), taken = new Set<string>();
  const changes: EliminationChange[] = [];
  for (const { m, cell, p } of pairs) {
    if (done.has(m) || taken.has(cellKey(cell))) continue;
    done.add(m);
    taken.add(cellKey(cell));
    const confidence = sure ? ELIMINATION_SURE : ELIMINATION_SHARED;
    // The other candidates share what is left.
    const rest = m.candidates.filter((c) => cellKey(c) !== cellKey(cell));
    const sum = rest.reduce((a, c) => a + c.confidence, 0);
    for (const c of rest) c.confidence = sum > 0 ? (c.confidence / sum) * Math.min(sum, 1 - confidence) : 0;
    m.candidates = [{ ...p, row: cell.row, col: cell.col, confidence }, ...rest];
    m.status = sure ? 'confident' : 'ambiguous';
    changes.push({ regionId: m.regionId, cell, rotationDeg: p.rotationDeg, free: free.length, open: open.length });
  }
  return changes;
}

/**
 * Single pieces of a scan whose best placement shares its cell with another single piece's (for a
 * cell claimed by k pieces, k − 1 count), among all placed pieces and among the confident ones.
 * A diagnostic: one cell holds one piece, so every duplicate claim is at least one wrong placement.
 */
export function duplicateClaims(regions: readonly DetectedRegion[], matches: readonly RegionMatch[]): { all: number; confident: number } {
  const kind = new Map(regions.map((r) => [r.id, r.kind]));
  const count = (pick: (m: RegionMatch) => boolean) => {
    const seen = new Map<string, number>();
    for (const m of matches) {
      if (kind.get(m.regionId) !== 'piece' || m.status === 'unmatched' || m.candidates.length === 0 || !pick(m)) continue;
      const k = cellKey(m.candidates[0]);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    let n = 0;
    for (const v of seen.values()) n += v - 1;
    return n;
  };
  return { all: count(() => true), confident: count((m) => m.status === 'confident') };
}

/** Default score slack within which a single piece moves to its next free candidate ({@link uniqueCells}). */
export const CLAIM_SLACK = 0.05;
/** Factor of a piece's confidences when it shares its cell with a more confident piece and has no free place within the slack. */
const CLAIM_DEMOTE = 0.5;

/** What {@link uniqueCells} changed. */
export interface UniqueCellChange {
  regionId: number;
  /** The more confident region holding the cell. */
  holder: number;
  cell: CellRef;
  /** 'moved': to its next free candidate (`to`); 'demoted': its confidence lowered. */
  action: 'moved' | 'demoted';
  to?: CellRef;
}

/**
 * One cell, one piece, within a scan: when two single pieces' best placements share a cell, the
 * less confident one gives way – to its best candidate in a cell no more confident piece (or
 * confident patch) holds, when that one scores within `slack` of its best, otherwise it is no
 * longer confident (its confidences halved). Placement scores only: no shape fits. Pieces are
 * taken most confident first (ties by region id, so the result is deterministic). Cells the user
 * marked as placed are no hard claim here: they are in the scores already (soft, see matchRegion).
 * Changes `matches` in place; a piece that gave way gets `uncertainReason: 'similar-spots'` (its
 * best spot is another piece's, the others score about the same).
 */
export function uniqueCells(regions: readonly DetectedRegion[], matches: RegionMatch[], slack = CLAIM_SLACK): UniqueCellChange[] {
  const kind = new Map(regions.map((r) => [r.id, r.kind]));
  const held = new Map<string, number>();
  for (const m of matches) {
    if (kind.get(m.regionId) !== 'patch' || m.status !== 'confident' || m.candidates.length === 0) continue;
    for (const c of m.coveredCells ?? []) held.set(cellKey(c), m.regionId);
  }
  const rank = (m: RegionMatch) => m.candidates[0].confidence + (m.status === 'confident' ? 1 : 0);
  const pieces = matches
    .filter((m) => kind.get(m.regionId) === 'piece' && m.status !== 'unmatched' && m.candidates.length > 0)
    .sort((a, b) => rank(b) - rank(a) || a.regionId - b.regionId);
  const changes: UniqueCellChange[] = [];
  for (const m of pieces) {
    const best = m.candidates[0];
    const holder = held.get(cellKey(best));
    if (holder === undefined) {
      held.set(cellKey(best), m.regionId);
      continue;
    }
    const k = m.candidates.findIndex((c, i) => i > 0 && !held.has(cellKey(c)) && best.score - c.score <= slack);
    if (k > 0) {
      const [c] = m.candidates.splice(k, 1);
      m.candidates.unshift(c);
      held.set(cellKey(c), m.regionId);
      changes.push({ regionId: m.regionId, holder, cell: { row: best.row, col: best.col }, action: 'moved', to: { row: c.row, col: c.col } });
    } else {
      for (const c of m.candidates) c.confidence *= CLAIM_DEMOTE;
      changes.push({ regionId: m.regionId, holder, cell: { row: best.row, col: best.col }, action: 'demoted' });
    }
    if (m.status === 'confident' && m.candidates[0].confidence < CONFIDENT_THRESHOLD) m.status = 'ambiguous';
    if (m.status !== 'confident') m.uncertainReason = 'similar-spots';
  }
  return changes;
}
