import { describe, expect, it } from 'vitest';
import type { DetectedRegion, Placement, RegionMatch, ScanResult } from '../../model/types';
import { boundsOf, buildScanItems, cellsText, isHiddenRegion, itemCounts, linkedTo, placingOrder, type ScanItem, touchingSides, nextFreeCandidate } from './items';

const grid = { rows: 8, cols: 10 };

function region(id: number, kind: DetectedRegion['kind'] = 'piece', x = id * 100, shapeKind?: 'edge' | 'corner' | 'interior'): DetectedRegion {
  return {
    id,
    kind,
    bbox: { x, y: 0, width: 50, height: 50 },
    contour: [{ x, y: 0 }, { x: x + 50, y: 0 }, { x: x + 50, y: 50 }, { x, y: 50 }],
    area: 2500,
    touchesBorder: false,
    orientationDeg: 0,
    issues: [],
    shape: shapeKind ? ({ kind: shapeKind, center: { x: x + 25, y: 25 }, bodySize: 50 } as DetectedRegion['shape']) : undefined,
  };
}
const place = (row: number, col: number, confidence = 0.9, rotationDeg = 0): Placement => ({ row, col, x: col * 10 + 5, y: row * 10 + 5, rotationDeg, score: 0, confidence });
const match = (regionId: number, status: RegionMatch['status'], candidates: Placement[], coveredCells?: RegionMatch['coveredCells']): RegionMatch => ({ regionId, status, candidates, coveredCells });

function scan(partial: Partial<ScanResult>): ScanResult {
  return { width: 1000, height: 500, regions: [], matches: [], fits: [], quality: { score: 1, issues: [], metrics: {} }, timings: {}, ...partial };
}

describe('hide rules', () => {
  it('hides unmatched, candidate-less and unknown regions', () => {
    expect(isHiddenRegion(region(1), match(1, 'unmatched', [place(0, 0, 0.1)]))).toBe(true);
    expect(isHiddenRegion(region(1), match(1, 'ambiguous', []))).toBe(true);
    expect(isHiddenRegion(region(1), undefined)).toBe(true);
    expect(isHiddenRegion(region(1, 'unknown'), match(1, 'confident', [place(0, 0)]))).toBe(true);
    expect(isHiddenRegion(region(1), match(1, 'ambiguous', [place(0, 0, 0.4)]))).toBe(false);
  });

  it('keeps hidden regions out of items and counts', () => {
    const r = buildScanItems(
      scan({
        regions: [region(1), region(2), region(3, 'unknown')],
        matches: [match(1, 'confident', [place(2, 2)]), match(2, 'unmatched', [place(3, 3, 0.1)]), match(3, 'confident', [place(4, 4)])],
      }),
      grid,
    );
    expect(r.items.map((i) => i.key)).toEqual(['r1']);
    expect(r.hiddenRegionIds).toEqual([2, 3]);
    expect(itemCounts(r.items)).toEqual({ items: 1, pieces: 1, assembled: 0, unsure: 0 });
  });
});

describe('assembled groups', () => {
  const result = scan({
    regions: [region(1), region(2), region(3), region(4, 'patch')],
    matches: [
      match(1, 'unmatched', []), // member of an assembled group: shown through the group
      match(2, 'confident', [place(1, 1)]),
      match(3, 'ambiguous', [place(5, 5, 0.5)]),
      match(4, 'confident', [place(6, 6)], [{ row: 6, col: 6 }, { row: 6, col: 7 }]),
    ],
    groups: [
      {
        id: 1,
        kind: 'assembled',
        regionIds: [2, 1],
        cells: [{ row: 1, col: 1 }, { row: 1, col: 2 }],
        bounds: { row0: 1, col0: 1, row1: 1, col1: 2 },
        rotationDeg: 90,
        x: 20,
        y: 15,
        confidence: 0.8,
      },
      { id: 2, kind: 'assembled', regionIds: [4], cells: [{ row: 6, col: 6 }, { row: 6, col: 7 }], bounds: { row0: 6, col0: 6, row1: 6, col1: 7 }, x: 70, y: 65, confidence: 0.4 },
    ],
  });
  const r = buildScanItems(result, grid);

  it('makes one item per group with one badge (smallest member id)', () => {
    const g = r.items.find((i) => i.key === 'g1')!;
    expect(g).toMatchObject({ kind: 'assembled', label: 1, regionIds: [2, 1], pieceCount: 2, status: 'confident' });
    expect(g.candidates).toHaveLength(1);
    expect(g.candidates[0]).toMatchObject({ rotationDeg: 90, x: 20, y: 15 });
    expect(r.items.some((i) => i.key === 'r1' || i.key === 'r2')).toBe(false);
  });

  it('uses confidence for the group status and keeps other pieces', () => {
    expect(r.items.find((i) => i.key === 'g2')!.status).toBe('ambiguous');
    expect(r.items.find((i) => i.key === 'r3')!.status).toBe('ambiguous');
    expect(itemCounts(r.items)).toEqual({ items: 3, pieces: 5, assembled: 2, unsure: 2 });
  });

  it('treats patches of older scans (no groups) as assembled items', () => {
    const old = buildScanItems({ ...result, groups: undefined }, grid);
    const p = old.items.find((i) => i.key === 'r4')!;
    expect(p).toMatchObject({ kind: 'assembled', pieceCount: 2 });
    expect(p.candidates[0].bounds).toEqual({ row0: 6, col0: 6, row1: 6, col1: 7 });
  });
});

