import { describe, expect, it } from 'vitest';
import type { DetectedRegion, Placement, RegionKind, RegionMatch, ScanResult } from '../model/types';
import { parseTruth, scoreTruth, truthPath, type PlacementTruth } from '../../scripts/feedback/truth';

function square(id: number, kind: RegionKind, x: number, y: number, size: number): DetectedRegion {
  return {
    id, kind, bbox: { x, y, width: size, height: size }, area: size * size, touchesBorder: false, orientationDeg: 0, issues: [],
    contour: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }],
  };
}
const place = (row: number, col: number, rotationDeg: number, confidence = 0.9): Placement => ({ row, col, x: 0, y: 0, rotationDeg, score: 0.5, confidence });

function result(regions: DetectedRegion[], matches: RegionMatch[]): ScanResult {
  return { width: 1000, height: 1000, regions, matches, fits: [], groups: [], quality: { score: 1, issues: [], metrics: {} }, timings: {} };
}

describe('placement truth', () => {
  const scan = result(
    [
      square(1, 'piece', 0, 0, 100),
      square(2, 'piece', 200, 0, 100),
      square(3, 'patch', 400, 0, 300),
      square(4, 'unknown', 0, 400, 100),
      square(5, 'piece', 200, 400, 100),
      square(6, 'patch', 400, 400, 300),
    ],
    [
      { regionId: 1, status: 'confident', candidates: [place(3, 4, 92)] },
      { regionId: 2, status: 'confident', candidates: [place(1, 1, 0), place(2, 2, 0)] },
      { regionId: 3, status: 'ambiguous', candidates: [place(5, 5, 180, 0.4)], coveredCells: [{ row: 5, col: 5 }, { row: 5, col: 6 }] },
      { regionId: 4, status: 'ambiguous', candidates: [place(7, 7, 0)] },
      { regionId: 5, status: 'unmatched', candidates: [place(8, 8, 0)] },
      {
        regionId: 6, status: 'confident', candidates: [place(10, 20, 207, 0.99)],
        coveredCells: [{ row: 10, col: 20 }, { row: 10, col: 21 }, { row: 11, col: 20 }, { row: 11, col: 21 }],
      },
    ],
  );
  const truth: PlacementTruth = {
    format: 'puzzle-solver-truth', version: 1, feedback: 'x.json',
    pieces: [
      { x: 50, y: 50, row: 3, col: 4, rotationDeg: 85 }, // right, rotation 7° off
      { x: 250, y: 50, row: 2, col: 2, rotationDeg: 0 }, // second candidate; confident but wrong
      { x: 450, y: 50, row: 5, col: 6, rotationDeg: 180 }, // in a patch with the next one
      { x: 650, y: 50, row: 9, col: 9, rotationDeg: 180 }, // same patch, cell not covered
      { x: 50, y: 450, row: 7, col: 7, rotationDeg: 0 }, // inside an 'unknown' region: not found
      { x: 250, y: 450, row: 8, col: 8, rotationDeg: 0 }, // unmatched: not placed
      { x: 900, y: 900, row: 0, col: 0, rotationDeg: 0 }, // on the table: not found
      { x: 950, y: 50, row: 0, col: 0, rotationDeg: 0, unsure: true }, // unsure: ignored
    ],
    blocks: [{ x: 550, y: 550, cells: [{ row: 10, col: 20 }, { row: 10, col: 21 }, { row: 11, col: 20 }], rotationDeg: 200 }],
  };

  it('scores pieces and blocks', () => {
    const { items, metrics } = scoreTruth(scan, truth);
    const piece = items.filter((j) => j.kind === 'piece');
    expect(piece.map((j) => j.top1)).toEqual([true, false, true, false, false, false, false, false]);
    expect(piece.map((j) => j.top3)).toEqual([true, true, true, false, false, false, false, false]);
    expect(piece.map((j) => j.regionId)).toEqual([1, 2, 3, 3, undefined, 5, undefined, undefined]);
    expect(piece[0].rotationOk).toBe(true);
    expect(piece[2].merged && piece[3].merged).toBe(true);
    // 7 sure pieces: 5 found (not in the unknown region, not on the table), 2 merged.
    expect(metrics.pieces).toBe(7);
    expect(metrics.unsure).toBe(1);
    expect(metrics.found).toBeCloseTo(5 / 7);
    expect(metrics.merged).toBeCloseTo(2 / 7);
    expect(metrics.top1).toBeCloseTo(2 / 7);
    expect(metrics.top3).toBeCloseTo(3 / 7);
    expect(metrics.rotationOk).toBe(1);
    // Confident: regions 1 and 2 (right, wrong).
    expect(metrics.confidentShare).toBeCloseTo(2 / 7);
    expect(metrics.confidentPrecision).toBe(0.5);
    // Block: 3 of 4 covered cells are right (Jaccard 0.75), rotation 7° off.
    expect(metrics.blocks).toBe(1);
    expect(metrics.blockTop1).toBe(1);
    expect(metrics.blockJaccard).toBeCloseTo(0.75);
    expect(metrics.blockRotationOk).toBe(1);
  });

  it('judges rotations against the tolerance and blocks below Jaccard 0.5 as misplaced', () => {
    const t: PlacementTruth = {
      ...truth,
      pieces: [{ x: 50, y: 50, row: 3, col: 4, rotationDeg: 270 }],
      blocks: [{ x: 550, y: 550, cells: [{ row: 10, col: 20 }, { row: 12, col: 20 }, { row: 12, col: 21 }, { row: 13, col: 20 }], rotationDeg: 207 }],
    };
    const { items, metrics } = scoreTruth(scan, t);
    expect(items[0].top1).toBe(true);
    expect(items[0].rotationOk).toBe(false);
    expect(metrics.rotationOk).toBe(0);
    expect(items[1].jaccard).toBeCloseTo(1 / 7);
    expect(metrics.blockTop1).toBe(0);
  });

  it('validates the format', () => {
    expect(truthPath('/a/fb18.json')).toBe('/a/fb18.truth.json');
    expect(() => parseTruth({ ...truth, format: 'x' })).toThrow();
    expect(() => parseTruth({ ...truth, pieces: [{ x: 1, y: 1, row: -1, col: 0, rotationDeg: 0 }] })).toThrow();
    expect(() => parseTruth({ ...truth, blocks: [{ x: 1, y: 1, cells: [], rotationDeg: 0 }] })).toThrow();
    expect(parseTruth(JSON.parse(JSON.stringify(truth))).pieces).toHaveLength(8);
  });
});
