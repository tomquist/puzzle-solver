/**
 * Grid benchmark: does the grid correct itself from scans (src/pipeline/gridBelief.ts), and does it
 * stay quiet when it is right? Each scenario is a puzzle with a known grid and a few synthetic scans
 * of it (rendered with src/testing/synth.ts); the app's grid handling is replayed over them
 * (src/testing/gridReplay.ts) from several starting points: the right grid, a neighbouring grid
 * (one column / one row off), no piece count (an estimated grid), and a wrong piece count.
 *
 *   questionsAtTruth   questions asked when starting from the right grid (must be 0)
 *   maxQuestions       most questions in one replay (must be ≤ 1: converge, never flip-flop)
 *   wrongQuestions     questions proposing a grid that is not the truth
 *   finalRight         share of starts that end on the right grid
 *   firstRight         share of starts whose first question (if any) proposes the right grid
 *   silentSwitches     report only: switches of an estimated grid without asking
 *
 * Gated by bench/baseline.json (suite 'grid'); questionsAtTruth and maxQuestions also hard.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../src/cv/image';
import { resizeRGBA } from '../src/cv/resize';
import type { GridEvidence, GridSpec } from '../src/model/types';
import { analyzeSegmented, forkSegmented, segmentScan, type SegmentedScan } from '../src/pipeline/analyzeScan';
import { estimateGrid } from '../src/pipeline/grid';
import { provisionalGrid } from '../src/pipeline/gridBelief';
import { buildReferenceIndex, type ReferenceIndex } from '../src/pipeline/match';
import type { GridProbe } from '../src/pipeline/match/cellSize';
import { replayGrid, type ReplayStart } from '../src/testing/gridReplay';
import { loadTestAsset } from '../src/testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, type RenderOptions } from '../src/testing/synth';
import { compareToBaseline, pickItems, report, saveBaselineSuite, UPDATE_BASELINE, yieldToEventLoop, type ItemSpec, type MetricRecord } from './lib';

interface Scenario {
  name: string;
  painting: 'starry-night' | 'great-wave';
  grid: GridSpec;
  /** One entry per scan. */
  scans: ItemSpec[];
  seed: number;
  render: RenderOptions;
  /** Portrait crop of the painting (aspect 0.79), as a children's puzzle box picture. */
  portrait?: boolean;
  /** Reference resolution relative to the painting. */
  referenceScale?: number;
}

const standard: RenderOptions = { background: [38, 40, 46], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1 };

const SCENARIOS: Scenario[] = [
  // Square cells, patches and loose pieces.
  {
    name: 'starry-20x16-patches', painting: 'starry-night', grid: { rows: 16, cols: 20 }, seed: 3, render: standard,
    scans: [{ singles: 8, patches: [[3, 3]] }, { singles: 10, patches: [[2, 4]] }, { singles: 8, patches: [[3, 4]] }, { singles: 10 }],
  },
  // Loose pieces only, a 1000-piece puzzle.
  {
    name: 'wave-40x25-singles', painting: 'great-wave', grid: { rows: 25, cols: 40 }, seed: 5, render: standard,
    scans: [{ singles: 20 }, { singles: 20 }, { singles: 20 }, { singles: 20 }],
  },
  // Non-square cells (1.2× wider than tall).
  {
    name: 'wave-30x25-wide-cells', painting: 'great-wave', grid: { rows: 25, cols: 30 }, seed: 7, render: standard,
    scans: [{ singles: 8, patches: [[3, 3]] }, { singles: 12 }, { singles: 6, patches: [[2, 4]] }, { singles: 12 }],
  },
  // Very few pieces per scan.
  {
    name: 'starry-20x16-few-pieces', painting: 'starry-night', grid: { rows: 16, cols: 20 }, seed: 9, render: standard,
    scans: [{ singles: 3 }, { singles: 3 }, { singles: 3 }, { singles: 3 }, { singles: 3 }],
  },
  // An 18-piece children's puzzle: 6 rows × 3 columns of a portrait picture (cells 1.6× wider than tall).
  {
    name: 'portrait-3x6-long-cells', painting: 'starry-night', grid: { rows: 6, cols: 3 }, seed: 11, portrait: true, referenceScale: 1.6,
    render: { ...standard, background: [200, 196, 190], scale: 0.5 },
    scans: [{ singles: 0, blocks: [{ rows: 6, cols: 3, missing: 0, holes: 2 }] }, { singles: 6 }, { singles: 0, blocks: [{ rows: 4, cols: 3, missing: 1 }] }],
  },
];

const COLUMNS = ['questionsAtTruth', 'maxQuestions', 'wrongQuestions', 'finalRight', 'firstRight', 'silentSwitches', 'ms'];
const results: Record<string, MetricRecord> = {};

