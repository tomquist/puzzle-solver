/**
 * Placed-cell robustness: scan benchmark scenes analysed with simulated "placed" marks (bench/
 * placed.ts) – correct ones, and ones where a share of the marks is wrong, the true cells of the
 * scan's own pieces among them. Users make mistakes when marking pieces as placed; their mistakes
 * must not decrease accuracy. Per setting (averaged over the scenes):
 *   top1 / top3            single pieces and patches in the right cell / single pieces among the best three
 *   confidentPrecision     confident placements that are right; confidentShare: truth items placed confidently
 *   confidentTurnPrecision confident placements right in cell and turn (within 10°)
 *   confidentWrong         confident placements in a wrong cell (summed over the scenes)
 *   markedTop1             single pieces whose own cell was (wrongly) marked: placed there all the same
 *   conflicts              of those, with `placedConflict` naming their own cell (the photo prefers the marked cell)
 *   gaps                   single pieces whose true cell is a gap (not marked, next to a marked cell), summed
 *   gapTop1 / gapTop3      of those, in the right cell / among the best three; gapTop1None / gapTop3None:
 *                          the same pieces without marks
 *   marks / wrong          marks and wrong marks per scene
 * Gate: with marks (wrong ones included) top1 and top3 are at least the no-marks result minus
 * PLACED_TOLERANCE (0.01), confidentPrecision at least the no-marks result minus
 * PLACED_PRECISION_TOLERANCE (0.002; relative to the same run, no baseline numbers).
 *
 * Every scan scenario and seed, split over PLACED_SHARDS files (bench/placed-<k>.eval.ts) that run in
 * parallel: each writes its scenes' records to .debug/bench/placed-shards/ (bench/shards.ts), and the
 * last one to finish in the run gates and reports them all (run them together: `bench/placed` as the
 * filter). Shards run elsewhere (CI: one job each) leave that to `npm run bench:placed-gate` over
 * their records (bench/placedGate.ts). The gate is on the averages over all scenes, as one run.
 *
 * Each scene is rendered, segmented and matched without marks (the first pass, which ignores them)
 * once; every setting analyses a copy from there on (pipeline/analyzeScan.ts `analyzeSegmented`),
 * with the same result as analyzeScan from the photo.
 *
 *   npm run bench                                  # all settings, every scene
 *   PLACED=f0.3-e0.25,others npm run bench         # some settings (plus 'none')
 *   PLACED_SCENES=quick npm run bench              # the first seed of a few scenes only
 */
