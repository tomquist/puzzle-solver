import { describe, expect, it } from 'vitest';
import type { FeedbackMark } from '../../feedback/format';
import type { DetectedRegion, Placement, RegionMatch, ScanResult } from '../../model/types';
import {
  addMissed,
  alternativesFor,
  areaName,
  detectionTones,
  foundText,
  hintKinds,
  looksLikeSeveral,
  markHint,
  markIndexForRegion,
  MARK_KINDS,
  regionAt,
  removeMark,
  setCorrectCell,
  setRegionMark,
  SEVERAL_PIECES_AREA,
  toggleRegionMark,
  typicalPieceArea,
} from './feedbackMarks';

function square(id: number, x: number, y: number, size: number, kind: DetectedRegion['kind'] = 'piece'): DetectedRegion {
  return {
    id,
    kind,
    bbox: { x, y, width: size, height: size },
    contour: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }],
    area: size * size,
    touchesBorder: false,
    orientationDeg: 0,
    issues: [],
  };
}
const place = (row: number, col: number, confidence = 0.9): Placement => ({ row, col, x: col * 10, y: row * 10, rotationDeg: 0, score: 0, confidence });
const match = (regionId: number, status: RegionMatch['status'], candidates: Placement[]): RegionMatch => ({ regionId, status, candidates });
function scan(partial: Partial<ScanResult>): ScanResult {
  return { width: 1000, height: 500, regions: [], matches: [], fits: [], quality: { score: 1, issues: [], metrics: {} }, timings: {}, ...partial };
}

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

  it('has a label, a meaning and how to place it for every kind', () => {
    expect(MARK_KINDS.map((k) => k.kind)).toEqual(['missed', 'not_a_piece', 'merged', 'bad_outline', 'wrong_place']);
    for (const k of MARK_KINDS) expect(k.label && k.what && k.how).toBeTruthy();
    // Labels are told apart in hints and notes.
    expect(new Set(MARK_KINDS.map((k) => k.label)).size).toBe(MARK_KINDS.length);
  });
});

describe('typical piece size and hints on a mark', () => {
  // Single pieces of about 100 × 100 (one cut off at the photo border), a two-piece blob the app
  // took for one piece, an assembled pair and a speck.
  const regions = [
    square(1, 0, 0, 100),
    square(2, 200, 0, 100),
    square(3, 400, 0, 110),
    square(4, 600, 0, 95),
    { ...square(5, 900, 0, 40), touchesBorder: true },
    { ...square(6, 0, 200, 100), area: 2.1 * 100 * 100 },
    square(7, 200, 200, 150, 'patch'),
    square(8, 400, 200, 10, 'unknown'),
  ];
  const result = scan({ regions });

  it('takes the median single piece, leaving out cut-off pieces, patches and specks', () => {
    // Single pieces: 95², 100², 100², 110², 2.1 × 100² → median 100².
    expect(typicalPieceArea(result)).toBe(10_000);
    expect(typicalPieceArea(scan({ regions: [square(1, 0, 0, 100), square(2, 200, 0, 120)] }))).toBeUndefined();
    expect(typicalPieceArea(scan({ regions: [square(1, 0, 0, 100), square(2, 200, 0, 120), square(3, 400, 0, 90), square(4, 600, 0, 110)] }))).toBe((100 * 100 + 110 * 110) / 2);
  });

  it('calls a region "several pieces" only when clearly larger than one piece', () => {
    const area = typicalPieceArea(result);
    expect(looksLikeSeveral(regions[5], area)).toBe(true);
    expect(looksLikeSeveral(regions[2], area)).toBe(false); // 1.21× – a big single piece
    expect(looksLikeSeveral({ ...regions[0], area: SEVERAL_PIECES_AREA * 10_000 }, area)).toBe(true);
    expect(looksLikeSeveral({ ...regions[0], area: SEVERAL_PIECES_AREA * 10_000 - 1 }, area)).toBe(false);
    expect(looksLikeSeveral(regions[5], undefined)).toBe(false);
  });

  it('hints only on "outline off": joined pieces, or a region clearly holding several', () => {
    const area = typicalPieceArea(result);
    expect(markHint('bad_outline', regions[5], 'confident', area)).toBe('several');
    expect(markHint('bad_outline', regions[5], 'hidden', area)).toBe('several');
    expect(markHint('bad_outline', regions[0], 'confident', area)).toBeUndefined();
    // Assembled groups are several pieces by design: the hint is about joined pieces instead.
    expect(markHint('bad_outline', regions[6], 'patch', area)).toBe('assembled');
    // Other marks never get a hint; without a typical size there is no "several" hint.
    for (const kind of ['not_a_piece', 'merged', 'wrong_place'] as const) {
      expect(markHint(kind, regions[5], 'confident', area)).toBeUndefined();
      expect(markHint(kind, regions[6], 'patch', area)).toBeUndefined();
    }
    expect(markHint('bad_outline', regions[5], 'confident', undefined)).toBeUndefined();
  });

  it('offers "not a piece" with the size hint, first where the region had no usable match', () => {
    // Real case: glare on a light table outlined at 3.5x a piece and marked "outline off".
    expect(hintKinds('several', 'hidden')).toEqual(['not_a_piece', 'merged']);
    expect(hintKinds('several', 'confident')).toEqual(['merged', 'not_a_piece']);
    expect(hintKinds('assembled', 'patch')).toEqual(['merged']);
  });

  it('suggests "pieces stuck together" first for a "missed" tap on a large found region', () => {
    expect(alternativesFor('confident', true)).toEqual(['merged', 'bad_outline', 'wrong_place']);
    expect(alternativesFor('hidden', true)).toEqual(['merged', 'bad_outline']);
    expect(alternativesFor('confident')).toEqual(['wrong_place', 'bad_outline', 'merged']);
  });
});

