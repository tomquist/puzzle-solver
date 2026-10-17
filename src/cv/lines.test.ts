import { describe, expect, it } from 'vitest';
import { canny } from './edges';
import type { Point } from './geometry';
import { createGray, createMask, type GrayImage } from './image';
import { fitLine, houghLines, lineFromPolar, lineIntersection } from './lines';
import { fillPolygon } from './raster';

function rotatedRect(cx: number, cy: number, w: number, h: number, angle: number): Point[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + c * x - s * y, y: cy + s * x + c * y }));
}

function polygonImage(w: number, h: number, poly: Point[]): GrayImage {
  const m = createMask(w, h);
  fillPolygon(m, poly);
  const g = createGray(w, h);
  for (let i = 0; i < w * h; i++) g.data[i] = m.data[i] ? 200 : 40;
  return g;
}

describe('houghLines', () => {
  for (const angle of [0, 0.25, -0.6]) {
    it(`finds the 4 sides of a rectangle rotated by ${angle} rad; refined intersections give its corners`, () => {
      const w = 240, h = 200;
      const truth = rotatedRect(120, 100, 140, 90, angle);
      const edges = canny(polygonImage(w, h, truth), 60, 150, 1);
      const lines = houghLines(edges, { maxLines: 4, threshold: 40 });
      expect(lines.length).toBe(4);
      for (const l of lines) {
        expect(l.theta).toBeGreaterThanOrEqual(0);
        expect(l.theta).toBeLessThan(Math.PI);
        expect(l.votes).toBeGreaterThanOrEqual(40);
      }
      // Two pairs of parallel lines, perpendicular to each other.
      const sorted = [...lines].sort((a, b) => a.theta - b.theta);
      const dTheta = (a: number, b: number) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
      const groups: typeof lines[] = [[sorted[0]], []];
      for (const l of sorted.slice(1)) (dTheta(l.theta, sorted[0].theta) < 0.1 ? groups[0] : groups[1]).push(l);
      expect(groups[0].length).toBe(2);
      expect(groups[1].length).toBe(2);
      expect(Math.abs(dTheta(groups[0][0].theta, groups[1][0].theta) - Math.PI / 2)).toBeLessThan(0.04);
      // Refine each line with fitLine on nearby edge pixels, then intersect.
      const edgePts: Point[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (edges.data[y * w + x]) edgePts.push({ x, y });
      const refined = lines.map((l) => {
        const c = Math.cos(l.theta), s = Math.sin(l.theta);
        const fit = fitLine(edgePts.filter((p) => Math.abs(p.x * c + p.y * s - l.rho) < 2.5));
        expect(fit).not.toBeNull();
        return { line: fit!, group: groups[0].includes(l) ? 0 : 1 };
      });
      const corners: Point[] = [];
      for (const a of refined.filter((r) => r.group === 0)) {
        for (const b of refined.filter((r) => r.group === 1)) {
          corners.push(lineIntersection(a.line.point, a.line.direction, b.line.point, b.line.direction)!);
        }
      }
      for (const t of truth) expect(Math.min(...corners.map((p) => Math.hypot(p.x - t.x, p.y - t.y)))).toBeLessThan(1.5);
    });
  }

  it('suppresses near-duplicates and returns nothing for empty masks', () => {
    const m = createMask(100, 100);
    for (let x = 0; x < 100; x++) { m.data[50 * 100 + x] = 1; m.data[51 * 100 + x] = 1; }
    const lines = houghLines(m, { threshold: 50 });
    expect(lines.length).toBe(1);
    expect(lines[0].theta).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(lines[0].rho - 50.5)).toBeLessThanOrEqual(0.5);
    expect(houghLines(createMask(10, 10))).toEqual([]);
  });

  it('treats lines near theta = 0 and theta = pi as the same family (wrap-around)', () => {
    // A nearly vertical line slanted so its best theta is close to pi (negative rho side).
    const m = createMask(120, 120);
    for (let y = 0; y < 120; y++) m.data[y * 120 + Math.round(60 + 0.01 * (y - 60))] = 1;
    const lines = houghLines(m, { threshold: 60 });
    expect(lines.length).toBe(1);
    const { point, direction } = lineFromPolar(lines[0].rho, lines[0].theta);
    // The line passes near (60, 60) and is nearly vertical.
    const d = Math.abs((60 - point.x) * direction.y - (60 - point.y) * direction.x);
    expect(d).toBeLessThan(1);
    expect(Math.abs(direction.y)).toBeGreaterThan(0.99);
  });
});

describe('fitLine / lineIntersection / lineFromPolar', () => {
  it('fits noisy points with total least squares', () => {
    let s = 4;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5);
    const pts = Array.from({ length: 200 }, (_, i) => {
      const t = i - 99.5;
      return { x: 10 + 2 * t / Math.sqrt(5) + rnd() * 0.5, y: 20 + t / Math.sqrt(5) + rnd() * 0.5 };
    });
    const f = fitLine(pts)!;
    expect(f.direction.x).toBeCloseTo(2 / Math.sqrt(5), 2);
    expect(f.direction.y).toBeCloseTo(1 / Math.sqrt(5), 2);
    expect(Math.hypot(f.point.x - 10, f.point.y - 20)).toBeLessThan(0.2);
    // Vertical line: direction points down (+y), unlike plain least squares this works.
    const v = fitLine([{ x: 5, y: 0 }, { x: 5, y: 10 }, { x: 5, y: 3 }])!;
    expect(v.direction.x).toBeCloseTo(0, 9);
    expect(v.direction.y).toBeCloseTo(1, 9);
    expect(v.point).toEqual({ x: 5, y: 13 / 3 });
    expect(fitLine([{ x: 1, y: 1 }])).toBeNull();
    expect(fitLine([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBeNull();
  });

  it('intersects lines and rejects parallel ones', () => {
    const p = lineIntersection({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 4, y: 0 }, { x: 0, y: 3 })!;
    expect(p.x).toBeCloseTo(4, 12);
    expect(p.y).toBeCloseTo(4, 12);
    expect(lineIntersection({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 5, y: 0 }, { x: -2, y: -4 })).toBeNull();
    const { point, direction } = lineFromPolar(10, 0);
    expect(point).toEqual({ x: 10, y: 0 });
    expect(direction.x).toBeCloseTo(0, 12);
    expect(direction.y).toBe(1);
  });
});
