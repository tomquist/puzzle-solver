import { describe, expect, it } from 'vitest';
import type { DetectedRegion } from '../../model/types';
import {
  blockRect,
  cellsOutlinePath,
  closeupSquare,
  cornerBrackets,
  insetCorner,
  itemPieceSize,
  outsideMaskPath,
  overviewMarker,
  pickupRect,
  shiftInside,
  targetContext,
} from './framing';
import type { ScanItem } from './items';

describe('pick-up crop', () => {
  it('shows the piece with about 3.5 piece sizes of surroundings, square', () => {
    const r = pickupRect({ x: 500, y: 400, width: 60, height: 50 }, 50, 2000, 1500);
    expect(r.width).toBe(175);
    expect(r.height).toBe(175);
    // Centred on the piece.
    expect(r.x + r.width / 2).toBe(530);
    expect(r.y + r.height / 2).toBe(425);
  });

  it('keeps a large group plus a piece on each side', () => {
    const r = pickupRect({ x: 500, y: 400, width: 300, height: 120 }, 50, 2000, 1500);
    expect(r.width).toBe(400);
  });

  it('stays inside the photo near its edges', () => {
    const r = pickupRect({ x: 5, y: 1450, width: 40, height: 40 }, 40, 2000, 1500);
    expect(r.x).toBe(0);
    expect(r.y + r.height).toBe(1500);
  });

  it('never cuts the item, even when the photo is small', () => {
    const r = pickupRect({ x: 10, y: 10, width: 180, height: 60 }, 60, 200, 100);
    expect(r.width).toBeGreaterThanOrEqual(180);
  });

  it('uses the piece body size, or the group cell size', () => {
    const piece = { id: 1, kind: 'piece', bbox: { x: 0, y: 0, width: 80, height: 80 }, contour: [], area: 3600, shape: { bodySize: 60 } } as unknown as DetectedRegion;
    const item = { key: 'r1', kind: 'piece', regionIds: [1], pieceCount: 1, bbox: piece.bbox } as unknown as ScanItem;
    expect(itemPieceSize(item, [piece])).toBe(60);
    const patch = { id: 2, kind: 'patch', bbox: { x: 0, y: 0, width: 80, height: 40 }, contour: [], area: 3200 } as unknown as DetectedRegion;
    const group = { key: 'g1', kind: 'assembled', regionIds: [2], pieceCount: 2, bbox: patch.bbox } as unknown as ScanItem;
    expect(itemPieceSize(group, [patch])).toBe(40);
  });

  it('makes a close-up square that holds the item at any rotation', () => {
    const s = closeupSquare({ x: 0, y: 0, width: 30, height: 40 }, 0);
    expect(s).toEqual({ cx: 15, cy: 20, side: 50 });
  });

  it('draws corner marks outside the framed rectangle', () => {
    expect(cornerBrackets({ x: 10, y: 10, width: 20, height: 20 }, 5, 2)).toBe('M8 13V8H13M27 8H32V13M32 27V32H27M13 32H8V27');
  });
});

describe('target context', () => {
  const grid = { rows: 20, cols: 30 };
  it('shows about 7 × 7 cells around a single cell', () => {
    // 3000 × 2000 picture → 100 × 100 px cells.
    const r = targetContext({ row0: 10, col0: 15, row1: 10, col1: 15 }, grid, 3000, 2000);
    expect(r).toEqual({ x: 1200, y: 700, width: 700, height: 700 });
  });

  it('adapts to the group size and the view aspect', () => {
    const r = targetContext({ row0: 10, col0: 10, row1: 11, col1: 14 }, grid, 3000, 2000, { aspect: 4 / 3 });
    // 5 columns + 2 on each side = 9 cells wide; 7 rows minimum → widened to 4:3.
    expect(r.width).toBeCloseTo(933.33, 1);
    expect(r.height).toBe(700);
    expect(r.x + r.width / 2).toBe(1250);
    expect(r.y + r.height / 2).toBe(1100);
  });

  it('is never smaller than minWidth (no blurry blow-up of a small picture)', () => {
    const r = targetContext({ row0: 1, col0: 1, row1: 1, col1: 1 }, { rows: 40, cols: 40 }, 400, 400, { minWidth: 160 });
    expect(r.width).toBe(160);
    expect(r.height).toBe(160);
  });

  it('measures blocks and moves rectangles inside the picture', () => {
    expect(blockRect({ row0: 1, col0: 2, row1: 2, col1: 2 }, grid, 3000, 2000)).toEqual({ x: 200, y: 100, width: 100, height: 200 });
    expect(shiftInside({ x: -50, y: 1900, width: 200, height: 200 }, 3000, 2000)).toEqual({ x: 0, y: 1800, width: 200, height: 200 });
    // Larger than the picture: centred.
    expect(shiftInside({ x: 0, y: 0, width: 400, height: 100 }, 200, 200)).toEqual({ x: -100, y: 0, width: 400, height: 100 });
  });

  it('outlines a group of cells along its outer edges only', () => {
    const d = cellsOutlinePath([{ row: 0, col: 0 }, { row: 0, col: 1 }], { rows: 2, cols: 2 }, 20, 20);
    // Two cells side by side: 6 outer edges, the shared edge is not drawn.
    expect(d.match(/M/g)).toHaveLength(6);
    expect(d).not.toContain('M10 0V10');
  });

  it('masks everything but the target cells', () => {
    expect(outsideMaskPath([{ row: 1, col: 1 }], { rows: 2, cols: 2 }, 20, 20)).toBe('M0 0H20V20H0ZM10 10h10v10h-10Z');
  });
});

describe('overview marker', () => {
  it('boxes the target (at least a minimum size) and draws crosshair lines up to the box', () => {
    const m = overviewMarker({ x: 500, y: 300, width: 10, height: 10 }, 1000, 800, 0.04);
    expect(m.box).toEqual({ x: 485, y: 285, width: 40, height: 40 });
    expect(m.cross).toBe('M505 0V285M505 325V800M0 305H485M525 305H1000');
  });

  it('leaves out lines that would have no length at the picture edge', () => {
    const m = overviewMarker({ x: 0, y: 0, width: 100, height: 100 }, 1000, 800, 0.04);
    expect(m.cross).toBe('M50 100V800M100 50H1000');
  });

  it('puts the inset in a corner away from the target', () => {
    // Target in the middle of the view: top-left.
    expect(insetCorner({ x: 1500, y: 1000, width: 100, height: 100 }, { x: 1200, y: 700, width: 700, height: 700 }, 3000, 2000)).toBe('top-left');
    // Near the picture's top-left corner (the view is clamped there): the farthest clear corner.
    expect(insetCorner({ x: 0, y: 0, width: 100, height: 100 }, { x: -300, y: -300, width: 700, height: 700 }, 3000, 2000)).toBe('bottom-left');
    // Top edge, in the middle: both top corners would touch it.
    expect(insetCorner({ x: 1500, y: 0, width: 100, height: 100 }, { x: 1200, y: -300, width: 700, height: 700 }, 3000, 2000)).toBe('bottom-left');
    // Left of the middle, clear of every corner: the farthest one.
    expect(insetCorner({ x: 100, y: 300, width: 200, height: 100 }, { x: -150, y: 0, width: 700, height: 700 }, 3000, 2000)).toBe('top-right');
  });
});
