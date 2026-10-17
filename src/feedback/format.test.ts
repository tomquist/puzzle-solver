import { describe, expect, it } from 'vitest';
import { FEEDBACK_FORMAT, FEEDBACK_VERSION, encodeFeedbackImage, decodeFeedbackImageBytes, feedbackFileName, parseFeedback, serializeFeedback, type FeedbackBundle } from './format';

const bundle: FeedbackBundle = {
  format: FEEDBACK_FORMAT,
  version: FEEDBACK_VERSION,
  createdAt: Date.UTC(2026, 9, 17, 18, 42),
  app: { version: 'abc1234', userAgent: 'test', viewport: { width: 390, height: 844, dpr: 3 } },
  puzzle: { pieceCount: 1000, grid: { rows: 27, cols: 37 }, cut: 'grid' },
  scan: {
    photo: encodeFeedbackImage(new Uint8Array([1, 2, 3, 250]), 'image/jpeg', 2, 2),
    result: { width: 2, height: 2, regions: [], matches: [], fits: [], quality: { score: 1, issues: [], metrics: {} }, timings: {} },
    placements: [],
  },
  marks: [{ kind: 'missed', x: 1, y: 1 }, { kind: 'wrong_place', regionId: 3, correct: { row: 2, col: 5 } }],
  comment: 'two pieces missed',
};

describe('feedback format', () => {
  it('round-trips through JSON with images intact', () => {
    const back = parseFeedback(serializeFeedback(bundle));
    expect(back.marks).toEqual(bundle.marks);
    expect([...decodeFeedbackImageBytes(back.scan!.photo)]).toEqual([1, 2, 3, 250]);
  });
  it('rejects other files', () => {
    expect(() => parseFeedback('nope')).toThrow(/JSON/);
    expect(() => parseFeedback(JSON.stringify({ format: 'x' }))).toThrow(/feedback file/);
    expect(() => parseFeedback(JSON.stringify({ ...bundle, version: 99 }))).toThrow(/version/);
  });
  it('names files by date', () => {
    expect(feedbackFileName(new Date(2026, 9, 17, 18, 42).getTime())).toBe('puzzle-feedback-2026-10-17-1842.json');
  });
});
