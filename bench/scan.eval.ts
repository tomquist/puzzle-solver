/**
 * End-to-end scan benchmark: synthetic piece photos → analyzeScan (segmentation, shapes, quality,
 * matching, fits) → metrics against ground truth, gated by bench/baseline.json.
 *
 *   npm run bench                     # run and compare with the baseline
 *   UPDATE_BASELINE=1 npm run bench   # accept the current numbers as the new baseline
 *   DEBUG_IMAGES=1 npm run bench      # also write overlays to .debug/bench/
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../src/cv/image';
import { rectifyQuad } from '../src/cv/warp';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { detectBox, suggestRectifiedSize } from '../src/pipeline/box';
import { buildReferenceIndex } from '../src/pipeline/match';
import type { GridSpec } from '../src/model/types';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../src/testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderBoxPhoto, renderPiecesPhoto, Rng, type RenderOptions, type RGB } from '../src/testing/synth';
import { average, compareToBaseline, yieldToEventLoop, evaluateScan, overlay, pickItems, report, saveBaselineSuite, UPDATE_BASELINE, type ItemSpec, type MetricRecord } from './lib';

interface Scenario {
  name: string;
  painting: 'starry-night' | 'great-wave';
  grid: GridSpec;
  items: ItemSpec;
  seeds: number[];
  render: (rng: Rng) => RenderOptions;
  /** Go through box photo → detectBox → rectify instead of using the painting directly. */
  viaBoxPhoto?: boolean;
  /** Clean scenarios must not raise warnings. */
  clean?: boolean;
}

const gain = (rng: Rng, spread: number): RGB => [rng.uniform(1 - spread, 1 + spread), rng.uniform(1 - spread, 1 + spread), rng.uniform(1 - spread, 1 + spread)];

const standard = (rng: Rng): RenderOptions => ({
  background: [38, 40, 46],
  noiseSigma: 3,
  blurSigma: 0.7,
  gain: gain(rng, 0.1),
  illumination: 0.1,
});

const SCENARIOS: Scenario[] = [
  { name: 'starry-320-dark', painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 24 }, seeds: [1, 2], render: standard, clean: true },
  { name: 'wave-1000-dark', painting: 'great-wave', grid: { rows: 25, cols: 40 }, items: { singles: 30 }, seeds: [1, 2], render: standard, clean: true },
  {
    name: 'starry-light-table',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 24 }, seeds: [3],
    render: (rng) => ({ ...standard(rng), background: [226, 222, 214], illumination: 0.15 }),
  },
  {
    name: 'wave-wood-table',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 24 }, seeds: [4],
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], backgroundTexture: 16, illumination: 0.2 }),
  },
  {
    name: 'starry-patches',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 10, patches: [[2, 2], [2, 3], [1, 3]] }, seeds: [5, 6],
    render: standard,
  },
  {
    name: 'wave-edges',
    painting: 'great-wave', grid: { rows: 25, cols: 40 }, items: { singles: 24, bordersOnly: true }, seeds: [7],
    render: standard, clean: true,
  },
  {
    name: 'starry-noisy-blurry',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [8],
    render: (rng) => ({ ...standard(rng), noiseSigma: 7, blurSigma: 1.4, gain: gain(rng, 0.18), illumination: 0.25 }),
  },
  {
    name: 'starry-via-box-photo',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [9],
    render: standard, viaBoxPhoto: true,
  },
  {
    name: 'wave-via-box-photo',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [10],
    render: standard, viaBoxPhoto: true,
  },
  // Assembled grids (seams, small gaps, slightly misaligned pieces) mixed with loose pieces.
  {
    name: 'starry-grids-dark',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 8, patches: [[2, 2], [3, 3], [4, 5]] }, seeds: [11, 12],
    render: standard,
  },
  {
    name: 'starry-grids-light',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 8, patches: [[2, 3], [3, 4], [1, 3]] }, seeds: [13],
    render: (rng) => ({ ...standard(rng), background: [226, 222, 214], illumination: 0.15 }),
  },
  {
    name: 'wave-grids-wood',
    painting: 'great-wave', grid: { rows: 25, cols: 40 }, items: { singles: 8, patches: [[2, 3], [3, 3], [4, 5]] }, seeds: [14, 15],
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], backgroundTexture: 16, illumination: 0.2 }),
  },
  {
    name: 'wave-grids-dark',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 6, patches: [[2, 2], [3, 4], [4, 5]] }, seeds: [16],
    render: standard,
  },
  // Loose pieces of neighbouring cells photographed together.
  {
    name: 'starry-neighbors',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 8, neighborRuns: [2, 2, 3, 2] }, seeds: [17, 18],
    render: standard,
  },
  {
    name: 'wave-neighbors-wood',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 8, neighborRuns: [2, 3, 2, 2] }, seeds: [19],
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], backgroundTexture: 16, illumination: 0.2 }),
  },
  // Real-photo conditions (src/testing/synth.ts RenderOptions): cardboard rim and directional cast
  // shadows, structured tables, phone JPEG + vignetting, objects cut by the photo border, uneven
  // light with glare, pieces 1–3 px apart or slightly overlapping.
  {
    name: 'starry-rim-shadow-dark',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [20],
    render: (rng) => ({ ...standard(rng), rim: {}, edgeDarkening: 0.15, shadow: 0.45, shadowOffset: [6, 4], shadowBlur: 3.5 }),
  },
  {
    name: 'wave-rim-shadow-light',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [21],
    render: (rng) => ({ ...standard(rng), background: [226, 222, 214], illumination: 0.15, rim: {}, edgeDarkening: 0.15, shadow: 0.5, shadowOffset: [8, 5], shadowBlur: 4.5 }),
  },
  {
    name: 'wave-woodgrain',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [22],
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], pattern: { kind: 'wood' }, illumination: 0.15 }),
  },
  {
    name: 'starry-weave',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [23],
    render: (rng) => ({ ...standard(rng), background: [120, 128, 120], pattern: { kind: 'weave' } }),
  },
  {
    name: 'wave-gingham',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [24],
    render: (rng) => ({ ...standard(rng), pattern: { kind: 'check' } }),
  },
  {
    name: 'starry-dots',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [25],
    render: (rng) => ({ ...standard(rng), pattern: { kind: 'dots' } }),
  },
  {
    name: 'wave-jpeg-vignette',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [26],
    render: (rng) => ({ ...standard(rng), noiseSigma: 4, jpegQuality: 70, vignette: 0.35, illumination: 0.15 }),
  },
  {
    name: 'starry-border-clutter',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 16 }, seeds: [27],
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], backgroundTexture: 12, clutter: ['box-edge', 'table-edge', 'finger'] }),
  },
  {
    name: 'wave-glare-uneven',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [28],
    render: (rng) => ({ ...standard(rng), background: [90, 96, 104], illumination: 0.35, glare: { count: 4 } }),
  },
  {
    name: 'starry-close-pairs',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [29],
    render: (rng) => ({ ...standard(rng), pairs: { count: 6, gap: [-3, 3] } }),
  },
];

