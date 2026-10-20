/**
 * End-to-end scan benchmark: synthetic piece photos → analyzeScan (segmentation, shapes, quality,
 * matching, fits) → metrics against ground truth, gated by bench/baseline.json.
 *
 *   npm run bench                     # run and compare with the baseline
 *   UPDATE_BASELINE=1 npm run bench   # accept the current numbers as the new baseline
 *   DEBUG_IMAGES=1 npm run bench      # also write overlays to .debug/bench/
 *   GRAPH_CUT=1 npm run bench         # A/B: with the graph-cut outline refinement (0: without)
 *   CONSISTENCY=1 npm run bench       # A/B: with the consistency pass of the placements (0: without)
 *
 * outlineIoU / boundaryF (report only): outline accuracy of the regions matched to a truth item.
 * shapeFits / shapeFitsTrue (report only): mutually best side fits among the scan's pieces wherever
 * they are placed (`shapeFits`, the consistency pass's evidence), and those that are true neighbours.
 * ambFixed / ambBroken / ambConfirmed / confMoved / consistencyMs (report only, when the consistency
 * pass runs): single pieces that were not confident before it and now sit in the right cell having
 * been wrong / now sit wrong having been right / stay right and became confident; confident pieces
 * it moved; its runtime.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../src/cv/image';
import { resizeRGBA } from '../src/cv/resize';
import { rectifyQuad } from '../src/cv/warp';
import { analyzeScan, DEFAULT_SIDE_COMPARISON } from '../src/pipeline/analyzeScan';
import { detectBox, suggestRectifiedSize } from '../src/pipeline/box';
import { buildReferenceIndex, impliedPlacement, shapeFits } from '../src/pipeline/match';
import type { GridSpec } from '../src/model/types';
import { CONSISTENCY, DEBUG_IMAGES, loadTestAsset, savePng, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderBoxPhoto, renderPiecesPhoto, Rng, type RenderOptions, type RGB } from '../src/testing/synth';
import { angleError, average, compareToBaseline, yieldToEventLoop, evaluateScan, overlay, pickItems, report, saveBaselineSuite, UPDATE_BASELINE, type ItemSpec, type MetricRecord } from './lib';

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
  /** Recolour the painting (reference and pieces alike), e.g. part of it in dark wood tones. */
  tone?: (img: RGBAImage) => RGBAImage;
  /** Reference resolution relative to the painting (a high-resolution box picture: cells much larger than the pieces on the photo). */
  referenceScale?: number;
}

const gain = (rng: Rng, spread: number): RGB => [rng.uniform(1 - spread, 1 + spread), rng.uniform(1 - spread, 1 + spread), rng.uniform(1 - spread, 1 + spread)];

const standard = (rng: Rng): RenderOptions => ({
  background: [38, 40, 46],
  noiseSigma: 3,
  blurSigma: 0.7,
  gain: gain(rng, 0.1),
  illumination: 0.1,
});

/**
 * The painting with its lower part (below 40–50 % of the height) in dark tones of a wood table:
 * pieces from there look like deep shadow on that table, and the reference shows them alike.
 */
function darkWoodLowerPart(img: RGBAImage, wood: RGB, level = 0.5): RGBAImage {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < img.height; y++) {
    const t = Math.max(0, Math.min(1, (y / img.height - 0.4) / 0.1));
    if (t === 0) continue;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4, d = img.data;
      const f = level * (0.6 + (0.8 * (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])) / 255);
      for (let c = 0; c < 3; c++) out.data[i + c] = d[i + c] * (1 - t) + t * (0.75 * wood[c] * f + 0.25 * d[i + c] * level);
    }
  }
  return out;
}

/**
 * The painting with its lower half in a flat grey (a grey sky, grey stones) keeping a little of the
 * print's lightness detail (`detail`, relative): pieces from there show large areas of nearly one
 * colour, as plain as a table, and the reference shows them alike.
 */
function greyLowerPart(img: RGBAImage, grey: RGB, detail = 0.2): RGBAImage {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < img.height; y++) {
    const t = Math.max(0, Math.min(1, (y / img.height - 0.45) / 0.05));
    if (t === 0) continue;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4, d = img.data;
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      for (let c = 0; c < 3; c++) out.data[i + c] = d[i + c] * (1 - t) + t * grey[c] * (1 + detail * (l - 0.4));
    }
  }
  return out;
}

