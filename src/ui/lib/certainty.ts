/**
 * How sure a place is, in words. The matcher's confidence (Placement.confidence) is a heuristic
 * score, not a probability fitted to real photos, so the app never shows it as a percentage: it
 * ranks the spots and, with the match status, picks one of a few honest words. Pure.
 *
 * | certainty | when                                                       | words                          |
 * |-----------|------------------------------------------------------------|--------------------------------|
 * | sure      | the matcher is confident                                   | Sure                           |
 * | likely    | not confident, but no other spot comes close               | Likely – check it              |
 * | unsure    | several spots come close, or the picture repeats itself    | Unsure – one of these 3 spots  |
 * | unlikely  | an alternative spot that does not come close (lists only)  | Less likely                    |
 *
 * Why a piece is unsure comes from the matcher (RegionMatch.uncertainReason) when it can tell.
 */
import type { CellRef, GridSpec, UncertainReason } from '../../model/types';
import type { ScanItem } from './items';

export type Certainty = 'sure' | 'likely' | 'unsure' | 'unlikely';

/** A spot whose confidence is at least this share of the best one is worth comparing ("comes close"). */
export const RIVAL_SHARE = 0.5;
/** At most this many spots are offered to compare. */
export const MAX_SPOTS = 4;

/** Reasons that mean several spots look alike, whatever the scores say. */
const LOOKALIKE: ReadonlySet<UncertainReason> = new Set(['plain', 'repeating', 'similar-spots']);

/**
 * The spots worth comparing for an item, best first (indices into `item.candidates`): the best one
 * and those that come close to it; for a plain or repeating picture the next few as well. One for
 * sure and likely items.
 */
export function spotsToCompare(item: ScanItem): number[] {
  const c = item.candidates;
  if (c.length === 0) return [];
  if (item.status === 'confident') return [0];
  const best = Math.max(1e-6, c[0].confidence);
  const close = c.map((p, i) => ({ p, i })).filter(({ p }, i) => i === 0 || p.confidence >= RIVAL_SHARE * best);
  const lookalike = item.uncertainReason !== undefined && LOOKALIKE.has(item.uncertainReason);
  const n = lookalike ? Math.max(close.length, Math.min(3, c.length)) : close.length;
  return c.slice(0, Math.min(n, MAX_SPOTS)).map((_, i) => i);
}

/** How sure the item's best place is. */
export function itemCertainty(item: ScanItem): Exclude<Certainty, 'unlikely'> {
  if (item.status === 'confident') return 'sure';
  return spotsToCompare(item).length >= 2 ? 'unsure' : 'likely';
}

/** How sure one of the item's spots is (index into `item.candidates`). */
export function spotCertainty(item: ScanItem, index: number): Certainty {
  if (index === 0) return itemCertainty(item);
  return spotsToCompare(item).includes(index) ? 'unsure' : 'unlikely';
}

/** One word for chips and meters. */
export const CERTAINTY_WORD: Record<Certainty, string> = {
  sure: 'Sure',
  likely: 'Likely',
  unsure: 'Unsure',
  unlikely: 'Less likely',
};

/** Filled steps of the three-step meter. */
export const CERTAINTY_STEPS: Record<Certainty, number> = { sure: 3, likely: 2, unsure: 1, unlikely: 0 };

/**
 * The certainty as a status line: "Sure", "Likely – check it", "Unsure – one of these 3 spots"
 * (where the spots are shown; `short`: "Unsure – one of 3 spots", for the selection card).
 */
export function certaintyLine(item: ScanItem, short = false): string {
  const c = itemCertainty(item);
  if (c === 'sure') return 'Sure';
  if (c === 'likely') return 'Likely – check it';
  const n = spotsToCompare(item).length;
  return n >= 2 ? `Unsure – one of ${short ? '' : 'these '}${n} spots` : 'Unsure – check the options';
}

/** Compact form for list rows: '' when sure, "likely", "unsure · 3 spots". */
export function certaintyBadge(item: ScanItem): string {
  const c = itemCertainty(item);
  if (c === 'sure') return '';
  if (c === 'likely') return 'likely';
  return `unsure · ${spotsToCompare(item).length} spots`;
}

export interface ReasonText {
  /** One line for the selection card and the placing mode: "Plain area – many spots look alike". */
  card: string;
  /** The reason and what to do, for the details: "Plain area – many spots look alike. Compare the options with your piece." */
  long: string;
}

export const REASON_TEXT: Record<UncertainReason, ReasonText> = {
  plain: { card: 'Plain area – many spots look alike', long: 'Plain area – many spots look alike. Compare the options with your piece.' },
  repeating: { card: 'Repeating pattern – several spots look alike', long: 'Repeating pattern – the same pattern is in several spots. Compare the options with your piece.' },
  'similar-spots': { card: 'A few spots look much the same', long: 'A few spots look much the same. Compare them with your piece.' },
  shape: { card: 'Outline unclear – check the piece', long: 'Outline unclear – check the piece: it may be two pieces, or have some table with it.' },
  small: { card: 'Small in the photo – little to match', long: 'Small in the photo – there was little to match. Take the next photo a bit closer.' },
};

/**
 * Why the item is not sure, with what to do; undefined when sure. Falls back to what the spots
 * show when the matcher gave no reason.
 */
export function uncertaintyText(item: ScanItem): ReasonText | undefined {
  const c = itemCertainty(item);
  if (c === 'sure') return undefined;
  if (item.uncertainReason) return REASON_TEXT[item.uncertainReason];
  if (c === 'unsure') return { card: 'Several spots match about as well', long: 'Several spots match about as well. Compare them with your piece.' };
  return { card: 'Not certain – check it against the picture', long: 'The match is not certain. Check it against the picture before you place it.' };
}

/**
 * The reason for compact places next to the certainty line (selection card, placing mode): only
 * what the line does not already say – a likely piece without a reason has nothing to add.
 */
export function cardReason(item: ScanItem): string | undefined {
  if (!item.uncertainReason && itemCertainty(item) !== 'unsure') return undefined;
  return uncertaintyText(item)?.card;
}

/** Plain words for a cell: "row 3, column 5". */
export function cellWords(cell: CellRef): string {
  return `row ${cell.row + 1}, column ${cell.col + 1}`;
}

/**
 * The placed-conflict note: the cell the user marked as placed that this item seems to belong in,
 * while that cell is still marked placed (and the note was not answered with "Keep").
 */
export function placedConflictCell(item: ScanItem, isPlacedCell: (cell: CellRef) => boolean, grid: GridSpec, kept: (item: ScanItem) => boolean): CellRef | undefined {
  const cell = item.placedConflict;
  if (!cell || cell.row < 0 || cell.col < 0 || cell.row >= grid.rows || cell.col >= grid.cols) return undefined;
  if (!isPlacedCell(cell) || kept(item)) return undefined;
  return cell;
}

/** Key under which "Keep" on a conflict note is remembered (AppPrefs.dismissed). */
export function conflictKeptKey(scanId: string, item: ScanItem): string {
  const c = item.placedConflict;
  return `placed-conflict:${scanId}:${item.key}:${c ? `${c.row},${c.col}` : ''}`;
}
