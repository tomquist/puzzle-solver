/**
 * End-to-end scan benchmark: synthetic piece photos → analyzeScan (segmentation, shapes, quality,
 * matching, fits) → metrics against ground truth, gated by bench/baseline.json.
 *
 *   npm run bench                     # run and compare with the baseline
 *   UPDATE_BASELINE=1 npm run bench   # accept the current numbers as the new baseline
 *   DEBUG_IMAGES=1 npm run bench      # also write overlays to .debug/bench/
 *   GRAPH_CUT=1 npm run bench         # A/B: with the graph-cut outline refinement (0: without)
 *   GRAIN=1 npm run bench             # A/B: with the wood-grain table model (0: without)
 *   CONSISTENCY=1 npm run bench       # A/B: with the consistency pass of the placements (0: without)
 *
 * confidentTurnPrecision: confident placements right in cell and turn (within 10°).
 * dupClaims (report only): single pieces whose best cell another single piece of the scan has too.
 * The single pieces' (confidence, right cell, right turn) go to .debug/bench/calibration/scan.json
 * for `npm run bench:calibration` (bench/calibration.ts).
 * cornerError / cornersOk / sideAccuracy: single pieces with a shape: mean largest corner error
 * (fraction of the body size), share within 3 %, sides read right (flat / tab / blank); the side
 * confusion matrix over all scenarios is printed after the table.
 * outlineIoU / boundaryF (report only): outline accuracy of the regions matched to a truth item.
 * shapeFits / shapeFitsTrue (report only): mutually best side fits among the scan's pieces wherever
 * they are placed (`shapeFits`, the consistency pass's evidence), and those that are true neighbours.
 * ambFixed / ambBroken / ambConfirmed / confMoved / consistencyMs (report only, when the consistency
 * pass runs): single pieces that were not confident before it and now sit in the right cell having
 * been wrong / now sit wrong having been right / stay right and became confident; confident pieces
 * it moved; its runtime.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeScan, DEFAULT_SIDE_COMPARISON } from '../src/pipeline/analyzeScan';
import { duplicateClaims, impliedPlacement, shapeFits } from '../src/pipeline/match';
import { CONSISTENCY, DEBUG_IMAGES, PLACEMENT_TUNING, savePng, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { angleError, average, compareToBaseline, yieldToEventLoop, evaluateScan, overlay, report, saveBaselineSuite, UPDATE_BASELINE, confusionTable, type CalibrationPair, type MetricRecord, type SideConfusion } from './lib';
import { saveCalibrationPairs } from './calibration';
import { renderScene, SCENARIOS } from './scanScenarios';

const COLUMNS = [
  'segRecall', 'segPrecision', 'shapeRate', 'kindAccuracy', 'cornerError', 'cornersOk', 'sideAccuracy', 'top1', 'top3', 'rotationOk', 'confidentPrecision', 'confidentTurnPrecision', 'confidentRate',
  'fitPrecision', 'fitRecall', 'assembledRecall', 'assembledPrecision', 'neighborPrecision', 'neighborRecall', 'hiddenRate', 'warnings', 'outlineIoU', 'boundaryF',
  'shapeFits', 'shapeFitsTrue', 'ambFixed', 'ambBroken', 'ambConfirmed', 'confMoved', 'consistencyMs', 'dupClaims', 'ms',
];
const results: Record<string, MetricRecord> = {};
const pairs: CalibrationPair[] = [];
const confusion: SideConfusion = {};

describe('scan benchmark', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const perSeed: MetricRecord[] = [];
      for (const seed of s.seeds) {
        await yieldToEventLoop();
        const { cut, index, photo, truth } = renderScene(s, seed);
        const t0 = performance.now();
        const { result, consistency } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), segment: SEGMENT_OPTIONS, consistency: CONSISTENCY, tuning: PLACEMENT_TUNING });
        const ms = performance.now() - t0;
        const { metrics, regionToTruth, pairs: scenePairs } = evaluateScan(result, truth, cut, ms, confusion);
        pairs.push(...scenePairs);
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
        changes.dupClaims = duplicateClaims(result.regions, result.matches).all;
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
    saveCalibrationPairs('scan', pairs);
    console.log(`Side kinds of the single pieces (median outward/inward deviation):\n${confusionTable('scan', confusion)}\n`);
    if (UPDATE_BASELINE) saveBaselineSuite('scan', results);
  });
});
