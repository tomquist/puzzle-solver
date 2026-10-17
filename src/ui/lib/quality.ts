/** Quality-report helpers for display (pure). */
import type { GridSpec, QualityIssue, Severity } from '../../model/types';
import { MAX_CANVAS_AREA } from '../../platform/imageSize';

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then infos (stable within a severity). */
export function sortIssues(issues: QualityIssue[]): QualityIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => RANK[a.issue.severity] - RANK[b.issue.severity] || a.i - b.i)
    .map((x) => x.issue);
}

export function worstSeverity(issues: QualityIssue[]): Severity | undefined {
  let worst: Severity | undefined;
  for (const i of issues) if (!worst || RANK[i.severity] < RANK[worst]) worst = i.severity;
  return worst;
}

/** Minimum reference pixels per cell for reliable matching; below this close-ups are suggested. */
export const MIN_PX_PER_CELL = 40;
export const GOOD_PX_PER_CELL = 64;

export interface ReferenceResolution {
  pxPerCell: number;
  level: 'good' | 'ok' | 'low';
  issue?: QualityIssue;
}

/** How many reference pixels each grid cell gets, and whether close-ups would help. */
export function referenceResolution(width: number, height: number, grid: GridSpec): ReferenceResolution {
  const pxPerCell = Math.floor(Math.min(width / Math.max(1, grid.cols), height / Math.max(1, grid.rows)));
  if (pxPerCell < MIN_PX_PER_CELL) {
    return {
      pxPerCell,
      level: 'low',
      issue: {
        code: 'reference_low_resolution',
        severity: 'warning',
        message: `Only ${pxPerCell} px per piece in the reference picture.`,
        hint: 'Add a few close-up photos of the box picture to make it sharper.',
      },
    };
  }
  if (pxPerCell < GOOD_PX_PER_CELL) {
    return {
      pxPerCell,
      level: 'ok',
      issue: {
        code: 'reference_low_resolution',
        severity: 'info',
        message: `${pxPerCell} px per piece – usable.`,
        hint: 'Close-ups of busy areas can still improve matching.',
      },
    };
  }
  return { pxPerCell, level: 'good' };
}

/**
 * Upscale factor for "Build sharper picture" from the close-ups' resolution gains: the median
 * gain, at most 3×, and small enough that the result stays within `maxSide` and `maxArea` (the
 * iOS canvas limit, so the picture can still be encoded and decoded on phones).
 */
export function composeScale(gains: number[], width: number, height: number, maxSide = 6000, maxArea = MAX_CANVAS_AREA): number {
  if (gains.length === 0) return 1;
  const sorted = [...gains].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const sideLimit = maxSide / Math.max(1, width, height);
  const areaLimit = Math.sqrt(maxArea / Math.max(1, width * height));
  return Math.max(1, Math.min(3, median, sideLimit, areaLimit));
}
