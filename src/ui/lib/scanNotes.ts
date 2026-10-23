/**
 * Notes for feedback kept with a scan (ScanRecord.feedbackNotes) and the spots chosen for its items
 * (ScanRecord.spotChoices) – pure helpers. Each change works on what is stored (read-modify-write in
 * one repository step, see useScanNotes), so changes made meanwhile elsewhere are kept.
 *
 * - "Doesn't fit" on a connection notes a 'wrong_fit': the connection is no longer suggested
 *   (withoutRejectedFits), also after the note went out in a feedback file.
 * - "Not here" notes a 'wrong_place' with the spot shown, and the next spot is chosen.
 * - The feedback screen starts with the unsent notes as marks (notesToMarks); removing such a mark
 *   removes its notes, sending the file marks them sent.
 */
import { cellKey, type CellRef, type FeedbackNote, type GridSpec, type ScanRecord, type ScanResult, type SpotChoice } from '../../model/types';
import type { RejectedSpot } from '../../feedback/format';
import type { DraftMark } from './feedbackMarks';
import type { ItemLink, ItemPlacement, ScanItem } from './items';

/** The note fields of a scan. */
export type ScanNotes = Pick<ScanRecord, 'feedbackNotes' | 'spotChoices'>;

export type WrongFitNote = Extract<FeedbackNote, { kind: 'wrong_fit' }>;
export type WrongPlaceNote = Extract<FeedbackNote, { kind: 'wrong_place' }>;

/** Notes not sent in a feedback file yet. */
export function unsentNotes(notes: FeedbackNote[] | undefined): FeedbackNote[] {
  return (notes ?? []).filter((n) => n.sentAt === undefined);
}

const samePair = (n: WrongFitNote, a: number, b: number) => (n.a === a && n.b === b) || (n.a === b && n.b === a);
const sameCell = (x: CellRef, y: CellRef) => x.row === y.row && x.col === y.col;
const sameGrid = (x: GridSpec, y: GridSpec) => x.rows === y.rows && x.cols === y.cols;

/** True when `notes` already say the same (the same pair; the same item and spot not yet sent). */
export function isNoted(notes: FeedbackNote[] | undefined, note: FeedbackNote): boolean {
  return (notes ?? []).some((n) => {
    if (n.kind === 'wrong_fit' && note.kind === 'wrong_fit') return samePair(n, note.a, note.b);
    if (n.kind === 'wrong_place' && note.kind === 'wrong_place') return n.sentAt === undefined && n.regionId === note.regionId && sameCell(n.cell, note.cell) && sameGrid(n.grid, note.grid);
    return false;
  });
}

/** Add a note (nothing changes when the same is noted already). */
export function addNote<S extends ScanNotes>(scan: S, note: FeedbackNote): S {
  if (isNoted(scan.feedbackNotes, note)) return scan;
  return { ...scan, feedbackNotes: [...(scan.feedbackNotes ?? []), note] };
}

/**
 * Remove notes by id – only unsent ones: a sent note stays (it keeps its connection hidden). The
 * field is dropped when no note is left.
 */
export function removeNotes<S extends ScanNotes>(scan: S, ids: Iterable<string>): S {
  const drop = new Set(ids);
  const before = scan.feedbackNotes ?? [];
  const kept = before.filter((n) => !(drop.has(n.id) && n.sentAt === undefined));
  if (kept.length === before.length) return scan;
  const next: S = { ...scan, feedbackNotes: kept };
  if (kept.length === 0) delete next.feedbackNotes;
  return next;
}

/** Mark notes as sent in a feedback file at `at` (epoch ms). */
export function markNotesSent<S extends ScanNotes>(scan: S, ids: Iterable<string>, at: number): S {
  const sent = new Set(ids);
  if (!scan.feedbackNotes?.some((n) => sent.has(n.id) && n.sentAt === undefined)) return scan;
  return { ...scan, feedbackNotes: scan.feedbackNotes.map((n) => (sent.has(n.id) && n.sentAt === undefined ? { ...n, sentAt: at } : n)) };
}

/** Choose the spot shown for an item (undefined: back to its best spot). */
export function setSpotChoice<S extends ScanNotes>(scan: S, key: string, choice: SpotChoice | undefined): S {
  const choices = { ...(scan.spotChoices ?? {}) };
  if (choice) choices[key] = { index: choice.index, ...(choice.cell ? { cell: { row: choice.cell.row, col: choice.cell.col } } : {}) };
  else delete choices[key];
  const next: S = { ...scan, spotChoices: choices };
  if (Object.keys(choices).length === 0) delete next.spotChoices;
  return next;
}

/** The choice of candidate `index` of `item` (with the cell it is at, to find it again). */
export function spotChoiceOf(item: ScanItem, index: number): SpotChoice {
  const cell = item.candidates[index]?.cells[0];
  return cell ? { index, cell: { row: cell.row, col: cell.col } } : { index };
}

/**
 * Candidate index per item key from the stored choices. A choice whose cell is no longer at its
 * index (the candidates changed) follows the cell, and is dropped when no candidate has it any
 * more; an index past the last candidate (every spot rejected) is kept.
 */
