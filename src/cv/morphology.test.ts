import { describe, expect, it } from 'vitest';
import { labelComponents, removeSmallComponents } from './components';
import { findOuterContours } from './contour';
import { distanceTransform } from './distance';
import type { Point } from './geometry';
import { createMask, maskArea, type Mask } from './image';
import { close, dilate, erode, fillHoles, open } from './morphology';
import { fillPolygon } from './raster';

function randomMask(w: number, h: number, density: number, seed: number): Mask {
  let s = seed >>> 0;
  const m = createMask(w, h);
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    m.data[i] = s / 2 ** 32 < density ? 1 : 0;
  }
  return m;
}

function fromRows(rows: string[]): Mask {
  const m = createMask(rows[0].length, rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => { m.data[y * m.width + x] = c === '#' ? 1 : 0; }));
  return m;
}

function toRows(m: Mask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < m.height; y++) {
    let s = '';
    for (let x = 0; x < m.width; x++) s += m.data[y * m.width + x] ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

/** Brute-force morphology with neutral outside pixels. */
function bruteMorph(m: Mask, r: number, shape: 'square' | 'disk', isDilate: boolean): Mask {
  const { width: w, height: h } = m;
  const out = createMask(w, h);
  const R = Math.ceil(r);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = false, all = true;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (shape === 'disk' ? dx * dx + dy * dy > r * r : Math.max(Math.abs(dx), Math.abs(dy)) > Math.floor(r)) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (m.data[yy * w + xx]) any = true;
          else all = false;
        }
      }
      out.data[y * w + x] = (isDilate ? any : all) ? 1 : 0;
    }
  }
  return out;
}

/** Jigsaw-like piece outline: square body with a round tab (+1), blank (-1) or flat side (0). */
function jigsawPolygon(cx: number, cy: number, size: number, angle: number, tabs: number[]): Point[] {
  const h = size / 2;
  const corners = [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
  const local: Point[] = [];
  for (let s = 0; s < 4; s++) {
    const a = corners[s], b = corners[(s + 1) % 4];
    const ux = (b.x - a.x) / size, uy = (b.y - a.y) / size;
    const nx = uy, ny = -ux; // outward normal for clockwise-on-screen traversal
    const at = (u: number, v: number): Point => ({ x: a.x + ux * u * size + nx * v * size, y: a.y + uy * u * size + ny * v * size });
    local.push(at(0, 0));
    const t = tabs[s];
    if (t !== 0) {
      local.push(at(0.44, 0));
      for (let k = 0; k <= 24; k++) {
        const phi = ((240 - (300 * k) / 24) * Math.PI) / 180;
        local.push(at(0.5 + 0.12 * Math.cos(phi), t * (0.17 + 0.12 * Math.sin(phi))));
      }
      local.push(at(0.56, 0));
    }
  }
  const c = Math.cos(angle), sn = Math.sin(angle);
  return local.map((p) => ({ x: cx + c * p.x - sn * p.y, y: cy + sn * p.x + c * p.y }));
}

describe('erode / dilate', () => {
  it('match brute force for square and disk elements on random masks', () => {
    for (const [density, seed] of [[0.1, 11], [0.6, 12], [0.9, 13]] as const) {
      const m = randomMask(31, 22, density, seed);
      for (const shape of ['square', 'disk'] as const) {
        for (const r of [1, 2, 2.5, 4, 7, 40]) {
          for (const isDilate of [true, false]) {
            const fast = isDilate ? dilate(m, r, shape) : erode(m, r, shape);
            expect(toRows(fast)).toEqual(toRows(bruteMorph(m, r, shape, isDilate)));
          }
        }
      }
    }
  });

  it('close equals brute-force closing of the mask embedded in an empty plane', () => {
    const m = randomMask(25, 19, 0.35, 21);
    for (const shape of ['square', 'disk'] as const) {
      for (const r of [1, 3, 5]) {
        const p = Math.ceil(r) + 1;
        const big = createMask(25 + 2 * p, 19 + 2 * p);
        for (let y = 0; y < 19; y++) for (let x = 0; x < 25; x++) big.data[(y + p) * big.width + x + p] = m.data[y * 25 + x];
        const ref = bruteMorph(bruteMorph(big, r, shape, true), r, shape, false);
        const got = close(m, r, shape);
        for (let y = 0; y < 19; y++) for (let x = 0; x < 25; x++) expect(got.data[y * 25 + x]).toBe(ref.data[(y + p) * big.width + x + p]);
      }
    }
  });

  it('radius 0 returns a normalised copy', () => {
    const m = createMask(3, 1);
    m.data.set([0, 255, 1]);
    expect(Array.from(dilate(m, 0).data)).toEqual([0, 1, 1]);
    expect(Array.from(erode(m, 0, 'disk').data)).toEqual([0, 1, 1]);
  });

  it('open removes specks, close bridges gaps', () => {
    const m = fromRows([
      '..........',
      '.#........',
      '....####..',
      '....####..',
      '....####..',
      '....####..',
      '..........',
    ]);
    expect(toRows(open(m, 1))).toEqual(toRows(fromRows([
      '..........',
      '..........',
      '....####..',
      '....####..',
      '....####..',
      '....####..',
      '..........',
    ])));
    const g = fromRows([
      '..........',
      '.###.###..',
      '.###.###..',
      '.###.###..',
      '..........',
    ]);
    expect(toRows(close(g, 1))).toEqual([
      '..........',
      '.#######..',
      '.#######..',
      '.#######..',
      '..........',
    ]);
  });
});

describe('fillHoles', () => {
  it('fills enclosed background, including diagonally-enclosed pockets, but not border-connected regions', () => {
    const m = fromRows([
      '..........',
      '.#####....',
      '.#...#..#.',
      '.#...#.#.#',
      '.#####..#.',
      '..........',
      '###.......',
      '..#.......',
    ]);
    expect(toRows(fillHoles(m))).toEqual([
      '..........',
      '.#####....',
      '.#####..#.',
      '.#####.###',
      '.#####..#.',
      '..........',
      '###.......',
      '..#.......',
    ]);
  });

  it('respects maxHoleArea', () => {
    const m = createMask(30, 20);
    fillPolygon(m, [{ x: 1, y: 1 }, { x: 28, y: 1 }, { x: 28, y: 18 }, { x: 1, y: 18 }]);
    const solid = maskArea(m);
    for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) m.data[y * 30 + x] = 0; // 9 px hole
    for (let y = 8; y <= 15; y++) for (let x = 10; x <= 25; x++) m.data[y * 30 + x] = 0; // 128 px hole
    expect(maskArea(fillHoles(m))).toBe(solid);
    expect(maskArea(fillHoles(m, 50))).toBe(solid - 128);
  });
});