const COLUMNS = [
  'segRecall', 'segPrecision', 'shapeRate', 'kindAccuracy', 'top1', 'top3', 'rotationOk', 'confidentPrecision', 'confidentRate',
  'fitPrecision', 'fitRecall', 'assembledRecall', 'assembledPrecision', 'neighborPrecision', 'neighborRecall', 'hiddenRate', 'warnings', 'ms',
];
const results: Record<string, MetricRecord> = {};
const paintings = new Map<string, RGBAImage>();
const painting = (name: Scenario['painting']) => {
  if (!paintings.has(name)) paintings.set(name, loadTestAsset(name));
  return paintings.get(name)!;
};

/** The reference the app would build: the painting itself, or the rectified box photo. */
function makeReference(s: Scenario, seed: number): RGBAImage {
  const src = painting(s.painting);
  if (!s.viaBoxPhoto) return perturbReference(src, { seed });
  const box = renderBoxPhoto(perturbReference(src, { seed }), { seed, width: 2000, height: 1500 });
  const detection = detectBox(box.photo);
  const size = suggestRectifiedSize(detection.quad, src.width / src.height);
  return rectifyQuad(box.photo, detection.quad, size.width, size.height);
}

describe('scan benchmark', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const perSeed: MetricRecord[] = [];
      for (const seed of s.seeds) {
        await yieldToEventLoop();
        const src = painting(s.painting);
        const cut = generateJigsaw(s.grid.rows, s.grid.cols, src.width, src.height, seed);
        const reference = makeReference(s, seed);
        const index = buildReferenceIndex(reference, s.grid, 'grid');
        const items = pickItems(cut, s.items, seed);
        const rng = new Rng(seed * 13 + 3);
        const { photo, truth } = renderPiecesPhoto(src, cut, items, { seed: seed + 50, ...s.render(rng) });
        const t0 = performance.now();
        const { result } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height) });
        const ms = performance.now() - t0;
        const { metrics, regionToTruth } = evaluateScan(result, truth, cut, ms);
        perSeed.push({ ...metrics });
        if (DEBUG_IMAGES) savePng(`.debug/bench/${s.name}-${seed}.png`, overlay(photo, result, truth, cut, regionToTruth));
      }
      const avg = average(perSeed);
      results[s.name] = avg;
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('scan', s.name, avg);
      if (s.clean) expect(avg.warnings, `${s.name}: clean photos must not raise warnings`).toBe(0);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  afterAll(() => {
    console.log('\n' + report('scan', results, COLUMNS) + '\n');
    if (UPDATE_BASELINE) saveBaselineSuite('scan', results);
  });
});
