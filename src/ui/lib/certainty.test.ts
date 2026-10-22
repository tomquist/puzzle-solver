import { describe, expect, it } from 'vitest';
import type { CellRef } from '../../model/types';
import {
  cardReason,
  certaintyBadge,
  certaintyLine,
  conflictKeptKey,
  itemCertainty,
  placedConflictCell,
  REASON_TEXT,
  spotCertainty,
  spotsToCompare,
  uncertaintyText,
} from './certainty';
import type { ItemPlacement, ScanItem } from './items';

const spot = (row: number, col: number, confidence: number): ItemPlacement => ({
  cells: [{ row, col }],
  bounds: { row0: row, col0: col, row1: row, col1: col },
  x: col * 10,
  y: row * 10,
  rotationDeg: 0,
  confidence,
});

function item(status: ScanItem['status'], confidences: number[], extra: Partial<ScanItem> = {}): ScanItem {
  return {
    key: 'r1',
    kind: 'piece',
    label: 1,
    regionIds: [1],
    pieceCount: 1,
    status,
    candidates: confidences.map((c, i) => spot(i, i, c)),
    center: { x: 0, y: 0 },
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    edge: false,
    ...extra,
  };
}

describe('certainty in words', () => {
  it('confident places are "Sure", whatever their number', () => {
    const it1 = item('confident', [0.62, 0.3]);
    expect(itemCertainty(it1)).toBe('sure');
    expect(certaintyLine(it1)).toBe('Sure');
    expect(certaintyBadge(it1)).toBe('');
    expect(spotsToCompare(it1)).toEqual([0]);
    expect(uncertaintyText(it1)).toBeUndefined();
  });

  it('an unsure place with no close rival is "Likely"', () => {
    const it1 = item('ambiguous', [0.45, 0.12, 0.05]);
    expect(itemCertainty(it1)).toBe('likely');
    expect(certaintyLine(it1)).toBe('Likely – check it');
    expect(certaintyBadge(it1)).toBe('likely');
    expect(spotCertainty(it1, 1)).toBe('unlikely');
  });

  it('close rivals make it "Unsure – one of these N spots", never a percentage', () => {
    const it1 = item('ambiguous', [0.4, 0.36, 0.22, 0.05]);
    expect(spotsToCompare(it1)).toEqual([0, 1, 2]);
    expect(itemCertainty(it1)).toBe('unsure');
    expect(certaintyLine(it1)).toBe('Unsure – one of these 3 spots');
    expect(certaintyBadge(it1)).toBe('unsure · 3 spots');
    expect(spotCertainty(it1, 2)).toBe('unsure');
    expect(spotCertainty(it1, 3)).toBe('unlikely');
    for (const text of [certaintyLine(it1), certaintyBadge(it1), uncertaintyText(it1)!.card, uncertaintyText(it1)!.long]) expect(text).not.toMatch(/%|\d\d/);
  });

  it('a plain or repeating picture offers the next spots even when their scores trail', () => {
    const plain = item('ambiguous', [0.5, 0.1, 0.08, 0.05, 0.01], { uncertainReason: 'plain' });
    expect(spotsToCompare(plain)).toEqual([0, 1, 2]);
    expect(itemCertainty(plain)).toBe('unsure');
    // An outline problem does not make other spots likelier.
    const shape = item('ambiguous', [0.5, 0.1], { uncertainReason: 'shape' });
    expect(itemCertainty(shape)).toBe('likely');
    // At most four spots.
    expect(spotsToCompare(item('ambiguous', [0.3, 0.3, 0.3, 0.3, 0.3, 0.3]))).toHaveLength(4);
  });

  it('says why, from the matcher or from the spots', () => {
    expect(uncertaintyText(item('ambiguous', [0.4, 0.38], { uncertainReason: 'plain' }))).toEqual(REASON_TEXT.plain);
    expect(REASON_TEXT.plain.card).toBe('Plain area – many spots look alike');
    expect(REASON_TEXT.repeating.card).toMatch(/^Repeating pattern/);
    expect(REASON_TEXT.shape.card).toBe('Outline unclear – check the piece');
    expect(uncertaintyText(item('ambiguous', [0.4, 0.38]))!.long).toMatch(/Compare them with your piece/);
    expect(uncertaintyText(item('ambiguous', [0.4]))!.card).toMatch(/check it against the picture/);
    // Compact places add only what the certainty line does not say.
    expect(cardReason(item('ambiguous', [0.4]))).toBeUndefined();
    expect(cardReason(item('ambiguous', [0.4], { uncertainReason: 'shape' }))).toBe('Outline unclear – check the piece');
    expect(cardReason(item('ambiguous', [0.4, 0.38]))).toBe('Several spots match about as well');
    expect(cardReason(item('confident', [0.9]))).toBeUndefined();
  });
});

describe('placed conflict', () => {
  const grid = { rows: 5, cols: 5 };
  const placed = new Set(['2,3']);
  const isPlaced = (c: CellRef) => placed.has(`${c.row},${c.col}`);
  const never = () => false;

  it('shows while the spot is marked placed and the note was not kept', () => {
    const it1 = item('ambiguous', [0.4], { placedConflict: { row: 2, col: 3 } });
    expect(placedConflictCell(it1, isPlaced, grid, never)).toEqual({ row: 2, col: 3 });
    // Unmarked meanwhile, kept, outside the grid, or none.
    expect(placedConflictCell(item('ambiguous', [0.4], { placedConflict: { row: 1, col: 1 } }), isPlaced, grid, never)).toBeUndefined();
    expect(placedConflictCell(it1, isPlaced, grid, () => true)).toBeUndefined();
    expect(placedConflictCell(item('ambiguous', [0.4], { placedConflict: { row: 7, col: 3 } }), () => true, grid, never)).toBeUndefined();
    expect(placedConflictCell(item('ambiguous', [0.4]), isPlaced, grid, never)).toBeUndefined();
  });

  it('remembers "Keep" per scan, item and spot', () => {
    const it1 = item('ambiguous', [0.4], { placedConflict: { row: 2, col: 3 } });
    expect(conflictKeptKey('s1', it1)).toBe('placed-conflict:s1:r1:2,3');
    expect(conflictKeptKey('s1', { ...it1, placedConflict: { row: 0, col: 0 } })).not.toBe(conflictKeptKey('s1', it1));
  });
});
