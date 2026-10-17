import { describe, expect, it } from 'vitest';
import { rgbaToGray } from '../../cv/color';
import { gaussianBlurGray } from '../../cv/filter';
import { createRGBA, maskArea } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { blurMetric, exposureStats, glareMask, laplacianVariance, noiseSigma } from './metrics';

describe('quality metrics', () => {
  const img = resizeRGBA(loadTestAsset('starry-night'), 640, 507);
  const gray = rgbaToGray(img);

  it('blur metric increases monotonically with blur and ignores contrast', () => {
    const values = [0, 1, 2, 4].map((s) => blurMetric(s === 0 ? gray : gaussianBlurGray(gray, s)));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[0]).toBeLessThan(0.5);
    expect(values[3]).toBeGreaterThan(0.6);
    const lowContrast = { ...gray, data: gray.data.map((v) => 100 + v * 0.3) };
    expect(Math.abs(blurMetric(lowContrast) - values[0])).toBeLessThan(0.05);
    expect(laplacianVariance(gray)).toBeGreaterThan(laplacianVariance(gaussianBlurGray(gray, 2)));
  });

  it('measures exposure and glare', () => {
    const white = createRGBA(10, 10, [255, 255, 255, 255]);
    expect(exposureStats(white).clippedHigh).toBe(1);
    expect(maskArea(glareMask(white))).toBe(100);
    const e = exposureStats(img);
    expect(e.mean).toBeGreaterThan(0.1);
    expect(e.mean).toBeLessThan(0.9);
  });

  it('estimates noise', () => {
    const flat = rgbaToGray(createRGBA(200, 200, [120, 120, 120, 255]));
    expect(noiseSigma(flat)).toBeLessThan(0.01);
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const noisy = { ...flat, data: flat.data.map((v) => {
      const g = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
      return v + 8 * g;
    }) };
    expect(noiseSigma(noisy)).toBeGreaterThan(6);
    expect(noiseSigma(noisy)).toBeLessThan(10);
  });
});
