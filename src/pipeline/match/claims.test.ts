/**
 * One cell, one piece (claims.ts): a confident loose piece on a cell an assembled patch covers –
 * the weaker placement gives way, and the piece then gets its fit hint to the patch instead of
 * none (findFits drops pairs whose cells overlap). The last free cells of a puzzle go to the
 * pieces without a confident place (the corner under a badge of the box picture).
 */
import { describe, expect, it } from 'vitest';
import type { CellRef, DetectedRegion, RegionMatch } from '../../model/types';
import { duplicateClaims, placeByElimination, resolveCellClaims, uniqueCells } from './claims';
import { findFits } from './fits';

const region = (id: number, kind: DetectedRegion['kind']): DetectedRegion => ({
  id, kind, bbox: { x: 0, y: 0, width: 10, height: 10 }, contour: [], area: 100, touchesBorder: false, orientationDeg: 0, issues: [],
});

const grid = { rows: 6, cols: 3 };
/** The 6 × 3 grid but for `holes`. */
const cellsBut = (...holes: CellRef[]) => {
  const out: CellRef[] = [];
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) if (!holes.some((h) => h.row === row && h.col === col)) out.push({ row, col });
  return out;
};

function scene(patchConf: number, pieceConf: number, covered: CellRef[]): { regions: DetectedRegion[]; matches: RegionMatch[] } {
  return {
    regions: [region(1, 'patch'), region(2, 'piece')],
    matches: [
      { regionId: 1, status: patchConf >= 0.7 ? 'confident' : 'ambiguous', coveredCells: covered, candidates: [{ row: covered[0].row, col: covered[0].col, x: 0, y: 0, rotationDeg: 0, score: 0.6, confidence: patchConf }] },
      { regionId: 2, status: pieceConf >= 0.7 ? 'confident' : 'ambiguous', candidates: [{ row: 2, col: 1, x: 0, y: 0, rotationDeg: 64, score: 0.9, confidence: pieceConf }] },
    ],
  };
}

describe('resolveCellClaims', () => {
  it('takes the cell off a less confident patch, and the piece then fits into its hole', () => {
    const { regions, matches } = scene(0.9, 0.98, cellsBut({ row: 4, col: 1 }));
    expect(findFits(regions, matches, grid)).toEqual([]);
    const changes = resolveCellClaims(regions, matches);
    expect(changes).toEqual([{ piece: 2, patch: 1, cell: { row: 2, col: 1 }, action: 'cell-dropped' }]);
    expect(matches[0].coveredCells!.some((c) => c.row === 2 && c.col === 1)).toBe(false);
    expect(matches[0].coveredCells).toHaveLength(16);
    expect(matches[1].status).toBe('confident');
    const fits = findFits(regions, matches, grid);
    expect(fits.some((h) => (h.a === 1 && h.b === 2) || (h.a === 2 && h.b === 1))).toBe(true);
  });

  it('lowers a piece that is less confident than the patch', () => {
    const { regions, matches } = scene(0.99, 0.85, cellsBut());
    const changes = resolveCellClaims(regions, matches);
    expect(changes.map((c) => c.action)).toEqual(['piece-demoted']);
    expect(matches[1].status).toBe('ambiguous');
    expect(matches[1].candidates[0].confidence).toBeCloseTo(0.425, 5);
    expect(matches[0].coveredCells).toHaveLength(18);
  });

  it('keeps the top-left cell of the patch up to date', () => {
    const { regions, matches } = scene(0.8, 0.9, cellsBut());
    matches[1].candidates[0].row = 0;
    matches[1].candidates[0].col = 0;
    resolveCellClaims(regions, matches);
    expect(matches[0].candidates[0]).toMatchObject({ row: 0, col: 1 });
  });

  it('leaves pieces outside the patch alone', () => {
    const { regions, matches } = scene(0.99, 0.95, cellsBut({ row: 2, col: 1 }));
    expect(resolveCellClaims(regions, matches)).toEqual([]);
    expect(matches[1].status).toBe('confident');
    expect(findFits(regions, matches, grid)).toHaveLength(1);
  });
});

