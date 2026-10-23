/**
 * Editing the marks of a feedback file (pure): one mark per detected region (tapping it again in
 * the same mode removes it, another mode replaces it), any number of "missed piece" points.
 */
import { pointInPolygon } from '../../cv/polygon';
import type { CellRef, DetectedRegion, GridSpec, ScanResult } from '../../model/types';
import type { FeedbackMark, FeedbackMarkKind } from '../../feedback/format';
import { buildScanItems } from './items';

/** Kinds placed by tapping one region of the photo. */
export type RegionMarkKind = Exclude<FeedbackMarkKind, 'missed' | 'wrong_fit'>;

/** A mark of one region (every kind but a missed point and a pair that doesn't fit). */
export type RegionMark = Extract<FeedbackMark, { kind: RegionMarkKind }>;

/** The kinds the feedback screen places by tapping the photo (its modes). */
export type MarkMode = 'missed' | RegionMarkKind;

/**
 * A mark on the feedback screen: a FeedbackMark, and the ids of the scan's notes it came from
 * (FeedbackNote; removing the mark removes them). Written to the file without `noteIds`.
 */
export type DraftMark = FeedbackMark & { noteIds?: string[] };

/** The marks as they go into the file (without the screen's note ids). */
export function toFileMarks(marks: DraftMark[]): FeedbackMark[] {
  return marks.map((m) => {
    const { noteIds, ...mark } = m;
    void noteIds;
    return mark as FeedbackMark;
  });
}

export interface MarkKindInfo<K extends FeedbackMarkKind = FeedbackMarkKind> {
  kind: K;
  /** Mode selector label: the problem in plain words. */
  label: string;
  /** What the problem looks like on the photo (shown while the mode is active). */
  what: string;
  /** How to place the mark. */
  how: string;
}

export const MARK_KINDS: MarkKindInfo<MarkMode>[] = [
  { kind: 'missed', label: 'Piece not found', what: 'A piece without a coloured outline.', how: 'Tap the middle of the piece.' },
  { kind: 'not_a_piece', label: 'Not a piece', what: 'An outline with no piece inside – table, shadow, glare or a gap.', how: 'Tap inside the outline.' },
  { kind: 'merged', label: 'Pieces stuck together', what: 'One outline around two or more loose pieces.', how: 'Tap inside the outline.' },
  { kind: 'bad_outline', label: 'Outline off', what: 'One piece, but its outline cuts part of it off or takes in table.', how: 'Tap inside the outline.' },
  { kind: 'wrong_place', label: 'Wrong place', what: 'The piece is shown in the wrong spot of the puzzle.', how: 'Tap the piece; you can then show the right spot.' },
];

/**
 * Kinds noted on the scan result or while placing (FeedbackNote), not placed on the feedback photo:
 * they come in already marked.
 */
export const NOTED_KINDS: MarkKindInfo[] = [
  {
    kind: 'wrong_fit',
    label: 'Doesn’t fit',
    what: 'Two pieces the app said join don’t fit together.',
    how: 'Select a piece on the scan result, then tap Doesn’t fit next to the other piece.',
  },
];

export function markInfo(kind: FeedbackMarkKind): MarkKindInfo {
  return [...MARK_KINDS, ...NOTED_KINDS].find((k) => k.kind === kind)!;
}

export function isRegionMark(m: FeedbackMark): m is RegionMark {
  return m.kind !== 'missed' && m.kind !== 'wrong_fit';
}

/** Index of the mark on `regionId`, or -1. */
export function markIndexForRegion(marks: FeedbackMark[], regionId: number): number {
  return marks.findIndex((m) => isRegionMark(m) && m.regionId === regionId);
}

/** Tap on a region in a region mode: add the mark, remove it (same kind) or change its kind. */
export function toggleRegionMark<M extends FeedbackMark>(marks: M[], kind: RegionMarkKind, regionId: number): (M | FeedbackMark)[] {
  const i = markIndexForRegion(marks, regionId);
  if (i < 0) return [...marks, { kind, regionId }];
  if (marks[i].kind === kind) return removeMark(marks, i);
  const next: (M | FeedbackMark)[] = [...marks];
  next[i] = { kind, regionId };
  return next;
}

/** Mark a region with `kind` (adds it, or changes the kind of its existing mark; never removes). */
export function setRegionMark<M extends FeedbackMark>(marks: M[], kind: RegionMarkKind, regionId: number): (M | FeedbackMark)[] {
  const i = markIndexForRegion(marks, regionId);
  if (i < 0) return [...marks, { kind, regionId }];
  const next: (M | FeedbackMark)[] = [...marks];
  next[i] = { kind, regionId };
  return next;
}

export function addMissed<M extends FeedbackMark>(marks: M[], x: number, y: number): (M | FeedbackMark)[] {
  return [...marks, { kind: 'missed', x: Math.round(x), y: Math.round(y) }];
}

export function removeMark<M>(marks: M[], index: number): M[] {
  return marks.filter((_, i) => i !== index);
}

