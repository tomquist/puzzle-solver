/**
 * The puzzle's self-correcting grid (pipeline/gridBelief.ts) in the app, owned by PuzzleProvider.
 *
 * Whenever the scans change (added, re-analysed, deleted) the evidence is synced – one entry per
 * existing scan – and weighed in the worker; the verdict may put a question on screen (stored in the
 * puzzle so it is shown once, until answered), switch an estimated grid without asking, or confirm
 * the grid. A grid change ("Use it", an estimated grid following the measurement, or Settings)
 * carries every scan's cells and the placed pieces over (pipeline/remap.ts, in the worker); scans
 * that cannot be carried over exactly – analysed at a scale far from the new grid's, or saved before
 * patches stored their lattice – are re-analysed in the background, with progress.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../../appVersion';
import type { GridSpec, GridState, ProgressRecord, PuzzleRecord, ScanRecord } from '../../model/types';
import { acceptGrid, adoptGrid, declineGrid, gridStateOf, sameGrid, syncEvidence } from '../../pipeline/gridBelief';
import { decodeExact } from '../../platform/imageio';
import type { PuzzleRepository } from '../../storage/types';
import type { GridVerdict, PipelineApi } from '../../worker/api';
import { placedCells } from '../lib/progress';

/** Cell changes (ln) up to this are remapped; larger ones re-analyse the scans (as pipeline/remap.ts REMAP_LIMIT). */
const REMAP_LIMIT = Math.log(1.08);
const cellChange = (a: GridSpec, b: GridSpec) => Math.max(Math.abs(Math.log(a.cols / b.cols)), Math.abs(Math.log(a.rows / b.rows)));

export type GridJob = { kind: 'updating'; grid: GridSpec; done: number; total: number };

export interface GridNotice {
  id: number;
  text: string;
}

export interface GridBeliefDeps {
  repo: PuzzleRepository;
  pipeline: PipelineApi;
  puzzle: PuzzleRecord | undefined;
  progress: () => ProgressRecord | undefined;
  savePuzzle(p: PuzzleRecord): Promise<void>;
  saveProgress(p: ProgressRecord): Promise<void>;
  /** Make the pipeline match against `p` (its grid); see PuzzleContext. */
  loadMatcher(p: PuzzleRecord): Promise<void>;
  scansVersion: number;
  scansChanged(): void;
}

export interface GridBelief {
  state: GridState;
  verdict: GridVerdict | undefined;
  job: GridJob | undefined;
  notice: GridNotice | undefined;
  clearNotice(): void;
  /** Answer the question on screen: switch to its grid ("Use it") or keep the current one. */
  answer(use: boolean): Promise<void>;
  /** The user chose another grid (Settings). */
  setGrid(grid: GridSpec, changes?: Partial<PuzzleRecord>): Promise<void>;
}

const fmt = (g: GridSpec) => `${g.cols} × ${g.rows}`;

/**
 * How far a new analysis measures (analyzeScan `gridProbe`): nothing extra once the grid is
 * confirmed; re-measuring at the scan's own scale when it is far from the grid's while the grid is
 * unconfirmed; also the ladder of scales (slow: several re-matches) while the grid is only an
 * estimate (no piece count).
 */
export function gridProbeFor(p: PuzzleRecord): 'near' | 'wide' | undefined {
  const st = gridStateOf(p);
  return st.status === 'confirmed' ? undefined : st.status === 'estimated' ? 'wide' : 'near';
}

