/**
 * Side retrieval benchmark: for every true pair of mating sides in a scan, how often the partner is
 * the closest (top-1) or among the five closest (top-5) complementary sides (tab ↔ blank as
 * detected) of all pieces in the scan, by each side comparison of the fit hints (src/pipeline/match:
 * fits.ts, sideCompare.ts) – shape point by point ('rms') or with DTW ('dtw', 'dtw-levelled'), the
 * colour strips just inside the sides, and shape and colour combined as the fit hints combine them.
 * Independent of the hints' gating thresholds; a side whose partner was not detected as
 * complementary counts as a miss.
 *
 * Scenes: a block of neighbouring cells photographed as loose pieces plus a few unrelated pieces,
 * segmented and shape-analysed by the real pipeline. Each scene is scored twice:
 *   detected  profiles and strips at the corners the shape analysis found
 *   jitter    every corner moved 2–5 % of the side length along the outline (random direction, in
 *             this evaluation only), as a corner found a few pixels off on a real photo would be
 *
 *   npx vitest run --config vitest.bench.config.ts bench/sides.eval.ts
 * Gated by bench/baseline.json (suite 'sides').
 */
import { afterAll, describe, expect, it } from 'vitest';
import { traceOuterContour } from '../src/cv/contour';
import type { RGBAImage } from '../src/cv/image';
import type { GridSpec, SideKind } from '../src/model/types';
import { profileMismatch, profileMismatchDtw, puzzleSideOf, sideMismatch, stripMismatch, type ShapeMetric } from '../src/pipeline/match';
import { cornerPositions, edgeStripsAt, outlineArc } from '../src/pipeline/match/edgeStrips';
import { segmentPieces, sideProfilesAt } from '../src/pipeline/pieces';
import { offsetPoints } from '../src/pipeline/pieces/util';
import { loadTestAsset } from '../src/testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, Rng, type RenderOptions, type RGB } from '../src/testing/synth';
import { associateRegions, compareToBaseline, report, saveBaselineSuite, UPDATE_BASELINE, yieldToEventLoop, type MetricRecord } from './lib';

interface Scenario {
  name: string;
  painting: 'starry-night' | 'great-wave';
  grid: GridSpec;
  /** Block of neighbouring cells (rows, cols) photographed as loose pieces. */
  block: [number, number];
  /** Further unrelated loose pieces. */
  extra: number;
  seeds: number[];
  render: (rng: Rng) => RenderOptions;
}

const gain = (rng: Rng, spread: number): RGB => [rng.uniform(1 - spread, 1 + spread), rng.uniform(1 - spread, 1 + spread), rng.uniform(1 - spread, 1 + spread)];
const standard = (rng: Rng): RenderOptions => ({ background: [38, 40, 46], noiseSigma: 3, blurSigma: 0.7, gain: gain(rng, 0.1), illumination: 0.1 });

const SCENARIOS: Scenario[] = [
  { name: 'starry-dark', painting: 'starry-night', grid: { rows: 16, cols: 20 }, block: [5, 6], extra: 6, seeds: [1, 2], render: standard },
  { name: 'wave-dark', painting: 'great-wave', grid: { rows: 20, cols: 30 }, block: [5, 6], extra: 6, seeds: [3, 4], render: standard },
  {
    name: 'starry-noisy-blurry', painting: 'starry-night', grid: { rows: 16, cols: 20 }, block: [5, 6], extra: 6, seeds: [5],
    render: (rng) => ({ ...standard(rng), noiseSigma: 7, blurSigma: 1.4, gain: gain(rng, 0.18), illumination: 0.25 }),
  },
  {
    name: 'wave-wood-table', painting: 'great-wave', grid: { rows: 20, cols: 30 }, block: [5, 6], extra: 6, seeds: [6],
    render: (rng) => ({ ...standard(rng), background: [150, 108, 70], backgroundTexture: 16, illumination: 0.2 }),
  },
  {
    name: 'starry-light-table', painting: 'starry-night', grid: { rows: 16, cols: 20 }, block: [5, 6], extra: 6, seeds: [7],
    render: (rng) => ({ ...standard(rng), background: [226, 222, 214], illumination: 0.15 }),
  },
  {
    name: 'wave-jpeg-vignette', painting: 'great-wave', grid: { rows: 20, cols: 30 }, block: [5, 6], extra: 6, seeds: [8],
    render: (rng) => ({ ...standard(rng), noiseSigma: 4, jpegQuality: 70, vignette: 0.35, illumination: 0.15 }),
  },
  {
    name: 'wave-glare-uneven', painting: 'great-wave', grid: { rows: 20, cols: 30 }, block: [5, 6], extra: 6, seeds: [9],
    render: (rng) => ({ ...standard(rng), background: [90, 96, 104], illumination: 0.35, glare: { count: 4 } }),
  },
  {
    name: 'starry-small-pieces', painting: 'starry-night', grid: { rows: 16, cols: 20 }, block: [5, 6], extra: 6, seeds: [10],
    render: (rng) => ({ ...standard(rng), scale: 0.6 }),
  },
];

