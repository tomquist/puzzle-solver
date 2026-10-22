/**
 * The puzzle's running scan analysis, owned by PuzzleProvider so it survives switching tabs: decode
 * the photo → make sure the matcher has the reference → pipeline.analyzeScan (progress) → save the
 * ScanRecord → open its result; its cell-size measurement for the grid belief follows in the
 * background (lib/gridMeasurements.ts). Prepare-to-save runs in the puzzle's lane
 * (lib/puzzleLane.ts), so a grid change never overlaps a scan.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../../appVersion';
import type { CaptureInfo, ProgressRecord, PuzzleRecord, ScanRecord } from '../../model/types';
import { blobToRGBA, decodeExact, isQuotaError, rgbaToBlob } from '../../platform/imageio';
import { SCAN_ANALYSIS_SIDE } from '../../platform/photoSettings';
import { newId, type PuzzleRepository } from '../../storage/types';
import type { PipelineApi } from '../../worker/api';
import { errorText } from '../components/Feedback';
import { navigate } from './useHashRoute';
import { placedCells } from '../lib/progress';
import { gridProbeFor } from './useGridBelief';
import { analysingScan, dropStaleMeasurements, queueGridMeasurement, setMeasurementTarget } from '../lib/gridMeasurements';
import { inPuzzleLane } from '../lib/puzzleLane';
import { href } from '../lib/routes';

/** Longest side scan photos are analysed and stored at (the pipeline's default analysis size). */
const SCAN_MAX_SIDE = SCAN_ANALYSIS_SIDE;

export type ScanJob =
  | { kind: 'running'; progress: number; message: string }
  | { kind: 'error'; title: string; message: string; photo?: Blob; capture?: CaptureInfo };

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
  /** The latest record (ahead of React state; see PuzzleContext). */
  getPuzzle(): PuzzleRecord | undefined;
  progress(): ProgressRecord | undefined;
  ensureMatcher(): Promise<void>;
  scansChanged(): void;
}

export function useScanJob(deps: ScanJobDeps): { job: ScanJob | undefined; start(photo: Blob, capture?: CaptureInfo): void; cancel(): void } {
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

  // The measurements' results reach this puzzle's belief through scansChanged.
  useEffect(() => {
    setMeasurementTarget({
      repo: deps.repo,
      pipeline: deps.pipeline,
      changed: (puzzleId) => {
        if (mounted.current && latest.current.puzzle?.id === puzzleId) latest.current.scansChanged();
      },
    });
  }, [deps.repo, deps.pipeline]);

  // Measurements lost with a reload.
  const puzzleId = deps.puzzle?.id;
  useEffect(() => {
    if (!puzzleId) return;
    void dropStaleMeasurements(latest.current.repo, puzzleId).then((changed) => changed && latest.current.scansChanged());
  }, [puzzleId]);

  const start = useCallback((photo: Blob, capture?: CaptureInfo) => {
    const { repo, pipeline, puzzle: shown, getPuzzle, progress, ensureMatcher, scansChanged } = latest.current;
    if (!shown) return;
    const puzzleId = shown.id;
    const myRun = ++run.current;
    const alive = () => run.current === myRun && mounted.current;
    const working = (p: number, message: string) => {
      if (alive()) setJob({ kind: 'running', progress: p, message });
    };
    const fail = (title: string, message: string, retry?: Blob) => {
      if (alive()) setJob({ kind: 'error', title, message, ...(retry ? { photo: retry, capture } : {}) });
    };
    void (async () => {
      working(0.01, 'Reading photo…');
      // Where it failed (set inside the lane's callback too, hence an object).
      const at: { stage: 'read' | 'prepare' | 'analyse' | 'save' } = { stage: 'read' };
      try {
        // The photo is analysed at the size the pipeline works at, as the JPEG that is stored: encode
        // once and analyse the decoded JPEG, so the stored photo (and a feedback file made from it)
        // holds exactly the pixels the analysis saw.
        const source: { width?: number; height?: number } = {};
        const jpeg = await rgbaToBlob(await blobToRGBA(photo, SCAN_MAX_SIDE, undefined, source), 'image/jpeg', 0.95);
        // How the photo was taken, with its own size (a file: as chosen; the camera: as captured).
        const captured: CaptureInfo = { ...(capture ?? { method: 'file' }), ...(source.width && source.height ? { width: source.width, height: source.height } : {}) };
        const rgba = await decodeExact(jpeg);
        at.stage = 'prepare';
        working(0.02, 'Preparing the puzzle picture…');
        // In the puzzle's lane: a grid change waits for this scan to be saved (and then carries it
        // over), and a scan asked for during a grid change is analysed with the new grid.
        const saved = await inPuzzleLane(puzzleId, async () => {
          await ensureMatcher();
          const puzzle = getPuzzle();
          if (!puzzle || puzzle.id !== puzzleId) throw new Error('The puzzle is not open.');
          at.stage = 'analyse';
          // While the grid is not confirmed, the scan also measures cells far from the grid's size.
          const gridProbe = gridProbeFor(puzzle);
          const resp = await analysingScan(() =>
            pipeline.analyzeScan(puzzleId, rgba, { placedCells: placedCells(progress(), puzzle.grid), gridProbe }, (e) =>
              working(0.03 + e.progress * 0.9, e.message ?? STAGE_LABEL[e.stage] ?? 'Analysing…'),
            ),
          );
          if (run.current !== myRun) return undefined; // cancelled
          at.stage = 'save';
          working(0.95, 'Saving scan…');
          const photoBlobId = await repo.putBlob(jpeg);
          const scan: ScanRecord = {
            id: newId(),
            puzzleId,
            createdAt: Date.now(),
            photoBlobId,
            width: resp.result.width,
            height: resp.result.height,
            result: resp.result,
            appVersion: APP_VERSION,
            capture: captured,
          };
          await repo.saveScan(scan);
          if (resp.gridFollowUp) queueGridMeasurement(resp.gridFollowUp, scan.id, puzzleId);
          return scan;
        });
        if (!saved) return;
        scansChanged();
        if (!alive()) return;
        setJob(undefined);
        // Open the result if the user is still somewhere in this puzzle.
        if (location.hash.startsWith(href.puzzle(puzzleId))) navigate(href.scan(puzzleId, saved.id));
      } catch (e) {
        if (at.stage === 'save') {
          fail('Could not save the scan', isQuotaError(e) ? 'Your browser’s storage is full. Delete old scans in History and try again.' : errorText(e), photo);
        } else if (at.stage === 'read') {
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
