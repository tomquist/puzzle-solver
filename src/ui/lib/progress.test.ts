import { describe, expect, it } from 'vitest';
import { emptyProgress, isPlaced, placeCells, placedCells, placedCount, progressPercent, restorePlaced, unplaceCells } from './progress';

const grid = { rows: 10, cols: 20 };

describe('progress math', () => {
  it('starts empty', () => {
    const p = emptyProgress('p');
    expect(placedCount(p, grid)).toBe(0);
    expect(progressPercent(p, grid)).toBe(0);
    expect(progressPercent(undefined, grid)).toBe(0);
  });

  it('places cells immutably and keeps the first timestamp', () => {
    const p0 = emptyProgress('p');
    const p1 = placeCells(p0, [{ row: 0, col: 0 }, { row: 1, col: 2 }], { scanId: 's', regionId: 3 }, 100);
    expect(p0.placed).toEqual({});
    expect(p1.placed['1,2']).toEqual({ at: 100, scanId: 's', regionId: 3 });
    const p2 = placeCells(p1, [{ row: 1, col: 2 }], {}, 200);
    expect(p2.placed['1,2'].at).toBe(100);
    expect(isPlaced(p2, { row: 1, col: 2 })).toBe(true);
    expect(isPlaced(p2, { row: 5, col: 5 })).toBe(false);
  });

  it('computes the percentage (never 0 once something is placed, never 100 too early)', () => {
    let p = placeCells(emptyProgress('p'), [{ row: 0, col: 0 }], {}, 1);
    expect(progressPercent(p, grid)).toBe(1);
    const all = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 20; c++) all.push({ row: r, col: c });
    p = placeCells(p, all.slice(0, 199), {}, 2);
    expect(progressPercent(p, grid)).toBe(99);
    p = placeCells(p, all, {}, 3);
    expect(progressPercent(p, grid)).toBe(100);
  });

  it('ignores cells outside the grid', () => {
    const p = placeCells(emptyProgress('p'), [{ row: 50, col: 0 }, { row: 2, col: 2 }], {}, 1);
    expect(placedCells(p, grid)).toEqual([{ row: 2, col: 2 }]);
  });

  it('unplaces cells', () => {
    const p = placeCells(emptyProgress('p'), [{ row: 2, col: 2 }, { row: 3, col: 3 }], {}, 1);
    const q = unplaceCells(p, [{ row: 2, col: 2 }], 2);
    expect(Object.keys(q.placed)).toEqual(['3,3']);
  });

  it('puts unplaced entries back as they were (undo)', () => {
    const p = placeCells(emptyProgress('p'), [{ row: 2, col: 2 }], { scanId: 's1', regionId: 4 }, 1);
    const entry = p.placed['2,2'];
    const q = restorePlaced(unplaceCells(p, [{ row: 2, col: 2 }], 2), { '2,2': entry }, 3);
    expect(q.placed['2,2']).toEqual({ at: 1, scanId: 's1', regionId: 4 });
    expect(q.updatedAt).toBe(3);
  });
});
