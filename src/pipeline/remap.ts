/**
 * When the grid changes, scans and placed pieces follow without re-analysing the photos.
 *
 * Why: a scan's placements are stored as continuous reference positions (a piece's body centre,
 * a patch's lattice of cells in reference px – `RegionMatch.lattice`); cells are only derived from
 * them. So a new grid re-derives every cell the way the matcher does (cellAt for a piece, the
 * lattice's one-offset vote for a patch), then the fit hints and groups, which depend on cells.
 * Scans saved before the lattice was stored map their patches' old cells by their centres – close,
 * but not exact over a large patch; `exact: false` tells the caller to re-analyse them when it can.
 * Placed progress moves with the pieces it was confirmed from (their positions), or by the old
 * cell's centre; two old cells landing on one new cell keep the earlier.
 */
import type { CellRef, GridSpec, Id, Placement, ProgressRecord, RefLattice, RegionMatch, ScanResult } from '../model/types';
import { cellKey } from '../model/types';
import { DEFAULT_SIDE_COMPARISON } from './analyzeScan';
import { buildGroups, findFits, type FitOptions } from './match';

interface Size {
  width: number;
  height: number;
}

const cellOf = (x: number, y: number, grid: GridSpec, ref: Size): CellRef => ({
  row: Math.min(grid.rows - 1, Math.max(0, Math.floor((y + 0.5) / (ref.height / grid.rows)))),
  col: Math.min(grid.cols - 1, Math.max(0, Math.floor((x + 0.5) / (ref.width / grid.cols)))),
});

const centreOf = (c: CellRef, grid: GridSpec, ref: Size) => ({ x: ((c.col + 0.5) * ref.width) / grid.cols - 0.5, y: ((c.row + 0.5) * ref.height) / grid.rows - 0.5 });

function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

/**
 * Grid cells of a stored patch lattice, shifted by `shift` (reference px): the lattice is rigid, so
 * its axes map onto the grid's and one integer offset – the one most of its cells' centres agree on,
 * weighted by coverage – places every cell (as `latticeToGrid` in match/matchRegion.ts).
 */
export function latticeOnGrid(lat: RefLattice, grid: GridSpec, ref: Size, shift = { x: 0, y: 0 }): CellRef[] {
  const cw = ref.width / grid.cols, ch = ref.height / grid.rows;
  const toGrid = (x: number, y: number) => ({ col: (x + shift.x + 0.5) / cw, row: (y + shift.y + 0.5) / ch });
  const o = toGrid(lat.origin.x, lat.origin.y);
  const ea = toGrid(lat.origin.x + lat.a.x, lat.origin.y + lat.a.y), eb = toGrid(lat.origin.x + lat.b.x, lat.origin.y + lat.b.y);
  const da = { col: ea.col - o.col, row: ea.row - o.row }, db = { col: eb.col - o.col, row: eb.row - o.row };
  const aOnCol = Math.abs(da.col) >= Math.abs(da.row);
  const sa = Math.sign(aOnCol ? da.col : da.row) || 1;
  const sb = Math.sign(aOnCol ? db.row : db.col) || 1;
  const step = (i: number, j: number) => (aOnCol ? { col: sa * i, row: sb * j } : { col: sb * j, row: sa * i });
  const votes = new Map<string, number>();
  const n = Math.floor(lat.cells.length / 3);
  for (let k = 0; k < n; k++) {
    const i = lat.cells[3 * k], j = lat.cells[3 * k + 1], cov = lat.cells[3 * k + 2];
    const g = toGrid(lat.origin.x + (i + 0.5) * lat.a.x + (j + 0.5) * lat.b.x, lat.origin.y + (i + 0.5) * lat.a.y + (j + 0.5) * lat.b.y);
    const st = step(i, j);
    const key = `${Math.floor(g.row) - st.row},${Math.floor(g.col) - st.col}`;
    votes.set(key, (votes.get(key) ?? 0) + cov);
  }
  let bestKey = '', bestN = 0;
  for (const [key, v] of votes) if (v > bestN) [bestKey, bestN] = [key, v];
  if (!bestKey) return [];
  const [tr, tc] = bestKey.split(',').map(Number);
  const out = new Map<string, CellRef>();
  for (let k = 0; k < n; k++) {
    const st = step(lat.cells[3 * k], lat.cells[3 * k + 1]);
    const c = { row: tr + st.row, col: tc + st.col };
    if (c.row >= 0 && c.col >= 0 && c.row < grid.rows && c.col < grid.cols) out.set(cellKey(c), c);
  }
  return [...out.values()].sort((p, q) => p.row - q.row || p.col - q.col);
}

/** Old cells → new cells by their centres (patches without a stored lattice). */
function mapCells(cells: CellRef[], from: GridSpec, to: GridSpec, ref: Size): CellRef[] {
  const out = new Map<string, CellRef>();
  for (const c of cells) {
    const p = centreOf(c, from, ref);
    const n = cellOf(p.x, p.y, to, ref);
    out.set(cellKey(n), n);
  }
  return [...out.values()].sort((p, q) => p.row - q.row || p.col - q.col);
}

const topLeft = (cells: CellRef[]) => cells.reduce((a, b) => (b.row < a.row || (b.row === a.row && b.col < a.col) ? b : a));

/**
 * A scan's result on another grid (see module documentation). `exact` is false when a patch had
 * no stored lattice (scans from older versions): its cells were mapped by their centres.
 */