describe('neighbour links', () => {
  it('links adjacent members of neighbour groups', () => {
    const r = buildScanItems(
      scan({
        regions: [region(1), region(2), region(3)],
        matches: [match(1, 'confident', [place(2, 2)]), match(2, 'confident', [place(2, 3)]), match(3, 'confident', [place(2, 4)])],
        groups: [{ id: 1, kind: 'neighbors', regionIds: [1, 2, 3], cells: [], bounds: { row0: 2, col0: 2, row1: 2, col1: 4 }, x: 0, y: 0, confidence: 0.7 }],
      }),
      grid,
    );
    expect(r.links.map((l) => `${l.a}-${l.b}`)).toEqual(['r1-r2', 'r2-r3']);
    expect(linkedTo('r2', r.links).sort()).toEqual(['r1', 'r3']);
  });

  it('falls back to location fits for scans without groups, ignoring hidden regions', () => {
    const r = buildScanItems(
      scan({
        regions: [region(1), region(2), region(3)],
        matches: [match(1, 'confident', [place(2, 2)]), match(2, 'confident', [place(2, 3)]), match(3, 'unmatched', [])],
        fits: [
          { a: 1, b: 2, sideA: 'right', sideB: 'left', confidence: 0.8, reason: 'location' },
          { a: 2, b: 3, sideA: 'right', sideB: 'left', confidence: 0.8, reason: 'location' },
          { a: 1, b: 2, sideA: 'top', sideB: 'bottom', confidence: 0.9, reason: 'shape' },
        ],
      }),
      grid,
    );
    expect(r.links).toEqual([{ a: 'r1', b: 'r2', source: 'fit', sideA: 'right', sideB: 'left' }]);
  });

  it('does not use fits when the scan has groups', () => {
    const r = buildScanItems(
      scan({
        regions: [region(1), region(2)],
        matches: [match(1, 'confident', [place(2, 2)]), match(2, 'confident', [place(2, 3)])],
        fits: [{ a: 1, b: 2, sideA: 'right', sideB: 'left', confidence: 0.8, reason: 'location' }],
        groups: [],
      }),
      grid,
    );
    expect(r.links).toEqual([]);
  });
});

describe('placing order', () => {
  const item = (key: string, kind: ScanItem['kind'], status: ScanItem['status'], row: number, col: number): ScanItem => ({
    key,
    kind,
    label: Number(key.slice(1)),
    regionIds: [Number(key.slice(1))],
    pieceCount: 1,
    status,
    candidates: [{ cells: [{ row, col }], bounds: boundsOf([{ row, col }]), x: 0, y: 0, confidence: 0.9 }],
    center: { x: 0, y: 0 },
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    edge: false,
  });

  it('places assembled grids first, then confident pieces, then unsure ones', () => {
    const items = [item('r1', 'piece', 'ambiguous', 0, 0), item('r2', 'piece', 'confident', 7, 9), item('g3', 'assembled', 'confident', 4, 4)];
    expect(placingOrder(items, [], grid).map((i) => i.key)).toEqual(['g3', 'r2', 'r1']);
  });

  it('sweeps across the picture in a serpentine', () => {
    // 8 rows → bands of 2 rows: band 0 left→right, band 1 right→left, …
    const items = [item('r1', 'piece', 'confident', 0, 9), item('r2', 'piece', 'confident', 1, 0), item('r3', 'piece', 'confident', 2, 1), item('r4', 'piece', 'confident', 3, 8), item('r5', 'piece', 'confident', 4, 5)];
    expect(placingOrder(items, [], grid).map((i) => i.key)).toEqual(['r2', 'r1', 'r4', 'r3', 'r5']);
  });

  it('keeps linked neighbours consecutive and skips placed items', () => {
    const items = [item('r1', 'piece', 'confident', 0, 0), item('r2', 'piece', 'confident', 0, 5), item('r3', 'piece', 'ambiguous', 7, 0), item('r4', 'piece', 'confident', 0, 2)];
    const links = [{ a: 'r1', b: 'r3', source: 'group' as const }];
    expect(placingOrder(items, links, grid).map((i) => i.key)).toEqual(['r1', 'r3', 'r4', 'r2']);
    expect(placingOrder(items, links, grid, (i) => i.key === 'r1').map((i) => i.key)).toEqual(['r4', 'r2', 'r3']);
  });
});

