import { describe, expect, it } from 'vitest';
import type { DetectedRegion, RegionMatch, ScanResult } from '../../model/types';
import { cellsForPlacement, currentPlacement, displayStatus, fitHintTexts, orderedCandidates, regionPassesFilter, scanStats } from './pieces';
import { composeScale, referenceResolution, sortIssues } from './quality';

function region(id: number, kind: DetectedRegion['kind'], shapeKind?: 'edge' | 'corner' | 'interior'): DetectedRegion {
  return {
    id, kind, bbox: { x: 0, y: 0, width: 1, height: 1 }, contour: [], area: 1, touchesBorder: false, orientationDeg: 0, issues: [],
    shape: shapeKind ? ({ kind: shapeKind } as DetectedRegion['shape']) : undefined,
  };
}
const place = (row: number, col: number, confidence = 0.5) => ({ row, col, x: 0, y: 0, rotationDeg: 0, score: 0, confidence });

const result: ScanResult = {
  width: 100, height: 100, timings: {}, quality: { score: 1, issues: [], metrics: {} },
  regions: [region(1, 'piece', 'interior'), region(2, 'piece', 'edge'), region(3, 'patch'), region(4, 'piece')],
  matches: [
    { regionId: 1, status: 'confident', candidates: [place(1, 1, 0.9), place(2, 2, 0.2)] },
    { regionId: 2, status: 'ambiguous', candidates: [place(0, 3)] },
    { regionId: 3, status: 'confident', candidates: [place(4, 4, 0.8)], coveredCells: [{ row: 4, col: 4 }, { row: 4, col: 5 }] },
    { regionId: 4, status: 'unmatched', candidates: [] },
  ],
  fits: [
    { a: 1, b: 2, sideA: 'right', sideB: 'left', confidence: 0.8, reason: 'location' },
    { a: 1, b: 3, sideA: 'top', sideB: 'bottom', confidence: 0.3, reason: 'shape' },
  ],
};

describe('scan result helpers', () => {
  it('derives display status', () => {
    expect(displayStatus(result.regions[0], result.matches[0])).toBe('confident');
    expect(displayStatus(result.regions[2], result.matches[2])).toBe('patch');
    expect(displayStatus(result.regions[3], result.matches[3])).toBe('unmatched');
    expect(displayStatus(result.regions[3], undefined)).toBe('unmatched');
  });

  it('promotes the next candidate after rejection', () => {
    const m = result.matches[0];
    expect(currentPlacement(m, 0)?.row).toBe(1);
    expect(currentPlacement(m, 1)?.row).toBe(2);
    expect(currentPlacement(m, 2)).toBeUndefined();
    expect(orderedCandidates(m, 1).map((c) => c.row)).toEqual([2, 1]);
  });

  it('shifts covered cells of patches', () => {
    const m: RegionMatch = result.matches[2];
    expect(cellsForPlacement(m, m.candidates[0])).toEqual([{ row: 4, col: 4 }, { row: 4, col: 5 }]);
    expect(cellsForPlacement(m, place(1, 1))).toEqual([{ row: 1, col: 1 }, { row: 1, col: 2 }]);
    expect(cellsForPlacement(result.matches[0], place(7, 8))).toEqual([{ row: 7, col: 8 }]);
  });

  it('filters', () => {
    expect(regionPassesFilter(result.regions[1], result.matches[1], 'edges')).toBe(true);
    expect(regionPassesFilter(result.regions[0], result.matches[0], 'edges')).toBe(false);
    expect(regionPassesFilter(result.regions[3], result.matches[3], 'unmatched')).toBe(true);
  });

  it('counts', () => {
    expect(scanStats(result)).toEqual({ regions: 4, pieces: 3, patches: 1, confident: 2, ambiguous: 1, unmatched: 1, edges: 1 });
  });

  it('describes fits from both sides', () => {
    expect(fitHintTexts(1, result)).toEqual(['Fits #2 on its right side', 'Attaches to patch #3 at its top (maybe)']);
    expect(fitHintTexts(2, result)).toEqual(['Fits #1 on its left side']);
  });
});

describe('quality helpers', () => {
  it('sorts issues by severity', () => {
    const issues = sortIssues([
      { code: 'glare', severity: 'info', message: 'a' },
      { code: 'blurry', severity: 'error', message: 'b' },
      { code: 'too_dark', severity: 'warning', message: 'c' },
    ]);
    expect(issues.map((i) => i.message)).toEqual(['b', 'c', 'a']);
  });
  it('rates reference resolution', () => {
    expect(referenceResolution(1000, 700, { rows: 27, cols: 38 })).toMatchObject({ pxPerCell: 25, level: 'low' });
    expect(referenceResolution(2000, 1400, { rows: 27, cols: 38 }).level).toBe('ok');
    expect(referenceResolution(3000, 2000, { rows: 10, cols: 15 })).toEqual({ pxPerCell: 200, level: 'good' });
  });
  it('picks a compose scale', () => {
    expect(composeScale([], 1000)).toBe(1);
    expect(composeScale([2, 2.5, 5], 1000)).toBe(2.5);
    expect(composeScale([5, 6], 1000)).toBe(3);
    expect(composeScale([2.5], 4000)).toBe(1.5);
  });
});
