import { describe, expect, it } from 'vitest';
import { fitColourGmm, gmmNegLogLik, gmmNegLogLikBest, likeliestComponent } from './gmm';

/** n colours around each centre (uniform noise of ± spread per channel), deterministic. */
function clusters(centres: number[][], n: number, spread: number): Float32Array {
  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out = new Float32Array(3 * n * centres.length);
  let k = 0;
  for (const c of centres) for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) out[k++] = c[ch] + (rnd() * 2 - 1) * spread;
  return out;
}

describe('colour GMM', () => {
  it('finds the clusters of a mixture and scores colours by them', () => {
    const centres = [[40, 50, 120], [200, 60, 70], [230, 220, 200]];
    const data = clusters(centres, 300, 8);
    const g = fitColourGmm(data, 900, { k: 3 })!;
    expect(g.k).toBe(3);
    // Every centre has a component mean within a few levels.
    for (const c of centres) {
      let best = Infinity;
      for (let q = 0; q < g.k; q++) best = Math.min(best, Math.hypot(g.mean[3 * q] - c[0], g.mean[3 * q + 1] - c[1], g.mean[3 * q + 2] - c[2]));
      expect(best).toBeLessThan(3);
    }
    // Colours of the mixture are far more likely than a colour between the clusters.
    expect(gmmNegLogLik(g, 200, 60, 70)).toBeLessThan(gmmNegLogLik(g, 120, 140, 130) - 20);
    // The best component's term bounds the mixture's from above, within log k.
    const full = gmmNegLogLik(g, 45, 52, 118), best = gmmNegLogLikBest(g, 45, 52, 118);
    expect(best).toBeGreaterThanOrEqual(full - 1e-9);
    expect(best - full).toBeLessThan(Math.log(3) + 1e-9);
    expect(likeliestComponent(g, 230, 220, 200)).not.toBe(likeliestComponent(g, 40, 50, 120));
  });

  it('is deterministic and copes with few or identical samples', () => {
    const data = clusters([[100, 100, 100], [150, 90, 60]], 200, 5);
    const a = fitColourGmm(data, 400)!, b = fitColourGmm(data, 400)!;
    expect(Array.from(a.mean)).toEqual(Array.from(b.mean));
    // 20 samples: at most one component per 12 samples.
    expect(fitColourGmm(data, 20)!.k).toBe(1);
    // All alike: the variance floor keeps the model finite.
    const same = new Float32Array(3 * 50).fill(128);
    const g = fitColourGmm(same, 50)!;
    expect(Number.isFinite(gmmNegLogLik(g, 128, 128, 128))).toBe(true);
    expect(gmmNegLogLik(g, 128, 128, 128)).toBeLessThan(gmmNegLogLik(g, 140, 128, 128));
    expect(fitColourGmm(same, 0)).toBeNull();
  });
});
