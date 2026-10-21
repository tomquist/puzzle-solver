/**
 * Replay of the app's grid handling over a sequence of scans (shared by scripts/grid-replay.ts on
 * real feedback files and bench/grid.eval.ts on synthetic scenes): at every scan the photo is
 * analysed with the grid the app has at that moment (and the probe mode the app would ask for),
 * its evidence added and the decision applied – a question is answered "Use it", an estimated grid
 * follows silently, a confirmation is recorded. After a change, scans so far are re-analysed when
 * the cells changed by more than 8 % (as the app does; nearer changes only remap cells and keep the
 * evidence, which does not depend on the grid).
 */
import type { GridEvidence, GridSpec, GridState, PieceCountKind } from '../model/types';
import { acceptGrid, adoptGrid, decideGrid, newGridState, sameGrid, withScanEvidence } from '../pipeline/gridBelief';
import type { GridProbe } from '../pipeline/match/cellSize';
import { cellChange, REMAP_LIMIT } from '../pipeline/remap';

export interface ReplayStart {
  label: string;
  grid: GridSpec;
  count: number;
  countKind: PieceCountKind;
  status: GridState['status'];
}

export interface ReplayOutcome {
  start: string;
  order: string;
  questions: number;
  /** Position (1-based) of the first question, its grid and whether it was the truth. */
  first?: { at: number; grid: GridSpec; right: boolean };
  wrongQuestions: number;
  silentSwitches: number;
  confirmedAt?: number;
  final: GridSpec;
  finalStatus: GridState['status'];
  right: boolean;
  log: string[];
}

/** The app's probe mode for a grid state (src/ui/hooks/useGridBelief.ts gridProbeFor). */
export const probeModeFor = (st: GridState): GridProbe | undefined => (st.status === 'confirmed' ? undefined : st.status === 'estimated' ? 'wide' : 'near');

const fmt = (g: GridSpec) => `${g.cols}×${g.rows}`;

/**
 * Replay `scans` (ids, in order) from `start`; `analyse(id, grid, probe)` returns a scan's evidence
 * analysed with that grid.
 */
export async function replayGrid(
  scans: string[],
  start: ReplayStart,
  truth: GridSpec,
  ref: { width: number; height: number },
  analyse: (id: string, grid: GridSpec, probe: GridProbe | undefined) => Promise<GridEvidence>,
  order = 'taken',
): Promise<ReplayOutcome> {
  let grid = { ...start.grid };
  let state = newGridState(start.status);
  const out: ReplayOutcome = { start: start.label, order, questions: 0, wrongQuestions: 0, silentSwitches: 0, final: grid, finalStatus: state.status, right: false, log: [] };
  const done: string[] = [];
  for (let i = 0; i < scans.length; i++) {
    const id = scans[i];
    done.push(id);
    state = withScanEvidence(state, id, await analyse(id, grid, probeModeFor(state)));
    const d = decideGrid({ refWidth: ref.width, refHeight: ref.height, pieceCount: start.count, countKind: start.countKind, grid, state });
    if (d.kind === 'suggest' || d.kind === 'adopt') {
      const previous = grid;
      const right = sameGrid(d.grid, truth);
      if (d.kind === 'suggest') {
        out.questions++;
        if (!right) out.wrongQuestions++;
        out.first ??= { at: i + 1, grid: d.grid, right };
        state = acceptGrid(state, previous);
      } else {
        out.silentSwitches++;
        state = adoptGrid(state, previous);
      }
      out.log.push(`#${i + 1} ${id}: ${d.kind} ${fmt(d.grid)} (odds ${d.odds.toFixed(0)}, ${d.sources} sources)${right ? '' : ' WRONG'}`);
      grid = { ...d.grid };
      if (cellChange(previous, grid) > REMAP_LIMIT) {
        for (const g of done) state = withScanEvidence(state, g, await analyse(g, grid, probeModeFor(state)));
      }
    } else if (d.kind === 'confirm') {
      state = { ...state, status: 'confirmed' };
      out.confirmedAt ??= i + 1;
      out.log.push(`#${i + 1} ${id}: confirmed ${fmt(grid)} (odds ${d.odds.toFixed(0)})`);
    }
  }
  out.final = grid;
  out.finalStatus = state.status;
  out.right = sameGrid(grid, truth);
  return out;
}

/** Deterministic shuffle (orders of the replay). */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
