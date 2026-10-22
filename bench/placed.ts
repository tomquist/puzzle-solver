/**
 * Simulated "placed" marks for the benchmarks: cells the user has marked as filled on the board,
 * drawn from the truth of a scan, with some of them wrong. Users make mistakes when marking pieces
 * as placed (a tap on the neighbouring cell, a piece marked from the wrong scan, a mark left after
 * the piece came off the board), and the matcher must never trust the marks blindly: with wrong
 * marks, placements must be at least as good as with no marks at all.
 *
 * Settings (see {@link PLACED_SETTINGS}):
 *   none         no marks (the reference the others are judged against)
 *   others       every cell but the scan's own is marked (all other pieces are on the board)
 *   f<F>-e<E>    a fraction F of all cells is marked; a fraction E of the marks is wrong: the cell
 *                is empty. Wrong marks hit the scan's own cells in proportion E (that share of the
 *                scan's pieces find their own true cell marked as filled), the rest other empty cells.
 *   others-e<E>  'others' plus a fraction E of the scan's own cells marked (wrong).
 *   frame-e<E>   how people really assemble: a contiguous region of half the cells – the frame (the
 *                border cells; a walk along the border from a random corner when they are more than
 *                half) and a blob grown inwards from it – with a fraction E of the marks wrong: the
 *                scan's own cells in proportion E, the rest empty cells next to the region (a tap on
 *                the neighbouring cell). The scan's pieces are loose, so their cells are never part of
 *                the region: where one borders it, the piece belongs in a gap.
 * The draw is deterministic (seeded).
 *
 * A gap is a cell that is not marked but borders at least one marked cell ({@link gapNeighbours});
 * bench/placed.eval.ts reports the pieces whose true cell is a gap separately.
 */
import { cellKey, type CellRef, type GridSpec } from '../src/model/types';
import { Rng } from '../src/testing/synth';

export interface PlacedSetting {
  name: string;
  mode: 'none' | 'others' | 'random' | 'frame';
  /** Share of all cells marked ('random', 'frame'). */
  f?: number;
  /** Share of the marks that are wrong (cells that are empty, the scan's own among them). */
  e?: number;
}

export const NO_MARKS: PlacedSetting = { name: 'none', mode: 'none' };

/**
 * Gate: with marks, wrong ones included, top-1, top-3 and confident precision are at least the
 * no-marks result minus this – tighter than the baseline tolerance: one piece of one synthetic scene
 * moves the scenes' average by about 0.007…
 */
export const PLACED_TOLERANCE = 0.01;
/** …and one piece of the private files' 75 by 0.013. */
export const PLACED_TOLERANCE_PRIVATE = 0.015;

/** The settings the benchmarks run (PLACED=<name,name,…> picks some). */
export const PLACED_SETTINGS: PlacedSetting[] = [
  NO_MARKS,
  { name: 'others', mode: 'others', e: 0 },
  { name: 'others-e0.25', mode: 'others', e: 0.25 },
  { name: 'f0.3-e0', mode: 'random', f: 0.3, e: 0 },
  { name: 'f0.3-e0.1', mode: 'random', f: 0.3, e: 0.1 },
  { name: 'f0.3-e0.25', mode: 'random', f: 0.3, e: 0.25 },
  { name: 'f0.7-e0', mode: 'random', f: 0.7, e: 0 },
  { name: 'f0.7-e0.1', mode: 'random', f: 0.7, e: 0.1 },
  { name: 'f0.7-e0.25', mode: 'random', f: 0.7, e: 0.25 },
  { name: 'frame', mode: 'frame', f: 0.5, e: 0 },
  { name: 'frame-e0.1', mode: 'frame', f: 0.5, e: 0.1 },
  { name: 'frame-e0.25', mode: 'frame', f: 0.5, e: 0.25 },
];

const DIRS: [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]];

/** Marked 4-neighbours of `cell` (0 for a marked cell: it is no gap). */
export function gapNeighbours(grid: GridSpec, marked: ReadonlySet<string>, cell: CellRef): number {
  if (marked.has(cellKey(cell))) return 0;
  let k = 0;
  for (const [dr, dc] of DIRS) {
    const row = cell.row + dr, col = cell.col + dc;
    if (row >= 0 && col >= 0 && row < grid.rows && col < grid.cols && marked.has(cellKey({ row, col }))) k++;
  }
  return k;
}

/** Settings picked by a PLACED environment variable: comma-separated names; unset, '1' or 'all': all. */
export function placedSettingsFromEnv(env: string | undefined): PlacedSetting[] {
  if (!env || env === '1' || env === 'all') return PLACED_SETTINGS;
  const names = env.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = PLACED_SETTINGS.filter((s) => names.includes(s.name));
  return picked.some((s) => s.mode === 'none') ? picked : [NO_MARKS, ...picked];
}

export interface SimulatedMarks {
  cells: CellRef[];
  /** The scan's own cells among the marks (wrong marks on a piece of the scan). */
  onScan: Set<string>;
  wrong: number;
}

/**
 * Marks for one scan: `scanCells` are the true cells of everything in the scan (empty on the
 * board). See the module documentation.
 */
