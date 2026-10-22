/**
 * Private placement evaluation: feedback files in test-corpus/private/ (git-ignored; they hold the
 * user's photos and the puzzle's commercial picture and must NEVER be committed) with a placement
 * truth sidecar `<name>.truth.json` (scripts/feedback/truth.ts). Each file is replayed through the
 * full pipeline (matching included; the file must carry its reference picture) and scored against
 * the truth, next to the result stored in the file (what the app computed back then):
 *   found / merged      sure pieces inside a piece / patch region / sharing it with another one
 *   top1 / top3         the piece's cell is the best / among the best three placements
 *   rotationOk          top-1 placements turned within 10° of the truth
 *   confidentShare      pieces placed confidently; confidentPrecision: of those, right (top-1)
 *   blockTop1 / blockJaccard / blockRotationOk   assembled blocks (cell Jaccard ≥ 0.5)
 *   dupClaims           single pieces whose best cell another single piece of the scan also has
 * Also a side confusion matrix: the sides of every sure, unmerged single piece with a shape as the
 * current pipeline reads them, against the truth (sides facing the puzzle border are flat, the
 * others have a knob).
 * Report only (no baseline: the files exist on one machine). Skips when the folder is empty.
 *
 * PLACED=1 (or a list of settings, bench/placed.ts) also analyses every file with simulated
 * "placed" marks drawn from its truth – correct ones and wrong ones on the scan's own cells – and
 * reports top1 / top3 / confidentPrecision / confidentShare per setting over all files' pieces, and
 * gapTop1 / gapTop3 for the pieces whose true cell is a gap (not marked, next to a marked cell; `gaps`
 * of them), next to the same pieces' results without marks (gapTop1None / gapTop3None).
 * Gate: with marks, wrong ones included, these are at least the no-marks result minus
 * PLACED_TOLERANCE_PRIVATE (0.015, one piece) for top1 and top3, and no more pieces are placed
 * confidently in a wrong cell (confidentWrong) than without marks.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromiumDecoder, fromChromium, type ChromiumDecoder } from '../scripts/feedback/chromium';
import { decodeFeedbackImage, readFeedbackFile } from '../scripts/feedback/io';
import { replayFeedback } from '../scripts/feedback/replay';
import { isReviewFile } from '../scripts/feedback/review';
import { isTruthFile, readTruth, scoreTruth, truthCalibrationPairs, type TruthJudgement } from '../scripts/feedback/truth';
import { cellKey, type CellRef } from '../src/model/types';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { buildReferenceIndex, duplicateClaims } from '../src/pipeline/match';
import { CONSISTENCY, PLACEMENT_TUNING, REPO_ROOT, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { saveCalibrationPairs } from './calibration';
import { confusionTable, report, tallyPlacedSides, yieldToEventLoop, type CalibrationPair, type MetricRecord, type SideConfusion } from './lib';
import { gapNeighbours, NO_MARKS, PLACED_TOLERANCE_PRIVATE, placedSettingsFromEnv, simulatePlacedCells } from './placed';

const DIR = resolve(REPO_ROOT, 'test-corpus/private');
const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json') && !isTruthFile(f) && !isReviewFile(f) && existsSync(resolve(DIR, f.replace(/\.json$/i, '.truth.json')))).sort()
  : [];
const COLUMNS = ['pieces', 'unsure', 'found', 'merged', 'top1', 'top3', 'rotationOk', 'confidentShare', 'confidentPrecision', 'confidentTurnPrecision', 'dupClaims', 'blocks', 'blockTop1', 'blockJaccard', 'blockRotationOk', 'ms'];
const results: Record<string, MetricRecord> = {};
const misses: string[] = [];
const pairs: CalibrationPair[] = [];
const PLACED = process.env.PLACED;
const placedSettings = PLACED ? placedSettingsFromEnv(PLACED) : [];
const PLACED_COLUMNS = ['pieces', 'top1', 'top3', 'rotationOk', 'confidentShare', 'confidentPrecision', 'confidentTurnPrecision', 'confidentWrong', 'marked', 'markedTop1', 'conflicts', 'gaps', 'gapTop1', 'gapTop1None', 'gapTop3', 'gapTop3None'];
/** Per placed setting: counts summed over the files' sure pieces. */
const placedTally = new Map<string, Record<string, number>>();
/** Placed settings: pieces placed confidently in a wrong cell. */
const placedMisses: string[] = [];
const confusion: SideConfusion = {};

