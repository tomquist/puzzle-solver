import { describe, expect, it } from 'vitest';
import type { Point } from '../../cv/geometry';
import type { CellRef, DetectedRegion } from '../../model/types';
import { cellItemOf, cellPoint, rimPoint, scaleAspect, type CellItem } from './cellSpots';
import { fitPose, type FitItem } from './fit';
import type { ScanItem } from './items';
import { sideVector } from './overlay';
import { itemRouteEnd } from './route';

/** A patch lying in the photo: puzzle (row, col) → photo, cell centres at whole numbers. */
function frame(origin: Point, rotationDeg: number, px: number) {
  const right = sideVector('right', rotationDeg);
  const down = sideVector('bottom', rotationDeg);
  return (row: number, col: number): Point => ({ x: origin.x + (right.x * col + down.x * row) * px, y: origin.y + (right.y * col + down.y * row) * px });
}

const block = (rows: number, cols: number, skip: string[] = []): CellRef[] =>
  Array.from({ length: rows * cols }, (_, i) => ({ row: Math.floor(i / cols), col: i % cols })).filter((c) => !skip.includes(`${c.row},${c.col}`));

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('cells of an item in the photo', () => {
  const cells = block(2, 2).map((c) => ({ row: c.row + 2, col: c.col + 2 }));
  it('offsets a cell from the centre along the puzzle axes without anchors', () => {
    const item: CellItem = { center: { x: 100, y: 100 }, cells, rotationDeg: 0, cellPx: 40 };
    // Upright: the bottom-right cell lies half a cell right and down of the centre.
    expect(cellPoint(item, { row: 3, col: 3 }, 1).x).toBeCloseTo(120, 6);
    expect(cellPoint(item, { row: 3, col: 3 }, 1).y).toBeCloseTo(120, 6);
    // A quarter turn clockwise needed: the puzzle's right points up, its bottom right.
    const q = cellPoint({ ...item, rotationDeg: 90 }, { row: 3, col: 3 }, 1);
    expect(q.x).toBeCloseTo(120, 6);
    expect(q.y).toBeCloseTo(80, 6);
  });

  it('steps from the nearest anchor', () => {
    const item: CellItem = {
      center: { x: 0, y: 0 },
      cells,
      rotationDeg: 0,
      cellPx: 40,
      anchors: [
        { at: { x: 500, y: 500 }, row: 2, col: 2, exact: true },
        { at: { x: 600, y: 520 }, row: 3, col: 3, exact: true },
      ],
    };
    expect(cellPoint(item, { row: 2, col: 2 }, 1)).toEqual({ x: 500, y: 500 });
    expect(cellPoint(item, { row: 3, col: 3 }, 1)).toEqual({ x: 600, y: 520 });
    // (2, 3) is as near to both: the first.
    expect(cellPoint(item, { row: 2, col: 3 }, 1)).toEqual({ x: 540, y: 500 });
  });
});

