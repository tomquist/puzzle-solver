import { describe, expect, it } from 'vitest';
import type { DetectedRegion } from '../../model/types';
import { cellAt, cellRect, clampPan, cropAround, fitTransform, gridPath, paddedBox, polygonCentroid, polygonPath, regionCenter, upArrow, zoomAt, trimmedSegment, connectionCurve, groupCellCenter, groupCellSize, sideVector, transformForRect, unionRect } from './overlay';

describe('polygons', () => {
  it('builds SVG path data', () => {
    expect(polygonPath([{ x: 0, y: 0 }, { x: 10.04, y: 0 }, { x: 10, y: 5.55 }])).toBe('M0 0L10 0L10 5.6Z');
    expect(polygonPath([])).toBe('');
  });
  it('computes centroids', () => {
    const c = polygonCentroid([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }]);
    expect(c.x).toBeCloseTo(2);
    expect(c.y).toBeCloseTo(1);
  });
  it('prefers the piece shape center', () => {
    const region = {
      id: 1, kind: 'piece', bbox: { x: 0, y: 0, width: 10, height: 10 }, contour: [], area: 100,
      touchesBorder: false, orientationDeg: 0, issues: [],
    } as DetectedRegion;
    expect(regionCenter(region)).toEqual({ x: 5, y: 5 });
  });
});

describe('arrows', () => {
  it('points the up arrow according to the rotation', () => {
    const a = upArrow({ x: 100, y: 100 }, 0, 50);
    expect(a.head[0].x).toBeCloseTo(100);
    expect(a.head[0].y).toBeCloseTo(50);
    const b = upArrow({ x: 100, y: 100 }, 90, 50);
    expect(b.head[0].x).toBeCloseTo(50);
    expect(b.head[0].y).toBeCloseTo(100);
  });
});

describe('grid cells', () => {
  const grid = { rows: 4, cols: 5 };
  it('maps cells to reference rectangles and back', () => {
    expect(cellRect({ row: 1, col: 2 }, grid, 500, 400)).toEqual({ x: 200, y: 100, width: 100, height: 100 });
    expect(cellAt(250, 150, grid, 500, 400)).toEqual({ row: 1, col: 2 });
    expect(cellAt(-5, 9999, grid, 500, 400)).toEqual({ row: 3, col: 0 });
  });
  it('draws interior grid lines', () => {
    const d = gridPath({ rows: 2, cols: 2 }, 100, 50);
    expect(d).toBe('M50 0V50M0 25H100');
  });
  it('crops 2.2 cells around a location', () => {
    const c = cropAround(10, 20, grid, 500, 400);
    expect(c.cx).toBe(10);
    expect(c.side).toBeCloseTo(220);
  });
  it('pads and clamps boxes', () => {
    expect(paddedBox({ x: 5, y: 5, width: 10, height: 10 }, 1, 20, 18)).toEqual({ x: 0, y: 0, width: 20, height: 18 });
  });
});

describe('zoom & pan', () => {
  it('fits content into the viewport', () => {
    expect(fitTransform(200, 100, 100, 100)).toEqual({ scale: 0.5, x: 0, y: 25 });
  });
  it('zooms about a fixed point', () => {
    const t = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { x: 50, y: 50 }, 0.1, 10);
    expect(t).toEqual({ scale: 2, x: -50, y: -50 });
    // Point under the cursor stays put: content (50,50) → viewport 50*2-50 = 50.
    expect(zoomAt(t, 100, { x: 0, y: 0 }, 0.1, 10).scale).toBe(10);
  });
  it('clamps panning', () => {
    expect(clampPan({ scale: 1, x: 30, y: -500 }, 200, 200, 100, 100)).toEqual({ scale: 1, x: 0, y: -100 });
    expect(clampPan({ scale: 0.25, x: 0, y: 0 }, 200, 200, 100, 100)).toEqual({ scale: 0.25, x: 25, y: 25 });
  });
  it('shows a content rectangle as large as it fits, within the zoom limits', () => {
    // 100 × 100 rect in a 200 × 200 viewport of 1000 × 1000 content → scale 2, centred on (450, 450).
    expect(transformForRect({ x: 400, y: 400, width: 100, height: 100 }, 1000, 1000, 200, 200, 0.2, 5)).toEqual({ scale: 2, x: -800, y: -800 });
    // Never zoomed in past maxScale (a small picture is not blown up).
    expect(transformForRect({ x: 400, y: 400, width: 10, height: 10 }, 1000, 1000, 200, 200, 0.2, 2.5).scale).toBe(2.5);
    // Near the content's edge the view stays inside the content.
    expect(transformForRect({ x: -50, y: -50, width: 100, height: 100 }, 1000, 1000, 200, 200, 0.2, 5)).toEqual({ scale: 2, x: 0, y: 0 });
  });
  it('unites rectangles', () => {
    expect(unionRect([{ x: 0, y: 5, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }])).toEqual({ x: 0, y: 0, width: 25, height: 15 });
    expect(unionRect([])).toBeUndefined();
  });
});

