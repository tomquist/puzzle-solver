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
 * Report only (no baseline: the files exist on one machine). Skips when the folder is empty.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromiumDecoder, fromChromium, type ChromiumDecoder } from '../scripts/feedback/chromium';
import { readFeedbackFile } from '../scripts/feedback/io';
import { replayFeedback } from '../scripts/feedback/replay';
import { isReviewFile } from '../scripts/feedback/review';
import { isTruthFile, readTruth, scoreTruth, type TruthJudgement } from '../scripts/feedback/truth';
import { REPO_ROOT } from '../src/testing/nodeImageIO';
import { report, yieldToEventLoop, type MetricRecord } from './lib';

const DIR = resolve(REPO_ROOT, 'test-corpus/private');
const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json') && !isTruthFile(f) && !isReviewFile(f) && existsSync(resolve(DIR, f.replace(/\.json$/i, '.truth.json')))).sort()
  : [];
const COLUMNS = ['pieces', 'unsure', 'found', 'merged', 'top1', 'top3', 'rotationOk', 'confidentShare', 'confidentPrecision', 'blocks', 'blockTop1', 'blockJaccard', 'blockRotationOk', 'ms'];
const results: Record<string, MetricRecord> = {};
const misses: string[] = [];

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
      results[`${name} (current)`] = { ...current.metrics, ms: replay.timings.analyze ?? 0 };
      for (const j of current.items) if (!j.unsure && (!j.top1 || !j.rotationOk || j.merged || j.regionId === undefined)) misses.push(describeMiss(name, j));
    });
  }
  afterAll(async () => {
    await chrome?.close();
    console.log('\n' + report('private', results, COLUMNS) + '\n');
    if (misses.length > 0) console.log(`Misplaced, merged or missed (current pipeline):\n${misses.join('\n')}\n`);
  });
});
