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
        if (best.confidence < CONFIDENT_THRESHOLD) q.status = 'ambiguous';
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
 * single cell becomes confident; otherwise the new candidates stay ambiguous. Changes `matches` in
 * place.
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
  const sure = open.length === 1 && free.length === 1;
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
