/**
 * The feedback tooling (scripts/feedback, bench/feedback.eval.ts) on a synthetic feedback file with
 * known answers: written to disk, read back, replayed with the current pipeline, judged, and
 * rendered by the inspector.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeFeedback, type FeedbackBundle } from '../../feedback/format';
import { writeInspection } from '../../../scripts/feedback/inspect';
import { evaluateFeedbackFile, feedbackMetrics, replayFeedback, type FeedbackMetrics, type FeedbackReplay } from '../../../scripts/feedback/replay';
import { readReview, reviewPath, type FeedbackReview } from '../../../scripts/feedback/review';
import { makeSyntheticFeedback } from '../../../scripts/feedback/synthetic';

const dir = mkdtempSync(join(tmpdir(), 'feedback-tooling-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('feedback tooling', () => {
  let bundle: FeedbackBundle;
  let replay: FeedbackReplay;
  let metrics: FeedbackMetrics;
  beforeAll(() => {
    const synthetic = makeSyntheticFeedback({ seed: 21 });
    bundle = synthetic.bundle;
    // A second 'missed' mark on empty table: it must stay missed, with a diagnosis.
    bundle.marks.push({ kind: 'missed', x: synthetic.emptyPoint.x, y: synthetic.emptyPoint.y });
    const file = join(dir, 'puzzle-feedback-synthetic.json');
    writeFileSync(file, serializeFeedback(bundle));
    ({ replay, metrics } = evaluateFeedbackFile(file));
  }, 120_000);
  const verdict = (kind: string) => replay.marks.filter((j) => j.mark.kind === kind);

  it('judges every kind of mark against the current pipeline', () => {
    const [found, table] = verdict('missed');
    expect(found.fixed, found.now).toBe(true);
    expect(table.fixed).toBe(false);
    expect(table.why).toMatch(/table|score/);
    expect(verdict('not_a_piece')[0].fixed).toBe(true);
    expect(verdict('merged')[0].fixed, verdict('merged')[0].now).toBe(true);
    expect(verdict('merged')[0].currentIds.length).toBe(2);
    expect(verdict('wrong_place')[0].fixed).toBe(true);
    expect(verdict('bad_outline')[0].fixed).toBeNull();
    expect(replay.placements.every((p) => p.ok && p.originalOk)).toBe(true);
  });

  it('computes the gated metrics', () => {
    expect(metrics.missedFound).toBe(0.5);
    expect(metrics.falseRemoved).toBe(1);
    expect(metrics.mergedSplit).toBe(1);
    expect(metrics.wrongFixed).toBe(1);
    expect(metrics.placementsTop1).toBe(1);
    expect(metrics.boxError).toBeLessThan(0.02);
    expect(metrics.items).toBe(bundle.marks.length + bundle.scan!.placements.length);
  });

  it('counts only marks the visual review confirmed', () => {
    // The 'missed' mark on empty table (added last) is a user mistake.
    const tableMark = bundle.marks.length;
    const review: FeedbackReview = {
      reviewed: '2026-10-18',
      marks: Object.fromEntries(replay.marks.map((j) => [String(j.index), { verdict: j.index === tableMark ? 'wrong' : 'ok' }])),
    };
    const file = join(dir, 'puzzle-feedback-synthetic.json');
    writeFileSync(reviewPath(file), JSON.stringify(review));
    expect(readReview(file)).toEqual(review);
    rmSync(reviewPath(file));
    const reviewed = feedbackMetrics({ ...replay, reviewed: true, marks: replay.marks.map((j) => ({ ...j, review: review.marks[String(j.index)] })) });
    expect(reviewed.missedFound).toBe(1);
    expect(reviewed.falseRemoved).toBe(metrics.falseRemoved);
    // Unreviewed marks of a reviewed file don't count either.
    const partial = feedbackMetrics({ ...replay, reviewed: true, marks: replay.marks.map((j) => ({ ...j, review: undefined })) });
    expect(partial.missedFound).toBeUndefined();
  });

  it('writes readable inspection images and a summary', () => {
    const out = join(dir, 'inspect');
    const { summary, files } = writeInspection(replay, out);
    for (const name of ['1-original.png', '2-current.png', '3-score.png', '4-mask.png', '5-background.png', '6-marks-1.png', '6-marks-2.png', '7-box.png', 'summary.txt', 'replay.json']) {
      expect(existsSync(join(out, name)), name).toBe(true);
    }
    expect(files.length).toBeGreaterThanOrEqual(10);
    const png = PNG.sync.read(readFileSync(join(out, '2-current.png')));
    expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(1400 + 200);
    expect(summary).toMatch(/M1 +missed/);
    expect(summary).toMatch(/STILL MISSED/);
    expect(summary).toMatch(/placements: top-1 now 3\/3/);
    expect(summary).toMatch(/box: corner error/);
  });

  it('replays segmentation only when the file has no reference picture', { timeout: 60_000 }, () => {
    const noRef = { ...bundle, reference: undefined, box: undefined };
    const r = replayFeedback(noRef, 'no-reference');
    expect(r.matched).toBe(false);
    expect(r.marks.find((j) => j.mark.kind === 'missed')!.fixed).toBe(true);
    expect(r.marks.find((j) => j.mark.kind === 'wrong_place')!.fixed).toBeNull();
    expect(r.notes.join(' ')).toMatch(/no reference/);
    const { files } = writeInspection(r, join(dir, 'no-reference'));
    expect(files.some((f) => f.endsWith('2-current.png'))).toBe(true);
  });
});
