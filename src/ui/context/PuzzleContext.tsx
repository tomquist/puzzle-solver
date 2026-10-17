/**
 * Everything a puzzle's screens share: the record, solving progress, the reference picture (URL +
 * bitmap for crops) and the matcher state (pipeline.loadReference). Mounted once per puzzle id so
 * switching tabs or opening scan results doesn't reload anything.
 */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProgressRecord, PuzzleRecord } from '../../model/types';
import { blobToRGBA } from '../../platform/imageio';
import type { PipelineApi } from '../../worker/api';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import { IconPuzzle } from '../components/Icons';
import { TopBar } from '../components/TopBar';
import { useBitmap, useObjectUrl, useStoredBlob } from '../hooks/useObjectUrl';
import { emptyProgress } from '../lib/progress';
import { href } from '../lib/routes';
import { usePipeline } from './PipelineContext';
import { useRepo } from './RepositoryContext';

export interface ReferenceImage {
  url: string;
  bitmap?: ImageBitmap;
  width: number;
  height: number;
}

export type MatcherStatus = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export interface PuzzleContextValue {
  puzzle: PuzzleRecord;
  savePuzzle(p: PuzzleRecord): Promise<void>;
  progress: ProgressRecord;
  saveProgress(p: ProgressRecord): Promise<void>;
  reference: ReferenceImage | undefined;
  matcher: MatcherStatus;
  /** Resolves once the pipeline has this puzzle's reference loaded (loads it if needed). */
  ensureMatcher(): Promise<void>;
  /** Incremented whenever scans are added/removed. */
  scansVersion: number;
  scansChanged(): void;
}

const PuzzleContext = createContext<PuzzleContextValue | null>(null);

// Which reference/grid/cut each puzzle was loaded with in the pipeline (module-wide, survives remounts).
const loadedKeys = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();

function matcherKey(p: PuzzleRecord): string {
  return `${p.reference.blobId}|${p.grid.rows}x${p.grid.cols}|${p.cut}`;
}

async function loadIntoPipeline(pipeline: PipelineApi, puzzle: PuzzleRecord, blob: Blob): Promise<void> {
  const key = matcherKey(puzzle);
  if (loadedKeys.get(puzzle.id) === key && (await pipeline.hasReference(puzzle.id))) return;
  const flightKey = `${puzzle.id}|${key}`;
  let p = inflight.get(flightKey);
  if (!p) {
    p = (async () => {
      // Full resolution; the buffer may be transferred to the worker, so it is not kept here.
      const rgba = await blobToRGBA(blob, 16384);
      await pipeline.loadReference(puzzle.id, rgba, puzzle.grid, puzzle.cut);
      loadedKeys.set(puzzle.id, key);
    })().finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
  }
  return p;
}

export function PuzzleProvider({ id, children }: { id: string; children: ReactNode }) {
  const repo = useRepo();
  const pipeline = usePipeline();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'missing' } | { kind: 'error'; error: unknown } | { kind: 'ready'; puzzle: PuzzleRecord; progress: ProgressRecord }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [scansVersion, setScansVersion] = useState(0);
  const [matcher, setMatcher] = useState<MatcherStatus>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    Promise.all([repo.getPuzzle(id), repo.getProgress(id)]).then(
      ([puzzle, progress]) => {
        if (!alive) return;
        setState(puzzle ? { kind: 'ready', puzzle, progress: progress ?? emptyProgress(id) } : { kind: 'missing' });
      },
      (error: unknown) => alive && setState({ kind: 'error', error }),
    );
    return () => {
      alive = false;
    };
  }, [repo, id, attempt]);

  const puzzle = state.kind === 'ready' ? state.puzzle : undefined;
  const { blob: refBlob, missing: refMissing } = useStoredBlob(puzzle?.reference.blobId);
  const refUrl = useObjectUrl(refBlob);
  const refBitmap = useBitmap(refBlob);

  const ensureMatcher = useCallback(async () => {
    if (!puzzle || !refBlob) throw new Error('The puzzle picture is still loading.');
    await loadIntoPipeline(pipeline, puzzle, refBlob);
  }, [pipeline, puzzle, refBlob]);

  const ensureRef = useRef(ensureMatcher);
  ensureRef.current = ensureMatcher;

  // Load the matcher as soon as the reference is available (and again when grid/cut change).
  const key = puzzle ? matcherKey(puzzle) : '';
  useEffect(() => {
    if (!refBlob || !key) return;
    let alive = true;
    setMatcher({ kind: 'loading' });
    ensureRef.current().then(
      () => alive && setMatcher({ kind: 'ready' }),
      (e: unknown) => alive && setMatcher({ kind: 'error', message: e instanceof Error ? e.message : 'Could not prepare the picture for matching.' }),
    );
    return () => {
      alive = false;
    };
  }, [refBlob, key]);

  const savePuzzle = useCallback(
    async (p: PuzzleRecord) => {
      const next = { ...p, updatedAt: Date.now() };
      await repo.savePuzzle(next);
      setState((s) => (s.kind === 'ready' ? { ...s, puzzle: next } : s));
    },
    [repo],
  );

  const saveProgress = useCallback(
    async (p: ProgressRecord) => {
      setState((s) => (s.kind === 'ready' ? { ...s, progress: p } : s));
      await repo.saveProgress(p);
    },
    [repo],
  );

  const scansChanged = useCallback(() => setScansVersion((v) => v + 1), []);

  const value = useMemo<PuzzleContextValue | null>(() => {
    if (state.kind !== 'ready') return null;
    return {
      puzzle: state.puzzle,
      savePuzzle,
      progress: state.progress,
      saveProgress,
      reference: refUrl ? { url: refUrl, bitmap: refBitmap, width: state.puzzle.reference.width, height: state.puzzle.reference.height } : undefined,
      matcher: refMissing ? { kind: 'error', message: 'The puzzle picture is missing from storage.' } : matcher,
      ensureMatcher,
      scansVersion,
      scansChanged,
    };
  }, [state, savePuzzle, saveProgress, refUrl, refBitmap, refMissing, matcher, ensureMatcher, scansVersion, scansChanged]);

  if (state.kind === 'loading') {
    return (
      <>
        <TopBar title="Loading…" back={href.home()} />
        <main className="page">
          <Spinner label="Opening puzzle…" />
        </main>
      </>
    );
  }
  if (state.kind === 'missing') {
    return (
      <>
        <TopBar title="Puzzle not found" back={href.home()} />
        <main className="page">
          <EmptyState
            icon={<IconPuzzle size={32} />}
            title="This puzzle is not on this device"
            actions={
              <a className="btn btn-primary" href={href.home()}>
                Go to my puzzles
              </a>
            }
          >
            <p>It may have been deleted, or it was created in another browser. Use Export / Import to move puzzles between devices.</p>
          </EmptyState>
        </main>
      </>
    );
  }
  if (state.kind === 'error') {
    return (
      <>
        <TopBar title="Puzzle" back={href.home()} />
        <main className="page">
          <ErrorState title="Could not open this puzzle" error={state.error} onRetry={() => setAttempt((a) => a + 1)} />
        </main>
      </>
    );
  }
  return <PuzzleContext value={value}>{children}</PuzzleContext>;
}

export function usePuzzle(): PuzzleContextValue {
  const v = use(PuzzleContext);
  if (!v) throw new Error('usePuzzle must be used inside <PuzzleProvider>');
  return v;
}
