import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../cv/geometry';
import { polygonArea } from '../../cv/polygon';
import type { RGBAImage } from '../../cv/image';
import type { DetectedRegion, PieceShape, RegionMatch } from '../../model/types';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, type JigsawCut, type PieceTruth } from '../../testing/synth';
import { analyzeScan } from '../analyzeScan';
import { angleError, inputFromTruth } from './testkit';
import { buildGroups, buildReferenceIndex, findFits, matchRegions, type ReferenceIndex } from './index';

function regionOf(t: PieceTruth, id: number, shape?: PieceShape): DetectedRegion {
  return {
    id,
    kind: t.pieces.length > 1 ? 'patch' : 'piece',
    bbox: t.bbox,
    contour: t.outline,
    area: polygonArea(t.outline),
    touchesBorder: false,
    shape,
    orientationDeg: 0,
    issues: [],
  };
}

/** Truth of one member piece of a rendered patch, as if it had been photographed alone. */
function memberTruth(t: PieceTruth, k: number): PieceTruth {
  const m = t.members![k];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of m.outline) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return {
    pieces: [m.piece], row: m.row, col: m.col, center: m.center, rotationDeg: m.rotationDeg, corners: m.corners, outline: m.outline,
    bbox: { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1) - Math.floor(x0) + 1, height: Math.ceil(y1) - Math.floor(y0) + 1 },
    transform: m.transform, scale: t.scale,
  };
}

function orientationOf(t: PieceTruth): number {
  let o = -t.rotationDeg;
  while (o <= -45) o += 90;
  while (o > 45) o -= 90;
  return o;
}