describe('texts', () => {
  it('describes single cells and ranges', () => {
    expect(cellsText({ cells: [], bounds: { row0: 4, col0: 11, row1: 4, col1: 11 }, x: 0, y: 0, confidence: 1 })).toBe('row 5, column 12');
    expect(cellsText({ cells: [], bounds: { row0: 2, col0: 4, row1: 3, col1: 6 }, x: 0, y: 0, confidence: 1 })).toBe('rows 3–4, columns 5–7');
  });
});

describe('placed candidate', () => {
  it('finds the candidate this scan placed for an item', async () => {
    const { placedCandidateIndex } = await import('../screens/scan/useScanModel');
    const item = {
      key: 'r3', kind: 'piece', label: 3, regionIds: [3], pieceCount: 1, status: 'ambiguous',
      candidates: [
        { cells: [{ row: 1, col: 1 }], bounds: boundsOf([{ row: 1, col: 1 }]), x: 0, y: 0, confidence: 0.5 },
        { cells: [{ row: 4, col: 4 }], bounds: boundsOf([{ row: 4, col: 4 }]), x: 0, y: 0, confidence: 0.4 },
      ],
      center: { x: 0, y: 0 }, bbox: { x: 0, y: 0, width: 1, height: 1 }, edge: false,
    } as ScanItem;
    const progress = { puzzleId: 'p', updatedAt: 0, placed: { '4,4': { at: 1, scanId: 's', regionId: 3 } } };
    expect(placedCandidateIndex(item, progress, 's')).toBe(1);
    expect(placedCandidateIndex(item, progress, 'other')).toBe(-1);
    expect(placedCandidateIndex(item, { ...progress, placed: {} }, 's')).toBe(-1);
  });
});

describe('touchingSides', () => {
  it('names the sides through which adjacent cells touch', () => {
    expect(touchingSides([{ row: 3, col: 4 }], [{ row: 3, col: 5 }])).toEqual({ sideA: 'right', sideB: 'left' });
    expect(touchingSides([{ row: 3, col: 4 }], [{ row: 2, col: 4 }])).toEqual({ sideA: 'top', sideB: 'bottom' });
    expect(touchingSides([{ row: 3, col: 4 }], [{ row: 5, col: 4 }])).toBeUndefined();
  });
});

describe('nextFreeCandidate', () => {
  const cand = (row: number, col: number) => ({ cells: [{ row, col }], bounds: { row0: row, col0: col, row1: row, col1: col }, x: 0, y: 0, confidence: 0.3 });
  const item = { key: 'r5', kind: 'piece', label: 5, regionIds: [5], pieceCount: 1, status: 'ambiguous', candidates: [cand(0, 0), cand(1, 1), cand(2, 2), cand(3, 3)], center: { x: 0, y: 0 }, bbox: { x: 0, y: 0, width: 1, height: 1 }, edge: false } as ScanItem;
  const progress = { puzzleId: 'p', updatedAt: 0, placed: { '1,1': { at: 1, scanId: 'other', regionId: 2 } } };
  it('skips cells placed by other pieces and cells other items point at', () => {
    expect(nextFreeCandidate(item, 0, progress, 's', new Set())).toBe(2);
    expect(nextFreeCandidate(item, 0, progress, 's', new Set(['2,2']))).toBe(3);
    expect(nextFreeCandidate(item, 0, progress, 's', new Set(['2,2', '3,3']))).toBe(-1);
  });
  it('treats cells this piece itself placed as free', () => {
    const own = { ...progress, placed: { '1,1': { at: 1, scanId: 's', regionId: 5 } } };
    expect(nextFreeCandidate(item, 0, own, 's', new Set())).toBe(1);
  });
});
