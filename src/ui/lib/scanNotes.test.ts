import { describe, expect, it } from 'vitest';
import type { DetectedRegion, FeedbackNote, Placement, RegionGroup, RegionMatch, ScanRecord, ScanResult } from '../../model/types';
import { createMemoryRepository } from '../../storage';
import { storeNotesChange } from '../hooks/useScanNotes';
import { toFileMarks } from './feedbackMarks';
import { buildScanItems } from './items';
import {
  addNote,
  markNotesSent,
  noteIdsOf,
  notesToMarks,
  removeNotes,
  resolveSpotChoices,
  setSpotChoice,
  spotChoiceOf,
  unsentNotes,
  withoutRejectedFits,
  wrongFitNote,
  wrongPlaceNote,
  wrongPlaceNotesAt,
  type ScanNotes,
} from './scanNotes';

function square(id: number, x: number, y: number, size = 40): DetectedRegion {
  return {
    id,
    kind: 'piece',
    bbox: { x, y, width: size, height: size },
    contour: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }],
    area: size * size,
    touchesBorder: false,
    orientationDeg: 0,
    issues: [],
  };
}
const place = (row: number, col: number, rotationDeg = 90): Placement => ({ row, col, x: col * 10 + 5, y: row * 10 + 5, rotationDeg, score: 0.5, confidence: 0.6 });
const match = (regionId: number, ...candidates: Placement[]): RegionMatch => ({ regionId, status: 'ambiguous', candidates });
const neighbours = (id: number, regionIds: number[]): RegionGroup => ({
  id,
  kind: 'neighbors',
  regionIds,
  cells: [],
  bounds: { row0: 0, col0: 0, row1: 0, col1: 0 },
  x: 0,
  y: 0,
  confidence: 0.8,
});
const grid = { rows: 10, cols: 10 };

/** Pieces 1 and 2 go next to each other (r1c1, r1c2), 3 next to 2 (r2c2); 4 is alone. */
const result: ScanResult = {
  width: 800,
  height: 600,
  regions: [square(1, 10, 10), square(2, 100, 10), square(3, 200, 10), square(4, 300, 300)],
  matches: [match(1, place(1, 1), place(4, 4)), match(2, place(1, 2), place(6, 6, 180)), match(3, place(2, 2)), match(4, place(8, 8))],
  fits: [],
  groups: [neighbours(1, [1, 2, 3])],
  quality: { score: 1, issues: [], metrics: {} },
  timings: {},
};
const { items, links } = buildScanItems(result, grid);
const item = (id: number) => items.find((i) => i.key === `r${id}`)!;

