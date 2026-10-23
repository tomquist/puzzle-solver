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
 * counting loose pieces and assembled groups (which stay one region each). `kind`: the right kind
 * when the user picked the wrong one for a real problem (e.g. "outline off" on glare with no piece
 * inside: not_a_piece); the mark is then judged as that kind (region marks only).
 *
 * `pieces` (bad_outline marks): what the marked area really holds, as by-eye points spread over
 * each piece (photo pixels, well inside: body, knobs, tabs, so that a cut through a piece leaves
 * points on both sides), and `assembled`: the groups of those pieces (0-based indices) that are
 * assembled. With it the mark is judged: fixed when every piece lies whole in one piece / patch
 * region (all its points in the same region) and no region holds points of two pieces, except one
 * patch region holding exactly one assembled group (an assembled group stays one region; split
 * exactly along its seams, one region per piece, is right as well). `table` (optional): by-eye points
 * of table (or shadow) next to those pieces that the marked outline took in, such as the table in a
 * blank closed off by a touching neighbour or in the notch between two pieces: fixed then also needs
 * each of them outside every piece / patch region.
 *
 * `objects` (optional) is a complete answer key for the photo: one point (photo pixels, well inside)
 * for every loose piece and every assembled group, found by checking the photo by eye, not taken
 * from any result. It scores the whole result, including mistakes nobody marked. `unsure` objects
 * count neither way. With `area` the key covers only that rectangle (photo pixels; for photos where
 * only part can be told apart reliably): only regions centred inside it are judged real or false,
 * while its objects are found by any region over them.
 */
import { existsSync, readFileSync } from 'node:fs';

export type MarkVerdict = 'ok' | 'wrong' | 'unsure';

export interface MarkReview {
  verdict: MarkVerdict;
  parts?: number;
  /** The kind the mark should have had (region marks only); it is judged as this kind. */
  kind?: 'not_a_piece' | 'merged' | 'bad_outline' | 'wrong_place';
  /** bad_outline marks: points of each piece the marked area holds (see above). */
  pieces?: { x: number; y: number }[][];
  /** Groups of `pieces` (0-based indices) that are assembled: one patch region per group is right too. */
  assembled?: number[][];
  /** bad_outline marks with `pieces`: points of table the outline wrongly took in (must lie in no region). */
  table?: { x: number; y: number }[];
  note?: string;
}

export interface ReviewObject {
  x: number;
  y: number;
  unsure?: boolean;
  note?: string;
}

export interface FeedbackReview {
  /** Date of the review (YYYY-MM-DD). */
  reviewed: string;
  marks: Record<string, MarkReview>;
  /** Every piece and assembled group in the photo (or in `area`), when the reviewer listed them all. */
  objects?: ReviewObject[];
  area?: { x: number; y: number; width: number; height: number };
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
    if (m.kind !== undefined && !['not_a_piece', 'merged', 'bad_outline', 'wrong_place'].includes(m.kind)) throw new Error(`${path}: bad kind in review entry "${key}"`);
    if (m.assembled !== undefined && (!Array.isArray(m.assembled) || m.assembled.some((g) => !Array.isArray(g) || g.some((k) => !Number.isInteger(k) || k < 0 || k >= (m.pieces?.length ?? 0))))) throw new Error(`${path}: bad assembled groups in review entry "${key}"`);
    if (m.table !== undefined && (!Array.isArray(m.table) || m.table.some((q) => !Number.isFinite(q?.x) || !Number.isFinite(q?.y)))) throw new Error(`${path}: bad table points in review entry "${key}"`);
    if (m.pieces !== undefined && (!Array.isArray(m.pieces) || m.pieces.some((ps) => !Array.isArray(ps) || ps.length === 0 || ps.some((q) => !Number.isFinite(q?.x) || !Number.isFinite(q?.y))))) throw new Error(`${path}: bad pieces in review entry "${key}"`);
  }
  for (const o of review.objects ?? []) if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) throw new Error(`${path}: bad object ${JSON.stringify(o)}`);
  return review;
}
