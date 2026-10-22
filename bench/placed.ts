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
 * The draw is deterministic (seeded).
 */
import { cellKey, type CellRef, type GridSpec } from '../src/model/types';
import { Rng } from '../src/testing/synth';

export interface PlacedSetting {
  name: string;
  mode: 'none' | 'others' | 'random';
  /** Share of all cells marked ('random'). */
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
];

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
  }
  const cells = [...marks].sort().map((k) => {
    const [row, col] = k.split(',').map(Number);
    return { row, col };
  });
  return { cells, onScan, wrong };
}