export function resolveSpotChoices(choices: Record<string, SpotChoice> | undefined, items: ScanItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!choices) return out;
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const [key, choice] of Object.entries(choices)) {
    const item = byKey.get(key);
    if (!item || !Number.isInteger(choice.index) || choice.index < 0) continue;
    if (choice.index >= item.candidates.length) {
      out[key] = item.candidates.length;
      continue;
    }
    if (!choice.cell) {
      out[key] = choice.index;
      continue;
    }
    const at = (i: number) => item.candidates[i].cells[0];
    if (at(choice.index) && sameCell(at(choice.index), choice.cell)) out[key] = choice.index;
    else {
      const moved = item.candidates.findIndex((p) => p.cells[0] && sameCell(p.cells[0], choice.cell!));
      if (moved >= 0) out[key] = moved;
    }
  }
  return out;
}

/** Item key of every region (members of an assembled group map to the group). */
function itemOfRegion(items: ScanItem[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const item of items) for (const id of item.regionIds) out.set(id, item.key);
  return out;
}

/** The links without those a 'wrong_fit' note (sent or not) rejects. */
export function withoutRejectedFits<L extends Pick<ItemLink, 'a' | 'b'>>(links: L[], items: ScanItem[], notes: FeedbackNote[] | undefined): L[] {
  const fits = (notes ?? []).filter((n): n is WrongFitNote => n.kind === 'wrong_fit');
  if (fits.length === 0) return links;
  const keyOf = itemOfRegion(items);
  const rejected = new Set<string>();
  for (const n of fits) {
    const a = keyOf.get(n.a);
    const b = keyOf.get(n.b);
    if (a && b && a !== b) rejected.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return links.filter((l) => !rejected.has(l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`));
}

/** The note for "`item` doesn't fit with `other`" (the sides from their link, when it has them). */
export function wrongFitNote(id: string, item: ScanItem, other: ScanItem, link: ItemLink | undefined): WrongFitNote {
  const note: WrongFitNote = { id, kind: 'wrong_fit', a: item.label, b: other.label };
  if (link) {
    const forward = link.a === item.key;
    const sideA = forward ? link.sideA : link.sideB;
    const sideB = forward ? link.sideB : link.sideA;
    if (sideA) note.sideA = sideA;
    if (sideB) note.sideB = sideB;
  }
  return note;
}

/** The note for "`item` doesn't go at `placement`" (its first cell and turn, on `grid`). */
export function wrongPlaceNote(id: string, item: ScanItem, placement: ItemPlacement, grid: GridSpec): WrongPlaceNote | undefined {
  const cell = placement.cells[0] ?? { row: placement.bounds.row0, col: placement.bounds.col0 };
  if (!Number.isInteger(cell.row) || !Number.isInteger(cell.col)) return undefined;
  const note: WrongPlaceNote = { id, kind: 'wrong_place', regionId: item.label, cell: { row: cell.row, col: cell.col }, grid: { rows: grid.rows, cols: grid.cols } };
  if (placement.rotationDeg !== undefined) note.rotationDeg = placement.rotationDeg;
  return note;
}

/** Ids of the unsent 'wrong_place' notes of an item at a cell (the user chose that spot again). */
export function wrongPlaceNotesAt(notes: FeedbackNote[] | undefined, regionId: number, cell: CellRef | undefined): string[] {
  if (!cell) return [];
  return unsentNotes(notes).flatMap((n) => (n.kind === 'wrong_place' && n.regionId === regionId && sameCell(n.cell, cell) ? [n.id] : []));
}

/**
 * The unsent notes as feedback marks, in the order they were noted: one 'wrong_fit' mark per pair,
 * one 'wrong_place' mark per item with its rejected spots (spots noted on another grid than
 * `grid` are left out: their cells mean something else now). Notes about regions the result does
 * not have (any more) are left out.
 */
export function notesToMarks(notes: FeedbackNote[] | undefined, result: Pick<ScanResult, 'regions'>, grid: GridSpec): DraftMark[] {
  const ids = new Set(result.regions.map((r) => r.id));
  const marks: DraftMark[] = [];
  const places = new Map<number, Extract<DraftMark, { kind: 'wrong_place' }>>();
  for (const n of unsentNotes(notes)) {
    if (n.kind === 'wrong_fit') {
      if (!ids.has(n.a) || !ids.has(n.b) || n.a === n.b) continue;
      const same = marks.find((m): m is Extract<DraftMark, { kind: 'wrong_fit' }> => m.kind === 'wrong_fit' && ((m.a === n.a && m.b === n.b) || (m.a === n.b && m.b === n.a)));
      if (same) {
        same.noteIds = [...(same.noteIds ?? []), n.id];
        continue;
      }
      marks.push({ kind: 'wrong_fit', a: n.a, b: n.b, ...(n.sideA ? { sideA: n.sideA } : {}), ...(n.sideB ? { sideB: n.sideB } : {}), noteIds: [n.id] });
      continue;
    }
    if (!ids.has(n.regionId)) continue;
    let mark = places.get(n.regionId);
    if (!mark) {
      mark = { kind: 'wrong_place', regionId: n.regionId, noteIds: [] };
      places.set(n.regionId, mark);
      marks.push(mark);
    }
    mark.noteIds = [...(mark.noteIds ?? []), n.id];
    if (!sameGrid(n.grid, grid)) continue;
    const spot: RejectedSpot = { row: n.cell.row, col: n.cell.col, ...(n.rotationDeg !== undefined ? { rotationDeg: n.rotationDeg } : {}) };
    if (!mark.rejected?.some((s) => cellKey(s) === cellKey(spot))) mark.rejected = [...(mark.rejected ?? []), spot];
  }
  return marks;
}

/** All note ids the marks carry. */
export function noteIdsOf(marks: DraftMark[]): string[] {
  return marks.flatMap((m) => m.noteIds ?? []);
}