describe('a patch turned upside down (the fb24 case)', () => {
  // A 4 × 5 cell block turned 184.5°, 100 px per cell; the piece joins above cell (0, 3) – on the
  // far edge of the patch, which lies at the bottom of the photo. That side has a blank, a little
  // off the middle.
  const rot = 184.5;
  const at = frame({ x: 1000, y: 1000 }, rot, 100);
  const cells = block(4, 5);
  // The real outline (cell units, then the photo): the block, minus the blank in (0, 3)'s top side.
  const outline = [
    [-0.5, -0.5],
    [-0.5, 2.82],
    [-0.15, 2.82],
    [-0.15, 3.24],
    [-0.5, 3.24],
    [-0.5, 4.5],
    [3.5, 4.5],
    [3.5, -0.5],
  ].map(([r, c]) => at(r, c));
  const truth = at(0, 3);
  // What the photo alone suggests: the outline's centre as the cells' middle (here 0.15 of a cell
  // off – holes, notches and tabs move it) and √(area / cells), 6 % too big.
  const rough: FitItem = { key: 'g1', label: 10, pieces: 20, center: at(1.35, 2), cells, rotationDeg: rot, cellPx: 106 };
  const piece: FitItem = { key: 'r7', label: 7, pieces: 1, center: { x: 300, y: 300 }, cells: [{ row: -1, col: 3 }], rotationDeg: 221.4, cellPx: 100, anchors: [{ at: { x: 300, y: 300 }, row: -1, col: 3, exact: true }] };

  it('docks off by a quarter of a cell from the rough frame alone', () => {
    const pose = fitPose(piece, rough, 1)!;
    expect(pose.mover).toBe('a');
    expect(pose.anchorCell).toEqual({ row: 0, col: 3 });
    expect(pose.side).toBe('top');
    // Above in the puzzle = below in the photo here.
    expect(pose.docked.y).toBeGreaterThan(pose.anchorPoint.y);
    expect(dist(pose.docked, at(-1, 3))).toBeGreaterThan(25);
  });

  it('finds the real rim and the blank on the outline', () => {
    const pose = fitPose(piece, { ...rough, outlines: [outline] }, 1)!;
    // On the rim (the cell's depth is 106 px instead of 100: half of that off at most), centred on
    // the blank (3.03 – between 2.82 and 3.24).
    expect(dist(pose.anchorPoint, at(0.03, 3.03))).toBeLessThan(6);
    expect(dist(pose.docked, at(-1, 3.03))).toBeLessThan(10);
    expect(dist(pose.anchorPoint, truth)).toBeLessThan(8);
    expect(pose.rotateDeg).toBeCloseTo(36.9, 1);
  });

  it('keeps the plain cell point where no rim is found', () => {
    // The cell does not reach the outline's edge on that side (the outline is a whole cell bigger).
    const big = [at(-1.5, -0.5), at(-1.5, 4.5), at(3.5, 4.5), at(3.5, -0.5)];
    const item = { ...rough, outlines: [big] };
    expect(rimPoint(item, { row: 0, col: 3 }, 'top', 1)).toEqual(cellPoint(item, { row: 0, col: 3 }, 1));
  });

  it('docks a piece in a hole of the patch from where the matcher put it', () => {
    // Cell (2, 1) is missing; the matcher says the outline's centre is at row 1.5, col 2 of the
    // box, and the scan's pieces are 100 px.
    const holed = block(4, 5, ['2,1']);
    const region = { id: 10, kind: 'patch', contour: outline, area: 20 * 106 * 106, bbox: { x: 0, y: 0, width: 1, height: 1 } } as unknown as DetectedRegion;
    const scanItem = { key: 'g1', kind: 'assembled', label: 10, regionIds: [10], pieceCount: 19, center: at(1.5, 2), candidates: [] } as unknown as ScanItem;
    const refCell = { w: 50, h: 50 };
    const placement = {
      cells: holed,
      bounds: { row0: 0, col0: 0, row1: 3, col1: 4 },
      x: 0,
      y: 0,
      rotationDeg: rot,
      confidence: 1,
      anchors: [{ at: at(1.5, 2), x: (2 + 0.5) * 50 - 0.5, y: (1.5 + 0.5) * 50 - 0.5 }],
    };
    const cells = cellItemOf(scanItem, placement, new Map([[10, region]]), { refCell, bodySize: 100 })!;
    expect(cells.cellPx).toBe(100);
    expect(scaleAspect({ refCell })).toBe(1);
    const hole: FitItem = { key: 'r5', label: 5, pieces: 1, center: { x: 200, y: 200 }, cells: [{ row: 2, col: 1 }], rotationDeg: 0, cellPx: 100 };
    const pose = fitPose(hole, { ...cells, key: 'g1', label: 10, pieces: 19 }, 1)!;
    expect(dist(pose.docked, at(2, 1))).toBeLessThan(1);
  });

  it('ends the connection line at the same touching cell, on the rim', () => {
    // The matcher's point a little off and the scan's piece size 6 % big: the rim corrects both.
    const region = { id: 10, kind: 'patch', contour: outline, area: 20 * 106 * 106, bbox: { x: 0, y: 0, width: 1, height: 1 } } as unknown as DetectedRegion;
    const regions = new Map([[10, region]]);
    const scanItem = { key: 'g1', kind: 'assembled', label: 10, regionIds: [10], pieceCount: 20, center: at(1.5, 2), candidates: [] } as unknown as ScanItem;
    const placement = {
      cells,
      bounds: { row0: 0, col0: 0, row1: 3, col1: 4 },
      x: 0,
      y: 0,
      rotationDeg: rot,
      confidence: 1,
      anchors: [{ at: at(1.35, 2), x: (2 + 0.5) * 50 - 0.5, y: (1.5 + 0.5) * 50 - 0.5 }],
    };
    const scale = { refCell: { w: 50, h: 50 }, bodySize: 106 };
    const patch = { ...cellItemOf(scanItem, placement, regions, scale)!, key: 'g1', label: 10, pieces: 20 };
    const pose = fitPose(piece, patch, 1)!;
    const end = itemRouteEnd(scanItem, placement, regions, 'top', { row: 0, col: 3 }, 10, scale);
    expect(end.center).toEqual(pose.anchorPoint);
    const leaves = { x: end.center.x + end.dir!.x * end.reach, y: end.center.y + end.dir!.y * end.reach };
    expect(dist(leaves, at(-0.5, 3.03))).toBeLessThan(6);
    expect(dist(pose.docked, at(-1, 3.03))).toBeLessThan(10);
  });
});
