import { describe, expect, it } from 'vitest';
import { rgbaToLab, rgbToLab } from './color';
import { createRGBA } from './image';

describe('rgbaToLab (lookup-table fast path)', () => {
  it('matches the exact per-pixel conversion', () => {
    const img = createRGBA(64, 64);
    let seed = 7;
    for (let i = 0; i < img.data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = i % 4 === 3 ? 255 : seed & 255;
    }
    // Include the extremes.
    img.data.set([0, 0, 0, 255, 255, 255, 255, 255, 1, 2, 3, 255], 0);
    const lab = rgbaToLab(img);
    let worst = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const exact = rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(exact[c] - lab.data[i * 3 + c]));
    }
    expect(worst).toBeLessThan(0.01);
  });
});
