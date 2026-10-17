/**
 * Box-detection benchmark: synthetic box photos with known picture quads → detectBox → corner error.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../src/cv/image';
import { drawPolygon } from '../src/cv/raster';
import { detectBox } from '../src/pipeline/box';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../src/testing/nodeImageIO';
import { renderBoxPhoto, type BoxPhotoOptions } from '../src/testing/synth';
import { compareToBaseline, yieldToEventLoop, quadError, report, saveBaselineSuite, UPDATE_BASELINE, type MetricRecord } from './lib';

interface BoxScenario {
  name: string;
  options: (seed: number) => BoxPhotoOptions;
  seeds: number[];
}

const SEEDS = [1, 2, 3, 4, 5, 6];
const SCENARIOS: BoxScenario[] = [
  { name: 'framed-lid-wood', seeds: SEEDS, options: (seed) => ({ seed, frameWidth: 0.07, background: 'wood', perspective: 0.06 }) },
  { name: 'borderless-plain', seeds: SEEDS, options: (seed) => ({ seed, frameWidth: 0, background: 'plain', perspective: 0.05 }) },
  { name: 'strong-perspective', seeds: SEEDS, options: (seed) => ({ seed, frameWidth: 0.05, perspective: 0.11 }) },
  { name: 'noisy-dim', seeds: SEEDS, options: (seed) => ({ seed, frameWidth: 0.06, noiseSigma: 6, blurSigma: 1, gain: 0.7, illumination: 0.25 }) },
];

const results: Record<string, MetricRecord> = {};

describe('box benchmark', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const errors: number[] = [];
      let falseWarnings = 0;
      let ms = 0;
      for (const painting of ['starry-night', 'great-wave'] as const) {
        const ref: RGBAImage = loadTestAsset(painting);
        for (const seed of s.seeds) {
          await yieldToEventLoop();
          const box = renderBoxPhoto(ref, { width: 1800, height: 1350, ...s.options(seed) });
          const t0 = performance.now();
          const det = detectBox(box.photo);
          ms += performance.now() - t0;
          const err = quadError(det.quad, box.pictureQuad);
          errors.push(err);
          if (s.name !== 'noisy-dim') falseWarnings += det.quality.issues.filter((i) => i.severity !== 'info').length;
          if (DEBUG_IMAGES && err > 0.015) {
            const out = { ...box.photo, data: new Uint8ClampedArray(box.photo.data) };
            drawPolygon(out, box.pictureQuad, [255, 255, 255, 255], 2);
            drawPolygon(out, det.quad, [255, 40, 40, 255], 2);
            savePng(`.debug/bench/box-${s.name}-${painting}-${seed}.png`, out);
          }
        }
      }
      const rec: MetricRecord = {
        scenes: errors.length,
        successRate: errors.filter((e) => e <= 0.015).length / errors.length,
        meanError: errors.reduce((a, b) => a + b, 0) / errors.length,
        falseWarnings,
        ms: ms / errors.length,
      };
      results[s.name] = rec;
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('box', s.name, rec);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  afterAll(() => {
    console.log('\n' + report('box', results, ['scenes', 'successRate', 'meanError', 'falseWarnings', 'ms']) + '\n');
    if (UPDATE_BASELINE) saveBaselineSuite('box', results);
  });
});
