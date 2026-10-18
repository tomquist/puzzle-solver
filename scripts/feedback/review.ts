/**
 * Reviews of a feedback file's marks. Marks are what the user tapped, not ground truth: users miss
 * a piece, tap beside one or mark two touching pieces as one. Before a file's marks gate the
 * benchmark, each one is checked by eye on the photo and the verdict goes into a sidecar next to
 * the file, `<name>.review.json`:
 *
 *   { "reviewed": "2026-10-18", "marks": { "1": { "verdict": "ok", "parts": 3, "note": "…" } } }
 *
 * Keys are the 1-based mark numbers of the inspector (M1, M2, …). Verdicts: 'ok' (the mark is
 * right), 'wrong' (the user's mistake), 'unsure'. Once a file has a review only its 'ok' marks
 * count in the metrics. `parts` (merged marks): how many regions the marked region really holds,
 * counting loose pieces and assembled groups (which stay one region each).
 */
import { existsSync, readFileSync } from 'node:fs';

export type MarkVerdict = 'ok' | 'wrong' | 'unsure';

export interface MarkReview {
  verdict: MarkVerdict;
  parts?: number;
  note?: string;
}

export interface FeedbackReview {
  /** Date of the review (YYYY-MM-DD). */
  reviewed: string;
  marks: Record<string, MarkReview>;
}

export const isReviewFile = (path: string): boolean => /\.review\.json$/i.test(path);

export function reviewPath(feedbackPath: string): string {
  return feedbackPath.replace(/\.json$/i, '') + '.review.json';
}

/** The review next to a feedback file, if there is one. Throws on a malformed review. */
export function readReview(feedbackPath: string): FeedbackReview | undefined {
  const path = reviewPath(feedbackPath);
  if (!existsSync(path)) return undefined;
  const review = JSON.parse(readFileSync(path, 'utf8')) as FeedbackReview;
  for (const [key, m] of Object.entries(review.marks ?? {})) {
    if (!/^\d+$/.test(key) || !['ok', 'wrong', 'unsure'].includes(m.verdict)) throw new Error(`${path}: bad review entry "${key}"`);
  }
  return review;
}
