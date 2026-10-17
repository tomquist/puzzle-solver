import { describe, expect, it } from 'vitest';
import type { FeedbackMark } from '../../feedback/format';
import { addMissed, areaName, markIndexForRegion, MARK_KINDS, removeMark, setCorrectCell, toggleRegionMark } from './feedbackMarks';

describe('feedback marks', () => {
  it('toggles, replaces and removes region marks (one per region)', () => {
    let marks: FeedbackMark[] = [];
    marks = toggleRegionMark(marks, 'not_a_piece', 4);
    marks = toggleRegionMark(marks, 'merged', 7);
    expect(marks).toEqual([
      { kind: 'not_a_piece', regionId: 4 },
      { kind: 'merged', regionId: 7 },
    ]);
    // Another kind on the same region replaces the mark in place.
    marks = toggleRegionMark(marks, 'bad_outline', 4);
    expect(marks[0]).toEqual({ kind: 'bad_outline', regionId: 4 });
    expect(marks).toHaveLength(2);
    // The same kind again removes it.
    marks = toggleRegionMark(marks, 'bad_outline', 4);
    expect(marks).toEqual([{ kind: 'merged', regionId: 7 }]);
    expect(markIndexForRegion(marks, 7)).toBe(0);
    expect(markIndexForRegion(marks, 4)).toBe(-1);
  });

  it('adds rounded missed points and removes by index', () => {
    let marks = addMissed([], 10.4, 20.6);
    marks = addMissed(marks, 30, 40);
    expect(marks).toEqual([
      { kind: 'missed', x: 10, y: 21 },
      { kind: 'missed', x: 30, y: 40 },
    ]);
    expect(removeMark(marks, 0)).toEqual([{ kind: 'missed', x: 30, y: 40 }]);
    // Missed points never count as a region's mark.
    expect(markIndexForRegion(marks, 10)).toBe(-1);
  });

  it('sets and clears the right cell of a wrong-place mark only', () => {
    let marks: FeedbackMark[] = [{ kind: 'wrong_place', regionId: 3 }, { kind: 'missed', x: 1, y: 2 }];
    marks = setCorrectCell(marks, 0, { row: 2, col: 5 });
    expect(marks[0]).toEqual({ kind: 'wrong_place', regionId: 3, correct: { row: 2, col: 5 } });
    expect(setCorrectCell(marks, 1, { row: 0, col: 0 })).toBe(marks);
    expect(setCorrectCell(marks, 0, undefined)[0]).toEqual({ kind: 'wrong_place', regionId: 3 });
  });

  it('names areas of a picture', () => {
    expect(areaName(10, 10, 300, 300)).toBe('top left');
    expect(areaName(150, 150, 300, 300)).toBe('middle');
    expect(areaName(299, 150, 300, 300)).toBe('right');
    expect(areaName(300, 300, 300, 300)).toBe('bottom right');
    expect(areaName(-5, 299, 300, 300)).toBe('bottom left');
  });

  it('has a label and help text for every kind', () => {
    expect(MARK_KINDS.map((k) => k.kind)).toEqual(['missed', 'not_a_piece', 'merged', 'bad_outline', 'wrong_place']);
    for (const k of MARK_KINDS) expect(k.label && k.help).toBeTruthy();
  });
});
