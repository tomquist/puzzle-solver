/**
 * Feedback replay: every `*.json` in test-corpus/feedback/ is a feedback file sent from the app
 * ("Send feedback"). The current pipeline re-analyses its scan photo (and box photo) and must keep
 * the user's corrections fixed. Metrics per file (only those the file has marks for):
 *   missedFound     'missed' points now inside a detected piece / patch
 *   falseRemoved    'not_a_piece' regions no longer detected as piece / patch
 *   mergedSplit     'merged' regions now split into several regions
 *   mergedExact     'merged' regions now split into exactly the reviewed number of parts
 *   outlineFixed    'bad_outline' marks whose review lists the pieces there: each piece now whole in
 *                   one region (an assembled group: one patch, or one region per piece)
 *   objectRecall    answer-key objects (review.objects) inside a piece / patch region
 *   objectClean     answer-key objects alone in their region (not merged with another)
 *   objectPrecision piece / patch regions holding an answer-key object (the rest are false)
 *   wrongFixed      'wrong_place' marks with a known cell now placed there (top-1)
 *   placementsTop1  confirmed placements still top-1
 *   boxError        largest corner error of detectBox vs. the user's quad (fraction of the diagonal)
 * Report only: the side kinds the current pipeline reads on all single pieces of the photos, with
 * their median outward / inward deviation (no side truth here: the files carry no placements; see
 * bench/private.eval.ts for a confusion matrix against placement truth).
 * Marks are user input: a `<file>.review.json` next to a file records the visual check of each mark
 * (scripts/feedback/review.ts); with one, only marks reviewed 'ok' count.
 * Scan photos from Chromium browsers are decoded with Playwright's Chromium, as on the phone (JPEG
 * decoders differ by a level or two, enough to flip borderline decisions); others with jpeg-js.
 * Gated by bench/baseline.json (suite 'feedback'); `UPDATE_BASELINE=1` records the numbers,
 * `DEBUG_IMAGES=1` also writes the inspection images to .debug/bench/feedback/<file>/.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumDecoder, fromChromium, type ChromiumDecoder } from '../scripts/feedback/chromium';
import { writeInspection } from '../scripts/feedback/inspect';
import { readFeedbackFile } from '../scripts/feedback/io';
import { feedbackMetrics, replayFeedback } from '../scripts/feedback/replay';
import { isReviewFile, readReview } from '../scripts/feedback/review';
import { DEBUG_IMAGES, REPO_ROOT } from '../src/testing/nodeImageIO';
import { compareToBaseline, confusionTable, report, saveBaselineSuite, tallySide, UPDATE_BASELINE, yieldToEventLoop, type MetricRecord, type SideConfusion } from './lib';

const DIR = resolve(REPO_ROOT, 'test-corpus/feedback');
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json') && !isReviewFile(f)).sort() : [];
const COLUMNS = ['items', 'regions', 'missedFound', 'falseRemoved', 'mergedSplit', 'mergedExact', 'outlineFixed', 'objectRecall', 'objectClean', 'objectPrecision', 'wrongFixed', 'placementsTop1', 'boxError', 'ms'];
const results: Record<string, MetricRecord> = {};
const confusion: SideConfusion = {};

describe('feedback replay', () => {
  if (files.length === 0) {
    it.skip('no feedback files in test-corpus/feedback/', () => {});
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
      const chromiumFile = !!bundle.scan && fromChromium(bundle.app.userAgent);
      if (chromiumFile && !chrome) throw new Error('Chromium is needed to decode this file as on the phone: npx playwright install chromium');
      const scanPhoto = chromiumFile ? await chrome!.decode(bundle.scan!.photo) : undefined;
      const replay = replayFeedback(bundle, file.replace(/\.json$/i, ''), { review: readReview(path), scanPhoto });
      const metrics = feedbackMetrics(replay);
      results[file] = metrics;
      for (const r of replay.current?.regions ?? []) if (r.kind === 'piece' && r.shape) for (const side of r.shape.sides) tallySide(confusion, 'any', side);
      if (DEBUG_IMAGES) writeInspection(replay, resolve(REPO_ROOT, '.debug/bench/feedback', replay.name));
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('feedback', file, metrics);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
  afterAll(async () => {
    await chrome?.close();
    console.log('\n' + report('feedback', results, COLUMNS) + '\n');
    console.log(`Side kinds read on the single pieces (no truth; median outward/inward deviation):\n${confusionTable('feedback', confusion)}\n`);
    if (UPDATE_BASELINE) saveBaselineSuite('feedback', results);
  });
});
