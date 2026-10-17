import { describe, expect, it } from 'vitest';
import { describeCell, estimateGrid } from './grid';

function within(grid: { rows: number; cols: number }, cols: [number, number], rows: [number, number]): void {
  expect(grid.cols).toBeGreaterThanOrEqual(cols[0]);
  expect(grid.cols).toBeLessThanOrEqual(cols[1]);
  expect(grid.rows).toBeGreaterThanOrEqual(rows[0]);
  expect(grid.rows).toBeLessThanOrEqual(rows[1]);
}

describe('estimateGrid', () => {
  it('matches real manufacturer layouts (plausible ranges)', () => {
    // 1000 pieces, 70×50 cm: real puzzles are 38×27 or 40×25.
    within(estimateGrid(1000, 70 / 50).best, [37, 40], [25, 27]);
    // 500 pieces, 49×36 cm: 27×19 / 26×19.
    within(estimateGrid(500, 49 / 36).best, [25, 27], [19, 20]);
    // 1500 pieces, 80×60 cm: ~45×33.
    within(estimateGrid(1500, 80 / 60).best, [43, 46], [32, 35]);
    // 2000 pieces, 98×75 cm: ~55×40 (Ravensburger uses 56×38).
    within(estimateGrid(2000, 98 / 75).best, [50, 56], [37, 41]);
  });

  it('finds exact layouts', () => {
    expect(estimateGrid(100, 1).best).toEqual({ rows: 10, cols: 10 });
    expect(estimateGrid(24, 1.5).best).toEqual({ rows: 4, cols: 6 });
    expect(estimateGrid(24, 26 / 18).best).toEqual({ rows: 4, cols: 6 });
    expect(estimateGrid(300, 48 / 34).best).toEqual({ rows: 15, cols: 20 });
  });

  it('handles portrait pictures by swapping rows and columns', () => {
    const landscape = estimateGrid(1000, 70 / 50).best;
    const portrait = estimateGrid(1000, 50 / 70).best;
    expect(portrait).toEqual({ rows: landscape.cols, cols: landscape.rows });
  });

  it('returns about five distinct candidates, best first, with near-correct counts', () => {
    const { best, candidates } = estimateGrid(1000, 1.4);
    expect(candidates.length).toBe(5);
    expect(candidates[0]).toEqual(best);
    const keys = new Set(candidates.map((g) => `${g.rows}x${g.cols}`));
    expect(keys.size).toBe(candidates.length);
    for (const g of candidates) expect(Math.abs(g.rows * g.cols - 1000) / 1000).toBeLessThan(0.1);
    // Mutating the result must not affect `best`.
    candidates[0].rows = 1;
    expect(best.rows).not.toBe(1);
  });

  it('sanitises invalid input instead of throwing', () => {
    expect(estimateGrid(0, 1).best).toEqual({ rows: 1, cols: 1 });
    expect(estimateGrid(Number.NaN, 1).best).toEqual({ rows: 1, cols: 1 });
    expect(estimateGrid(100, 0).best).toEqual({ rows: 10, cols: 10 });
    expect(estimateGrid(100, Number.POSITIVE_INFINITY).best).toEqual({ rows: 10, cols: 10 });
    const tiny = estimateGrid(2, 1);
    expect(tiny.best.rows * tiny.best.cols).toBe(2);
  });
});

describe('describeCell', () => {
  const grid = { rows: 27, cols: 38 };

  it('uses 1-based numbers and a 3×3 area name', () => {
    expect(describeCell({ row: 2, col: 11 }, grid)).toBe('row 3, column 12 (top left)');
    expect(describeCell({ row: 13, col: 19 }, grid)).toBe('row 14, column 20 (center)');
    expect(describeCell({ row: 13, col: 30 }, grid)).toBe('row 14, column 31 (right)');
    expect(describeCell({ row: 20, col: 18 }, grid)).toBe('row 21, column 19 (bottom)');
  });

  it('marks corner and edge pieces', () => {
    expect(describeCell({ row: 0, col: 0 }, grid)).toBe('row 1, column 1 (top left, corner piece)');
    expect(describeCell({ row: 26, col: 37 }, grid)).toBe('row 27, column 38 (bottom right, corner piece)');
    expect(describeCell({ row: 0, col: 19 }, grid)).toBe('row 1, column 20 (top, edge piece)');
    expect(describeCell({ row: 12, col: 0 }, grid)).toBe('row 13, column 1 (left, edge piece)');
    expect(describeCell({ row: 26, col: 5 }, grid)).toBe('row 27, column 6 (bottom left, edge piece)');
  });

  it('handles tiny grids', () => {
    expect(describeCell({ row: 0, col: 0 }, { rows: 1, cols: 1 })).toBe('row 1, column 1 (center, corner piece)');
    expect(describeCell({ row: 1, col: 1 }, { rows: 3, cols: 3 })).toBe('row 2, column 2 (center)');
    expect(describeCell({ row: 1, col: 0 }, { rows: 2, cols: 2 })).toBe('row 2, column 1 (bottom left, corner piece)');
  });
});
