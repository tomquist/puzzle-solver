import { describe, expect, it } from 'vitest';
import type { CellRef } from '../../model/types';
import { cellAxes, fitDescription, fitPose, glidePath, touchingCells, type FitItem } from './fit';
import { sideVector } from './overlay';
import { routeLink } from './route';

const piece = (key: string, x: number, y: number, cell: CellRef, rotationDeg: number, cellPx = 50): FitItem => ({
  key,
  label: Number(key.slice(1)),
  pieces: 1,
  center: { x, y },
  cells: [cell],
  rotationDeg,
  cellPx,
});

describe('fit pose', () => {
  it('docks a piece next to an upright one, turned like it', () => {
    // A upright at (100, 100) in cell (2, 2); B is A's right neighbour, lies a quarter turned.
    const a = piece('r7', 100, 100, { row: 2, col: 2 }, 0);
    const b = piece('r12', 400, 300, { row: 2, col: 3 }, 90);
    const p = fitPose(a, b, 1)!;
    expect(p.mover).toBe('b');
    expect(p.pivot).toEqual({ x: 400, y: 300 });
    expect(p.docked.x).toBeCloseTo(150);
    expect(p.docked.y).toBeCloseTo(100);
    expect(p.rotateDeg).toBe(90);
    expect(p.side).toBe('right');
    expect(p.seam!.center.x).toBeCloseTo(125);
    expect(p.seam!.length).toBeCloseTo(50);
  });

  it("follows A's orientation in the photo", () => {
    // A needs a quarter turn clockwise: its puzzle right points up in the photo.
    const a = piece('r7', 100, 100, { row: 2, col: 2 }, 90);
    expect(sideVector('right', 90).y).toBeCloseTo(-1);
    const right = fitPose(a, piece('r12', 0, 0, { row: 2, col: 3 }, 0), 1)!;
    expect(right.docked.x).toBeCloseTo(100);
    expect(right.docked.y).toBeCloseTo(50);
    // B must turn by B − A = −90: a quarter counter-clockwise.
    expect(right.rotateDeg).toBe(-90);
    // Below A (puzzle) = to the right of A in the photo here.
    const below = fitPose(a, piece('r13', 0, 0, { row: 3, col: 2 }, 270), 1)!;
    expect(below.docked.x).toBeCloseTo(150);
    expect(below.docked.y).toBeCloseTo(100);
    expect(below.rotateDeg).toBe(180);
    expect(below.side).toBe('bottom');
    // Upside down A: above in the puzzle = below in the photo; the short way round.
    const flipped = fitPose(piece('r7', 100, 100, { row: 2, col: 2 }, 180), piece('r14', 0, 0, { row: 1, col: 2 }, 10), 1)!;
    expect(flipped.docked.y).toBeCloseTo(150);
    expect(flipped.rotateDeg).toBe(-170);
    expect(flipped.side).toBe('top');
  });

  it('docks a piece at the right cell of a patch, and moves the smaller item', () => {
    // A 2 × 2 patch centred at (200, 200), upright; the piece goes right of its top-right cell.
    const patch: FitItem = {
      key: 'g1',
      label: 3,
      pieces: 4,
      center: { x: 200, y: 200 },
      cells: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 1, col: 1 },
      ],
      rotationDeg: 0,
      cellPx: 50,
    };
    const p = piece('r9', 500, 500, { row: 0, col: 2 }, 0);
    // The piece is selected (a), the patch is its partner (b): the piece still moves.
    const pose = fitPose(p, patch, 1)!;
    expect(pose.mover).toBe('a');
    expect(pose.anchorCell).toEqual({ row: 0, col: 1 });
    expect(pose.anchorPoint.x).toBeCloseTo(225);
    expect(pose.anchorPoint.y).toBeCloseTo(175);
    expect(pose.docked.x).toBeCloseTo(275);
    expect(pose.docked.y).toBeCloseTo(175);
    expect(pose.side).toBe('right');
    // A turned patch (a quarter clockwise needed): its cells run up the photo.
    const turned = fitPose(p, { ...patch, rotationDeg: 90 }, 1)!;
    expect(turned.anchorPoint.x).toBeCloseTo(175);
    expect(turned.anchorPoint.y).toBeCloseTo(175);
    expect(turned.docked.x).toBeCloseTo(175);
    expect(turned.docked.y).toBeCloseTo(125);
  });

  it('uses per-axis cell sizes for non-square cells', () => {
    // A 3 × 6 children's puzzle: cells about 1.6 : 1 (wider than tall).
    const { w, h } = cellAxes(50, 1.6);
    expect(w / h).toBeCloseTo(1.6);
    expect((w + h) / 2).toBeCloseTo(50);
    const a = piece('r1', 100, 100, { row: 1, col: 1 }, 0);
    expect(fitPose(a, piece('r2', 0, 0, { row: 1, col: 2 }, 0), 1.6)!.docked.x).toBeCloseTo(100 + w);
    expect(fitPose(a, piece('r3', 0, 0, { row: 2, col: 1 }, 0), 1.6)!.docked.y).toBeCloseTo(100 + h);
    // Turned a quarter: the long axis runs vertically in the photo.
    const t = piece('r1', 100, 100, { row: 1, col: 1 }, 90);
    const right = fitPose(t, piece('r2', 0, 0, { row: 1, col: 2 }, 90), 1.6)!;
    expect(right.docked.y).toBeCloseTo(100 - w);
    expect(right.seam!.length).toBeCloseTo(h);
  });

  it('picks the closest cells of two groups', () => {
    expect(touchingCells([{ row: 0, col: 0 }, { row: 0, col: 1 }], [{ row: 0, col: 3 }, { row: 0, col: 2 }])).toEqual([
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ]);
  });

  it('glides from the pivot to the docked point, along the connection line', () => {
    const a = piece('r7', 100, 100, { row: 2, col: 2 }, 0);
    const b = piece('r12', 400, 100, { row: 2, col: 3 }, 180);
    const pose = fitPose(a, b, 1)!;
    const route = routeLink(
      { center: a.center, reach: 25, dir: sideVector('right', 0) },
      { center: b.center, reach: 25, dir: sideVector('left', 180) },
    )!;
    const path = glidePath(pose, route, false, 8);
    expect(path[0]).toEqual(pose.pivot);
    expect(path[8].x).toBeCloseTo(pose.docked.x);
    expect(path[8].y).toBeCloseTo(pose.docked.y);
    // B's joining side faces away from A: the glide first goes out past B's far side.
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(400);
    expect(glidePath(pose, undefined, false, 2)[1]).toEqual({ x: 275, y: 100 });
  });

  it('describes the fit in plain words', () => {
    const a = piece('r7', 100, 100, { row: 2, col: 2 }, 0);
    const pose = fitPose(a, piece('r12', 0, 0, { row: 2, col: 3 }, -90), 1)!;
    expect(fitDescription(pose, { label: 12, pieces: 1 }, { label: 7 })).toBe('Piece #12 joins on the right side of #7, turned a quarter to the left.');
    const above = fitPose(a, piece('r13', 0, 0, { row: 1, col: 2 }, 3), 1)!;
    expect(fitDescription(above, { label: 13, pieces: 1 }, { label: 7 })).toBe('Piece #13 joins above #7, the same way round.');
  });
});
