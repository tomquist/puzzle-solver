import { describe, expect, it } from 'vitest';
import { createGray, createMask, maskArea } from './image';
import { adaptiveThreshold, otsuThreshold, threshold } from './threshold';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function gaussian(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
}

describe('otsuThreshold', () => {
  it('splits two clean levels in the middle with separability 1', () => {
    const g = createGray(10, 10, 50);
    for (let i = 0; i < 40; i++) g.data[i] = 200;
    const r = otsuThreshold(g);
    expect(r.threshold).toBeGreaterThan(120);
    expect(r.threshold).toBeLessThan(130);
    expect(r.separability).toBeCloseTo(1, 9);
    expect(maskArea(threshold(g, r.threshold))).toBe(40);
  });

  it('bins integer 0..255 data exactly (threshold at k + 0.5)', () => {
    const g = createGray(4, 1);
    g.data.set([0, 100, 101, 255]);
    const r = otsuThreshold(g);
    expect(r.threshold - Math.floor(r.threshold)).toBeCloseTo(0.5, 9);
    expect(r.threshold).toBeGreaterThan(101);
    expect(r.threshold).toBeLessThan(255);
    expect(Array.from(threshold(g, r.threshold).data)).toEqual([0, 0, 0, 1]);
  });

  it('finds the valley between two noisy modes and rates separability', () => {
    const rnd = lcg(5);
    const g = createGray(200, 100);
    for (let i = 0; i < g.data.length; i++) g.data[i] = i % 10 < 3 ? 60 + 10 * gaussian(rnd) : 180 + 12 * gaussian(rnd);
    const r = otsuThreshold(g);
    expect(r.threshold).toBeGreaterThan(105);
    expect(r.threshold).toBeLessThan(135);
    expect(r.separability).toBeGreaterThan(0.85);
    const uni = createGray(200, 100);
    for (let i = 0; i < uni.data.length; i++) uni.data[i] = 120 + 20 * gaussian(rnd);
    const u = otsuThreshold(uni);
    expect(u.separability).toBeLessThan(0.7);
    expect(u.threshold).toBeGreaterThan(110);
    expect(u.threshold).toBeLessThan(130);
  });

  it('honours the mask and handles constant / empty input', () => {
    const g = createGray(6, 1);
    g.data.set([10, 10, 90, 90, 1000, 1000]);
    const mask = createMask(6, 1);
    mask.data.set([1, 1, 1, 1, 0, 0]);
    const r = otsuThreshold(g, mask, 64);
    expect(r.threshold).toBeGreaterThan(10);
    expect(r.threshold).toBeLessThan(90);
    expect(otsuThreshold(createGray(3, 3, 7))).toEqual({ threshold: 7, separability: 0 });
    expect(otsuThreshold(g, createMask(6, 1))).toEqual({ threshold: 0, separability: 0 });
  });
});

describe('threshold / adaptiveThreshold', () => {
  it('threshold is strict (value > t)', () => {
    const g = createGray(3, 1);
    g.data.set([1, 2, 3]);
    expect(Array.from(threshold(g, 2).data)).toEqual([0, 0, 1]);
  });

  it('adaptive threshold finds bright blobs on an illumination gradient', () => {
    const w = 120, h = 60;
    const g = createGray(w, h);
    const truth = createMask(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.data[y * w + x] = (200 * x) / w;
    for (const [bx, by] of [[10, 10], [55, 30], [100, 45]]) {
      for (let y = by; y < by + 6; y++) for (let x = bx; x < bx + 6; x++) { g.data[y * w + x] += 50; truth.data[y * w + x] = 1; }
    }
    const m = adaptiveThreshold(g, 10, 20);
    expect(Array.from(m.data)).toEqual(Array.from(truth.data));
    // A global threshold cannot do this.
    const t = otsuThreshold(g).threshold;
    expect(maskArea(threshold(g, t))).toBeGreaterThan(1000);
  });
});
