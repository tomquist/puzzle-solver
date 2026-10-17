/**
 * Grid estimation: turn "N pieces, picture W × H" into rows × columns, and describe grid cells in
 * words for the UI. Pure TS, worker-safe.
 */
import type { CellRef, GridSpec } from '../model/types';

/** Number of candidates returned by {@link estimateGrid}. */
const MAX_CANDIDATES = 5;
/**
 * Weight of the piece-squareness term relative to the relative piece-count error. With 0.5 a
 * layout whose pieces are 10 % off square costs about as much as one with 5 % too many/few pieces.
 */
const SQUARENESS_WEIGHT = 0.5;

interface ScoredGrid {
  grid: GridSpec;
  score: number;
  countError: number;
}

/**
 * Estimates the rows × columns layout of a grid-cut puzzle from its piece count and the aspect
 * ratio (width / height) of the picture.
 *
 * Every layout is scored by its relative piece-count error `|rows·cols − N| / N` plus
 * {@link SQUARENESS_WEIGHT} × `|log(aspect · rows / cols)|` (how far the pieces are from square).
 * Invalid input is sanitised (piece count rounded and clamped to ≥ 1, non-positive or non-finite
 * aspect treated as 1), so this never throws.
 *
 * @returns the best layout and up to five distinct candidates, best first (`candidates[0]` equals
 *   `best`).
 */
export function estimateGrid(
  pieceCount: number,
  aspect: number,
): { best: GridSpec; candidates: GridSpec[] } {
  const n = Number.isFinite(pieceCount) ? Math.max(1, Math.round(pieceCount)) : 1;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;

  const idealRows = Math.sqrt(n / a);
  const idealCols = Math.sqrt(n * a);
  const rowLo = Math.max(1, Math.floor(idealRows * 0.5));
  const rowHi = Math.min(n, Math.ceil(idealRows * 1.6) + 1);
  const colLo = Math.max(1, Math.floor(idealCols * 0.5));
  const colHi = Math.min(n, Math.ceil(idealCols * 1.6) + 1);

  const scored: ScoredGrid[] = [];
  for (let rows = rowLo; rows <= rowHi; rows++) {
    for (let cols = colLo; cols <= colHi; cols++) {
      const countError = Math.abs(rows * cols - n) / n;
      if (countError > 0.5) continue;
      const squareness = Math.abs(Math.log((a * rows) / cols));
      scored.push({ grid: { rows, cols }, score: countError + SQUARENESS_WEIGHT * squareness, countError });
    }
  }
  if (scored.length === 0) {
    // Only reachable for degenerate inputs (e.g. extreme aspect ratios); fall back to the rounded ideal.
    const rows = Math.max(1, Math.round(idealRows));
    const cols = Math.max(1, Math.round(n / rows));
    return { best: { rows, cols }, candidates: [{ rows, cols }] };
  }

  scored.sort(
    (p, q) =>
      p.score - q.score || p.countError - q.countError || p.grid.rows - q.grid.rows || p.grid.cols - q.grid.cols,
  );
  const candidates = scored.slice(0, MAX_CANDIDATES).map((s) => ({ ...s.grid }));
  return { best: { ...candidates[0] }, candidates };
}

const AREA_NAMES = [
  ['top left', 'top', 'top right'],
  ['left', 'center', 'right'],
  ['bottom left', 'bottom', 'bottom right'],
] as const;

/** 0 / 1 / 2 = first / middle / last third, judged by the cell's center. */
function third(index: number, count: number): 0 | 1 | 2 {
  const f = (index + 0.5) / Math.max(1, count);
  return f < 1 / 3 ? 0 : f > 2 / 3 ? 2 : 1;
}

/**
 * Human-readable location of a grid cell, e.g. `"row 3, column 12 (top left)"` or
 * `"row 1, column 1 (top left, corner piece)"`. Row/column numbers are 1-based; the area name
 * comes from a coarse 3 × 3 division of the picture, and border cells are marked as
 * "corner piece" / "edge piece".
 */
export function describeCell(cell: CellRef, grid: GridSpec): string {
  const area = AREA_NAMES[third(cell.row, grid.rows)][third(cell.col, grid.cols)];
  const onRowBorder = cell.row === 0 || cell.row === grid.rows - 1;
  const onColBorder = cell.col === 0 || cell.col === grid.cols - 1;
  const border = onRowBorder && onColBorder ? 'corner piece' : onRowBorder || onColBorder ? 'edge piece' : undefined;
  return `row ${cell.row + 1}, column ${cell.col + 1} (${border ? `${area}, ${border}` : area})`;
}