/** The painting's middle as a portrait picture (aspect 0.79, as a 2378 × 3000 box picture). */
function portraitCrop(img: RGBAImage): RGBAImage {
  const w = Math.round(0.79 * img.height), x0 = Math.round((img.width - w) / 2);
  const out = { width: w, height: img.height, data: new Uint8ClampedArray(w * img.height * 4) };
  for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x0 + w) * 4), y * w * 4);
  return out;
}

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
  // From real feedback (light wood-look tiles): dark gaps crossing under and next to pieces, a large
  // soft shadow from the border, pieces in dark tones of the table colour (the lower part of the
  // painting recoloured, so the reference shows them alike), and all of it together.
  {
    name: 'wave-plank-gaps',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 16, patches: [[2, 2]] }, seeds: [30],
    render: (rng) => ({ ...standard(rng), background: [196, 172, 140], pattern: { kind: 'planks', width: 260, gap: 12, tiles: true }, illumination: 0.15 }),
  },
  {
    name: 'starry-shadow-zone',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 20 }, seeds: [31],
    render: (rng) => ({ ...standard(rng), background: [206, 196, 178], shadowZone: { strength: 0.5 } }),
  },
  {
    name: 'wave-dark-wood-pieces',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 20 }, seeds: [32],
    tone: (img) => darkWoodLowerPart(img, [160, 140, 112], 0.55),
    render: (rng) => ({ ...standard(rng), background: [160, 140, 112], backgroundTexture: 22, noiseSigma: 4, jpegQuality: 80 }),
  },
  {
    name: 'starry-wood-tiles-real',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 14, patches: [[1, 2], [2, 2]] }, seeds: [33],
    tone: (img) => darkWoodLowerPart(img, [192, 170, 142]),
    render: (rng) => ({
      ...standard(rng), background: [192, 170, 142], pattern: { kind: 'planks', width: 300, gap: 14, tiles: true },
      shadowZone: { strength: 0.45 }, jpegQuality: 80, illumination: 0.15,
    }),
  },
  // From real feedback (a dense table with a half-built frame): about 50 pieces packed closely on a
  // light grey-green mat, a fifth of them in touching or overlapping pairs and more nearly touching,
  // an assembled strip of six, and a second, lighter surface with its own lighting under part of them.
  {
    name: 'starry-dense-touching',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 44, patches: [[1, 6]] }, seeds: [34],
    render: (rng) => ({
      ...standard(rng), background: [158, 160, 138], illumination: 0.15, margin: 5, packing: 1.5,
      pairs: { count: 10, gap: [-3, 2] }, secondSurface: {}, jpegQuality: 85,
    }),
  },
  // From real feedback (two surfaces, dark grey pieces): many pieces in dark greys of the table
  // colour scattered over a light grey table, next to an olive cloth. The dark grey is a piece
  // colour, not a further table colour, even where many of them lie along the photo border.
  {
    name: 'wave-dark-grey-two-surfaces',
    painting: 'great-wave', grid: { rows: 20, cols: 30 }, items: { singles: 36 }, seeds: [35],
    render: (rng) => ({
      ...standard(rng), background: [168, 171, 176], illumination: 0.15, margin: 4, packing: 1.7,
      darkPieces: { share: 0.6, level: 0.4 }, secondSurface: { color: [142, 134, 82] }, jpegQuality: 85,
    }),
  },
  // From real feedback (a tan board under the phone's shadow): assembled patches along all four
  // photo sides, cut off by them, cover nearly all of the border band; loose pieces lie in between,
  // a hard-edged rectangular shadow darkens the middle and water stains mark the board. Half of
  // the print is a nearly plain grey (a grey sky): the border band is mostly print, and its grey
  // looks like a table colour there. The table is the board.
  {
    name: 'starry-board-edge-patches',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, seeds: [36, 37], tone: (img) => greyLowerPart(img, [115, 115, 118]),
    items: { singles: 10, patches: [[2, 9], [2, 9], [2, 9], [2, 9], [2, 9], [2, 9], [2, 9], [2, 9]] },
    render: (rng) => ({
      ...standard(rng), background: [198, 162, 114], backgroundTexture: 10, illumination: 0.1, scale: 0.9, width: 1260, height: 1420,
      edgePatches: { gap: -24 }, hardShadow: { rect: [0.3, 0.35, 0.72, 1.1], strength: 0.3 }, stains: { count: 5 }, jpegQuality: 85,
    }),
  },
  // Blocks of neighbouring loose pieces from a plain area: the painting's lower half in a nearly
  // flat grey, the blocks around and below where it begins. Placement alone is ambiguous for most
  // of them, but their sides fit each other and some neighbours lie in the textured part. (Blocks
  // in the Great Wave's sky are no test: its paper grain places them confidently.)
  {
    name: 'starry-grey-neighbors',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, seeds: [38, 39], tone: (img) => greyLowerPart(img, [115, 115, 118]),
    items: { singles: 4, neighborBlocks: [[3, 3], [2, 3], [2, 3], [2, 2]], neighborArea: { rows: [0.3, 0.8], cols: [0, 1] } },
    render: standard,
  },
  // From real feedback (one large block on a light blue table): a single assembled block of about
  // 45 pieces with ragged sides and notches, turned 25–35°, and no loose piece in the photo, so the
  // scan has no single-piece size to go by.
  {
    name: 'starry-lone-block-turned',
    painting: 'starry-night', grid: { rows: 16, cols: 20 }, items: { singles: 0, blocks: [{ rows: 8, cols: 7, missing: 11 }] }, seeds: [38, 39],
    render: (rng) => ({ ...standard(rng), background: [196, 208, 218], illumination: 0.15, rotation: rng.uniform(25, 35) + 180 * rng.int(2) }),
  },
  // From real feedback (an 18-piece children's puzzle, 6 rows × 3 columns of a portrait picture:
  // cells 1.6× wider than tall, pieces ~3× a 1000-piece puzzle's on the photo): the puzzle
  // assembled but for two pieces taken out of its middle, which lie beside it. The block covers
  // its 16 cells, not the holes, and the loose pieces fit into the holes. The box picture's cells are
  // ~2.4× the pieces' size on the photo (as in the user's photos).
  {
    name: 'starry-portrait-18-holes',
    painting: 'starry-night', grid: { rows: 6, cols: 3 }, seeds: [40, 41], tone: portraitCrop, referenceScale: 1.6,
    items: { singles: 0, blocks: [{ rows: 6, cols: 3, missing: 0, holes: 2 }] },
    render: (rng) => ({ ...standard(rng), background: [200, 196, 190], illumination: 0.15, scale: 0.5, rim: {}, shadow: 0.35, shadowOffset: [5, 4], shadowBlur: 3 }),
  },
  // The same puzzle as one block (two pieces off its outline) and nothing else: no loose piece gives
  // the piece size, so the block measures it from its own seams, whose spacing differs by 1.6×
  // between the two directions.
  {
    name: 'starry-portrait-18-lone-block',
    painting: 'starry-night', grid: { rows: 6, cols: 3 }, seeds: [44, 45], tone: portraitCrop, referenceScale: 1.6,
    items: { singles: 0, blocks: [{ rows: 6, cols: 3, missing: 2 }] },
    render: (rng) => ({ ...standard(rng), background: [196, 208, 218], illumination: 0.15, scale: 0.5, rotation: rng.uniform(-20, 20) }),
  },
  // The same puzzle's pieces loose on grained wood (thick cardboard with a rim and a cast shadow).
  {
    name: 'starry-portrait-18-woodgrain',
    painting: 'starry-night', grid: { rows: 6, cols: 3 }, seeds: [42, 43], tone: portraitCrop, referenceScale: 1.6,
    items: { singles: 12 },
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], pattern: { kind: 'wood' }, illumination: 0.15, scale: 0.5, rim: {}, shadow: 0.35, shadowOffset: [5, 4], shadowBlur: 3 }),
  },
];