describe('connections', () => {
  it('trims connection lines to the badge edges', () => {
    const s = trimmedSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20)!;
    expect(s.from).toEqual({ x: 10, y: 0 });
    expect(s.to).toEqual({ x: 80, y: 0 });
    expect(trimmedSegment({ x: 0, y: 0 }, { x: 15, y: 0 }, 10)).toBeNull();
  });
});

describe('connection curves', () => {
  it('maps puzzle sides into the photo for a rotated piece', () => {
    // Upright piece: sides point the obvious way (y down).
    expect(sideVector('right', 0)).toEqual({ x: 1, y: 0 });
    expect(sideVector('top', 0)).toEqual({ x: 0, y: -1 });
    // A piece that must turn 90° clockwise lies turned 90° counter-clockwise in the photo:
    // its future top points left, its future right points up.
    const top = sideVector('top', 90);
    const right = sideVector('right', 90);
    expect(top.x).toBeCloseTo(-1, 9);
    expect(top.y).toBeCloseTo(0, 9);
    expect(right.x).toBeCloseTo(0, 9);
    expect(right.y).toBeCloseTo(-1, 9);
  });

  it('starts and ends on the joining edges and bends out of them', () => {
    // A (upright) at the left, B (upright) at the right; A's right edge joins B's left edge.
    const c = connectionCurve(
      { center: { x: 0, y: 0 }, reach: 10, dir: sideVector('right', 0) },
      { center: { x: 100, y: 0 }, reach: 10, dir: sideVector('left', 0) },
    )!;
    expect(c.from).toEqual({ x: 10, y: 0 });
    expect(c.to).toEqual({ x: 90, y: 0 });
    expect(c.d.startsWith('M10,0 C')).toBe(true);
    // B lies upside down: its future left edge now faces right, so the curve must arrive from the right.
    const flipped = connectionCurve(
      { center: { x: 0, y: 0 }, reach: 10, dir: sideVector('right', 0) },
      { center: { x: 100, y: 0 }, reach: 10, dir: sideVector('left', 180) },
    )!;
    expect(flipped.to.x).toBeCloseTo(110, 6);
    const c2x = Number(flipped.d.split(' ')[2].split(',')[0]);
    expect(c2x).toBeGreaterThan(110);
  });

  it('falls back to a straight-ish link from badge to badge without sides', () => {
    const c = connectionCurve({ center: { x: 0, y: 0 }, reach: 5 }, { center: { x: 0, y: 50 }, reach: 5 })!;
    expect(c.from).toEqual({ x: 0, y: 5 });
    expect(c.to).toEqual({ x: 0, y: 45 });
  });
});

describe('cells of a placed group', () => {
  const cells = [{ row: 2, col: 2 }, { row: 2, col: 3 }, { row: 3, col: 2 }, { row: 3, col: 3 }];
  it('offsets a member cell from the group centre along the puzzle axes', () => {
    // Upright: the bottom-right cell lies half a cell right and down of the centre.
    const p = groupCellCenter({ x: 100, y: 100 }, cells, { row: 3, col: 3 }, 0, 40);
    expect(p.x).toBeCloseTo(120, 6);
    expect(p.y).toBeCloseTo(120, 6);
    // Needs a quarter turn clockwise to stand upright: in the photo the puzzle's right points up and
    // its bottom points right, so the bottom-right member lies right of and above the centre.
    const q = groupCellCenter({ x: 100, y: 100 }, cells, { row: 3, col: 3 }, 90, 40);
    expect(q.x).toBeCloseTo(120, 6);
    expect(q.y).toBeCloseTo(80, 6);
  });

  it('measures a cell by the members\' body size, else by area per cell', () => {
    const piece = (id: number, body: number) => ({ id, kind: 'piece', bbox: { x: 0, y: 0, width: 1, height: 1 }, contour: [], area: body * body, touchesBorder: false, orientationDeg: 0, issues: [], shape: { bodySize: body } }) as unknown as DetectedRegion;
    expect(groupCellSize([piece(1, 40), piece(2, 50), piece(3, 44)], 3)).toBe(44);
    const patch = { id: 4, kind: 'patch', bbox: { x: 0, y: 0, width: 1, height: 1 }, contour: [], area: 6400, touchesBorder: false, orientationDeg: 0, issues: [] } as DetectedRegion;
    expect(groupCellSize([patch], 4)).toBe(40);
  });
});
