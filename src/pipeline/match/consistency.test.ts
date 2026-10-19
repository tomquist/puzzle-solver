import { describe, expect, it } from 'vitest';
import type { CellRef, DetectedRegion, MatchStatus, PieceShape, Placement, RegionMatch, SideKind } from '../../model/types';
import { enforceConsistency, impliedPlacement } from './consistency';
import { puzzleSideOf, type ShapeFit } from './fits';

/** Toy single piece: local side i faces puzzle side i at rotation 0 (shape angle `angleDeg`). */
function piece(id: number, angleDeg = 0, kinds: SideKind[] = ['tab', 'blank', 'tab', 'blank']): DetectedRegion {
  const side = (kind: SideKind) => ({ kind, length: 100, profile: [] });
  const shape: PieceShape = {
    corners: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    sides: [side(kinds[0]), side(kinds[1]), side(kinds[2]), side(kinds[3])],
    angleDeg,
    bodySize: 100,
    center: { x: 50, y: 50 },
    kind: 'interior',
    confidence: 1,
  };
  return { id, kind: 'piece', bbox: { x: 0, y: 0, width: 100, height: 100 }, contour: [], area: 10000, touchesBorder: false, shape, orientationDeg: angleDeg, issues: [] };
}

function at(row: number, col: number, score: number, confidence: number, rotationDeg = 0): Placement {
  return { row, col, x: col * 10, y: row * 10, rotationDeg, score, confidence };
}

function match(regionId: number, status: MatchStatus, candidates: Placement[], coveredCells?: CellRef[]): RegionMatch {
  return { regionId, status, candidates, coveredCells };
}

function fit(a: number, sideA: number, b: number, sideB: number, confidence = 0.9): ShapeFit {
  return { a, sideA, b, sideB, distance: 0.005, ratio: 4, confidence };
}

const grid = { rows: 5, cols: 5 };
const top = (m: RegionMatch) => [m.candidates[0].row, m.candidates[0].col];

describe('impliedPlacement', () => {
  it('puts the partner next to the anchor with its fitting side facing back', () => {
    for (const angleA of [-30, 0, 17, 44]) {
      for (const angleB of [-44, -5, 0, 38]) {
        for (const rot of [0, 90, 180, 270]) {
          const A = piece(1, angleA).shape!, B = piece(2, angleB).shape!;
          const rotationDeg = (rot - angleA + 360) % 360;
          for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
              const p = impliedPlacement(A, { row: 2, col: 2, rotationDeg }, i, B, j);
              const side = puzzleSideOf(A, rotationDeg, i);
              expect(Math.abs(p.row - 2) + Math.abs(p.col - 2)).toBe(1);
              expect([p.row - 2, p.col - 2]).toEqual([[-1, 0], [0, 1], [1, 0], [0, -1]][side]);
              expect(puzzleSideOf(B, p.rotationDeg, j)).toBe((side + 2) % 4);
            }
          }
        }
      }
    }
  });
});

