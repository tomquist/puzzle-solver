/**
 * The matcher's fast paths give exactly what the plain computations give (the speed-ups must not
 * change a single result): the prefilter threshold by quickselect, two window scores in one pass,
 * the dense score map four positions at a time, and the remembered patch lattice fits.
 */
import { describe, expect, it } from 'vitest';
import { createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { Rng } from '../../testing/synth';
import { fitPatchLattice, type PatchLattice } from '../pieces/patchLattice';
import { kthSmallest } from './matchRegion';
import { buildReferenceIndex } from './referenceIndex';
import { buildTemplate, DEFAULT_SCORE, makePhotoSource, scoreAt, scoreMap, scorePair } from './template';

/** Smooth random colour blobs (a texture the score varies over). */
function texture(w: number, h: number, seed: number): RGBAImage {
  const rng = new Rng(seed);
  const img = createRGBA(w, h, [0, 0, 0, 255]);
  const blobs = Array.from({ length: 40 }, () => ({ x: rng.uniform(0, w), y: rng.uniform(0, h), r: rng.uniform(8, 40), c: [rng.uniform(0, 255), rng.uniform(0, 255), rng.uniform(0, 255)] }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        let v = 128;
        for (const b of blobs) v += 0.4 * (b.c[k] - 128) * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.r * b.r));
        img.data[i + k] = v + rng.uniform(-6, 6);
      }
    }
  }
  return img;
}

function ellipse(w: number, h: number): Mask {
  const m = createMask(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - w / 2) / (0.45 * w)) ** 2 + ((y - h / 2) / (0.4 * h)) ** 2 <= 1) m.data[y * w + x] = 1;
  return m;
}

describe('kthSmallest', () => {
  it('is the value sorting puts at k, with duplicates and ±0', () => {
    const rng = new Rng(3);
    for (const n of [1, 2, 3, 7, 100, 1001]) {
      for (const levels of [3, 50, 1e6]) {
        const a = Float32Array.from({ length: n }, () => Math.round(rng.uniform(-1, 1) * levels) / levels);
        const sorted = Float32Array.from(a).sort();
        for (const k of [0, n >> 1, Math.floor(n * 0.9) - 1, n - 1].filter((k) => k >= 0)) {
          expect(kthSmallest(a, k) === sorted[k]).toBe(true);
        }
      }
    }
  });
});

describe('scores', () => {
  const index = buildReferenceIndex(texture(320, 240, 1), { rows: 6, cols: 8 }, 'grid');
  const crop = texture(90, 80, 2);
  const src = makePhotoSource(crop, ellipse(90, 80), { x: 100, y: 60 }, 2, index.channelWeights);
  const map = { pivot: src.centroid, phi: 0.3, s: 0.7 };

  it('scores two positions in one pass as one at a time (neighbours in a row and in a column)', () => {
    for (const li of [1, 2, 3]) {
      const level = index.levels[li];
      const t = buildTemplate(src, map, level)!;
      const out = new Float64Array(2);
      for (const d of [1, level.stride, level.stride + 2]) {
        const pos = 5 * level.stride + 6;
        scorePair(level, t, pos, d, DEFAULT_SCORE, out);
        expect(Number.isFinite(out[0]) && Object.is(out[0], scoreAt(level, t, 6, 5, DEFAULT_SCORE))).toBe(true);
        const p1 = pos + d;
        expect(Object.is(out[1], scoreAt(level, t, p1 % level.stride, Math.floor(p1 / level.stride), DEFAULT_SCORE))).toBe(true);
      }
    }
  });

  it('scores a row of the dense map four at a time as one at a time', () => {
    for (const li of [0, 1]) {
      const level = index.levels[li];
      const t = buildTemplate(src, map, level, 0.6, 5)!;
      const x0 = 1, x1 = Math.min(level.stride - t.w, 23), y = 3;
      const row = new Float32Array(x1 - x0 + 1);
      scoreMap(level, t, x0, x1, y, y, { ...DEFAULT_SCORE, hinge: 0.4 }, row);
      for (let x = x0; x <= x1; x++) {
        const one = new Float32Array(1);
        scoreMap(level, t, x, x, y, y, { ...DEFAULT_SCORE, hinge: 0.4 }, one);
        expect(Number.isFinite(one[0]) && Object.is(row[x - x0], one[0])).toBe(true);
      }
    }
  });
});

describe('fitPatchLattice (remembered)', () => {
  it('fits again exactly as afresh, and callers cannot change what it remembers', () => {
    const image = texture(200, 160, 4);
    // Dark seams every 40 px in a block mask.
    const mask = createMask(200, 160);
    for (let y = 10; y < 150; y++) for (let x = 12; x < 190; x++) mask.data[y * 200 + x] = 1;
    for (let y = 0; y < 160; y++) for (let x = 0; x < 200; x++) if (x % 40 === 3 || y % 40 === 7) for (let k = 0; k < 3; k++) image.data[(y * 200 + x) * 4 + k] = 20;
    const prior: PatchLattice = { origin: { x: 41, y: 45 }, angle: 0.01, pa: 41, pb: 39.5, strength: [-1, -1] };
    const first = fitPatchLattice(image, mask, prior);
    const fresh = fitPatchLattice(image, { ...mask, data: mask.data.slice() }, prior);
    expect(first).toEqual(fresh);
    first.origin.x += 5;
    first.strength[0] = 9;
    expect(fitPatchLattice(image, mask, prior)).toEqual(fresh);
  });
});