describe('performance (2400×1800, 40 jigsaw pieces)', () => {
  it('runs morphology, hole filling, labelling and distance transform fast', () => {
    const W = 2400, H = 1800;
    const m = createMask(W, H);
    let n = 0;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const tabs = [((gx + gy) % 3) - 1, (gx % 3) - 1, (gy % 3) - 1, ((gx * gy) % 3) - 1];
        fillPolygon(m, jigsawPolygon(150 + gx * 300, 180 + gy * 360, 170, 0.3 * gx - 0.2 * gy, tabs));
        n++;
      }
    }
    // Speckle noise and pinholes.
    let s = 7;
    for (let k = 0; k < 20000; k++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      m.data[s % (W * H)] ^= 1;
    }
    const timings: Record<string, number> = {};
    const time = <T,>(name: string, f: () => T): T => {
      const t0 = performance.now();
      const r = f();
      timings[name] = Math.round(performance.now() - t0);
      return r;
    };
    // Warm-up for the JIT on a small mask.
    close(dilate(randomMask(200, 200, 0.5, 1), 3, 'disk'), 3);
    const opened = time('open r=2 square', () => open(m, 2));
    time('dilate r=10 square', () => dilate(m, 10));
    time('erode r=15 square', () => erode(m, 15));
    time('dilate r=10 disk', () => dilate(m, 10, 'disk'));
    const closed = time('close r=10 disk', () => close(opened, 10, 'disk'));
    const filled = time('fillHoles', () => fillHoles(closed));
    const cleaned = time('removeSmallComponents', () => removeSmallComponents(filled, 500));
    const lab = time('labelComponents', () => labelComponents(cleaned));
    time('distanceTransform', () => distanceTransform(cleaned));
    const contours = time('findOuterContours', () => findOuterContours(cleaned, 500));
    console.log('cv-shapes timings (ms):', JSON.stringify(timings));
    expect(lab.count).toBe(n);
    expect(contours.length).toBe(n);
    for (const t of Object.values(timings)) expect(t).toBeLessThan(2000);
  });
});