/** One side of a detected piece in one scoring mode. */
interface SideRec {
  region: number;
  kind: SideKind;
  profile: number[];
  strip?: Float32Array;
}

const SHAPES: ShapeMetric[] = ['rms', 'dtw', 'dtw-levelled'];
const METRICS: Record<string, (a: SideRec, b: SideRec) => number> = {
  rms: (a, b) => profileMismatch(a.profile, b.profile),
  dtw: (a, b) => profileMismatchDtw(a.profile, b.profile, 1),
  'dtw-levelled': (a, b) => profileMismatchDtw(a.profile, b.profile, 2, true),
  colour: (a, b) => (a.strip && b.strip ? stripMismatch(a.strip, b.strip) : Infinity),
  ...Object.fromEntries(SHAPES.map((shape) => [`${shape}+colour`, (a: SideRec, b: SideRec) => sideMismatch(a.profile, b.profile, a.strip, b.strip, { shape })])),
};
const NAMES = Object.keys(METRICS);
const MODES = ['detected', 'jitter'] as const;
type Mode = (typeof MODES)[number];

const complementary = (a: SideKind, b: SideKind) => (a === 'tab' && b === 'blank') || (a === 'blank' && b === 'tab');

interface Tally {
  queries: number;
  kindOk: number;
  top1: Record<string, number>;
  top5: Record<string, number>;
}
const newTally = (): Tally => ({ queries: 0, kindOk: 0, top1: {}, top5: {} });
const tallies = (): Record<Mode, Tally> => ({ detected: newTally(), jitter: newTally() });

const perScenario: Record<string, Record<Mode, Tally>> = {};
const pooled = tallies();
const paintings = new Map<string, RGBAImage>();

