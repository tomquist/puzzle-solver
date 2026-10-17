import { describe, expect, it } from 'vitest';
import { traceOuterContour } from './contour';
import { polygonSignedArea, type Point } from './geometry';
import { createMask } from './image';
import {
  convexHull, minAreaRect, pointInPolygon, polygonArea, polygonCentroid, polygonPerimeter, resampleContour, simplifyPolygon,
  smoothContour,
} from './polygon';
import { fillPolygon } from './raster';

const xy = (pts: Point[]): number[][] => pts.map((p) => [p.x, p.y]);

function rotatedRect(cx: number, cy: number, w: number, h: number, angle: number): Point[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + c * x - s * y, y: cy + s * x + c * y }));
}

/** Points along the outline of an axis-aligned w×h rectangle, clockwise, starting at `start` steps. */
function rectOutline(w: number, h: number, start: number): Point[] {
  const pts: Point[] = [];
  for (let x = 0; x < w; x++) pts.push({ x, y: 0 });
  for (let y = 0; y < h; y++) pts.push({ x: w, y });
  for (let x = w; x > 0; x--) pts.push({ x, y: h });
  for (let y = h; y > 0; y--) pts.push({ x: 0, y });
  return pts.slice(start).concat(pts.slice(0, start));
}

describe('simplifyPolygon', () => {
  it('reduces a closed rectangle outline to its 4 corners wherever the outline starts', () => {
    for (const start of [0, 5, 13, 29]) {
      const s = simplifyPolygon(rectOutline(10, 6, start), 0.5);
      expect(s.length).toBe(4);
      expect(new Set(s.map((p) => `${p.x},${p.y}`))).toEqual(new Set(['0,0', '10,0', '10,6', '0,6']));
      expect(polygonSignedArea(s)).toBe(60);
    }
  });

  it('simplifies open polylines keeping both ends', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: -0.1 }, { x: 3, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 7 }];
    expect(xy(simplifyPolygon(pts, 0.5, false))).toEqual([[0, 0], [2, -0.1], [3, 5], [5, 7]]);
    expect(xy(simplifyPolygon(pts, 100, false))).toEqual([[0, 0], [5, 7]]);
  });

  it('turns a traced, rotated rectangle into a quad close to the truth', () => {
    const m = createMask(200, 160);
    const truth = rotatedRect(100, 80, 120, 70, 0.4);
    fillPolygon(m, truth);
    const c = traceOuterContour(m);
    const q = simplifyPolygon(c, 0.02 * polygonPerimeter(c));
    expect(q.length).toBe(4);
    for (const t of truth) expect(Math.min(...q.map((p) => Math.hypot(p.x - t.x, p.y - t.y)))).toBeLessThan(2.5);
  });

  it('copes with degenerate input', () => {
    expect(simplifyPolygon([], 1)).toEqual([]);
    expect(simplifyPolygon([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('convexHull', () => {
  it('returns the hull clockwise on screen without interior or collinear points', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 3, y: 4 }, { x: 7, y: 2 }, { x: 0, y: 5 },
      { x: 10, y: 10 },
    ];
    const h = convexHull(pts);
    expect(h.length).toBe(4);
    expect(polygonSignedArea(h)).toBe(100);
    expect(new Set(xy(h).map(String))).toEqual(new Set(['0,0', '10,0', '10,10', '0,10']));
    expect(convexHull([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('area / perimeter / centroid / pointInPolygon', () => {
  const L = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 3 }, { x: 0, y: 3 }];
  it('computes metrics of a concave polygon', () => {
    expect(polygonArea(L)).toBe(6);
    expect(polygonArea([...L].reverse())).toBe(6);
    expect(polygonPerimeter(L)).toBe(14);
    expect(polygonPerimeter(L, false)).toBe(11);
    const c = polygonCentroid(L);
    // Union of 4x1 bar (centroid 2, 0.5) and 1x2 bar (0.5, 2).
    expect(c.x).toBeCloseTo((4 * 2 + 2 * 0.5) / 6, 12);
    expect(c.y).toBeCloseTo((4 * 0.5 + 2 * 2) / 6, 12);
    expect(polygonCentroid([{ x: 0, y: 0 }, { x: 2, y: 2 }])).toEqual({ x: 1, y: 1 });
  });
  it('tests point containment (even-odd)', () => {
    expect(pointInPolygon({ x: 0.5, y: 2 }, L)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 0.5 }, L)).toBe(true);
    expect(pointInPolygon({ x: 2, y: 2 }, L)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 0.5 }, L)).toBe(false);
  });
});

describe('minAreaRect', () => {
  it('recovers rotated rectangles (width >= height, angle of the long side in (-pi/2, pi/2])', () => {
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (const angle of [0, 0.3, -0.7, Math.PI / 2, 2.5, -1.2]) {
      const corners = rotatedRect(50, 40, 30, 12, angle);
      const pts = [...corners];
      for (let k = 0; k < 50; k++) {
        const u = rnd() - 0.5, v = rnd() - 0.5;
        pts.push({ x: 50 + Math.cos(angle) * u * 30 - Math.sin(angle) * v * 12, y: 40 + Math.sin(angle) * u * 30 + Math.cos(angle) * v * 12 });
      }
      const r = minAreaRect(pts);
      expect(r.width).toBeCloseTo(30, 6);
      expect(r.height).toBeCloseTo(12, 6);
      expect(r.center.x).toBeCloseTo(50, 6);
      expect(r.center.y).toBeCloseTo(40, 6);
      let expected = angle;
      while (expected > Math.PI / 2) expected -= Math.PI;
      while (expected <= -Math.PI / 2) expected += Math.PI;
      expect(r.angle).toBeCloseTo(expected, 6);
      expect(polygonSignedArea(r.corners)).toBeCloseTo(360, 4);
      expect(r.corners[0].x + r.corners[0].y).toBeLessThanOrEqual(Math.min(...r.corners.map((p) => p.x + p.y)) + 1e-9);
      for (const c of corners) expect(Math.min(...r.corners.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))).toBeLessThan(1e-6);
    }
  });

  it('prefers the near-axis angle for squares and handles degenerate input', () => {
    const sq = minAreaRect(rotatedRect(0, 0, 10, 10, 1.3));
    expect(sq.angle).toBeCloseTo(1.3 - Math.PI / 2, 6);
    const seg = minAreaRect([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(seg.width).toBeCloseTo(5, 9);
    expect(seg.height).toBeCloseTo(0, 9);
    expect(seg.center.x).toBeCloseTo(1.5, 9);
    expect(seg.center.y).toBeCloseTo(2, 9);
    expect(minAreaRect([]).width).toBe(0);
  });

  it('fits a traced rasterized rectangle', () => {
    const m = createMask(220, 200);
    fillPolygon(m, rotatedRect(110, 100, 150, 90, -0.5));
    const r = minAreaRect(traceOuterContour(m));
    expect(r.width).toBeGreaterThan(147);
    expect(r.width).toBeLessThan(151);
    expect(r.height).toBeGreaterThan(87);
    expect(r.height).toBeLessThan(91);
    expect(r.angle).toBeCloseTo(-0.5, 1);
  });
});

describe('smoothContour / resampleContour', () => {
  it('smooths a noisy circle while preserving its centroid and closure', () => {
    let seed = 9;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const n = 400;
    const pts = Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n, r = 50 + (rnd() - 0.5) * 4;
      return { x: 100 + r * Math.cos(t), y: 80 + r * Math.sin(t) };
    });
    const spread = (p: Point[]) => {
      const rs = p.map((q) => Math.hypot(q.x - 100, q.y - 80));
      const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
      return Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
    };
    const s = smoothContour(pts, 3);
    expect(s.length).toBe(n);
    expect(spread(s)).toBeLessThan(spread(pts) / 2.5);
    const c = polygonCentroid(s), c0 = polygonCentroid(pts);
    expect(Math.hypot(c.x - c0.x, c.y - c0.y)).toBeLessThan(0.02);
    // Wrap-around: smoothing the same curve rotated gives the rotated result.
    const rotated = smoothContour(pts.slice(7).concat(pts.slice(0, 7)), 3);
    expect(rotated[0].x).toBeCloseTo(s[7].x, 9);
    expect(smoothContour(pts.slice(0, 5), 20).length).toBe(5);
  });

  it('resamples at equal arc length (closed and open)', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(xy(resampleContour(sq, 8))).toEqual([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]);
    expect(xy(resampleContour(sq, 4, false))).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(xy(resampleContour(sq, 7, false))).toEqual([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10]]);
    expect(resampleContour([{ x: 2, y: 3 }], 3)).toEqual([{ x: 2, y: 3 }, { x: 2, y: 3 }, { x: 2, y: 3 }]);
    expect(resampleContour(sq, 0)).toEqual([]);
  });
});