describe('placeByElimination', () => {
  /** A patch covering all but `free` cells and the confident pieces' cells, plus single pieces. */
  function puzzle(free: CellRef[], pieces: { id: number; cell: CellRef; confident: boolean }[]) {
    const regions = [region(1, 'patch'), ...pieces.map((p) => region(p.id, 'piece'))];
    const covered = cellsBut(...free, ...pieces.filter((p) => p.confident).map((p) => p.cell));
    const matches: RegionMatch[] = [
      { regionId: 1, status: 'confident', coveredCells: covered, candidates: [{ row: 0, col: 0, x: 0, y: 0, rotationDeg: 0, score: 0.6, confidence: 0.95 }] },
      ...pieces.map((p): RegionMatch => ({
        regionId: p.id, status: p.confident ? 'confident' : 'ambiguous',
        candidates: [{ row: p.cell.row, col: p.cell.col, x: 0, y: 0, rotationDeg: 10, score: 0.4, confidence: p.confident ? 0.9 : 0.05 }],
      })),
    ];
    return { regions, matches };
  }
  // The scorer: a fixed score per cell, the best turn at 90°.
  const scorer = (scores: Record<string, number>) => (_id: number, cell: CellRef, rot: number) =>
    ({ row: cell.row, col: cell.col, x: 1, y: 2, rotationDeg: rot, score: (scores[`${cell.row},${cell.col}`] ?? 0) + (rot === 90 ? 0.05 : 0), confidence: 0 });

  it('puts the one open piece into the one free cell (the badge corner)', () => {
    // The badge corner r5c2 is free; the open piece's best guess is r4c2, which another piece holds.
    const { regions, matches } = puzzle([{ row: 5, col: 2 }], [{ id: 2, cell: { row: 4, col: 2 }, confident: false }, { id: 3, cell: { row: 4, col: 2 }, confident: true }]);
    const changes = placeByElimination(regions, matches, grid, [], scorer({ '5,2': 0.1 }));
    expect(changes).toEqual([{ regionId: 2, cell: { row: 5, col: 2 }, rotationDeg: 90, free: 1, open: 1 }]);
    expect(matches[1].status).toBe('confident');
    expect(matches[1].candidates[0]).toMatchObject({ row: 5, col: 2, rotationDeg: 90, confidence: 0.75 });
    // The former guess stays as an alternative.
    expect(matches[1].candidates[1]).toMatchObject({ row: 4, col: 2 });
  });

  it('assigns open pieces to free cells by score, ambiguously when there is a choice', () => {
    const { regions, matches } = puzzle([{ row: 5, col: 2 }, { row: 0, col: 0 }], [{ id: 2, cell: { row: 3, col: 1 }, confident: false }]);
    const changes = placeByElimination(regions, matches, grid, [], scorer({ '5,2': 0.1, '0,0': 0.3 }));
    expect(changes.map((c) => c.cell)).toEqual([{ row: 0, col: 0 }]);
    expect(matches[1].status).toBe('ambiguous');
    expect(matches[1].candidates[0].confidence).toBeCloseTo(0.4, 5);
  });

  it('counts the cells the user has placed', () => {
    const { regions, matches } = puzzle([{ row: 5, col: 2 }, { row: 0, col: 0 }], [{ id: 2, cell: { row: 3, col: 1 }, confident: false }]);
    const changes = placeByElimination(regions, matches, grid, [{ row: 0, col: 0 }], scorer({ '0,0': 0.3 }));
    expect(changes.map((c) => c.cell)).toEqual([{ row: 5, col: 2 }]);
    expect(matches[1].status).toBe('confident');
  });

  it('does nothing while many cells are free or more pieces are open than cells', () => {
    const many = puzzle([{ row: 5, col: 2 }, { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }], [{ id: 2, cell: { row: 3, col: 1 }, confident: false }]);
    expect(placeByElimination(many.regions, many.matches, grid, [], scorer({}))).toEqual([]);
    const crowded = puzzle([{ row: 5, col: 2 }], [{ id: 2, cell: { row: 3, col: 1 }, confident: false }, { id: 3, cell: { row: 3, col: 2 }, confident: false }]);
    expect(placeByElimination(crowded.regions, crowded.matches, grid, [], scorer({}))).toEqual([]);
  });

  it('stays unsure when the piece itself points at a cell the user marked as placed (a wrong mark)', () => {
    // The user marked r3c1 although it is empty; the open piece's best guess is r3c1.
    const regions = [region(1, 'patch'), region(2, 'piece')];
    const matches: RegionMatch[] = [
      { regionId: 1, status: 'confident', coveredCells: cellsBut({ row: 5, col: 2 }, { row: 3, col: 1 }), candidates: [{ row: 0, col: 0, x: 0, y: 0, rotationDeg: 0, score: 0.6, confidence: 0.95 }] },
      { regionId: 2, status: 'ambiguous', candidates: [{ row: 3, col: 1, x: 0, y: 0, rotationDeg: 10, score: 0.4, confidence: 0.3 }] },
    ];
    const changes = placeByElimination(regions, matches, grid, [{ row: 3, col: 1 }], scorer({ '5,2': 0.1 }));
    expect(changes.map((c) => c.cell)).toEqual([{ row: 5, col: 2 }]);
    expect(matches[1].status).toBe('ambiguous');
    expect(matches[1].candidates[0].confidence).toBeCloseTo(0.4, 5);
  });
});

