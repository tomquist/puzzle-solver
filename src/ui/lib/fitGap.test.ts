/**
 * Docking into a gap of an assembled patch: a hole inside the block (all four neighbours in the
 * patch – no outer rim at the joining side) and a notch of its outline.
 */
import { describe, expect, it } from 'vitest';
import type { Point } from '../../cv/geometry';
import type { CellRef, DetectedRegion, GridSpec, ScanResult } from '../../model/types';
import gap from './__fixtures__/fit-inner-gap.json';
import { cellItemOf, cellPoint, scaleAspect, type CellScale } from './cellSpots';
import { fitPose, type FitItem } from './fit';
import { buildScanItems } from './items';
import { cellSize, sideVector } from './overlay';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('feedback 2026-10-23-2357: piece #13 into the hole of patch #3', () => {
  // Patch #3 covers 14 cells around r25c40 (r24c40 above, r25c39 / r25c41 beside, r26c40 below),
  // turned ≈ 181.6°; piece #13 belongs in that hole. Where the hole lies in the photo, measured on
  // the scan photo: the table showing through it inside #3's outline is a 12.4k px blob (one
  // piece) with its centroid at (354.5, 980.1), its box x 284–429, y 915–1051. The hole has the
  // shape of #13, so its centroid is where #13's outline centre (its pivot) belongs.
  const hole = { x: 354.5, y: 980.1 };
  const result = { ...gap, width: gap.photo.width, height: gap.photo.height } as unknown as ScanResult;
  const grid = gap.grid as GridSpec;
  const scale: CellScale = { refCell: cellSize(grid, gap.reference.width, gap.reference.height), bodySize: gap.medianBodySize };
  const aspect = scaleAspect(scale);
  const regions = new Map(result.regions.map((r) => [r.id, r as DetectedRegion]));
  const { items } = buildScanItems(result, grid);
  const fitItem = (key: string): FitItem => {
    const item = items.find((i) => i.key === key)!;
    return { ...cellItemOf(item, item.candidates[0], regions, scale)!, key, label: item.label, pieces: item.pieceCount };
  };
  const patch = fitItem('g1');
  const piece = fitItem('r13');

  it('is a hole in the patch: all four neighbours are covered', () => {
    const has = (row: number, col: number) => patch.cells.some((c) => c.row === row && c.col === col);
    expect(has(25, 40)).toBe(false);
    expect([has(24, 40), has(26, 40), has(25, 39), has(25, 41)]).toEqual([true, true, true, true]);
  });

  it('docks #13 in the hole, not half a cell off', () => {
    const pose = fitPose(patch, piece, aspect)!;
    expect(pose.mover).toBe('b');
    expect(pose.moverCell).toEqual({ row: 25, col: 40 });
    expect(pose.anchorCell).toEqual({ row: 24, col: 40 });
    expect(pose.side).toBe('bottom');
    // About 125 px per cell here: within a seventh of a cell.
    expect(dist(pose.docked, hole)).toBeLessThan(18);
    // The cell of the hole in the patch's own cells, too.
    expect(dist(cellPoint(patch, { row: 25, col: 40 }, aspect), hole)).toBeLessThan(18);
  });
});

/** A patch lying in the photo: puzzle (row, col) → photo, cell centres at whole numbers. */
function frame(origin: Point, rotationDeg: number, px: number) {
  const right = sideVector('right', rotationDeg);
  const down = sideVector('bottom', rotationDeg);
  return (row: number, col: number): Point => ({ x: origin.x + (right.x * col + down.x * row) * px, y: origin.y + (right.y * col + down.y * row) * px });
}

describe('gaps of a synthetic patch, its size and centre only roughly known', () => {
  // A 5 × 6 block turned 184.5°, 100 px per cell, with a hole at (2, 2) (not in the outline: it
  // only shows the table) and a notch at (0, 5) (in the outline). The scan's pieces say 93 px per
  // cell and the matcher's point is a fifth of a cell off: 2 cells out that drifts by ~0.3 cell.
  const rot = 184.5;
  const at = frame({ x: 2000, y: 1500 }, rot, 100);
  const cells: CellRef[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 6; col++) if (!(row === 2 && col === 2) && !(row === 0 && col === 5)) cells.push({ row, col });
  const outline = [
    [-0.5, -0.5],
    [-0.5, 4.5],
    [0.5, 4.5],
    [0.5, 5.5],
    [4.5, 5.5],
    [4.5, -0.5],
  ].map(([r, c]) => at(r, c));
  const patch: FitItem = {
    key: 'g1',
    label: 1,
    pieces: cells.length,
    center: { x: 0, y: 0 },
    cells,
    rotationDeg: rot,
    cellPx: 93,
    anchors: [{ at: at(2, 2.5), row: 2.2, col: 2.6 }],
    outlines: [outline],
  };
  const pieceAt = (row: number, col: number): FitItem => ({
    key: 'r9',
    label: 9,
    pieces: 1,
    center: { x: 300, y: 300 },
    cells: [{ row, col }],
    rotationDeg: 10,
    cellPx: 100,
    anchors: [{ at: { x: 300, y: 300 }, row, col, exact: true }],
  });

  it('drifts without the outline', () => {
    const pose = fitPose({ ...patch, outlines: undefined }, pieceAt(2, 2), 1)!;
    expect(dist(pose.docked, at(2, 2))).toBeGreaterThan(15);
  });

  it('docks into the hole from any side', () => {
    // The piece docks against the first neighbour in the patch's cell list: put each one first.
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const first = (c: CellRef) => c.row === 2 + dr && c.col === 2 + dc;
      const pose = fitPose({ ...patch, cells: [...cells.filter(first), ...cells.filter((c) => !first(c))] }, pieceAt(2, 2), 1)!;
      expect(pose.anchorCell).toEqual({ row: 2 + dr, col: 2 + dc });
      expect(dist(pose.docked, at(2, 2))).toBeLessThan(8);
    }
  });

  it('docks into the notch of the outline', () => {
    const pose = fitPose(patch, pieceAt(0, 5), 1)!;
    expect(dist(pose.docked, at(0, 5))).toBeLessThan(8);
  });
});