describe('buildGroups', () => {
  const rows = 16, cols = 20;
  let ref: RGBAImage;
  let index: ReferenceIndex;
  let cut: JigsawCut;
  const at = (r: number, c: number) => r * cols + c;

  beforeAll(() => {
    ref = loadTestAsset('starry-night');
    index = buildReferenceIndex(perturbReference(ref, { seed: 4 }), { rows, cols }, 'grid');
    cut = generateJigsaw(rows, cols, ref.width, ref.height, 41);
  });

  it('reports an assembled grid found as one patch region (whole pipeline)', () => {
    const grid = [at(4, 6), at(4, 7), at(4, 8), at(5, 6), at(5, 7), at(5, 8), at(6, 6), at(6, 7), at(6, 8)];
    const { photo, truth } = renderPiecesPhoto(ref, cut, [grid, at(12, 2), at(1, 15)], { seed: 3, scale: 1.3, noiseSigma: 3, blurSigma: 0.7 });
    const { result } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height) });
    const groups = result.groups ?? [];
    const assembled = groups.filter((g) => g.kind === 'assembled');
    expect(assembled.length).toBe(1);
    const g = assembled[0];
    expect(g.cells.map((c) => `${c.row},${c.col}`).sort()).toEqual(grid.map((i) => `${cut.pieces[i].row},${cut.pieces[i].col}`).sort());
    expect(g.bounds).toEqual({ row0: 4, col0: 6, row1: 6, col1: 8 });
    expect(angleError(g.rotationDeg!, truth[0].rotationDeg)).toBeLessThan(5);
    expect(g.confidence).toBeGreaterThan(0.7);
    expect(g.x).toBeCloseTo(7.5 * index.cellW - 0.5, 0);
    expect(g.id).toBe(1);
  });

  it('links assembled groups to the pieces and groups they border once placed (whole pipeline)', () => {
    // Two separately lying patches and a loose piece that border each other in the finished
    // puzzle, plus an unrelated piece.
    const patchA = [at(4, 6), at(4, 7), at(5, 6), at(5, 7)];
    const patchB = [at(4, 8), at(5, 8)];
    const { photo } = renderPiecesPhoto(ref, cut, [patchA, at(6, 7), patchB, at(12, 2)], { seed: 6, scale: 1.3, noiseSigma: 3, blurSigma: 0.7 });
    const { result } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height) });
    const groups = result.groups ?? [];
    const cellsText = (g: { cells: { row: number; col: number }[] }) => g.cells.map((c) => `${c.row},${c.col}`).sort();
    expect(groups.filter((g) => g.kind === 'assembled').map(cellsText).sort()).toEqual([['4,6', '4,7', '5,6', '5,7'], ['4,8', '5,8']]);
    const nb = groups.filter((g) => g.kind === 'neighbors');
    expect(nb.length).toBe(1);
    // One neighbour group: both patches (all their regions) and the loose piece, not the unrelated one.
    expect(cellsText(nb[0])).toEqual(['4,6', '4,7', '4,8', '5,6', '5,7', '5,8', '6,7']);
    const assembledIds = groups.filter((g) => g.kind === 'assembled').flatMap((g) => g.regionIds);
    for (const id of assembledIds) expect(nb[0].regionIds).toContain(id);
  });

  it('assembles touching piece regions, rescuing a weak member from its neighbours', () => {
    // As if segmentation had split a 2×3 grid at its seams into six touching piece regions.
    const grid = [at(9, 11), at(9, 12), at(9, 13), at(10, 11), at(10, 12), at(10, 13)];
    const { photo, truth } = renderPiecesPhoto(ref, cut, [grid, at(2, 3)], { seed: 8, scale: 1.3, noiseSigma: 3, blurSigma: 0.7 });
    const members = truth[0].members!.map((_, k) => memberTruth(truth[0], k));
    const items = [...members, truth[1]];
    const inputs = items.map((t, i) => {
      const inp = inputFromTruth(photo, cut, t, i + 1, { withShape: true });
      inp.orientationDeg = orientationOf(t);
      return inp;
    });
    const regions = items.map((t, i) => {
      const r = regionOf(t, i + 1, inputs[i].shape);
      r.orientationDeg = inputs[i].orientationDeg;
      return r;
    });
    const matches = matchRegions(index, inputs);
    // Spoil one member: unmatched (it would be hidden).
    matches[4] = { regionId: 5, candidates: [], status: 'unmatched' };
    // And another one: an ambiguous, wrong best guess.
    const wrong = matches[1].candidates[0];
    matches[1] = { regionId: 2, status: 'ambiguous', candidates: [{ ...wrong, row: 0, col: 0, x: 30, y: 30, confidence: 0.2 }, ...matches[1].candidates.slice(1)] };
    const groups = buildGroups(regions, matches, findFits(regions, matches, index.grid), index.grid, { cellW: index.cellW, cellH: index.cellH, bodySize: inputs[0].expectedBodySize });
    const g = groups.find((x) => x.kind === 'assembled')!;
    expect(g).toBeDefined();
    expect(g.regionIds).toEqual([1, 2, 3, 4, 5, 6]);
    expect(g.cells.map((c) => `${c.row},${c.col}`).sort()).toEqual(['10,11', '10,12', '10,13', '9,11', '9,12', '9,13']);
    expect(angleError(g.rotationDeg!, truth[0].rotationDeg)).toBeLessThan(5);
    for (const k of [1, 4]) {
      const m = matches[k];
      expect(m.status).not.toBe('unmatched');
      expect({ row: m.candidates[0].row, col: m.candidates[0].col }).toEqual({ row: members[k].row, col: members[k].col });
      expect(m.candidates[0].confidence).toBeGreaterThan(0.5);
    }
    // The loose piece is not part of it.
    expect(groups.some((x) => x.regionIds.includes(7) && x.kind === 'assembled')).toBe(false);
  });

  it('does not make a region that is clearly not one piece confident through its neighbours', () => {
    const grid = [at(9, 11), at(9, 12), at(9, 13), at(10, 11), at(10, 12), at(10, 13)];
    const { photo, truth } = renderPiecesPhoto(ref, cut, [grid], { seed: 8, scale: 1.3, noiseSigma: 3, blurSigma: 0.7 });
    const members = truth[0].members!.map((_, k) => memberTruth(truth[0], k));
    const inputs = members.map((t, i) => {
      const inp = inputFromTruth(photo, cut, t, i + 1, { withShape: true });
      inp.orientationDeg = orientationOf(t);
      return inp;
    });
    const regions = members.map((t, i) => {
      const r = regionOf(t, i + 1, inputs[i].shape);
      r.orientationDeg = inputs[i].orientationDeg;
      return r;
    });
    const matches = matchRegions(index, inputs);
    matches[4] = { regionId: 5, candidates: [], status: 'unmatched' };
    // Its outline takes in table: 1.8 times a piece's area.
    regions[4].area *= 1.8;
    buildGroups(regions, matches, findFits(regions, matches, index.grid), index.grid, { cellW: index.cellW, cellH: index.cellH, bodySize: inputs[0].expectedBodySize });
    // Placed where its neighbours say, but not confidently.
    expect({ row: matches[4].candidates[0].row, col: matches[4].candidates[0].col }).toEqual({ row: members[4].row, col: members[4].col });
    expect(matches[4].status).toBe('ambiguous');
  });

  it('links loose pieces of neighbouring cells and leaves unrelated ones alone', () => {
    const items = [at(7, 3), at(7, 4), at(8, 4), at(13, 16), at(2, 9)];
    const { photo, truth } = renderPiecesPhoto(ref, cut, items, { seed: 5, scale: 1.3, noiseSigma: 3, blurSigma: 0.7 });
    const inputs = truth.map((t, i) => inputFromTruth(photo, cut, t, i + 1, { withShape: true }));
    const regions = truth.map((t, i) => regionOf(t, i + 1, inputs[i].shape));
    const matches = matchRegions(index, inputs);
    expect(matches.every((m) => m.status === 'confident')).toBe(true);
    const groups = buildGroups(regions, matches, findFits(regions, matches, index.grid), index.grid, { cellW: index.cellW, cellH: index.cellH, bodySize: inputs[0].expectedBodySize });
    expect(groups.filter((g) => g.kind === 'assembled')).toEqual([]);
    const nb = groups.filter((g) => g.kind === 'neighbors');
    expect(nb.length).toBe(1);
    expect(nb[0].regionIds).toEqual([1, 2, 3]);
    expect(nb[0].cells.map((c) => `${c.row},${c.col}`).sort()).toEqual(['7,3', '7,4', '8,4']);
    // Loose pieces lie at random angles: no common rotation.
    const rots = truth.slice(0, 3).map((t) => t.rotationDeg);
    if (Math.max(...rots.map((r) => angleError(r, rots[0]))) > 20) expect(nb[0].rotationDeg).toBeUndefined();
  });

  it('does not assemble touching pieces whose placements disagree with their layout', () => {
    // Two squares side by side in the photo; placements far apart in the reference.
    const square = (x: number, y: number, s: number): Point[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
    const s = 80;
    const regions: DetectedRegion[] = [square(100, 100, s), square(100 + s + 2, 100, s)].map((contour, i) => ({
      id: i + 1, kind: 'piece', bbox: { x: contour[0].x, y: contour[0].y, width: s, height: s }, contour, area: s * s, touchesBorder: false, orientationDeg: 0, issues: [],
    }));
    const cw = index.cellW, ch = index.cellH;
    const place = (row: number, col: number, conf: number) => ({ row, col, x: (col + 0.5) * cw - 0.5, y: (row + 0.5) * ch - 0.5, rotationDeg: 0, score: 0.8, confidence: conf });
    const far: RegionMatch[] = [
      { regionId: 1, status: 'confident', candidates: [place(3, 3, 0.95)] },
      { regionId: 2, status: 'confident', candidates: [place(10, 12, 0.95)] },
    ];
    expect(buildGroups(regions, far, [], index.grid, { cellW: cw, cellH: ch, bodySize: s })).toEqual([]);
    const near: RegionMatch[] = [
      { regionId: 1, status: 'confident', candidates: [place(3, 3, 0.95)] },
      { regionId: 2, status: 'confident', candidates: [place(3, 4, 0.95)] },
    ];
    const g = buildGroups(regions, near, [], index.grid, { cellW: cw, cellH: ch, bodySize: s });
    expect(g.length).toBe(1);
    expect(g[0]).toMatchObject({ kind: 'assembled', regionIds: [1, 2], bounds: { row0: 3, col0: 3, row1: 3, col1: 4 }, rotationDeg: 0 });
    // Neither group for regions that only touch at a corner.
    const corner = [regions[0], { ...regions[1], contour: square(100 + s + 1, 100 + s + 1, s), bbox: { x: 181, y: 181, width: s, height: s } }];
    const diag: RegionMatch[] = [
      { regionId: 1, status: 'confident', candidates: [place(3, 3, 0.95)] },
      { regionId: 2, status: 'confident', candidates: [place(4, 4, 0.95)] },
    ];
    expect(buildGroups(corner, diag, [], index.grid, { cellW: cw, cellH: ch, bodySize: s }).filter((x) => x.kind === 'assembled')).toEqual([]);
  });
});
