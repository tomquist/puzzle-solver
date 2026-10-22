/**
 * Placed-cell robustness: scan benchmark scenes analysed with simulated "placed" marks (bench/
 * placed.ts) – correct ones, and ones where a share of the marks is wrong, the true cells of the
 * scan's own pieces among them. Users make mistakes when marking pieces as placed; their mistakes
 * must not decrease accuracy. Per setting (averaged over the scenes):
 *   top1 / top3            single pieces and patches in the right cell / single pieces among the best three
 *   confidentPrecision     confident placements that are right; confidentShare: truth items placed confidently
 *   confidentTurnPrecision confident placements right in cell and turn (within 10°)
 *   markedTop1             single pieces whose own cell was (wrongly) marked: placed there all the same
 *   conflicts              of those, with `placedConflict` naming their own cell (the photo prefers the marked cell)
 *   marks / wrong          marks and wrong marks per scene
 * Gate: with marks (wrong ones included) top1, top3 and confidentPrecision are at least the
 * no-marks result minus PLACED_TOLERANCE (0.01; relative to the same run, no baseline numbers).
 *
 *   npm run bench                                  # all settings on the default scenes
 *   PLACED=f0.3-e0.25,others npm run bench         # some settings (plus 'none')
 *   PLACED_SCENES=all npm run bench                # every scan scenario (slow)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { cellKey } from '../src/model/types';
import { CONSISTENCY, PLACEMENT_TUNING, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { average, evaluateScan, report, yieldToEventLoop, type MetricRecord } from './lib';
import { PLACED_TOLERANCE, placedSettingsFromEnv, simulatePlacedCells } from './placed';
import { renderScene, SCENARIOS } from './scanScenarios';

/**
 * Scenes run by default (first seed each): plain areas and small grids, where the marks matter, and
 * textured photos, where they must not hurt.
 */
const DEFAULT_SCENES = [
  'starry-320-dark', 'wave-1000-dark', 'starry-patches', 'starry-noisy-blurry', 'wave-woodgrain', 'starry-grey-neighbors', 'starry-portrait-18-woodgrain',
];
const ALL = process.env.PLACED_SCENES === 'all';
const scenes = SCENARIOS.filter((s) => ALL || DEFAULT_SCENES.includes(s.name));
const settings = placedSettingsFromEnv(process.env.PLACED);
const COLUMNS = ['top1', 'top3', 'rotationOk', 'confidentPrecision', 'confidentTurnPrecision', 'confidentShare', 'markedTop1', 'marked', 'conflicts', 'marks', 'wrong'];
/** Metrics gated against the no-marks run. */
const GATED = ['top1', 'top3', 'confidentPrecision'];
const perSetting = new Map<string, MetricRecord[]>(settings.map((s) => [s.name, []]));

describe('placed-cell robustness', () => {
  for (const s of scenes) {
    it(s.name, async () => {
      for (const seed of ALL ? s.seeds : s.seeds.slice(0, 1)) {
        await yieldToEventLoop();
        const { cut, index, photo, truth } = renderScene(s, seed);
        const scanCells = truth.flatMap((t) => t.pieces.map((i) => ({ row: cut.pieces[i].row, col: cut.pieces[i].col })));
        for (const setting of settings) {
          await yieldToEventLoop();
          const marks = simulatePlacedCells(s.grid, scanCells, setting, seed);
          const t0 = performance.now();
          const { result } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), segment: SEGMENT_OPTIONS, consistency: CONSISTENCY, tuning: PLACEMENT_TUNING, placedCells: marks.cells });
          const { metrics, regionToTruth } = evaluateScan(result, truth, cut, performance.now() - t0);
          // Single pieces whose own cell carries a wrong mark.
          let marked = 0, markedTop1 = 0, conflicts = 0;
          const matchById = new Map(result.matches.map((m) => [m.regionId, m]));
          regionToTruth.forEach((ti, rid) => {
            const t = truth[ti];
            if (t.pieces.length > 1 || !marks.onScan.has(cellKey(t))) return;
            marked++;
            const m = matchById.get(rid);
            const c = m?.candidates[0];
            if (c && c.row === t.row && c.col === t.col && m.status !== 'unmatched') markedTop1++;
            if (m?.placedConflict && m.placedConflict.row === t.row && m.placedConflict.col === t.col) conflicts++;
          });
          perSetting.get(setting.name)!.push({
            top1: metrics.top1, top3: metrics.top3, rotationOk: metrics.rotationOk, confidentPrecision: metrics.confidentPrecision,
            confidentTurnPrecision: metrics.confidentTurnPrecision, confidentShare: metrics.confidentRate,
            markedTop1: marked > 0 ? markedTop1 / marked : NaN, marked, conflicts, marks: marks.cells.length, wrong: marks.wrong,
          });
        }
      }
    });
  }

  it('wrong marks never make the placements worse than no marks', () => {
    const results = summary();
    const none = results.none;
    const tol = PLACED_TOLERANCE;
    const problems: string[] = [];
    for (const [name, rec] of Object.entries(results)) {
      if (name === 'none') continue;
      for (const k of GATED) if (rec[k] < none[k] - tol - 1e-9) problems.push(`${name}.${k}: ${rec[k].toFixed(3)} < none ${none[k].toFixed(3)} - ${tol}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  afterAll(() => {
    console.log('\n' + report('placed', summary(), COLUMNS) + '\n');
  });
});

/** Per setting: metrics averaged over the scenes (markedTop1 over the scenes with such a piece; counts summed). */
function summary(): Record<string, MetricRecord> {
  const out: Record<string, MetricRecord> = {};
  for (const [name, recs] of perSetting) {
    if (recs.length === 0) continue;
    const avg = average(recs);
    const withMarked = recs.filter((r) => r.marked > 0);
    avg.markedTop1 = withMarked.length > 0 ? withMarked.reduce((a, r) => a + r.markedTop1 * r.marked, 0) / withMarked.reduce((a, r) => a + r.marked, 0) : NaN;
    avg.marked = recs.reduce((a, r) => a + r.marked, 0);
    avg.conflicts = recs.reduce((a, r) => a + r.conflicts, 0);
    out[name] = avg;
  }
  return out;
}