/** Set (or clear) the right cell of a "wrong place" mark (its rejected spots and notes stay). */
export function setCorrectCell<M extends FeedbackMark>(marks: M[], index: number, cell: CellRef | undefined): M[] {
  const m = marks[index];
  if (!m || m.kind !== 'wrong_place') return marks;
  const next = [...marks];
  const changed: Record<string, unknown> = { ...m };
  if (cell) changed.correct = { row: cell.row, col: cell.col };
  else delete changed.correct;
  next[index] = changed as M;
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

/** How the result screens treat a detected region: the colour it gets on the feedback photo. */
export type DetectionTone = 'confident' | 'ambiguous' | 'patch' | 'hidden';

export function detectionTones(result: ScanResult, grid: GridSpec): Map<number, DetectionTone> {
  const { items } = buildScanItems(result, grid);
  const tones = new Map<number, DetectionTone>();
  for (const item of items) for (const id of item.regionIds) tones.set(id, item.kind === 'assembled' ? 'patch' : item.status);
  // Everything else (no usable match, weak assembled groups) is found but not shown.
  for (const r of result.regions) if (!tones.has(r.id)) tones.set(r.id, 'hidden');
  return tones;
}

/** The detected region under a photo point (the smallest one when outlines overlap). */
export function regionAt(result: ScanResult, x: number, y: number): DetectedRegion | undefined {
  let best: DetectedRegion | undefined;
  for (const r of result.regions) {
    const b = r.bbox;
    if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height || r.contour.length < 3) continue;
    if (pointInPolygon({ x, y }, r.contour) && (!best || r.area < best.area)) best = r;
  }
  return best;
}

/** "This piece was …" */
export function foundText(tone: DetectionTone): string {
  switch (tone) {
    case 'confident':
      return 'found';
    case 'ambiguous':
      return 'found (unsure)';
    case 'patch':
      return 'found (in an assembled group)';
    case 'hidden':
      return 'found but not shown';
  }
}

/**
 * Better marks than "missed" for a piece the app did find, most likely first (a found-but-hidden
 * piece has no place to be wrong). On a region clearly larger than one piece, the "missed" piece is
 * most likely stuck together with another one.
 */
export function alternativesFor(tone: DetectionTone, several = false): RegionMarkKind[] {
  if (several) return tone === 'hidden' ? ['merged', 'bad_outline'] : ['merged', 'bad_outline', 'wrong_place'];
  return tone === 'hidden' ? ['bad_outline', 'merged'] : ['wrong_place', 'bad_outline', 'merged'];
}

/** Fewest single-piece regions a typical piece size is taken from. */
const MIN_PIECES_FOR_SIZE = 3;

/**
 * Area of a typical single piece in this scan: the median area of the regions the app took for one
 * piece (cut off ones at the photo border left out; the median ignores the odd merged one), or
 * undefined when there are too few to tell.
 */
export function typicalPieceArea(result: ScanResult): number | undefined {
  const areas = result.regions
    .filter((r) => r.kind === 'piece' && !r.touchesBorder && r.area > 0)
    .map((r) => r.area)
    .sort((a, b) => a - b);
  if (areas.length < MIN_PIECES_FOR_SIZE) return undefined;
  const mid = areas.length >> 1;
  return areas.length % 2 ? areas[mid] : (areas[mid - 1] + areas[mid]) / 2;
}

/**
 * Area (× a typical piece) from which a region clearly holds more than one piece. Single pieces
 * vary by about ±25 % (tabs vs. blanks, perspective), two pieces are about 2×.
 */
export const SEVERAL_PIECES_AREA = 1.8;

/** True when a region is clearly larger than one piece of this scan. */
export function looksLikeSeveral(region: DetectedRegion, pieceArea: number | undefined): boolean {
  return pieceArea !== undefined && pieceArea > 0 && region.area >= SEVERAL_PIECES_AREA * pieceArea;
}

/**
 * A gentle second opinion right after a region mark was added – only where it is clear:
 * - 'assembled': "Outline off" on pieces the user joined (one outline around them is right);
 * - 'several': "Outline off" on a region clearly larger than one piece (likely pieces stuck together).
 */
export type MarkHint = 'assembled' | 'several';

/**
 * The marks a hint offers instead, most likely first. A region much bigger than one piece holds
 * several pieces – or none (glare, a shadow); without a usable match ('hidden') none is likelier.
 */
export function hintKinds(hint: MarkHint, tone: DetectionTone): RegionMarkKind[] {
  if (hint === 'assembled') return ['merged'];
  return tone === 'hidden' ? ['not_a_piece', 'merged'] : ['merged', 'not_a_piece'];
}

export function markHint(kind: RegionMarkKind, region: DetectedRegion, tone: DetectionTone, pieceArea: number | undefined): MarkHint | undefined {
  if (kind !== 'bad_outline') return undefined;
  if (tone === 'patch') return 'assembled';
  return looksLikeSeveral(region, pieceArea) ? 'several' : undefined;
}