export function useGridBelief(deps: GridBeliefDeps): GridBelief {
  const latest = useRef(deps);
  latest.current = deps;
  const [verdict, setVerdict] = useState<GridVerdict>();
  const [job, setJob] = useState<GridJob>();
  const [notice, setNotice] = useState<GridNotice>();
  const busy = useRef(false);
  const puzzle = deps.puzzle;
  const state = puzzle ? gridStateOf(puzzle) : gridStateOf({});

  /** Carry scans and progress to `to`, save the puzzle (`next`), re-analyse what cannot be carried. */
  const changeGrid = useCallback(async (next: PuzzleRecord, from: GridSpec, to: GridSpec) => {
    const { repo, pipeline, savePuzzle, saveProgress, loadMatcher, scansChanged } = latest.current;
    busy.current = true;
    try {
      const scans = await repo.listScans(next.id);
      const progress = latest.current.progress();
      const remapped = await pipeline.remapGrid({
        scans: scans.map((s) => ({ id: s.id, result: s.result })),
        progress: progress ?? { puzzleId: next.id, placed: {}, updatedAt: 0 },
        from,
        to,
        ref: { width: next.reference.width, height: next.reference.height },
      });
      await savePuzzle(next);
      const far = cellChange(from, to) > REMAP_LIMIT;
      const redo: ScanRecord[] = [];
      for (const s of scans) {
        const r = remapped.scans.find((x) => x.id === s.id);
        if (!r) continue;
        await repo.saveScan({ ...s, result: r.result });
        if (far || !r.exact) redo.push(s);
      }
      if (progress && Object.keys(progress.placed).length > 0) await saveProgress(remapped.progress);
      scansChanged();
      const placedText =
        remapped.dropped > 0
          ? ` ${remapped.dropped} placed ${remapped.dropped === 1 ? 'piece' : 'pieces'} could not be moved to the new grid – please place ${remapped.dropped === 1 ? 'it' : 'them'} again.`
          : remapped.moved > 0
            ? ` Placed pieces moved with it.`
            : '';
      setNotice({ id: Date.now(), text: `Grid changed to ${fmt(to)}.${placedText}` });
      if (redo.length > 0) {
        // Background re-analysis at the new grid (photos as stored).
        setJob({ kind: 'updating', grid: to, done: 0, total: redo.length });
        await loadMatcher(next);
        for (let i = 0; i < redo.length; i++) {
          const s = (await repo.getScan(redo[i].id)) ?? redo[i];
          const blob = await repo.getBlob(s.photoBlobId);
          if (blob) {
            const rgba = await decodeExact(blob);
            const cur = latest.current.puzzle ?? next;
            const resp = await pipeline.analyzeScan(next.id, rgba, {
              placedCells: placedCells(latest.current.progress(), to),
              gridProbe: gridProbeFor(cur),
            });
            await repo.saveScan({ ...s, result: resp.result, width: resp.result.width, height: resp.result.height, appVersion: APP_VERSION });
          }
          setJob({ kind: 'updating', grid: to, done: i + 1, total: redo.length });
        }
        setJob(undefined);
        scansChanged();
      }
    } finally {
      busy.current = false;
    }
  }, []);

  // Sync the evidence with the scans and weigh it whenever they change.
  const gridKey = puzzle ? `${puzzle.id}|${puzzle.grid.rows}x${puzzle.grid.cols}|${puzzle.pieceCount}|${puzzle.pieceCountKind ?? 'exact'}` : '';
  useEffect(() => {
    if (!gridKey) return;
    let alive = true;
    void (async () => {
      const { repo, pipeline, savePuzzle } = latest.current;
      const p0 = latest.current.puzzle;
      if (!p0 || busy.current || job) return;
      const scans = await repo.listScans(p0.id);
      const ref = { width: p0.reference.width, height: p0.reference.height };
      const before = gridStateOf(p0);
      const { suggestion: pending, ...open } = syncEvidence(before, scans, p0.grid, ref);
      let st: GridState = open;
      // Weigh the evidence as if nothing were on screen; a question already shown stays while the
      // scans still point at its grid (shown once), and goes when they no longer do.
      const v = await pipeline.assessGrid({ refWidth: ref.width, refHeight: ref.height, pieceCount: p0.pieceCount, countKind: p0.pieceCountKind ?? 'exact', grid: p0.grid, state: st });
      if (!alive) return;
      setVerdict(v);
      const p = latest.current.puzzle;
      if (!p || p.id !== p0.id || !sameGrid(p.grid, p0.grid) || busy.current) return;
      const d = v.decision;
      if (pending && (sameGrid(v.best, pending.grid) || (d.kind === 'suggest' && sameGrid(d.grid, pending.grid)))) st = { ...st, suggestion: pending };
      else if (d.kind === 'suggest') st = { ...st, suggestion: { grid: d.grid, odds: d.odds, sources: d.sources, scans: d.scans, at: Date.now() } };
      else if (d.kind === 'confirm') st = { ...st, status: 'confirmed', changedAt: Date.now() };
      else if (d.kind === 'adopt') {
        const to = d.grid;
        const next: PuzzleRecord = {
          ...p,
          grid: to,
          pieceCount: (p.pieceCountKind ?? 'exact') === 'unknown' ? to.rows * to.cols : p.pieceCount,
          gridState: adoptGrid(st, p.grid),
        };
        await changeGrid(next, p.grid, to);
        return;
      }
      if (JSON.stringify(st) !== JSON.stringify(before)) await savePuzzle({ ...p, gridState: st });
    })();
    return () => {
      alive = false;
    };
  }, [gridKey, deps.scansVersion, job, changeGrid]);

  const answer = useCallback(
    async (use: boolean) => {
      const p = latest.current.puzzle;
      if (!p) return;
      const st = gridStateOf(p);
      const s = st.suggestion;
      if (!s) return;
      if (!use) {
        await latest.current.savePuzzle({ ...p, gridState: declineGrid(st, s.grid) });
        return;
      }
      const to = s.grid;
      const next: PuzzleRecord = {
        ...p,
        grid: to,
        pieceCount: (p.pieceCountKind ?? 'exact') === 'unknown' ? to.rows * to.cols : p.pieceCount,
        gridState: acceptGrid(st, p.grid),
      };
      await changeGrid(next, p.grid, to);
    },
    [changeGrid],
  );

  const setGrid = useCallback(
    async (grid: GridSpec, changes: Partial<PuzzleRecord> = {}) => {
      const p = latest.current.puzzle;
      if (!p) return;
      const st = gridStateOf(p);
      const { suggestion: _dropped, ...rest } = st;
      void _dropped;
      // The user's own choice: unconfirmed (the scans may still disagree, once), no pending question.
      const next: PuzzleRecord = { ...p, ...changes, grid, gridState: { ...rest, status: 'unconfirmed', changedAt: Date.now() } };
      if (sameGrid(grid, p.grid)) {
        await latest.current.savePuzzle({ ...p, ...changes });
        return;
      }
      await changeGrid(next, p.grid, grid);
    },
    [changeGrid],
  );

  return { state, verdict, job, notice, clearNotice: useCallback(() => setNotice(undefined), []), answer, setGrid };
}
