/**
 * Gaps next to placed pieces (gaps.ts): which sides of a cell face placed cells, whether a piece's
 * clear side readings agree with a cell's position, the colour continuity across a piece's sides
 * into the box picture, and the reordering of ambiguous pieces – within the photo's slack only, and
 * never above the placed gain.
 */
import { describe, expect, it } from 'vitest';
import { createMask, createRGBA, type RGBAImage } from '../../cv/image';
import type { DetectedRegion, PieceShape, Placement, RegionMatch, SideShape } from '../../model/types';
import { borderAgrees, continuityMismatch, placedSides, preferFittingGaps, sampleSides } from './gaps';
import type { MatchDetail } from './matchRegion';
import { buildReferenceIndex } from './referenceIndex';
import type { MatchInput, ReferenceIndex } from './types';

const grid = { rows: 3, cols: 3 };
const keys = (...cells: [number, number][]) => new Set(cells.map(([r, c]) => `${r},${c}`));

describe('placedSides', () => {
  it('tells which neighbours are placed, top, right, bottom, left', () => {
    expect(placedSides(grid, keys([0, 1], [1, 0]), { row: 1, col: 1 })).toEqual([true, false, false, true]);
    expect(placedSides(grid, keys([0, 1]), { row: 2, col: 2 })).toEqual([false, false, false, false]);
  });
  it('is null for a placed cell or one off the grid', () => {
    expect(placedSides(grid, keys([1, 1]), { row: 1, col: 1 })).toBeNull();
    expect(placedSides(grid, keys(), { row: 3, col: 0 })).toBeNull();
  });
});

const side = (kind: SideShape['kind'], depth: number): SideShape => ({
  kind,
  length: 100,
  profile: Array.from({ length: 16 }, (_, k) => depth * Math.sin((Math.PI * k) / 15)),
});
const shapeWith = (sides: SideShape[], corners: PieceShape['corners'] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], bodySize = 1): PieceShape => ({
  corners, sides: sides as PieceShape['sides'], angleDeg: 0, bodySize, center: { x: 0.5, y: 0.5 }, kind: 'edge', confidence: 1,
});

describe('borderAgrees', () => {
  const edgeTop = shapeWith([side('flat', 0.01), side('tab', 0.25), side('blank', -0.25), side('tab', 0.25)]);
  it('wants a clearly flat side towards the puzzle border', () => {
    expect(borderAgrees(edgeTop, 0, { row: 0, col: 1 }, grid)).toBe(true);
    expect(borderAgrees(edgeTop, 0, { row: 1, col: 1 }, grid)).toBe(false);
    // Turned a half turn, the flat side faces down.
    expect(borderAgrees(edgeTop, 180, { row: 2, col: 1 }, grid)).toBe(true);
    expect(borderAgrees(edgeTop, 180, { row: 0, col: 1 }, grid)).toBe(false);
  });
  it('wants no clear knob towards the puzzle border', () => {
    expect(borderAgrees(edgeTop, 0, { row: 0, col: 0 }, grid)).toBe(false);
  });
  it('lets unclear readings pass: a flat side as bent as real ones, a shallow knob', () => {
    const unclear = shapeWith([side('flat', 0.06), side('tab', 0.08), side('blank', -0.25), side('tab', 0.25)]);
    expect(borderAgrees(unclear, 0, { row: 1, col: 1 }, grid)).toBe(true);
    expect(borderAgrees(unclear, 0, { row: 0, col: 2 }, grid)).toBe(true);
  });
});

describe('continuityMismatch', () => {
  // 2 × 2 cells of 64 px: red | blue with a red band along its left edge (the print runs on across
  // the cut); green | blue below.
  const reference = createRGBA(128, 128, [0, 0, 255, 255]);
  const paint = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) reference.data.set([...rgb, 255], (y * 128 + x) * 4);
  };
  paint(0, 0, 64, 64, [220, 30, 30]);
  paint(64, 0, 6, 64, [220, 30, 30]);
  paint(0, 64, 64, 64, [30, 200, 30]);
  const index = buildReferenceIndex(reference, { rows: 2, cols: 2 }, 'grid');
  // The piece of the top-right cell, photographed as is.
  const photo: RGBAImage = createRGBA(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) photo.data.set(reference.data.subarray((y * 128 + 64 + x) * 4, (y * 128 + 64 + x) * 4 + 4), (y * 64 + x) * 4);
  const mask = createMask(64, 64);
  mask.data.fill(1);
  const corners: PieceShape['corners'] = [{ x: 0, y: 0 }, { x: 63, y: 0 }, { x: 63, y: 63 }, { x: 0, y: 63 }];
  const shape = shapeWith([side('flat', 0), side('flat', 0), side('flat', 0), side('flat', 0)], corners, 63);
  const samples = sampleSides(photo, mask, { x: 0, y: 0 }, corners, shape, index.channelWeights)!;
  const at = (x: number, y: number) => ({ map: { pivot: { x: 31.5, y: 31.5 }, phi: 0, s: 1 }, ref: { x, y } });

  it('samples every side', () => {
    expect(samples.sides).toHaveLength(4);
    for (const s of samples.sides) expect(Number.isNaN(s.colour[0])).toBe(false);
  });
  it('finds the print continuing across the left side at the true place, not one cell lower', () => {
    const right = continuityMismatch(index, samples, at(95.5, 31.5), [3])!;
    const wrong = continuityMismatch(index, samples, at(95.5, 95.5), [3])!;
    expect(right).toBeLessThan(0.5 * wrong);
  });
  it('is null without sides to compare', () => {
    expect(continuityMismatch(index, samples, at(95.5, 31.5), [])).toBeNull();
  });
});

