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
 * parallel: each writes its scenes' records to .debug/bench/placed-shards/, and the last one to
 * finish in the run gates and reports them all (run them together: `bench/placed` as the filter).
 *
 *   npm run bench                                  # all settings, every scene
 *   PLACED=f0.3-e0.25,others npm run bench         # some settings (plus 'none')
 *   PLACED_SCENES=quick npm run bench              # the first seed of a few scenes only
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSegmented, forkSegmented, scanFirstPass, segmentScan, type AnalyzeScanOptions } from '../src/pipeline/analyzeScan';
import { cellKey } from '../src/model/types';
import { CONSISTENCY, PLACEMENT_TUNING, REPO_ROOT, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { average, evaluateScan, report, yieldToEventLoop, type MetricRecord } from './lib';
import { gapNeighbours, PLACED_PRECISION_TOLERANCE, PLACED_TOLERANCE, placedSettingsFromEnv, simulatePlacedCells } from './placed';
import { renderScene, SCENARIOS } from './scanScenarios';

/** PLACED_SCENES=quick: the first seed of these (plain areas and small grids, textured photos). */
const QUICK_SCENES = ['starry-320-dark', 'wave-1000-dark', 'starry-patches', 'starry-noisy-blurry', 'wave-woodgrain', 'starry-grey-neighbors', 'starry-portrait-18-woodgrain'];
const QUICK = process.env.PLACED_SCENES === 'quick';
/** Shards of the scenes (one bench file each). */
export const PLACED_SHARDS = 3;
const ALL_RUNS = SCENARIOS.flatMap((s) => (QUICK ? (QUICK_SCENES.includes(s.name) ? [s.seeds[0]] : []) : s.seeds).map((seed) => ({ s, seed })));
/** Records of one run of the bench, shared by its shard files (set in vitest.bench.config.ts). */
const RUN_ID = process.env.BENCH_RUN_ID ?? `pid${process.ppid}`;
const SHARD_DIR = resolve(REPO_ROOT, '.debug/bench/placed-shards');
const settings = placedSettingsFromEnv(process.env.PLACED);
const COLUMNS = ['top1', 'top3', 'rotationOk', 'confidentPrecision', 'confidentTurnPrecision', 'confidentShare', 'confidentWrong', 'markedTop1', 'marked', 'conflicts', 'gaps', 'gapTop1', 'gapTop1None', 'gapTop3', 'gapTop3None', 'marks', 'wrong'];
/** Metrics gated against the no-marks run. */
const GATED = ['top1', 'top3', 'confidentPrecision'];

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
      mkdirSync(SHARD_DIR, { recursive: true });
      const own = resolve(SHARD_DIR, `${RUN_ID}-${shard}.json`);
      writeFileSync(`${own}.tmp`, JSON.stringify(Object.fromEntries(perSetting)));
      renameSync(`${own}.tmp`, own);
      const files = Array.from({ length: PLACED_SHARDS }, (_, k) => resolve(SHARD_DIR, `${RUN_ID}-${k}.json`));
      if (!files.every(existsSync)) {
        console.log(`placed bench: shard ${shard + 1} done; the last shard of the run gates`);
        return;
      }
      const all = new Map<string, MetricRecord[]>();
      for (const f of files) {
        const recs = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Record<string, number | null>[]>;
        for (const [name, list] of Object.entries(recs)) all.set(name, [...(all.get(name) ?? []), ...list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? NaN])))]);
      }
      const results = summary(all);
      console.log('\n' + report('placed', results, COLUMNS) + '\n');
      const none = results.none;
      const problems: string[] = [];
      for (const [name, rec] of Object.entries(results)) {
        if (name === 'none') continue;
        for (const k of GATED) {
          const tol = k === 'confidentPrecision' ? PLACED_PRECISION_TOLERANCE : PLACED_TOLERANCE;
          if (rec[k] < none[k] - tol - 1e-9) problems.push(`${name}.${k}: ${rec[k].toFixed(3)} < none ${none[k].toFixed(3)} - ${tol}`);
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
}

/** Per setting: metrics averaged over the scenes (markedTop1 and the gap rates over the scenes' such pieces; counts summed). */
function summary(perSetting: Map<string, MetricRecord[]>): Record<string, MetricRecord> {
  const out: Record<string, MetricRecord> = {};
  for (const [name, recs] of perSetting) {
    if (recs.length === 0) continue;
    const avg = average(recs);
    const withMarked = recs.filter((r) => r.marked > 0);
    avg.markedTop1 = withMarked.length > 0 ? withMarked.reduce((a, r) => a + r.markedTop1 * r.marked, 0) / withMarked.reduce((a, r) => a + r.marked, 0) : NaN;
    avg.marked = recs.reduce((a, r) => a + r.marked, 0);
    avg.conflicts = recs.reduce((a, r) => a + r.conflicts, 0);
    avg.confidentWrong = recs.reduce((a, r) => a + r.confidentWrong, 0);
    const sum = (k: string) => recs.reduce((a, r) => a + r[k], 0);
    avg.gaps = sum('gaps');
    for (const k of ['gapTop1', 'gapTop3', 'gapTop1None', 'gapTop3None']) avg[k] = avg.gaps > 0 ? sum(k) / avg.gaps : NaN;
    out[name] = avg;
  }
  return out;
}
