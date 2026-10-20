/**
 * Table colour along the grain (grain.ts): stripe orientation from the structure tensor, robust
 * sliding means along a line, and the fitted model on a synthetic grained table – the stripes are
 * explained (grain-free sigma far below their spread), also right next to an excluded piece, while
 * a plain noisy table gets no grain model.
 */
import { describe, expect, it } from 'vitest';
import { rgbToLab } from '../../cv/color';
import { createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { Rng } from '../../testing/synth';
import { fitGrainTable, lineMeans, stripeOrientation } from './grain';

describe('stripeOrientation', () => {
  it('reads stripes perpendicular to the dominant gradient', () => {
    // Horizontal stripes: the gradient is vertical (jyy dominates).
    const h = stripeOrientation(0.1, 10, 0);
    expect(Math.min(h.angle, 180 - h.angle)).toBeLessThan(1);
    expect(h.coherence).toBeGreaterThan(0.95);
    const v = stripeOrientation(10, 0.1, 0);
    expect(Math.abs(v.angle - 90)).toBeLessThan(1);
    // Diagonal stripes from y = x (gradient along (1, −1)).
    const d = stripeOrientation(5, 5, -5);
    expect(Math.abs(d.angle - 45)).toBeLessThan(1);
  });

  it('has no coherence without a direction', () => {
    expect(stripeOrientation(3, 3, 0).coherence).toBeLessThan(1e-9);
    expect(stripeOrientation(0, 0, 0).coherence).toBe(0);
  });
});

describe('lineMeans', () => {
  const run = (vals: number[][], ok: number[], reach: number, minCount: number) => {
    const n = vals.length;
    const v = new Float32Array(vals.flat()), out = new Float32Array(n * 3);
    lineMeans(v, Uint8Array.from(ok), n, reach, minCount, [1, 1, 1], out, new Float64Array((n + 1) * 4), new Uint8Array(n));
    return Array.from({ length: n }, (_, i) => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
  };

  it('averages the table samples within reach and skips excluded ones', () => {
    const vals = Array.from({ length: 20 }, (_, i) => (i >= 8 && i < 12 ? [90, 40, 40] : [50, 5, 20]));
    const ok = vals.map((_, i) => (i >= 8 && i < 12 ? 0 : 1));
    const m = run(vals, ok, 5, 3);
    for (const p of m) expect(p).toEqual([50, 5, 20]);
  });

  it('leaves an outlier out of the second pass', () => {
    const vals = Array.from({ length: 21 }, (_, i) => (i === 10 ? [80, 5, 20] : [50 + (i % 2), 5, 20]));
    const m = run(vals, vals.map(() => 1), 10, 3);
    expect(m[10][0]).toBeCloseTo(50.5, 0);
  });

  it('takes the side of a change of light that the sample is on', () => {
    const vals = Array.from({ length: 30 }, (_, i) => (i < 15 ? [60, 8, 22] : [40, 6, 16]));
    const m = run(vals, vals.map(() => 1), 8, 4);
    for (let i = 0; i < 30; i++) expect(m[i][0]).toBeCloseTo(i < 15 ? 60 : 40, 5);
  });

  it('gives no estimate where too few table samples are in reach', () => {
    const vals = Array.from({ length: 12 }, () => [50, 5, 20]);
    const ok = vals.map((_, i) => (i < 2 ? 1 : 0));
    const m = run(vals, ok, 3, 3);
    expect(Number.isNaN(m[8][0])).toBe(true);
  });
});

/**
 * A wood table: stripes along `angleDeg` whose lightness and warmth vary from stripe to stripe
 * (2–6 px wide) plus pixel noise, and a few flat green rectangles ("pieces"); returns the photo and
 * the pieces' mask.
 */
function grainedTable(angleDeg: number, seed: number, grain = true): { img: RGBAImage; pieces: Mask } {
  const W = 600, H = 450;
  const rng = new Rng(seed);
  const img = createRGBA(W, H);
  const pieces = createMask(W, H);
  const rad = (angleDeg * Math.PI) / 180, nx = -Math.sin(rad), ny = Math.cos(rad);
  // Stripe profile across the grain.
  const prof: number[] = [];
  for (let k = 0; k < 2000; ) {
    const width = Math.round(rng.uniform(2, 6)), v = grain ? rng.uniform(-18, 18) : 0;
    for (let j = 0; j < width; j++, k++) prof.push(v);
  }
  const rects = [{ x: 120, y: 100, w: 90, h: 130 }, { x: 330, y: 220, w: 140, h: 90 }];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // Linear interpolation across the grain (a lens blurs the stripes; no staircase aliasing).
      const across = Math.max(0, Math.min(prof.length - 2, x * nx + y * ny + 1000));
      const a0 = Math.floor(across), f = across - a0;
      const s = prof[a0] * (1 - f) + prof[a0 + 1] * f;
      const inPiece = rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      if (inPiece) {
        pieces.data[y * W + x] = 1;
        img.data[o] = 80 + rng.uniform(-3, 3); img.data[o + 1] = 150 + rng.uniform(-3, 3); img.data[o + 2] = 70 + rng.uniform(-3, 3);
      } else {
        img.data[o] = 170 + s + rng.uniform(-2, 2); img.data[o + 1] = 120 + 0.8 * s + rng.uniform(-2, 2); img.data[o + 2] = 75 + 0.5 * s + rng.uniform(-2, 2);
      }
      img.data[o + 3] = 255;
    }
  }
  return { img, pieces };
}

describe('fitGrainTable', () => {
  for (const angle of [0, 25, 70]) {
    it(`explains wood grain at ${angle}° next to the pieces`, () => {
      const { img, pieces } = grainedTable(angle, 7 + angle);
      const g = fitGrainTable(img, pieces, 110, [6, 2, 3]);
      expect(g).not.toBeNull();
      expect(g!.coherence).toBeGreaterThan(0.5);
      // The stripes spread the table's lightness; along the grain little more than noise is left.
      const L: number[] = [];
      for (let i = 0; i < pieces.data.length; i += 7) {
        if (pieces.data[i]) continue;
        L.push(rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2])[0]);
      }
      const mean = L.reduce((a, v) => a + v, 0) / L.length;
      const spread = Math.sqrt(L.reduce((a, v) => a + (v - mean) ** 2, 0) / L.length);
      expect(g!.sigma[0]).toBeLessThan(0.6 * spread);
      // Table pixels right next to a piece: the estimate is their own stripe's colour.
      let worst = 0;
      for (const [x, y] of [[117, 160], [212, 160], [160, 97], [160, 233], [327, 260], [472, 260]]) {
        const p = (y * img.width + x) * 4;
        const lab = rgbToLab(img.data[p], img.data[p + 1], img.data[p + 2]);
        const i = (y * g!.width + x) * 3;
        expect(Number.isNaN(g!.lab[i])).toBe(false);
        worst = Math.max(worst, Math.abs(g!.lab[i] - lab[0]));
      }
      expect(worst).toBeLessThan(4);
    });
  }

  it('finds no grain on a plain table', () => {
    const { img, pieces } = grainedTable(0, 3, false);
    expect(fitGrainTable(img, pieces, 110, [2, 1, 1])).toBeNull();
  });
});
