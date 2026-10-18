/**
 * The puzzle's running scan analysis, owned by PuzzleProvider so it survives switching tabs: decode
 * the photo → make sure the matcher has the reference → pipeline.analyzeScan (progress) → save the
 * ScanRecord → open its result.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../../appVersion';
import type { ProgressRecord, PuzzleRecord, ScanRecord } from '../../model/types';
import { blobToRGBA, isQuotaError, rgbaToBlob } from '../../platform/imageio';
import { newId, type PuzzleRepository } from '../../storage/types';
import type { PipelineApi } from '../../worker/api';
import { errorText } from '../components/Feedback';
import { navigate } from './useHashRoute';
import { placedCells } from '../lib/progress';
import { href } from '../lib/routes';

export type ScanJob =
  | { kind: 'running'; progress: number; message: string }
  | { kind: 'error'; title: string; message: string; photo?: Blob };

const STAGE_LABEL: Record<string, string> = {
  prepare: 'Preparing photo…',
  quality: 'Checking photo quality…',
  segment: 'Finding pieces…',
  shape: 'Analysing shapes…',
  match: 'Matching pieces to the picture…',
  fits: 'Looking for pieces that fit together…',
  done: 'Done',
};

export interface ScanJobDeps {
  repo: PuzzleRepository;
  pipeline: PipelineApi;
  puzzle: PuzzleRecord | undefined;
  progress: ProgressRecord | undefined;
  ensureMatcher(): Promise<void>;
  scansChanged(): void;
}

export function useScanJob(deps: ScanJobDeps): { job: ScanJob | undefined; start(photo: Blob): void; cancel(): void } {
  const [job, setJob] = useState<ScanJob>();
  const run = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(deps);
  latest.current = deps;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback((photo: Blob) => {
    const { repo, pipeline, puzzle, progress, ensureMatcher, scansChanged } = latest.current;
    if (!puzzle) return;
    const myRun = ++run.current;
    const alive = () => run.current === myRun && mounted.current;
    const working = (p: number, message: string) => {
      if (alive()) setJob({ kind: 'running', progress: p, message });
    };
    const fail = (title: string, message: string, retry?: Blob) => {
      if (alive()) setJob({ kind: 'error', title, message, photo: retry });
    };
    void (async () => {
      working(0.01, 'Reading photo…');
      let stage: 'read' | 'prepare' | 'analyse' | 'save' = 'read';
      try {
        const rgba = await blobToRGBA(photo, 4096);
        stage = 'prepare';
        working(0.02, 'Preparing the puzzle picture…');
        await ensureMatcher();
        stage = 'analyse';
        const resp = await pipeline.analyzeScan(puzzle.id, rgba, { placedCells: placedCells(progress, puzzle.grid) }, (e) =>
          working(0.03 + e.progress * 0.9, e.message ?? STAGE_LABEL[e.stage] ?? 'Analysing…'),
        );
        if (run.current !== myRun) return; // cancelled
        stage = 'save';
        working(0.95, 'Saving scan…');
        // High quality: feedback files replay this exact image, so keep compression artefacts small.
        const jpeg = await rgbaToBlob(resp.analysedImage, 'image/jpeg', 0.95);
        const photoBlobId = await repo.putBlob(jpeg);
        const scan: ScanRecord = {
          id: newId(),
          puzzleId: puzzle.id,
          createdAt: Date.now(),
          photoBlobId,
          width: resp.result.width,
          height: resp.result.height,
          result: resp.result,
          appVersion: APP_VERSION,
        };
        await repo.saveScan(scan);
        scansChanged();
        if (!alive()) return;
        setJob(undefined);
        // Open the result if the user is still somewhere in this puzzle.
        if (location.hash.startsWith(href.puzzle(puzzle.id))) navigate(href.scan(puzzle.id, scan.id));
      } catch (e) {
        if (stage === 'save') {
          fail('Could not save the scan', isQuotaError(e) ? 'Your browser’s storage is full. Delete old scans in History and try again.' : errorText(e), photo);
        } else if (stage === 'read') {
          fail('Could not read this photo', errorText(e, 'Try another photo.'));
        } else {
          fail('Analysis failed', errorText(e, 'Something went wrong while analysing the photo.'), photo);
        }
      }
    })();
  }, []);

  const cancel = useCallback(() => {
    run.current++;
    setJob(undefined);
  }, []);

  return { job, start, cancel };
}
