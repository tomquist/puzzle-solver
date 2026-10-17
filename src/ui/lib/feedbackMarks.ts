/**
 * Editing the marks of a feedback file (pure): one mark per detected region (tapping it again in
 * the same mode removes it, another mode replaces it), any number of "missed piece" points.
 */
import type { CellRef } from '../../model/types';
import type { FeedbackMark, FeedbackMarkKind } from '../../feedback/format';

export type RegionMarkKind = Exclude<FeedbackMarkKind, 'missed'>;

export interface MarkKindInfo {
  kind: FeedbackMarkKind;
  /** Mode selector label. */
  label: string;
  /** One-line instruction while the mode is active. */
  help: string;
}

export const MARK_KINDS: MarkKindInfo[] = [
  { kind: 'missed', label: 'Missed piece', help: 'Tap a piece that has no outline.' },
  { kind: 'not_a_piece', label: 'Not a piece', help: 'Tap an outline around something that isn’t a piece (shadow, glare, table).' },
  { kind: 'merged', label: 'Several pieces', help: 'Tap an outline that covers more than one piece.' },
  { kind: 'bad_outline', label: 'Wrong outline', help: 'Tap a piece whose outline doesn’t follow its edge.' },
  { kind: 'wrong_place', label: 'Wrong place', help: 'Tap a piece that was shown in the wrong place.' },
];

export function markInfo(kind: FeedbackMarkKind): MarkKindInfo {
  return MARK_KINDS.find((k) => k.kind === kind)!;
}

export function isRegionMark(m: FeedbackMark): m is Exclude<FeedbackMark, { kind: 'missed' }> {
  return m.kind !== 'missed';
}

/** Index of the mark on `regionId`, or -1. */
export function markIndexForRegion(marks: FeedbackMark[], regionId: number): number {
  return marks.findIndex((m) => isRegionMark(m) && m.regionId === regionId);
}

/** Tap on a region in a region mode: add the mark, remove it (same kind) or change its kind. */
export function toggleRegionMark(marks: FeedbackMark[], kind: RegionMarkKind, regionId: number): FeedbackMark[] {
  const i = markIndexForRegion(marks, regionId);
  if (i < 0) return [...marks, { kind, regionId }];
  if (marks[i].kind === kind) return removeMark(marks, i);
  const next = [...marks];
  next[i] = { kind, regionId };
  return next;
}

export function addMissed(marks: FeedbackMark[], x: number, y: number): FeedbackMark[] {
  return [...marks, { kind: 'missed', x: Math.round(x), y: Math.round(y) }];
}

export function removeMark(marks: FeedbackMark[], index: number): FeedbackMark[] {
  return marks.filter((_, i) => i !== index);
}

/** Set (or clear) the right cell of a "wrong place" mark. */
export function setCorrectCell(marks: FeedbackMark[], index: number, cell: CellRef | undefined): FeedbackMark[] {
  const m = marks[index];
  if (!m || m.kind !== 'wrong_place') return marks;
  const next = [...marks];
  next[index] = cell ? { kind: 'wrong_place', regionId: m.regionId, correct: { row: cell.row, col: cell.col } } : { kind: 'wrong_place', regionId: m.regionId };
  return next;
}

const AREAS = [
  ['top left', 'top', 'top right'],
  ['left', 'middle', 'right'],
  ['bottom left', 'bottom', 'bottom right'],
];

/** Where a point is in a picture, in words ("top left" … "bottom right"). */
export function areaName(x: number, y: number, width: number, height: number): string {
  const third = (v: number, size: number) => Math.min(2, Math.max(0, Math.floor((v / Math.max(1, size)) * 3)));
  return AREAS[third(y, height)][third(x, width)];
}