describe('side retrieval benchmark', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const t = tallies();
      for (const seed of s.seeds) {
        await yieldToEventLoop();
        if (!paintings.has(s.painting)) paintings.set(s.painting, loadTestAsset(s.painting));
        const src = paintings.get(s.painting)!;
        const cut = generateJigsaw(s.grid.rows, s.grid.cols, src.width, src.height, seed);
        const rng = new Rng(seed * 7 + 11);
        const [bh, bw] = s.block;
        const r0 = 1 + rng.int(s.grid.rows - bh - 1), c0 = 1 + rng.int(s.grid.cols - bw - 1);
        const items: number[] = [];
        for (let r = r0; r < r0 + bh; r++) for (let c = c0; c < c0 + bw; c++) items.push(r * s.grid.cols + c);
        const rest = rng.shuffle(cut.pieces.map((p) => p.index).filter((i) => !items.includes(i)));
        items.push(...rest.slice(0, s.extra));
        const { photo, truth } = renderPiecesPhoto(src, cut, rng.shuffle(items), { seed: seed + 50, ...s.render(new Rng(seed * 13 + 3)) });
        const seg = segmentPieces(photo, { assessQuality: false });
        const { regionToTruth } = associateRegions(seg.regions.map((x) => x.region), truth);

        // Detected single pieces with a shape, and their cells.
        const pieces = seg.regions.flatMap((sr) => {
          const ti = regionToTruth.get(sr.region.id);
          const shape = sr.region.shape;
          if (ti === undefined || !shape || truth[ti].pieces.length !== 1) return [];
          return [{ sr, shape, truth: truth[ti], cell: cut.pieces[truth[ti].pieces[0]] }];
        });
        const jitterRng = new Rng(seed * 101 + 7);
        for (const mode of MODES) {
          const sides: SideRec[] = [];
          const byPuzzleSide = new Map<string, SideRec>();
          for (const p of pieces) {
            const origin = { x: p.sr.region.bbox.x, y: p.sr.region.bbox.y };
            const shifts = mode === 'jitter' ? [0, 1, 2, 3].map(() => (jitterRng.bool() ? 1 : -1) * jitterRng.uniform(0.02, 0.05) * p.shape.bodySize) : undefined;
            // Profiles as the shape analysis reports them for these corners (on the outline it read).
            const profiles = shifts ? sideProfilesAt(offsetPoints(traceOuterContour(p.sr.mask), origin.x, origin.y), p.shape.corners, shifts) : null;
            const arc = outlineArc(p.sr.region.contour);
            const corners = cornerPositions(arc, p.shape).map((c, j) => c + (shifts?.[j] ?? 0));
            const strips = edgeStripsAt(p.sr.image, p.sr.mask, origin, arc, corners, p.shape.bodySize);
            for (let i = 0; i < 4; i++) {
              const rec: SideRec = { region: p.sr.region.id, kind: p.shape.sides[i].kind, profile: profiles?.[i].profile ?? p.shape.sides[i].profile, strip: strips?.sides[i] };
              sides.push(rec);
              byPuzzleSide.set(`${p.sr.region.id}|${puzzleSideOf(p.shape, p.truth.rotationDeg, i)}`, rec);
            }
          }
          // Queries: both directions of every truth-adjacent pair of detected pieces.
          const tally = t[mode];
          for (const p of pieces) {
            for (const q of pieces) {
              const dr = q.cell.row - p.cell.row, dc = q.cell.col - p.cell.col;
              const side = dr === 0 && dc === 1 ? 1 : dr === 1 && dc === 0 ? 2 : -1;
              if (side < 0) continue;
              const a = byPuzzleSide.get(`${p.sr.region.id}|${side}`), b = byPuzzleSide.get(`${q.sr.region.id}|${(side + 2) % 4}`);
              if (!a || !b) continue;
              for (const [x, y] of [[a, b], [b, a]] as const) {
                tally.queries++;
                if (!complementary(x.kind, y.kind)) continue;
                tally.kindOk++;
                const cands = sides.filter((o) => o.region !== x.region && complementary(x.kind, o.kind));
                for (const k of NAMES) {
                  const f = METRICS[k];
                  const dt = f(x, y);
                  let rank = 1;
                  for (const o of cands) if (o !== y && f(x, o) < dt) rank++;
                  if (rank === 1) tally.top1[k] = (tally.top1[k] ?? 0) + 1;
                  if (rank <= 5) tally.top5[k] = (tally.top5[k] ?? 0) + 1;
                }
              }
            }
          }
        }
      }
      perScenario[s.name] = t;
      for (const mode of MODES) {
        const P = pooled[mode];
        P.queries += t[mode].queries;
        P.kindOk += t[mode].kindOk;
        for (const k of NAMES) {
          P.top1[k] = (P.top1[k] ?? 0) + (t[mode].top1[k] ?? 0);
          P.top5[k] = (P.top5[k] ?? 0) + (t[mode].top5[k] ?? 0);
        }
      }
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('sides', s.name, record(t));
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  afterAll(() => {
    const rows: Record<string, MetricRecord> = {};
    for (const [name, t] of [...Object.entries(perScenario), ['all', pooled] as const]) {
      for (const mode of MODES) rows[`${name} ${mode}`] = { queries: t[mode].queries, kindOk: rate(t[mode].kindOk, t[mode].queries), ...rates(t[mode]) };
    }
    console.log('\n' + report('sides', rows, ['queries', 'kindOk', ...NAMES.flatMap((k) => [`${k}@1`, `${k}@5`])]) + '\n');
    if (UPDATE_BASELINE) saveBaselineSuite('sides', Object.fromEntries(Object.entries(perScenario).map(([name, t]) => [name, record(t)])));
  });
});

const rate = (a: number, b: number) => (b ? a / b : 0);

/** Top-1 / top-5 rates of every comparison. */
function rates(t: Tally): MetricRecord {
  const out: MetricRecord = {};
  for (const k of NAMES) {
    out[`${k}@1`] = rate(t.top1[k] ?? 0, t.queries);
    out[`${k}@5`] = rate(t.top5[k] ?? 0, t.queries);
  }
  return out;
}

/** Gated numbers of one scenario: every comparison's top-1 / top-5, with and without corner jitter. */
function record(t: Record<Mode, Tally>): MetricRecord {
  const out: MetricRecord = {};
  for (const mode of MODES) for (const [k, v] of Object.entries(rates(t[mode]))) out[`${mode} ${k}`] = v;
  return out;
}
