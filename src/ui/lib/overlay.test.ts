import { describe, expect, it } from 'vitest';
import type { DetectedRegion } from '../../model/types';
import {
  cellAt,
  cellRect,
  clampPan,
  cropAround,
  fitTransform,
  gridPath,
  paddedBox,
  polygonCentroid,
  polygonPath,
  regionCenter,
  upArrow,
  zoomAt,
} from './overlay';

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