/** The painting's middle as a portrait picture (aspect 0.79). */
function portraitCrop(img: RGBAImage): RGBAImage {
  const w = Math.round(0.79 * img.height), x0 = Math.round((img.width - w) / 2);
  const out = { width: w, height: img.height, data: new Uint8ClampedArray(w * img.height * 4) };
  for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x0 + w) * 4), y * w * 4);
  return out;
}

const fmt = (g: GridSpec) => `${g.cols}×${g.rows}`;

describe('grid benchmark', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const t0 = performance.now();
      const src0 = loadTestAsset(s.painting);
      const src = s.portrait ? portraitCrop(src0) : src0;
      const cut = generateJigsaw(s.grid.rows, s.grid.cols, src.width, src.height, s.seed);
      const refImg = s.referenceScale ? resizeRGBA(src, src.width * s.referenceScale, src.height * s.referenceScale) : src;
      const reference = perturbReference(refImg, { seed: s.seed });
      const ref = { width: reference.width, height: reference.height };
      const photos = s.scans.map((items, k) => renderPiecesPhoto(src, cut, pickItems(cut, items, s.seed * 10 + k), { seed: s.seed * 10 + k + 50, ...s.render }).photo);
      const indices = new Map<string, ReferenceIndex>();
      const cache = new Map<string, GridEvidence>();
      // Segmentation does not depend on the grid: once per photo, each analysis from a copy.
      const segmented = new Map<string, SegmentedScan>();
      const analyse = async (id: string, g: GridSpec, probe: GridProbe | undefined): Promise<GridEvidence> => {
        const key = `${id}|${g.rows}x${g.cols}|${probe ?? ''}`;
        let ev = cache.get(key);
        if (!ev) {
          await yieldToEventLoop();
          const gk = `${g.rows}x${g.cols}`;
          let index = indices.get(gk);
          if (!index) indices.set(gk, (index = buildReferenceIndex(reference, g, 'grid')));
          const photo = photos[Number(id)];
          const opts = { maxSide: Math.max(photo.width, photo.height), gridProbe: probe };
          let seg = segmented.get(id);
          if (!seg) segmented.set(id, (seg = segmentScan(photo, opts)));
          ev = analyzeSegmented(index, forkSegmented(seg, { ownInputs: true }), opts).result.gridEvidence!;
          cache.set(key, ev);
        }
        return ev;
      };
      const truth = s.grid, n = truth.rows * truth.cols, aspect = ref.width / ref.height;
      const wrongCount = Math.round(n * 0.65);
      const starts: ReplayStart[] = [
        { label: 'right', grid: truth, count: n, countKind: 'exact', status: 'unconfirmed' },
        { label: 'cols-1', grid: { rows: truth.rows, cols: truth.cols - 1 }, count: n, countKind: 'exact', status: 'unconfirmed' },
        { label: 'rows-1', grid: { rows: truth.rows - 1, cols: truth.cols }, count: n, countKind: 'exact', status: 'unconfirmed' },
        { label: 'unknown', grid: provisionalGrid(aspect), count: 0, countKind: 'unknown', status: 'estimated' },
        { label: `count ${wrongCount}`, grid: estimateGrid(wrongCount, aspect).best, count: wrongCount, countKind: 'exact', status: 'unconfirmed' },
      ];
      const ids = s.scans.map((_, k) => String(k));
      const outcomes = [];
      for (const st of starts) {
        const o = await replayGrid(ids, st, truth, ref, analyse);
        outcomes.push(o);
        console.log(`${s.name} from ${st.label} (${fmt(st.grid)}): questions ${o.questions}${o.first ? ` (first at scan ${o.first.at}: ${fmt(o.first.grid)})` : ''}, silent ${o.silentSwitches}, final ${fmt(o.final)} ${o.right ? '✓' : '✗'} ${o.finalStatus}${o.log.length ? `\n    ${o.log.join('\n    ')}` : ''}`);
      }
      const asked = outcomes.filter((o) => o.first);
      const rec: MetricRecord = {
        questionsAtTruth: outcomes[0].questions,
        maxQuestions: Math.max(...outcomes.map((o) => o.questions)),
        wrongQuestions: outcomes.reduce((a, o) => a + o.wrongQuestions, 0),
        finalRight: outcomes.filter((o) => o.right).length / outcomes.length,
        firstRight: asked.length === 0 ? 1 : asked.filter((o) => o.first!.right).length / asked.length,
        silentSwitches: outcomes.reduce((a, o) => a + o.silentSwitches, 0),
        ms: performance.now() - t0,
      };
      results[s.name] = rec;
      expect(rec.questionsAtTruth, `${s.name}: no question when the grid is right`).toBe(0);
      expect(rec.maxQuestions, `${s.name}: at most one question per replay`).toBeLessThanOrEqual(1);
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('grid', s.name, rec);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  afterAll(() => {
    console.log('\n' + report('grid', results, COLUMNS) + '\n');
    if (UPDATE_BASELINE) saveBaselineSuite('grid', results);
  });
});