export function simulatePlacedCells(grid: GridSpec, scanCells: readonly CellRef[], setting: PlacedSetting, seed: number): SimulatedMarks {
  const rng = new Rng(seed * 7919 + 17);
  const scan = new Set(scanCells.map(cellKey));
  const scanList = [...scan].sort();
  const rest: string[] = [];
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) if (!scan.has(cellKey({ row, col }))) rest.push(cellKey({ row, col }));
  const e = setting.e ?? 0;
  const marks = new Set<string>();
  const onScan = new Set<string>();
  let wrong = 0;
  if (setting.mode === 'others') {
    rest.forEach((k) => marks.add(k));
    for (const k of rng.shuffle(scanList).slice(0, Math.round(e * scanList.length))) {
      marks.add(k);
      onScan.add(k);
      wrong++;
    }
  } else if (setting.mode === 'random') {
    const total = Math.round((setting.f ?? 0) * grid.rows * grid.cols);
    const nWrong = Math.round(e * total);
    // Cells really on the board (the correct marks) and the empty ones besides the scan's.
    const shuffled = rng.shuffle(rest);
    const correct = shuffled.slice(0, Math.max(0, total - nWrong));
    const emptyOthers = shuffled.slice(correct.length);
    correct.forEach((k) => marks.add(k));
    const nScan = Math.min(nWrong, Math.round(e * scanList.length));
    for (const k of rng.shuffle(scanList).slice(0, nScan)) {
      marks.add(k);
      onScan.add(k);
      wrong++;
    }
    for (const k of emptyOthers.slice(0, nWrong - nScan)) {
      marks.add(k);
      wrong++;
    }
  } else if (setting.mode === 'frame') {
    const total = Math.round((setting.f ?? 0) * grid.rows * grid.cols);
    const nWrong = Math.round(e * total);
    const region = frameRegion(grid, scan, Math.max(0, total - nWrong), rng);
    region.forEach((k) => marks.add(k));
    const nScan = Math.min(nWrong, Math.round(e * scanList.length));
    for (const k of rng.shuffle(scanList).slice(0, nScan)) {
      marks.add(k);
      onScan.add(k);
      wrong++;
    }
    // The other wrong marks: empty cells next to the region first (a tap beside the right cell).
    const free = rest.filter((k) => !region.has(k));
    const near = rng.shuffle(free.filter((k) => gapNeighbours(grid, region, keyCell(k)) > 0));
    const far = rng.shuffle(free.filter((k) => gapNeighbours(grid, region, keyCell(k)) === 0));
    for (const k of [...near, ...far].slice(0, nWrong - nScan)) {
      marks.add(k);
      wrong++;
    }
  }
  const cells = [...marks].sort().map(keyCell);
  return { cells, onScan, wrong };
}

function keyCell(k: string): CellRef {
  const [row, col] = k.split(',').map(Number);
  return { row, col };
}

/**
 * A contiguous assembled region of `n` cells avoiding `scan` (see the module documentation): the
 * frame first, walked along the border from a random corner, then a blob grown inwards from one
 * cell next to the frame (each new cell next to the blob, picked with odds rising with its number of
 * region neighbours, so the blob stays compact).
 */
function frameRegion(grid: GridSpec, scan: ReadonlySet<string>, n: number, rng: Rng): Set<string> {
  const { rows, cols } = grid;
  const ring: string[] = [];
  for (let c = 0; c < cols; c++) ring.push(cellKey({ row: 0, col: c }));
  for (let r = 1; r < rows; r++) ring.push(cellKey({ row: r, col: cols - 1 }));
  if (rows > 1) for (let c = cols - 2; c >= 0; c--) ring.push(cellKey({ row: rows - 1, col: c }));
  if (cols > 1) for (let r = rows - 2; r >= 1; r--) ring.push(cellKey({ row: r, col: 0 }));
  const corners = [0, cols - 1, cols - 1 + rows - 1, 2 * (cols - 1) + rows - 1].filter((i) => i < ring.length);
  const start = corners[rng.int(corners.length)];
  const region = new Set<string>();
  for (let i = 0; i < ring.length && region.size < n; i++) {
    const k = ring[(start + i) % ring.length];
    if (!scan.has(k)) region.add(k);
  }
  // The blob: grown from one cell next to the frame, always next to itself (a new seed only when it
  // is boxed in by the scan's cells).
  const blob = new Set<string>();
  while (region.size < n) {
    const frontier: { k: string; w: number }[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const k = cellKey({ row, col });
        if (region.has(k) || scan.has(k)) continue;
        if (blob.size > 0 && gapNeighbours(grid, blob, { row, col }) === 0) continue;
        const nb = gapNeighbours(grid, region, { row, col });
        if (nb > 0) frontier.push({ k, w: nb * nb });
      }
    }
    if (frontier.length === 0) {
      if (blob.size === 0) break;
      blob.clear();
      continue;
    }
    let pick = rng.random() * frontier.reduce((a, f) => a + f.w, 0);
    let chosen = frontier[frontier.length - 1].k;
    for (const f of frontier) {
      pick -= f.w;
      if (pick < 0) {
        chosen = f.k;
        break;
      }
    }
    region.add(chosen);
    blob.add(chosen);
  }
  return region;
}
