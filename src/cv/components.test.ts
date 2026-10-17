import { describe, expect, it } from 'vitest';
import { componentMask, labelComponents, labelRuns, removeSmallComponents } from './components';
import { createMask, maskArea, type Mask } from './image';

function fromRows(rows: string[]): Mask {
  const m = createMask(rows[0].length, rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => { m.data[y * m.width + x] = c === '#' ? 1 : 0; }));
  return m;
}

function randomMask(w: number, h: number, density: number, seed: number): Mask {
  let s = seed >>> 0;
  const m = createMask(w, h);
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    m.data[i] = s / 2 ** 32 < density ? 1 : 0;
  }
  return m;
}

/** Reference labelling by flood fill, labels in raster order of first pixel. */
function bruteLabels(m: Mask, conn: 4 | 8): Int32Array {
  const { width: w, height: h } = m;
  const lab = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m.data[i] || lab[i]) continue;
    next++;
    const stack = [i];
    lab[i] = next;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w, y = Math.floor(j / w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (conn === 4 && dx !== 0 && dy !== 0)) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = yy * w + xx;
          if (m.data[k] && !lab[k]) { lab[k] = next; stack.push(k); }
        }
      }
    }
  }
  return lab;
}

describe('labelComponents', () => {
  it('distinguishes 4- and 8-connectivity and reports stats', () => {
    const m = fromRows([
      '##....',
      '##....',
      '..#..#',
      '.....#',
    ]);
    const c8 = labelComponents(m, 8);
    expect(c8.count).toBe(2);
    expect(c8.stats[0]).toEqual({
      label: 1, area: 5, bbox: { x: 0, y: 0, width: 3, height: 3 }, centroid: { x: 0.8, y: 0.8 }, touchesBorder: true, start: { x: 0, y: 0 },
    });
    expect(c8.stats[1]).toMatchObject({ label: 2, area: 2, bbox: { x: 5, y: 2, width: 1, height: 2 }, centroid: { x: 5, y: 2.5 }, start: { x: 5, y: 2 } });
    const c4 = labelComponents(m, 4);
    expect(c4.count).toBe(3);
    expect(c4.labels[2 * 6 + 2]).toBe(2);
    expect(c4.labels[2 * 6 + 5]).toBe(3);
    expect(c4.labels[0]).toBe(1);
    expect(c4.labels[3]).toBe(0);
  });

  it('handles U shapes merging late and interior components', () => {
    const m = fromRows([
      '.......',
      '.#.#.#.',
      '.#.#.#.',
      '.#####.',
      '.......',
    ]);
    const { count, stats } = labelComponents(m);
    expect(count).toBe(1);
    expect(stats[0].area).toBe(11);
    expect(stats[0].touchesBorder).toBe(false);
  });

  it('matches flood-fill labelling on random masks', () => {
    for (const [density, seed] of [[0.3, 1], [0.5, 2], [0.7, 3]] as const) {
      const m = randomMask(41, 29, density, seed);
      for (const conn of [4, 8] as const) {
        const ref = bruteLabels(m, conn);
        const { labels, count, stats } = labelComponents(m, conn);
        expect(Array.from(labels)).toEqual(Array.from(ref));
        expect(count).toBe(Math.max(0, ...ref));
        expect(stats.reduce((s, c) => s + c.area, 0)).toBe(maskArea(m));
        for (const s of stats) expect(labels[s.start.y * 41 + s.start.x]).toBe(s.label);
      }
    }
  });

  it('labelRuns groups background runs too', () => {
    const m = fromRows(['###', '#.#', '###']);
    const runs = labelRuns(m, 0, 4);
    expect(runs.count).toBe(1);
    expect([runs.y[0], runs.x0[0], runs.x1[0]]).toEqual([1, 1, 1]);
  });

  it('works on empty masks', () => {
    const r = labelComponents(createMask(5, 4));
    expect(r.count).toBe(0);
    expect(r.stats).toEqual([]);
  });
});

describe('componentMask', () => {
  it('extracts one component with padding, clipped at the image border', () => {
    const m = fromRows([
      '##..#',
      '#...#',
      '...##',
    ]);
    const { labels, stats } = labelComponents(m);
    const a = componentMask(labels, 5, 1, stats[0].bbox, 1);
    expect(a.width).toBe(4);
    expect(a.height).toBe(4);
    expect(Array.from(a.data)).toEqual([
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 0, 0,
      0, 0, 0, 0,
    ]);
    const b = componentMask(labels, 5, 2, stats[1].bbox);
    expect(Array.from(b.data)).toEqual([0, 1, 0, 1, 1, 1]);
  });
});

describe('removeSmallComponents', () => {
  it('drops components below minArea', () => {
    const m = fromRows([
      '#....##',
      '.....##',
      '.#.....',
      '.#.###.',
    ]);
    expect(Array.from(removeSmallComponents(m, 3).data)).toEqual(Array.from(fromRows([
      '.....##',
      '.....##',
      '.......',
      '...###.',
    ]).data));
    // Areas: 1 (single pixel), 2 (vertical pair), 4 (square), 3 (bar).
    expect(maskArea(removeSmallComponents(m, 2))).toBe(9);
    expect(maskArea(removeSmallComponents(m, 2, 4))).toBe(9);
  });
});