const COLUMNS = [
  'segRecall', 'segPrecision', 'shapeRate', 'kindAccuracy', 'top1', 'top3', 'rotationOk', 'confidentPrecision', 'confidentRate',
  'fitPrecision', 'fitRecall', 'assembledRecall', 'assembledPrecision', 'neighborPrecision', 'neighborRecall', 'hiddenRate', 'warnings', 'outlineIoU', 'boundaryF',
  'shapeFits', 'shapeFitsTrue', 'ambFixed', 'ambBroken', 'ambConfirmed', 'confMoved', 'consistencyMs', 'ms',
];
const results: Record<string, MetricRecord> = {};
const paintings = new Map<string, RGBAImage>();
const painting = (name: Scenario['painting']) => {
  if (!paintings.has(name)) paintings.set(name, loadTestAsset(name));
  return paintings.get(name)!;
};
/** The scenario's painting, recoloured when the scenario says so. */
const source = (s: Scenario) => {
  if (!s.tone) return painting(s.painting);
  const key = `${s.painting}:${s.name}`;
  if (!paintings.has(key)) paintings.set(key, s.tone(painting(s.painting)));
  return paintings.get(key)!;
};

/** The reference the app would build: the painting itself, or the rectified box photo. */
function makeReference(s: Scenario, seed: number): RGBAImage {
  const src = s.referenceScale ? resizeRGBA(source(s), source(s).width * s.referenceScale, source(s).height * s.referenceScale) : source(s);
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
        const src = source(s);
        const cut = generateJigsaw(s.grid.rows, s.grid.cols, src.width, src.height, seed);
        const reference = makeReference(s, seed);
        const index = buildReferenceIndex(reference, s.grid, 'grid');
        const items = pickItems(cut, s.items, seed);
        const rng = new Rng(seed * 13 + 3);
        const { photo, truth } = renderPiecesPhoto(src, cut, items, { seed: seed + 50, ...s.render(rng) });
        const t0 = performance.now();
        const { result, consistency } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), segment: SEGMENT_OPTIONS, consistency: CONSISTENCY });
        const ms = performance.now() - t0;
        const { metrics, regionToTruth } = evaluateScan(result, truth, cut, ms);
        const changes: MetricRecord = {};
        if (consistency) {
          changes.ambFixed = changes.ambBroken = changes.ambConfirmed = changes.confMoved = 0;
          changes.consistencyMs = result.timings?.consistency ?? 0;
          for (const ch of consistency.changes) {
            const ti = regionToTruth.get(ch.regionId);
            if (ti === undefined || truth[ti].pieces.length > 1) continue;
            const at = (p?: { row: number; col: number }) => !!p && p.row === truth[ti].row && p.col === truth[ti].col;
            const was = at(ch.before.placement), now = at(ch.after.placement);
            if (ch.before.status === 'confident') {
              if (!ch.before.placement || !ch.after.placement || ch.before.placement.row !== ch.after.placement.row || ch.before.placement.col !== ch.after.placement.col) changes.confMoved++;
            } else if (!was && now) changes.ambFixed++;
            else if (was && !now) changes.ambBroken++;
            else if (was && now && ch.after.status === 'confident') changes.ambConfirmed++;
          }
        }
        // Shape fits wherever the pieces are placed (the consistency pass's evidence), and how many are true.
        changes.shapeFits = changes.shapeFitsTrue = 0;
        const regionById = new Map(result.regions.map((r) => [r.id, r]));
        for (const f of shapeFits(result.regions, { ...DEFAULT_SIDE_COMPARISON, cache: new WeakMap() })) {
          changes.shapeFits++;
          const ta = regionToTruth.get(f.a), tb = regionToTruth.get(f.b);
          if (ta === undefined || tb === undefined || truth[ta].pieces.length > 1 || truth[tb].pieces.length > 1) continue;
          const A = truth[ta], B = truth[tb];
          const p = impliedPlacement(regionById.get(f.a)!.shape!, A, f.sideA, regionById.get(f.b)!.shape!, f.sideB);
          if (p.row === B.row && p.col === B.col && angleError(p.rotationDeg, B.rotationDeg) < 45) changes.shapeFitsTrue++;
        }
        perSeed.push({ ...metrics, ...changes });
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