describe('preferFittingGaps', () => {
  const index = { grid, channelWeights: [1, 1.6, 1.6] } as unknown as ReferenceIndex;
  const region: DetectedRegion = { id: 1, kind: 'piece', bbox: { x: 0, y: 0, width: 10, height: 10 }, contour: [], area: 100, touchesBorder: false, orientationDeg: 0, issues: [] };
  const input = { regionId: 1, kind: 'piece' } as MatchInput;
  const place = (row: number, col: number, score: number, confidence: number): Placement => ({ row, col, x: 0, y: 0, rotationDeg: 0, score, confidence });
  const detail = (cands: Placement[], status: RegionMatch['status'] = 'ambiguous', photo?: number[]): MatchDetail => ({
    match: { regionId: 1, status, candidates: cands },
    placements: cands.map(() => ({ map: { pivot: { x: 0, y: 0 }, phi: 0, s: 1 }, ref: { x: 0, y: 0 } })),
    photoConfidences: photo ?? cands.map((c) => c.confidence),
  });
  // (1, 1) is a gap: its top and left neighbours are placed; (2, 2) is not.
  const placed = [{ row: 0, col: 1 }, { row: 1, col: 0 }];
  const opts = { prior: 0.01, continuity: 0, slack: 0.03 };

  it('moves a near-tied gap first; its confidence rises to the former best at most', () => {
    const d = detail([place(2, 2, 0.5, 0.4), place(1, 1, 0.49, 0.3), place(0, 2, 0.3, 0.05)]);
    const changes = preferFittingGaps(index, [region], [input], [d], placed, opts);
    expect(changes).toEqual([{ regionId: 1, from: { row: 2, col: 2 }, to: { row: 1, col: 1 }, neighbours: 2 }]);
    expect(d.match.candidates.map((c) => [c.row, c.col])).toEqual([[1, 1], [2, 2], [0, 2]]);
    expect(d.match.candidates[0].confidence).toBeCloseTo(0.4, 9);
    expect(d.match.candidates[1].confidence).toBeCloseTo(0.3, 9);
    expect(d.match.status).toBe('ambiguous');
  });
  it('lifts a confidence by at most the placed gain over the photo’s own', () => {
    const d = detail([place(2, 2, 0.5, 0.6), place(1, 1, 0.49, 0.25)], 'ambiguous', [0.6, 0.1]);
    preferFittingGaps(index, [region], [input], [d], placed, { ...opts, gain: 0.2 });
    expect(d.match.candidates[0].row).toBe(1);
    expect(d.match.candidates[0].confidence).toBeCloseTo(0.3, 9);
  });
  it('never pulls a piece into a gap the photo clearly disfavours (a wrong mark makes a fake gap)', () => {
    const d = detail([place(2, 2, 0.5, 0.4), place(1, 1, 0.45, 0.2)]);
    expect(preferFittingGaps(index, [region], [input], [d], placed, opts)).toEqual([]);
    expect(d.match.candidates[0].row).toBe(2);
  });
  it('leaves a piece whose best place is a marked cell: the photo beat the marks already', () => {
    const d = detail([place(0, 1, 0.5, 0.4), place(1, 1, 0.49, 0.3)]);
    expect(preferFittingGaps(index, [region], [input], [d], placed, opts)).toEqual([]);
    expect(d.match.candidates[0].row).toBe(0);
  });
  it('leaves confident matches, and everything without placed cells', () => {
    const d = detail([place(2, 2, 0.5, 0.8), place(1, 1, 0.49, 0.1)], 'confident');
    expect(preferFittingGaps(index, [region], [input], [d], placed, opts)).toEqual([]);
    const e = detail([place(2, 2, 0.5, 0.4), place(1, 1, 0.49, 0.3)]);
    expect(preferFittingGaps(index, [region], [input], [e], [], opts)).toEqual([]);
  });
  it('does nothing with the evidence switched off', () => {
    const d = detail([place(2, 2, 0.5, 0.4), place(1, 1, 0.49, 0.3)]);
    expect(preferFittingGaps(index, [region], [input], [d], placed, { prior: 0, continuity: 0 })).toEqual([]);
  });
});