describe('enforceConsistency', () => {
  it('promotes the implied candidate of an ambiguous neighbour of a confident piece', () => {
    const regions = [piece(1), piece(2)];
    const matches = [
      match(1, 'confident', [at(2, 2, 0.8, 0.95)]),
      // Plain sky: nearly tied places, the right one (2,3) second.
      match(2, 'ambiguous', [at(4, 4, 0.5, 0.3), at(2, 3, 0.49, 0.25), at(0, 0, 0.48, 0.2)]),
    ];
    // Right side of piece 1 fits left side of piece 2.
    const report = enforceConsistency(regions, matches, [fit(1, 1, 2, 3)], grid);
    expect(top(matches[1])).toEqual([2, 3]);
    expect(matches[1].status).toBe('confident');
    expect(matches[1].candidates[0].confidence).toBeGreaterThan(0.7);
    expect(matches[1].candidates.reduce((s, c) => s + c.confidence, 0)).toBeLessThanOrEqual(1 + 1e-9);
    expect(top(matches[0])).toEqual([2, 2]);
    expect(report.changes.map((c) => [c.regionId, c.reason])).toEqual([[2, 'fit']]);
  });

  it('scores an implied placement the matcher did not list, and does not force a poor one', () => {
    const regions = [piece(1), piece(2)];
    const asked: [number, CellRef, number][] = [];
    const run = (score: number) => {
      const matches = [match(1, 'confident', [at(2, 2, 0.8, 0.95)]), match(2, 'ambiguous', [at(4, 4, 0.5, 0.3), at(0, 0, 0.48, 0.2)])];
      enforceConsistency(regions, matches, [fit(1, 1, 2, 3)], grid, {
        score: (id, cell, rotationDeg) => {
          asked.push([id, { row: cell.row, col: cell.col }, rotationDeg]);
          return at(cell.row, cell.col, score, 0, rotationDeg);
        },
      });
      return matches[1];
    };
    const plausible = run(0.47);
    expect(asked).toEqual([[2, { row: 2, col: 3 }, 0]]);
    expect(top(plausible)).toEqual([2, 3]);
    expect(plausible.status).toBe('confident');
    // The picture clearly disagrees there (0.25 below its best): the fit does not override it.
    const poor = run(0.25);
    expect(top(poor)).toEqual([4, 4]);
    expect(poor.status).toBe('ambiguous');
  });

  it('propagates along a chain: newly confident pieces anchor the next round', () => {
    const regions = [piece(1), piece(2), piece(3)];
    const matches = [
      match(1, 'confident', [at(2, 0, 0.8, 0.95)]),
      match(2, 'ambiguous', [at(4, 4, 0.5, 0.3), at(2, 1, 0.5, 0.3)]),
      match(3, 'ambiguous', [at(0, 4, 0.5, 0.3), at(2, 2, 0.5, 0.3)]),
    ];
    const report = enforceConsistency(regions, matches, [fit(1, 1, 2, 3), fit(2, 1, 3, 3)], grid);
    expect(top(matches[1])).toEqual([2, 1]);
    expect(top(matches[2])).toEqual([2, 2]);
    expect(matches[2].status).toBe('confident');
    // Weaker than its anchor: confidence decays along the chain.
    expect(matches[2].candidates[0].confidence).toBeLessThan(matches[1].candidates[0].confidence);
    expect(report.rounds).toBeGreaterThanOrEqual(2);
  });

  it('drops a fit that contradicts two confident placements', () => {
    const regions = [piece(1), piece(2)];
    const matches = [match(1, 'confident', [at(2, 2, 0.8, 0.95)]), match(2, 'confident', [at(0, 0, 0.8, 0.9)])];
    const report = enforceConsistency(regions, matches, [fit(1, 1, 2, 3)], grid);
    expect(report.pruned).toBe(1);
    expect(report.changes).toEqual([]);
    expect(matches.map((m) => [m.status, ...top(m)])).toEqual([['confident', 2, 2], ['confident', 0, 0]]);
  });

  it('keeps fits that agree with the confident placements', () => {
    const regions = [piece(1), piece(2)];
    const matches = [match(1, 'confident', [at(2, 2, 0.8, 0.95)]), match(2, 'confident', [at(2, 3, 0.8, 0.9)])];
    const report = enforceConsistency(regions, matches, [fit(1, 1, 2, 3)], grid);
    expect(report.pruned).toBe(0);
    expect(report.changes).toEqual([]);
  });

  it('drops a fit that would put the partner off the grid', () => {
    const regions = [piece(1), piece(2)];
    const matches = [match(1, 'confident', [at(2, 4, 0.8, 0.95)]), match(2, 'ambiguous', [at(0, 0, 0.5, 0.3)])];
    const report = enforceConsistency(regions, matches, [fit(1, 1, 2, 3)], grid, { score: () => { throw new Error('not scored'); } });
    expect(report.pruned).toBe(1);
    expect(top(matches[1])).toEqual([0, 0]);
  });

  it('lowers a confident placement that contradicts several fits, then re-places it from them', () => {
    const regions = [piece(1), piece(2), piece(3)];
    const matches = [
      match(1, 'confident', [at(1, 2, 0.8, 0.95)]),
      match(2, 'confident', [at(2, 1, 0.8, 0.95)]),
      // Misplaced: both neighbours' fits say (2,2).
      match(3, 'confident', [at(4, 4, 0.6, 0.75), at(2, 2, 0.58, 0.1)]),
    ];
    // Bottom of 1 fits top of 3; right of 2 fits left of 3.
    const report = enforceConsistency(regions, matches, [fit(1, 2, 3, 0), fit(2, 1, 3, 3)], grid);
    expect(top(matches[2])).toEqual([2, 2]);
    expect(matches[0].status).toBe('confident');
    expect(matches[1].status).toBe('confident');
    expect(report.pruned).toBe(0);
    expect(report.changes.map((c) => c.regionId)).toEqual([3]);
  });

  it('never puts two regions in one cell', () => {
    const regions = [piece(1), piece(2), piece(3), { ...piece(4), kind: 'patch' as const, shape: undefined }, piece(5)];
    const matches = [
      match(1, 'confident', [at(2, 2, 0.8, 0.95)]),
      match(2, 'confident', [at(2, 3, 0.8, 0.9)]),
      // Fits right of 1, but (2,3) is held by 2: no implied placement there.
      match(3, 'ambiguous', [at(4, 4, 0.5, 0.3), at(2, 3, 0.5, 0.3), at(3, 3, 0.45, 0.1)]),
      // A confident patch holds (0,0) and (0,1).
      match(4, 'confident', [at(0, 0, 0.8, 0.9)], [{ row: 0, col: 0 }, { row: 0, col: 1 }]),
      // Its best place is under the patch: it moves to its best free candidate.
      match(5, 'ambiguous', [at(0, 1, 0.5, 0.3), at(2, 2, 0.49, 0.25), at(4, 0, 0.48, 0.2)]),
    ];
    enforceConsistency(regions, matches, [fit(1, 1, 3, 3)], grid);
    expect(top(matches[2])).toEqual([4, 4]);
    expect(top(matches[4])).toEqual([4, 0]);
    const cells = matches.flatMap((m) => (m.coveredCells ?? [m.candidates[0]]).map((c) => `${c.row},${c.col}`));
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('gives a contested cell to the better supported piece, and keeps cells the user placed free', () => {
    const regions = [piece(1), piece(2), piece(3)];
    const run = (placedCells?: CellRef[]) => {
      const matches = [
        match(1, 'confident', [at(2, 2, 0.8, 0.95)]),
        match(2, 'ambiguous', [at(4, 4, 0.5, 0.3), at(2, 3, 0.5, 0.3)]),
        match(3, 'ambiguous', [at(0, 4, 0.5, 0.3), at(2, 3, 0.5, 0.3)]),
      ];
      // Two pieces fit the right side of 1 (a misread side): the stronger fit wins the cell.
      enforceConsistency(regions, matches, [fit(1, 1, 2, 3, 0.9), fit(1, 3, 3, 1, 0.5), fit(1, 1, 3, 3, 0.6)], grid, { placedCells });
      return matches;
    };
    const m = run();
    expect(top(m[1])).toEqual([2, 3]);
    expect(top(m[2])).not.toEqual([2, 3]);
    const placed = run([{ row: 2, col: 3 }]);
    expect(top(placed[1])).toEqual([4, 4]);
  });
});
