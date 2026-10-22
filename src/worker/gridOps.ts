/**
 * The grid belief and the grid remap as PipelineApi operations (shared by the real pipeline and the
 * mock): pure functions, run in the worker because weighing many scans' evidence takes a moment.
 */
import { assessGrid, decideGrid, type GridContext } from '../pipeline/gridBelief';
import { remapProgress, remapScanResult } from '../pipeline/remap';
import type { GridVerdict, RemapRequest, RemapResponse } from './api';

export function gridVerdict(ctx: GridContext): GridVerdict {
  const a = assessGrid(ctx);
  const best = a.ranked[0];
  return { decision: decideGrid(ctx, a), best: best.grid, odds: Math.exp(best.logPost - a.currentLogPost), w: a.w, h: a.h, scans: a.scans };
}

export function remapGrid(req: RemapRequest): RemapResponse {
  const scans = req.scans.map((s) => ({ id: s.id, ...remapScanResult(s.result, req.from, req.to, req.ref) }));
  const moved = remapProgress(req.progress, req.from, req.to, req.ref, { before: req.scans, after: scans });
  return { scans, progress: moved.progress, moved: moved.moved, dropped: moved.dropped };
}