describe('notes for feedback', () => {
  it('adds a doesn’t-fit note once per pair (either way round), with the sides of the link', () => {
    const link = links.find((l) => [l.a, l.b].sort().join() === 'r1,r2');
    const note = wrongFitNote('n1', item(2), item(1), link);
    expect(note).toEqual({ id: 'n1', kind: 'wrong_fit', a: 2, b: 1, sideA: 'left', sideB: 'right' });
    let s: ScanNotes = {};
    s = addNote(s, note);
    expect(addNote(s, wrongFitNote('n2', item(1), item(2), link))).toBe(s);
    expect(s.feedbackNotes).toHaveLength(1);
  });

  it('leaves the rejected connections out of the links, also after the note was sent', () => {
    expect(links).toHaveLength(2);
    const note = wrongFitNote('n1', item(1), item(2), undefined);
    let s = addNote<ScanNotes>({}, note);
    const kept = withoutRejectedFits(links, items, s.feedbackNotes);
    expect(kept.map((l) => [l.a, l.b].sort().join())).toEqual(['r2,r3']);
    s = markNotesSent(s, ['n1'], 1000);
    expect(withoutRejectedFits(links, items, s.feedbackNotes)).toEqual(kept);
    expect(unsentNotes(s.feedbackNotes)).toEqual([]);
    // Without notes nothing changes.
    expect(withoutRejectedFits(links, items, undefined)).toBe(links);
  });

  it('removes only unsent notes, and drops the field when none is left', () => {
    let s: ScanNotes = {};
    s = addNote(s, wrongFitNote('a', item(1), item(2), undefined));
    s = addNote(s, wrongFitNote('b', item(2), item(3), undefined));
    s = markNotesSent(s, ['a'], 5);
    s = removeNotes(s, ['a', 'b']);
    expect(s.feedbackNotes?.map((n) => n.id)).toEqual(['a']);
    const t = removeNotes(addNote<ScanNotes>({}, wrongFitNote('c', item(1), item(3), undefined)), ['c']);
    expect('feedbackNotes' in t).toBe(false);
    // Nothing to remove: the same object.
    expect(removeNotes(s, ['zzz'])).toBe(s);
  });

  it('notes a wrong place with its cell, turn and grid, once per spot', () => {
    const note = wrongPlaceNote('w1', item(2), item(2).candidates[0], grid)!;
    expect(note).toEqual({ id: 'w1', kind: 'wrong_place', regionId: 2, cell: { row: 1, col: 2 }, rotationDeg: 90, grid });
    let s = addNote<ScanNotes>({}, note);
    expect(addNote(s, { ...note, id: 'w2' })).toBe(s);
    s = addNote(s, wrongPlaceNote('w3', item(2), item(2).candidates[1], grid)!);
    expect(wrongPlaceNotesAt(s.feedbackNotes, 2, { row: 6, col: 6 })).toEqual(['w3']);
    expect(wrongPlaceNotesAt(s.feedbackNotes, 1, { row: 6, col: 6 })).toEqual([]);
  });

  it('keeps the chosen spots, following a cell whose candidate moved', () => {
    let s: ScanNotes = {};
    s = setSpotChoice(s, 'r2', spotChoiceOf(item(2), 1));
    expect(s.spotChoices).toEqual({ r2: { index: 1, cell: { row: 6, col: 6 } } });
    expect(resolveSpotChoices(s.spotChoices, items)).toEqual({ r2: 1 });
    // Every spot rejected: past the last candidate.
    s = setSpotChoice(s, 'r3', spotChoiceOf(item(3), 1));
    expect(resolveSpotChoices(s.spotChoices, items)).toEqual({ r2: 1, r3: 1 });
    // The candidates changed (re-analysed): the cell is now first; a cell no candidate has is dropped.
    const moved = buildScanItems({ ...result, matches: [match(2, place(6, 6)), match(1, place(1, 1))] }, grid).items;
    expect(resolveSpotChoices(s.spotChoices, moved)).toEqual({ r2: 0 });
    const gone = buildScanItems({ ...result, matches: [match(2, place(7, 7), place(1, 2))] }, grid).items;
    expect(resolveSpotChoices(s.spotChoices, gone)).toEqual({});
    // Back to the best spot: the field goes when it is empty.
    s = setSpotChoice(setSpotChoice(s, 'r2', undefined), 'r3', undefined);
    expect('spotChoices' in s).toBe(false);
  });

  it('turns the unsent notes into marks: one per pair, one per piece with its rejected spots', () => {
    const notes: FeedbackNote[] = [
      { id: 'f1', kind: 'wrong_fit', a: 1, b: 2, sideA: 'right', sideB: 'left' },
      { id: 'p1', kind: 'wrong_place', regionId: 2, cell: { row: 1, col: 2 }, rotationDeg: 90, grid },
      { id: 'f2', kind: 'wrong_fit', a: 2, b: 1 },
      { id: 'p2', kind: 'wrong_place', regionId: 2, cell: { row: 6, col: 6 }, grid },
      // Noted on another grid: still a wrong place, without that cell.
      { id: 'p3', kind: 'wrong_place', regionId: 3, cell: { row: 2, col: 2 }, grid: { rows: 20, cols: 5 } },
      // Sent already, and a region the result does not have.
      { id: 'f3', kind: 'wrong_fit', a: 3, b: 4, sentAt: 1 },
      { id: 'f4', kind: 'wrong_fit', a: 1, b: 99 },
    ];
    const marks = notesToMarks(notes, result, grid);
    expect(marks).toEqual([
      { kind: 'wrong_fit', a: 1, b: 2, sideA: 'right', sideB: 'left', noteIds: ['f1', 'f2'] },
      { kind: 'wrong_place', regionId: 2, noteIds: ['p1', 'p2'], rejected: [{ row: 1, col: 2, rotationDeg: 90 }, { row: 6, col: 6 }] },
      { kind: 'wrong_place', regionId: 3, noteIds: ['p3'] },
    ]);
    expect(noteIdsOf(marks)).toEqual(['f1', 'f2', 'p1', 'p2', 'p3']);
    // In the file: plain marks.
    expect(toFileMarks(marks)).toEqual([
      { kind: 'wrong_fit', a: 1, b: 2, sideA: 'right', sideB: 'left' },
      { kind: 'wrong_place', regionId: 2, rejected: [{ row: 1, col: 2, rotationDeg: 90 }, { row: 6, col: 6 }] },
      { kind: 'wrong_place', regionId: 3 },
    ]);
    expect(notesToMarks(undefined, result, grid)).toEqual([]);
  });

  it('stores a change on top of what changed meanwhile, and old records without notes still work', async () => {
    const repo = createMemoryRepository();
    const scan: ScanRecord = { id: 's1', puzzleId: 'p', createdAt: 1, photoBlobId: 'b', width: 800, height: 600, result };
    await repo.saveScan(scan);
    // Something else changes the record (e.g. its cells re-derived for a new grid) …
    await repo.updateScan('s1', (cur) => ({ ...cur, label: 'changed elsewhere' }));
    // … then a note is stored: both survive.
    await storeNotesChange(repo, 's1', (s) => addNote(s, wrongFitNote('n', item(1), item(2), undefined)));
    const stored = (await repo.getScan('s1'))!;
    expect(stored.label).toBe('changed elsewhere');
    expect(stored.feedbackNotes).toEqual([{ id: 'n', kind: 'wrong_fit', a: 1, b: 2 }]);
    // A change that changes nothing writes nothing.
    await storeNotesChange(repo, 's1', (s) => removeNotes(s, ['other']));
    expect(await repo.getScan('s1')).toEqual(stored);
    // An old record: no fields, nothing noted, nothing chosen.
    expect(notesToMarks(scan.feedbackNotes, scan.result, grid)).toEqual([]);
    expect(resolveSpotChoices(scan.spotChoices, items)).toEqual({});
  });
});
