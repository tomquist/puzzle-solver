/**
 * Feedback replay: every `*.json` in test-corpus/feedback/ is a feedback file sent from the app
 * ("Send feedback"). The current pipeline re-analyses its scan photo (and box photo) and must keep
 * the user's corrections fixed. Metrics per file (only those the file has marks for):
 *   missedFound     'missed' points now inside a detected piece / patch
 *   falseRemoved    'not_a_piece' regions no longer detected as piece / patch
 *   mergedSplit     'merged' regions now split into several regions
 *   mergedExact     'merged' regions now split into exactly the reviewed number of parts
 *   wrongFixed      'wrong_place' marks with a known cell now placed there (top-1)
 *   placementsTop1  confirmed placements still top-1
 *   boxError        largest corner error of detectBox vs. the user's quad (fraction of the diagonal)
 * Marks are user input: a `<file>.review.json` next to a file records the visual check of each mark
 * (scripts/feedback/review.ts); with one, only marks reviewed 'ok' count.
 * Gated by bench/baseline.json (suite 'feedback'); `UPDATE_BASELINE=1` records the numbers,
 * `DEBUG_IMAGES=1` also writes the inspection images to .debug/bench/feedback/<file>/.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeInspection } from '../scripts/feedback/inspect';
import { evaluateFeedbackFile } from '../scripts/feedback/replay';
import { isReviewFile } from '../scripts/feedback/review';
import { DEBUG_IMAGES, REPO_ROOT } from '../src/testing/nodeImageIO';
import { compareToBaseline, report, saveBaselineSuite, UPDATE_BASELINE, yieldToEventLoop, type MetricRecord } from './lib';

const DIR = resolve(REPO_ROOT, 'test-corpus/feedback');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json') && !isReviewFile(f)).sort() : [];
const COLUMNS = ['items', 'regions', 'missedFound', 'falseRemoved', 'mergedSplit', 'mergedExact', 'wrongFixed', 'placementsTop1', 'boxError', 'ms'];
const results: Record<string, MetricRecord> = {};

describe('feedback replay', () => {
  if (files.length === 0) {
    it.skip('no feedback files in test-corpus/feedback/', () => {});
    return;
  }
  for (const file of files) {
    it(file, async () => {
      await yieldToEventLoop();
      const { replay, metrics } = evaluateFeedbackFile(resolve(DIR, file));
      results[file] = metrics;
      if (DEBUG_IMAGES) writeInspection(replay, resolve(REPO_ROOT, '.debug/bench/feedback', replay.name));
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('feedback', file, metrics);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
  afterAll(() => {
    console.log('\n' + report('feedback', results, COLUMNS) + '\n');
    if (UPDATE_BASELINE) saveBaselineSuite('feedback', results);
  });
});
