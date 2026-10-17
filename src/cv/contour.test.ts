import { describe, expect, it } from 'vitest';
import { findOuterContours, traceOuterContour } from './contour';
import { polygonSignedArea, type Point } from './geometry';
import { createMask, maskToRGBA, type Mask } from './image';
import { drawPolygon, fillPolygon } from './raster';
import { DEBUG_IMAGES, savePng } from '../testing/nodeImageIO';

function fromRows(rows: string[]): Mask {
  const m = createMask(rows[0].length, rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => { m.data[y * m.width + x] = c === '#' ? 1 : 0; }));
  return m;
}

const xy = (pts: Point[]): number[][] => pts.map((p) => [p.x, p.y]);

/** Set pixels with an unset (or outside) 4-neighbour. */
function borderPixels(m: Mask): Set<string> {
  const s = new Set<string>();
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < m.width && y < m.height && m.data[y * m.width + x] !== 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (at(x, y) && (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1))) s.add(`${x},${y}`);
    }
  }
  return s;
}

function expectChain(pts: Point[]): void {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    expect(d).toBe(pts.length === 1 ? 0 : 1);
  }
}

/** Jigsaw-like piece outline: square body with a round tab (+1) or blank (-1) per side. */
function jigsawPolygon(cx: number, cy: number, size: number, angle: number, tabs: number[]): Point[] {
  const h = size / 2;
  const corners = [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
  const local: Point[] = [];
  for (let s = 0; s < 4; s++) {
    const a = corners[s], b = corners[(s + 1) % 4];
    const ux = (b.x - a.x) / size, uy = (b.y - a.y) / size;
    const at = (u: number, v: number): Point => ({ x: a.x + ux * u * size + uy * v * size, y: a.y + uy * u * size - ux * v * size });
    local.push(at(0, 0));
    if (tabs[s] !== 0) {
      local.push(at(0.44, 0));
      for (let k = 0; k <= 24; k++) {
        const phi = ((240 - (300 * k) / 24) * Math.PI) / 180;
        local.push(at(0.5 + 0.12 * Math.cos(phi), tabs[s] * (0.17 + 0.12 * Math.sin(phi))));
      }
      local.push(at(0.56, 0));
    }
  }
  const c = Math.cos(angle), sn = Math.sin(angle);
  return local.map((p) => ({ x: cx + c * p.x - sn * p.y, y: cy + sn * p.x + c * p.y }));
}

describe('traceOuterContour', () => {
  it('handles empty masks, single pixels and tiny squares (clockwise, no closing duplicate)', () => {
    expect(traceOuterContour(createMask(4, 4))).toEqual([]);
    expect(xy(traceOuterContour(fromRows(['...', '.#.', '...'])))).toEqual([[1, 1]]);
    expect(xy(traceOuterContour(fromRows(['##', '##'])))).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('walks 1-pixel-wide parts out and back', () => {
    expect(xy(traceOuterContour(fromRows(['###'])))).toEqual([[0, 0], [1, 0], [2, 0], [1, 0]]);
    expect(xy(traceOuterContour(fromRows(['#..', '.#.', '..#'])))).toEqual([[0, 0], [1, 1], [2, 2], [1, 1]]);
    // Blob with a one-pixel spur and a diagonal bridge to a second blob.
    const m = fromRows([
      '.......',
      '.##....',
      '.###...',
      '.##.#..',
      '.....##',
      '.....##',
    ]);
    const c = traceOuterContour(m);
    expectChain(c);
    expect(polygonSignedArea(c)).toBeGreaterThan(0);
    expect(new Set(c.map((p) => `${p.x},${p.y}`))).toEqual(borderPixels(m));
    expect(c[0]).toEqual({ x: 1, y: 1 });
  });

  it('is clockwise with positive area for a rectangle and ignores holes', () => {
    const m = fromRows([
      '........',
      '.######.',
      '.#....#.',
      '.#.##.#.',
      '.#....#.',
      '.######.',
    ]);
    const c = traceOuterContour(m);
    expect(c.length).toBe(18);
    expect(polygonSignedArea(c)).toBe(5 * 4);
    expect(c.every((p) => p.x === 1 || p.x === 6 || p.y === 1 || p.y === 5)).toBe(true);
    // Start on the right side of the ring: walking left from there would hit the hole first.
    expect(traceOuterContour(m, { x: 6, y: 3 })).toEqual(c);
    expect(traceOuterContour(m, { x: 6.3, y: 2.8 })).toEqual(c);
    // The island inside the hole is a separate component.
    expect(xy(traceOuterContour(m, { x: 4, y: 3 }))).toEqual([[3, 3], [4, 3]]);
    expect(traceOuterContour(m, { x: 0, y: 0 })).toEqual([]);
    expect(traceOuterContour(m, { x: -5, y: 0 })).toEqual([]);
  });

  it('traces shapes touching the image border', () => {
    const m = createMask(5, 3);
    m.data.fill(1);
    expect(xy(traceOuterContour(m))).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [3, 2], [2, 2], [1, 2], [0, 2], [0, 1]]);
  });

  it('traces a rasterized jigsaw piece: closed 8-chain over exactly the border pixels', () => {
    const m = createMask(260, 240);
    const poly = jigsawPolygon(128, 118, 130, 0.35, [1, -1, 1, -1]);
    fillPolygon(m, poly);
    const c = traceOuterContour(m);
    expectChain(c);
    expect(new Set(c.map((p) => `${p.x},${p.y}`))).toEqual(borderPixels(m));
    // Pixel-center polygon area ≈ true area minus half a pixel along the perimeter.
    const truth = polygonSignedArea(poly);
    const area = polygonSignedArea(c);
    expect(area).toBeGreaterThan(truth * 0.97);
    expect(area).toBeLessThan(truth);
    // Same result from an interior start point.
    expect(traceOuterContour(m, { x: 128, y: 118 })).toEqual(c);
    if (DEBUG_IMAGES) {
      const img = maskToRGBA(m);
      drawPolygon(img, c, [255, 0, 0, 255]);
      savePng('.debug/cv/contour-jigsaw.png', img);
    }
  });
});

describe('findOuterContours', () => {
  it('returns one contour per component above minArea', () => {
    const m = fromRows([
      '##.....#',
      '##..#...',
      '....##..',
      '#...###.',
    ]);
    const res = findOuterContours(m, 2);
    expect(res.map((r) => r.stats.area)).toEqual([4, 6]);
    expect(xy(res[0].contour)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(res[1].contour[0]).toEqual({ x: 4, y: 1 });
    expect(polygonSignedArea(res[1].contour)).toBeGreaterThan(0);
    expect(findOuterContours(m).length).toBe(4);
  });
});