const describeMiss = (name: string, j: TruthJudgement) =>
  `${name} ${j.kind} ${j.index} at ${Math.round(j.at.x)},${Math.round(j.at.y)}: truth ${j.truth}, ` +
  (j.regionId === undefined ? 'not found' : `region #${j.regionId} ${j.status ?? ''}${j.merged ? ' (merged)' : ''} placed ${j.placed}${j.top1 && !j.rotationOk ? ' (turned wrong)' : ''}`);

describe('private placement evaluation', () => {
  if (files.length === 0) {
    it.skip('no feedback files with a truth sidecar in test-corpus/private/', () => {});
    return;
  }
  let chrome: ChromiumDecoder | null = null;
  beforeAll(async () => {
    chrome = await chromiumDecoder();
  }, 60_000);
  for (const file of files) {
    it(file, async () => {
      await yieldToEventLoop();
      const path = resolve(DIR, file);
      const bundle = readFeedbackFile(path);
      const truth = readTruth(path)!;
      if (!bundle.scan || !bundle.reference) throw new Error(`${file}: needs a scan and the reference picture`);
      const name = file.replace(/\.json$/i, '');
      // As analysed by the app back then (the stored result).
      const stored = scoreTruth(bundle.scan.result, truth);
      results[`${name} (stored ${bundle.scan.appVersion ?? bundle.app.version})`] = stored.metrics;
      // The current pipeline.
      const chromiumFile = fromChromium(bundle.app.userAgent);
      if (chromiumFile && !chrome) throw new Error('Chromium is needed to decode this file as on the phone: npx playwright install chromium');
      const scanPhoto = chromiumFile ? await chrome!.decode(bundle.scan.photo) : undefined;
      const replay = replayFeedback(bundle, name, { skipBox: true, scanPhoto });
      const current = scoreTruth(replay.current!, truth);
      results[`${name} (stored ${bundle.scan.appVersion ?? bundle.app.version})`].dupClaims = duplicateClaims(bundle.scan.result.regions, bundle.scan.result.matches).all;
      results[`${name} (current)`] = { ...current.metrics, dupClaims: duplicateClaims(replay.current!.regions, replay.current!.matches).all, ms: replay.timings.analyze ?? 0 };
      pairs.push(...truthCalibrationPairs(current.items));
      for (const j of current.items) if (!j.unsure && (!j.top1 || !j.rotationOk || j.merged || j.regionId === undefined)) misses.push(describeMiss(name, j));
      for (const j of current.items) {
        const shape = replay.current!.regions.find((r) => r.id === j.regionId && r.kind === 'piece')?.shape;
        if (j.kind !== 'piece' || j.unsure || j.merged || !shape) continue;
        const p = truth.pieces![j.index];
        tallyPlacedSides(confusion, shape, p, p.rotationDeg, bundle.puzzle.grid);
      }
      if (placedSettings.length === 0) return;
      // Simulated placed marks: the scan's own cells are those of its truth pieces and blocks.
      const photo = scanPhoto ?? decodeFeedbackImage(bundle.scan.photo);
      const index = buildReferenceIndex(decodeFeedbackImage(bundle.reference), bundle.puzzle.grid, bundle.puzzle.cut);
      const scanCells: CellRef[] = [...(truth.pieces ?? []).map((p) => ({ row: p.row, col: p.col })), ...(truth.blocks ?? []).flatMap((b) => b.cells)];
      const seed = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
      /** Per truth piece: right cell first / among the best three, without marks. */
      const unmarked = new Map<number, { top1: boolean; top3: boolean }>();
      for (const setting of placedSettings) {
        await yieldToEventLoop();
        const marks = simulatePlacedCells(bundle.puzzle.grid, scanCells, setting, seed);
        const result = setting === NO_MARKS ? replay.current! : analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), segment: SEGMENT_OPTIONS, consistency: CONSISTENCY, tuning: PLACEMENT_TUNING, placedCells: marks.cells }).result;
        const score = scoreTruth(result, truth);
        const matchById = new Map(result.matches.map((m) => [m.regionId, m]));
        const t = placedTally.get(setting.name) ?? {};
        const add = (k: string, v: number) => (t[k] = (t[k] ?? 0) + v);
        const markSet = new Set(marks.cells.map(cellKey));
        (truth.pieces ?? []).forEach((p, i) => {
          const j = score.items[i];
          if (j.unsure) return;
          if (setting === NO_MARKS) unmarked.set(i, { top1: j.top1, top3: j.top3 });
          if (gapNeighbours(bundle.puzzle.grid, markSet, p) > 0) {
            const ref = unmarked.get(i) ?? { top1: false, top3: false };
            add('gaps', 1);
            add('gapTop1', +j.top1);
            add('gapTop3', +j.top3);
            add('gapTop1None', +ref.top1);
            add('gapTop3None', +ref.top3);
          }
          add('pieces', 1);
          add('top1', +j.top1);
          add('top3', +j.top3);
          add('rotationOk', +(j.top1 && j.rotationOk));
          add('confident', +j.confident);
          add('confidentOk', +(j.confident && j.top1));
          add('confidentTurnOk', +(j.confident && j.top1 && j.rotationOk));
          add('confidentWrong', +(j.confident && !j.top1));
          if (j.confident && !j.top1) placedMisses.push(`${setting.name}: ${describeMiss(name, j)}${marks.onScan.has(cellKey(p)) ? ' (own cell marked)' : ''}`);
          if (marks.onScan.has(cellKey(p))) {
            add('marked', 1);
            add('markedTop1', +j.top1);
            const pc = j.regionId === undefined ? undefined : matchById.get(j.regionId)?.placedConflict;
            add('conflicts', +(!!pc && pc.row === p.row && pc.col === p.col));
          }
        });
        placedTally.set(setting.name, t);
      }
    });
  }
  if (placedSettings.length > 0) {
    it('wrong placed marks never make the placements worse than no marks', () => {
      const res = placedResults();
      const none = res.none, tol = PLACED_TOLERANCE_PRIVATE;
      const problems: string[] = [];
      for (const [name, rec] of Object.entries(res)) {
        if (name === 'none') continue;
        for (const k of ['top1', 'top3']) if (rec[k] < none[k] - tol - 1e-9) problems.push(`${name}.${k}: ${rec[k].toFixed(3)} < none ${none[k].toFixed(3)} - ${tol}`);
        // Not one more piece placed surely in a wrong cell (a right one made unsure is no harm here).
        if (rec.confidentWrong > none.confidentWrong) problems.push(`${name}.confidentWrong: ${rec.confidentWrong} > none ${none.confidentWrong}`);
      }
      if (problems.length > 0) throw new Error(problems.join('\n'));
    });
  }
  afterAll(async () => {
    await chrome?.close();
    console.log('\n' + report('private', results, COLUMNS) + '\n');
    if (misses.length > 0) console.log(`Misplaced, merged or missed (current pipeline):\n${misses.join('\n')}\n`);
    if (placedTally.size > 0) console.log('\n' + report('private-placed', placedResults(), PLACED_COLUMNS) + '\n');
    if (placedMisses.length > 0) console.log(`Confident and wrong with placed marks:\n${placedMisses.join('\n')}\n`);
    saveCalibrationPairs('private', pairs);
    console.log(`Side kinds of the sure single pieces (current pipeline; median outward/inward deviation):\n${confusionTable('private', confusion)}\n`);
  });
});

/** Placed settings: rates over all files' sure pieces. */
function placedResults(): Record<string, MetricRecord> {
  const out: Record<string, MetricRecord> = {};
  for (const [name, t] of placedTally) {
    const r = (a: string, b: string) => ((t[b] ?? 0) > 0 ? (t[a] ?? 0) / t[b] : NaN);
    out[name] = {
      pieces: t.pieces ?? 0, top1: r('top1', 'pieces'), top3: r('top3', 'pieces'), rotationOk: r('rotationOk', 'top1'), confidentShare: r('confident', 'pieces'),
      confidentPrecision: r('confidentOk', 'confident'), confidentTurnPrecision: r('confidentTurnOk', 'confident'), confidentWrong: t.confidentWrong ?? 0,
      marked: t.marked ?? 0, markedTop1: r('markedTop1', 'marked'), conflicts: t.conflicts ?? 0,
      gaps: t.gaps ?? 0, gapTop1: r('gapTop1', 'gaps'), gapTop1None: r('gapTop1None', 'gaps'), gapTop3: r('gapTop3', 'gaps'), gapTop3None: r('gapTop3None', 'gaps'),
    };
  }
  return out;
}