/** A single piece with candidates [row, col, score, confidence]. */
function piece(id: number, status: RegionMatch['status'], cands: [number, number, number, number][]): RegionMatch {
  return { regionId: id, status, candidates: cands.map(([row, col, score, confidence]) => ({ row, col, x: 0, y: 0, rotationDeg: 0, score, confidence })) };
}

describe('uniqueCells', () => {
  it('moves the less confident piece to its next free candidate within the slack', () => {
    const regions = [region(1, 'piece'), region(2, 'piece')];
    const matches = [piece(1, 'confident', [[2, 2, 0.8, 0.95], [4, 4, 0.5, 0.01]]), piece(2, 'ambiguous', [[2, 2, 0.5, 0.4], [3, 1, 0.47, 0.3], [0, 0, 0.3, 0.1]])];
    expect(duplicateClaims(regions, matches)).toEqual({ all: 1, confident: 0 });
    const changes = uniqueCells(regions, matches, 0.05);
    expect(changes).toEqual([{ regionId: 2, holder: 1, cell: { row: 2, col: 2 }, action: 'moved', to: { row: 3, col: 1 } }]);
    expect(matches[1].candidates.map((c) => [c.row, c.col])).toEqual([[3, 1], [2, 2], [0, 0]]);
    expect(matches[1].uncertainReason).toBe('similar-spots');
    expect(matches[0].candidates[0]).toMatchObject({ row: 2, col: 2, confidence: 0.95 });
    expect(duplicateClaims(regions, matches)).toEqual({ all: 0, confident: 0 });
  });

  it('demotes a confident piece whose free alternatives score far worse', () => {
    const regions = [region(1, 'piece'), region(2, 'piece')];
    const matches = [piece(1, 'confident', [[2, 2, 0.8, 0.97]]), piece(2, 'confident', [[2, 2, 0.75, 0.9], [3, 1, 0.5, 0.05]])];
    expect(duplicateClaims(regions, matches)).toEqual({ all: 1, confident: 1 });
    const changes = uniqueCells(regions, matches, 0.05);
    expect(changes.map((c) => c.action)).toEqual(['demoted']);
    expect(matches[1].status).toBe('ambiguous');
    expect(matches[1].candidates[0]).toMatchObject({ row: 2, col: 2 });
    expect(matches[1].candidates[0].confidence).toBeCloseTo(0.45, 5);
    expect(matches[0].status).toBe('confident');
  });

  it('never moves into a cell a more confident piece or a confident patch holds', () => {
    const regions = [region(1, 'piece'), region(2, 'piece'), region(3, 'patch')];
    const patch: RegionMatch = { regionId: 3, status: 'confident', coveredCells: [{ row: 3, col: 1 }], candidates: [{ row: 3, col: 1, x: 0, y: 0, rotationDeg: 0, score: 0.6, confidence: 0.9 }] };
    const matches = [piece(1, 'confident', [[2, 2, 0.8, 0.95]]), piece(2, 'ambiguous', [[2, 2, 0.5, 0.4], [3, 1, 0.49, 0.3], [0, 1, 0.48, 0.1]]), patch];
    uniqueCells(regions, matches, 0.05);
    expect(matches[1].candidates[0]).toMatchObject({ row: 0, col: 1 });
  });

  it('is deterministic: equally confident pieces give way by region id', () => {
    const regions = [region(7, 'piece'), region(3, 'piece')];
    const run = () => {
      const matches = [piece(7, 'ambiguous', [[1, 1, 0.5, 0.4], [1, 2, 0.48, 0.3]]), piece(3, 'ambiguous', [[1, 1, 0.5, 0.4], [2, 2, 0.47, 0.3]])];
      uniqueCells(regions, matches, 0.05);
      return matches.map((m) => [m.regionId, m.candidates[0].row, m.candidates[0].col]);
    };
    expect(run()).toEqual([[7, 1, 2], [3, 1, 1]]);
    expect(run()).toEqual(run());
  });
});