export function remapScanResult(result: ScanResult, from: GridSpec, to: GridSpec, ref: Size): { result: ScanResult; exact: boolean } {
  let exact = true;
  const kinds = new Map(result.regions.map((r) => [r.id, r.kind]));
  const matches: RegionMatch[] = result.matches.map((m) => {
    const isPatch = kinds.get(m.regionId) === 'patch' && m.coveredCells !== undefined;
    if (!isPatch) {
      return { ...m, candidates: m.candidates.map((c) => ({ ...c, ...cellOf(c.x, c.y, to, ref) })) };
    }
    const lat = m.lattice;
    let covered: CellRef[] | undefined;
    const candidates: Placement[] = m.candidates.map((c, i) => {
      let cells: CellRef[];
      if (lat && angleDiff(c.rotationDeg, lat.rotationDeg) <= 45) {
        cells = latticeOnGrid(lat, to, ref, { x: c.x - lat.at.x, y: c.y - lat.at.y });
      } else {
        // Only the best placement's cells matter for an exact carry-over (alternatives at another
        // turn have no lattice of their own).
        if (i === 0) exact = false;
        // The old cells moved with this candidate's offset from the best one, by their centres.
        const base = m.coveredCells ?? [];
        const best = m.candidates[0];
        const dr = c.row - best.row, dc = c.col - best.col;
        cells = mapCells(base.map((b) => ({ row: b.row + dr, col: b.col + dc })), from, to, ref);
      }
      if (i === 0) covered = cells;
      return cells.length > 0 ? { ...c, ...topLeft(cells) } : { ...c, ...cellOf(c.x, c.y, to, ref) };
    });
    return { ...m, candidates, coveredCells: covered ?? [] };
  });
  const cellW = ref.width / to.cols, cellH = ref.height / to.rows;
  const fitOptions: FitOptions = { shape: DEFAULT_SIDE_COMPARISON.shape, cache: new WeakMap() };
  const bodySize = result.quality.metrics?.medianBodySize;
  const groups = buildGroups(result.regions, matches, findFits(result.regions, matches, to, fitOptions), to, { cellW, cellH, bodySize: bodySize > 0 ? bodySize : undefined });
  const fits = findFits(result.regions, matches, to, fitOptions);
  return { result: { ...result, matches, fits, groups }, exact };
}

/**
 * Placed cells on the new grid: a cell confirmed from a scan's piece moves with that piece (its
 * remapped placement nearest the old cell), any other by its centre. Two old cells on one new cell
 * keep the earlier; `dropped` counts the others.
 */
export function remapProgress(
  progress: ProgressRecord,
  from: GridSpec,
  to: GridSpec,
  ref: Size,
  scans: { before: { id: Id; result: ScanResult }[]; after: { id: Id; result: ScanResult }[] },
): { progress: ProgressRecord; moved: number; dropped: number } {
  const before = new Map(scans.before.map((s) => [s.id, s]));
  const after = new Map(scans.after.map((s) => [s.id, s]));
  const placed: ProgressRecord['placed'] = {};
  let moved = 0, dropped = 0;
  const entries = Object.entries(progress.placed).sort((a, b) => a[1].at - b[1].at);
  for (const [key, cell] of entries) {
    const [row, col] = key.split(',').map(Number);
    if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
    const old = { row, col };
    let next: CellRef | undefined;
    const sb = cell.scanId ? before.get(cell.scanId) : undefined, sa = cell.scanId ? after.get(cell.scanId) : undefined;
    if (sb && sa && cell.regionId !== undefined) {
      const mb = sb.result.matches.find((m) => m.regionId === cell.regionId);
      const ma = sa.result.matches.find((m) => m.regionId === cell.regionId);
      if (mb && ma) {
        const covered = mb.coveredCells ?? [];
        const k = covered.findIndex((c) => c.row === old.row && c.col === old.col);
        if (k >= 0 && ma.coveredCells && ma.coveredCells.length === covered.length) next = ma.coveredCells[k];
        else {
          // A piece: the candidate it was placed at (on the old grid), on the new grid.
          const i = mb.candidates.findIndex((c) => c.row === old.row && c.col === old.col);
          if (i >= 0 && ma.candidates[i] && kindsMatch(mb.candidates[i], ma.candidates[i])) next = { row: ma.candidates[i].row, col: ma.candidates[i].col };
        }
      }
    }
    if (!next) {
      const p = centreOf(old, from, ref);
      next = cellOf(p.x, p.y, to, ref);
    }
    const nk = cellKey(next);
    if (nk in placed) {
      dropped++;
      continue;
    }
    if (nk !== key) moved++;
    placed[nk] = cell;
  }
  return { progress: { ...progress, placed, updatedAt: Date.now() }, moved, dropped };
}

/** The same placement before and after a remap (same position). */
const kindsMatch = (a: Placement, b: Placement) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** Largest relative change of the cell size between two grids (ln). */
export function cellChange(a: GridSpec, b: GridSpec): number {
  return Math.max(Math.abs(Math.log(a.cols / b.cols)), Math.abs(Math.log(a.rows / b.rows)));
}

/**
 * Cell changes up to this (ln) are remapped; beyond it the scans were analysed at a scale too far
 * from the new grid's (the matcher refines ±10 %) and are worth re-analysing.
 */
export const REMAP_LIMIT = Math.log(1.08);
