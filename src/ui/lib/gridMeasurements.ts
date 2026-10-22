/**
 * The scans' cell-size measurements for the grid belief, after their results are shown
 * (AnalyzeResponse.gridFollowUp): a queue, oldest first, whose steps run on the worker while no scan
 * is analysed (a new scan's result goes first; it waits at most one step), each result saved into
 * its scan. Module-wide: the queue outlives the puzzle's screens (leaving the puzzle right after a
 * scan does not lose its measurement); only a reload does (see {@link dropStaleMeasurements}).
 */
import type { GridEvidence, ScanResult } from '../../model/types';
import type { PuzzleRepository } from '../../storage/types';
import type { PipelineApi } from '../../worker/api';

/** `result` with its cell-size evidence (none: the placeholder removed). */
function withEvidence(result: ScanResult, evidence: GridEvidence | undefined): ScanResult {
  const { gridEvidence: _old, ...rest } = result;
  void _old;
  return evidence ? { ...rest, gridEvidence: evidence } : rest;
}

const measuring = {
  queue: [] as { token: string; scanId: string; puzzleId: string }[],
  /** Scan analyses running: the queue waits for them. */
  analysing: 0,
  pumping: false,
  deps: undefined as { repo: PuzzleRepository; pipeline: PipelineApi; changed(puzzleId: string): void } | undefined,
};

/**
 * Measure a saved scan's cell size in the background (AnalyzeResponse.gridFollowUp); replaces a
 * measurement of the same scan still waiting (the scan was re-analysed).
 */
export function queueGridMeasurement(token: string, scanId: string, puzzleId: string): void {
  measuring.queue = measuring.queue.filter((m) => m.scanId !== scanId);
  measuring.queue.push({ token, scanId, puzzleId });
  void pumpMeasurements();
}

/** A scan analysis (the queued measurements wait for it, so it gets the worker first). */
export async function analysingScan<T>(work: () => Promise<T>): Promise<T> {
  measuring.analysing++;
  try {
    return await work();
  } finally {
    measuring.analysing--;
    void pumpMeasurements();
  }
}

/** Before a run of steps: the result screen's first render. */
const FIRST_STEP_DELAY_MS = 1000;

/** Wait for the page to be idle (and, before the first step, for the result to be shown). */
function breathe(first: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const idle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 250 }) : setTimeout(resolve, 0));
    setTimeout(idle, first ? FIRST_STEP_DELAY_MS : 0);
  });
}

/** Run the queued measurements' steps while no scan is analysed; save each result into its scan. */
async function pumpMeasurements(): Promise<void> {
  if (measuring.pumping) return;
  measuring.pumping = true;
  try {
    let first = true;
    for (;;) {
      // Let the page breathe first: the new result is on screen before the first step, and the
      // main thread idles between steps. With the pipeline in the worker this costs nothing; with
      // it on the main thread (?pipeline=local) a step blocks the page, and without this they
      // would run back to back in microtasks, ahead of the result.
      await breathe(first);
      first = false;
      if (measuring.queue.length === 0 || measuring.analysing > 0 || !measuring.deps) break;
      const { repo, pipeline, changed } = measuring.deps;
      const m = measuring.queue[0];
      const step = await pipeline.gridFollowUpStep(m.token).catch(() => ({ done: true as const, evidence: undefined }));
      if (!step.done) continue;
      const replaced = !measuring.queue.includes(m);
      measuring.queue = measuring.queue.filter((x) => x !== m);
      if (replaced) continue;
      // Only into the scan as it was saved (re-analysed meanwhile: its own evidence stands).
      const saved = await repo.updateScan(m.scanId, (scan) => (scan.result.gridEvidence?.pending ? { ...scan, result: withEvidence(scan.result, step.evidence) } : undefined));
      if (saved) changed(m.puzzleId);
    }
  } finally {
    measuring.pumping = false;
  }
}

/** Where the measurements are saved and announced (the open puzzle's provider sets it). */
export function setMeasurementTarget(deps: { repo: PuzzleRepository; pipeline: PipelineApi; changed(puzzleId: string): void }): void {
  measuring.deps = deps;
  void pumpMeasurements();
}

/**
 * Scans of `puzzleId` whose measurement cannot finish any more (the app was closed while it
 * waited) count by their placements' positions, as scans from before the measurement. True when
 * any changed.
 */
export async function dropStaleMeasurements(repo: PuzzleRepository, puzzleId: string): Promise<boolean> {
  if (measuring.analysing > 0) return false;
  let changed = false;
  for (const scan of await repo.listScans(puzzleId)) {
    if (!scan.result.gridEvidence?.pending || measuring.queue.some((m) => m.scanId === scan.id)) continue;
    const saved = await repo.updateScan(scan.id, (cur) => (cur.result.gridEvidence?.pending ? { ...cur, result: withEvidence(cur.result, undefined) } : undefined));
    changed ||= !!saved;
  }
  return changed;
}