import { describe, expect, it } from 'vitest';
import { analyzeSegmented, forkSegmented, scanFirstPass, segmentScan, type AnalyzeScanOptions } from '../src/pipeline/analyzeScan';
import { cellKey } from '../src/model/types';
import { CONSISTENCY, PLACEMENT_TUNING, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { evaluateScan, yieldToEventLoop, type MetricRecord } from './lib';
import { gapNeighbours, placedSettingsFromEnv, simulatePlacedCells } from './placed';
import { gatePlaced, mergedPlacedRecords, PLACED_SHARDS, PLACED_SUITE } from './placedGate';
import { writeShardRecords } from './shards';
import { renderScene, SCENARIOS } from './scanScenarios';

/** PLACED_SCENES=quick: the first seed of these (plain areas and small grids, textured photos). */
const QUICK_SCENES = ['starry-320-dark', 'wave-1000-dark', 'starry-patches', 'starry-noisy-blurry', 'wave-woodgrain', 'starry-grey-neighbors', 'starry-portrait-18-woodgrain'];
const QUICK = process.env.PLACED_SCENES === 'quick';
const ALL_RUNS = SCENARIOS.flatMap((s) => (QUICK ? (QUICK_SCENES.includes(s.name) ? [s.seeds[0]] : []) : s.seeds).map((seed) => ({ s, seed })));
const settings = placedSettingsFromEnv(process.env.PLACED);

/** The placed-cell bench for shard `shard` (of {@link PLACED_SHARDS}): its scenes, then the combined gate when it finishes last. */
export function placedSuite(shard: number): void {
  const perSetting = new Map<string, MetricRecord[]>(settings.map((s) => [s.name, []]));
  const runs = ALL_RUNS.filter((_, i) => i % PLACED_SHARDS === shard);
  describe(`placed-cell robustness ${shard + 1}/${PLACED_SHARDS}`, () => {
    for (const { s, seed } of runs) {
      it(`${s.name}#${seed}`, async () => {
        await yieldToEventLoop();
        const { cut, index, photo, truth } = renderScene(s, seed);
        const scanCells = truth.flatMap((t) => t.pieces.map((i) => ({ row: cut.pieces[i].row, col: cut.pieces[i].col })));
        /** Per truth item (single pieces): right cell first / among the best three, without marks. */
        const unmarked = new Map<number, { top1: boolean; top3: boolean }>();
        // Segmentation and the first matching pass do not depend on the marks: once per scene, and
        // every setting analyses a copy from there on (as analyzeScan would from the photo).
        const opts: AnalyzeScanOptions = { maxSide: Math.max(photo.width, photo.height), segment: SEGMENT_OPTIONS, consistency: CONSISTENCY, tuning: PLACEMENT_TUNING };
        const segmented = segmentScan(photo, opts);
        const firstPass = scanFirstPass(index, segmented, opts);
        for (const setting of settings) {
          await yieldToEventLoop();
          const marks = simulatePlacedCells(s.grid, scanCells, setting, seed);
          const t0 = performance.now();
          const { result } = analyzeSegmented(index, forkSegmented(segmented), { ...opts, placedCells: marks.cells }, firstPass);
          const { metrics, regionToTruth } = evaluateScan(result, truth, cut, performance.now() - t0);
          // Single pieces whose own cell carries a wrong mark.
          let marked = 0, markedTop1 = 0, conflicts = 0;
          const matchById = new Map(result.matches.map((m) => [m.regionId, m]));
          // Single pieces whose true cell is a gap: placed against the same pieces without marks.
          const markSet = new Set(marks.cells.map(cellKey));
          let gaps = 0, gapTop1 = 0, gapTop3 = 0, gapTop1None = 0, gapTop3None = 0;
          regionToTruth.forEach((ti, rid) => {
            const t = truth[ti];
            if (t.pieces.length > 1) return;
            const cands = matchById.get(rid)?.candidates ?? [];
            const own = { top1: !!cands[0] && cands[0].row === t.row && cands[0].col === t.col, top3: cands.slice(0, 3).some((c) => c.row === t.row && c.col === t.col) };
            if (setting.mode === 'none') unmarked.set(ti, own);
            if (gapNeighbours(s.grid, markSet, t) === 0) return;
            const ref = unmarked.get(ti) ?? { top1: false, top3: false };
            gaps++;
            gapTop1 += +own.top1;
            gapTop3 += +own.top3;
            gapTop1None += +ref.top1;
            gapTop3None += +ref.top3;
          });
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
            confidentWrong: Number.isFinite(metrics.confidentPrecision) ? Math.round(metrics.confidentRate * metrics.items * (1 - metrics.confidentPrecision)) : 0,
            markedTop1: marked > 0 ? markedTop1 / marked : NaN, marked, conflicts, marks: marks.cells.length, wrong: marks.wrong,
            gaps, gapTop1, gapTop3, gapTop1None, gapTop3None,
          });
        }
      });
    }

    it('wrong marks never make the placements worse than no marks (all shards)', () => {
      // This shard's records, then the gate when every shard of the run has written its own.
      writeShardRecords(PLACED_SUITE, shard, Object.fromEntries(perSetting));
      const all = mergedPlacedRecords();
      if (!all) {
        console.log(`placed bench: shard ${shard + 1} done; the last shard of the run gates`);
        return;
      }
      const { table, problems } = gatePlaced(all);
      console.log('\n' + table + '\n');
      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
}
