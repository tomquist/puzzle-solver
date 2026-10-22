/** Solving-progress math (pure). */
import { cellKey, type CellRef, type GridSpec, type Id, type PlacedCell, type ProgressRecord } from '../../model/types';

export function emptyProgress(puzzleId: Id): ProgressRecord {
  return { puzzleId, placed: {}, updatedAt: 0 };
}

function parseKey(key: string): CellRef | undefined {
  const [r, c] = key.split(',').map(Number);
  return Number.isInteger(r) && Number.isInteger(c) ? { row: r, col: c } : undefined;
}

export function inGrid(cell: CellRef, grid: GridSpec): boolean {
  return cell.row >= 0 && cell.col >= 0 && cell.row < grid.rows && cell.col < grid.cols;
}

/** Placed cells that lie inside the grid (cells from an older, larger grid are ignored). */
export function placedCells(progress: ProgressRecord | undefined, grid: GridSpec): CellRef[] {
  if (!progress) return [];
  const out: CellRef[] = [];
  for (const key of Object.keys(progress.placed)) {
    const cell = parseKey(key);
    if (cell && inGrid(cell, grid)) out.push(cell);
  }
  return out;
}

export function placedCount(progress: ProgressRecord | undefined, grid: GridSpec): number {
  return placedCells(progress, grid).length;
}

export function totalCells(grid: GridSpec): number {
  return Math.max(0, grid.rows) * Math.max(0, grid.cols);
}

/** 0..100, rounded down so 100 % means really finished (but never shows 0 once something is placed). */
export function progressPercent(progress: ProgressRecord | undefined, grid: GridSpec): number {
  const total = totalCells(grid);
  if (total === 0) return 0;
  const n = placedCount(progress, grid);
  if (n === 0) return 0;
  return Math.max(1, Math.floor((100 * n) / total));
}

export function isPlaced(progress: ProgressRecord | undefined, cell: CellRef): boolean {
  return !!progress && cellKey(cell) in progress.placed;
}

/** New record with `cells` marked as placed (existing entries are kept unchanged). */
export function placeCells(
  progress: ProgressRecord,
  cells: CellRef[],
  meta: { scanId?: Id; regionId?: number } = {},
  now = Date.now(),
): ProgressRecord {
  const placed = { ...progress.placed };
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!(key in placed)) placed[key] = { at: now, ...meta };
  }
  return { ...progress, placed, updatedAt: now };
}

/** New record with `cells` removed. */
export function unplaceCells(progress: ProgressRecord, cells: CellRef[], now = Date.now()): ProgressRecord {
  const placed = { ...progress.placed };
  for (const cell of cells) delete placed[cellKey(cell)];
  return { ...progress, placed, updatedAt: now };
}

/** New record with entries taken out earlier put back as they were (undo of unplaceCells). */
export function restorePlaced(progress: ProgressRecord, entries: Record<string, PlacedCell>, now = Date.now()): ProgressRecord {
  return { ...progress, placed: { ...progress.placed, ...entries }, updatedAt: now };
}
