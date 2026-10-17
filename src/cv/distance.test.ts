import { describe, expect, it } from 'vitest';
import { distanceTransform, squaredDistanceTransform } from './distance';
import { createMask, type Mask } from './image';

function randomMask(w: number, h: number, density: number, seed: number): Mask {
  let s = seed >>> 0;
  const m = createMask(w, h);
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    m.data[i] = s / 2 ** 32 < density ? 1 : 0;
  }
  return m;
}

function bruteSq(m: Mask, target: 0 | 1, outside: boolean): Float32Array {
  const { width: w, height: h } = m;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      if (outside) best = Math.min((x + 1) ** 2, (w - x) ** 2, (y + 1) ** 2, (h - y) ** 2);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          if ((m.data[yy * w + xx] !== 0 ? 1 : 0) === target) best = Math.min(best, (x - xx) ** 2 + (y - yy) ** 2);
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

describe('distance transform', () => {
  it('matches brute force on random masks (both targets, with and without outside)', () => {
    for (const [density, seed] of [[0.05, 1], [0.5, 2], [0.95, 3], [0.995, 4]] as const) {
      const m = randomMask(23, 17, density, seed);
      for (const target of [0, 1] as const) {
        for (const outside of [false, true]) {
          const fast = squaredDistanceTransform(m, target, outside);
          const ref = bruteSq(m, target, outside);
          for (let i = 0; i < ref.length; i++) expect(fast[i]).toBe(ref[i]);
        }
      }
    }
  });

  it('distanceTransform: 0 on unset pixels, Euclidean distance inside', () => {
    const m = createMask(9, 9);
    for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) m.data[y * 9 + x] = 1;
    const d = distanceTransform(m);
    expect(d.data[0]).toBe(0);
    expect(d.data[1 * 9 + 1]).toBe(1);
    expect(d.data[4 * 9 + 4]).toBe(4);
    expect(d.data[2 * 9 + 2]).toBe(2);
  });

  it('handles fully set masks (Infinity unless outsideIsUnset) and empty masks', () => {
    const full = createMask(5, 3);
    full.data.fill(1);
    expect(distanceTransform(full).data[7]).toBe(Infinity);
    const d = distanceTransform(full, { outsideIsUnset: true });
    expect(Array.from(d.data.slice(5, 10))).toEqual([1, 2, 2, 2, 1]);
    expect(Array.from(distanceTransform(createMask(4, 4)).data).every((v) => v === 0)).toBe(true);
  });
});