describe('detections on the feedback photo', () => {
  const result = scan({
    regions: [square(1, 0, 0, 100), square(2, 200, 0, 100), square(3, 400, 0, 100), square(4, 600, 0, 100, 'unknown'), square(5, 800, 0, 100), square(6, 820, 20, 30)],
    matches: [
      match(1, 'confident', [place(1, 1)]),
      match(2, 'ambiguous', [place(2, 2, 0.4)]),
      match(3, 'unmatched', []),
      match(5, 'confident', [place(5, 5)]),
      match(6, 'confident', [place(6, 6)]),
    ],
    groups: [{ id: 1, kind: 'assembled', regionIds: [5], cells: [{ row: 5, col: 5 }, { row: 5, col: 6 }], bounds: { row0: 5, col0: 5, row1: 5, col1: 6 }, x: 55, y: 50, confidence: 0.9 }],
  });

  it('colours regions like the result screen; everything not shown is "hidden"', () => {
    const tones = detectionTones(result, { rows: 10, cols: 10 });
    expect(Object.fromEntries(tones)).toEqual({ 1: 'confident', 2: 'ambiguous', 3: 'hidden', 4: 'hidden', 5: 'patch', 6: 'confident' });
  });

  it('finds the region under a point (the smallest when nested)', () => {
    expect(regionAt(result, 50, 50)?.id).toBe(1);
    expect(regionAt(result, 150, 50)).toBeUndefined();
    expect(regionAt(result, 830, 30)?.id).toBe(6);
    expect(regionAt(result, 890, 90)?.id).toBe(5);
    expect(regionAt(result, 50, 400)).toBeUndefined();
  });

  it('describes found pieces and offers better marks', () => {
    expect(`This piece was ${foundText('ambiguous')}`).toBe('This piece was found (unsure)');
    expect(foundText('hidden')).toBe('found but not shown');
    expect(alternativesFor('ambiguous')).toEqual(['wrong_place', 'bad_outline', 'merged']);
    expect(alternativesFor('hidden')).not.toContain('wrong_place');
  });

  it('sets a region mark without ever removing it', () => {
    let marks: FeedbackMark[] = setRegionMark([], 'bad_outline', 2);
    marks = setRegionMark(marks, 'bad_outline', 2);
    expect(marks).toEqual([{ kind: 'bad_outline', regionId: 2 }]);
    expect(setRegionMark(marks, 'wrong_place', 2)).toEqual([{ kind: 'wrong_place', regionId: 2 }]);
  });
});

