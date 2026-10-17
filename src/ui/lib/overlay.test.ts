import { describe, expect, it } from 'vitest';
import type { DetectedRegion } from '../../model/types';
import { cellAt, cellRect, clampPan, cropAround, fitTransform, gridPath, paddedBox, polygonCentroid, polygonPath, regionCenter, upArrow, zoomAt, trimmedSegment, badgeNotch, connectionCurve, sideVector } from './overlay';

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
});

describe('connections and turn notches', () => {
  it('trims connection lines to the badge edges', () => {
    const s = trimmedSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20)!;
    expect(s.from).toEqual({ x: 10, y: 0 });
    expect(s.to).toEqual({ x: 80, y: 0 });
    expect(trimmedSegment({ x: 0, y: 0 }, { x: 15, y: 0 }, 10)).toBeNull();
  });
  it('points the badge notch to the piece top', () => {
    const [tip] = badgeNotch({ x: 50, y: 50 }, 10, 0);
    expect(tip.x).toBeCloseTo(50);
    expect(tip.y).toBeCloseTo(50 - 15.5);
    const [tip90] = badgeNotch({ x: 50, y: 50 }, 10, 90); // needs a clockwise turn: top is on the left
    expect(tip90.x).toBeCloseTo(50 - 15.5);
    expect(tip90.y).toBeCloseTo(50);
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
