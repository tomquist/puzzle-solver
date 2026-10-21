/**
 * Grid changes without re-analysing photos (remap.ts): a scene analysed with a grid one column off
 * is carried over to the right grid; its pieces and patches must land where an analysis with the
 * right grid puts them, and placed progress must move with the pieces it came from.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cellKey, type GridSpec, type ProgressRecord, type ScanResult } from '../model/types';
import { loadTestAsset } from '../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, type PieceTruth } from '../testing/synth';
import { analyzeScan } from './analyzeScan';
import { buildReferenceIndex } from './match';
import { latticeOnGrid, remapProgress, remapScanResult } from './remap';

describe('remap: a scan analysed one column off, carried to the right grid', () => {
  const truthGrid: GridSpec = { rows: 16, cols: 20 };
  const wrong: GridSpec = { rows: 16, cols: 19 };
  let ref: { width: number; height: number };
  let atWrong: ScanResult, atRight: ScanResult;
  let truth: PieceTruth[];
  beforeAll(() => {
    const src = loadTestAsset('starry-night');
    const cut = generateJigsaw(truthGrid.rows, truthGrid.cols, src.width, src.height, 11);
    const reference = perturbReference(src, { seed: 11 });
    ref = { width: reference.width, height: reference.height };
    const at = (r: number, c: number) => r * truthGrid.cols + c;
    const block = (r0: number, c0: number, h: number, w: number) => Array.from({ length: h * w }, (_, k) => at(r0 + Math.floor(k / w), c0 + (k % w)));
    // Two assembled patches (3 × 3 near the left, 3 × 4 right of the middle) and loose pieces all over.
    const items = [block(2, 2, 3, 3), block(8, 10, 3, 4), at(0, 17), at(5, 8), at(12, 3), at(14, 16), at(6, 19), at(13, 9), at(1, 6), at(10, 0)];
    const scene = renderPiecesPhoto(src, cut, items, { seed: 61, background: [38, 40, 46], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1 });
    truth = scene.truth;
    const opts = { maxSide: Math.max(scene.photo.width, scene.photo.height) };
    atWrong = analyzeScan(buildReferenceIndex(reference, wrong, 'grid'), scene.photo, opts).result;
    atRight = analyzeScan(buildReferenceIndex(reference, truthGrid, 'grid'), scene.photo, opts).result;
  }, 240_000);

  it('stores every placed patch’s lattice in reference pixels', () => {
    const patches = atRight.regions.filter((r) => r.kind === 'patch').map((r) => atRight.matches.find((m) => m.regionId === r.id)!);
    expect(patches.length).toBeGreaterThan(0);
    for (const m of patches) {
      if (m.candidates.length === 0) continue;
      expect(m.lattice).toBeDefined();
      // On the grid it was analysed with, the stored lattice gives the cells the matcher reported.
      const cells = latticeOnGrid(m.lattice!, truthGrid, ref).map(cellKey).sort();
      expect(cells).toEqual((m.coveredCells ?? []).map(cellKey).sort());
    }
  });

  it('puts pieces and patches where the right grid’s analysis puts them', () => {
    const { result, exact } = remapScanResult(atWrong, wrong, truthGrid, ref);
    expect(exact).toBe(true);
    let compared = 0, same = 0;
    for (const r of result.regions) {
      const a = result.matches.find((m) => m.regionId === r.id);
      const b = atRight.matches.find((m) => m.regionId === r.id);
      if (!a || !b || a.status !== 'confident' || b.status !== 'confident') continue;
      // Same placement position (the matcher is grid-free up to its scale): same cells now.
      const pa = a.candidates[0], pb = b.candidates[0];
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 0.3 * (ref.width / truthGrid.cols)) continue;
      compared++;
      const ka = r.kind === 'patch' ? (a.coveredCells ?? []).map(cellKey).sort().join(' ') : cellKey(pa);
      const kb = r.kind === 'patch' ? (b.coveredCells ?? []).map(cellKey).sort().join(' ') : cellKey(pb);
      if (ka === kb) same++;
    }
    expect(compared).toBeGreaterThanOrEqual(4);
    expect(same / compared).toBeGreaterThanOrEqual(0.9);
    // And the patches cover their true cells.
    for (const t of truth.filter((x) => x.pieces.length > 1)) {
      const c = t.members![0].center;
      const r = result.regions.find((x) => x.kind === 'patch' && c.x >= x.bbox.x && c.y >= x.bbox.y && c.x < x.bbox.x + x.bbox.width && c.y < x.bbox.y + x.bbox.height);
      const m = r && result.matches.find((x) => x.regionId === r.id);
      if (!m || m.status !== 'confident') continue;
      const want = new Set(t.pieces.map((i) => cellKey({ row: Math.floor(i / truthGrid.cols), col: i % truthGrid.cols })));
      const got = (m.coveredCells ?? []).map(cellKey);
      const inter = got.filter((k) => want.has(k)).length;
      expect(inter / (want.size + got.length - inter)).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('moves placed pieces with the pieces they were confirmed from', () => {
    const piece = atWrong.matches.find((m) => m.status === 'confident' && atWrong.regions.find((r) => r.id === m.regionId)?.kind === 'piece')!;
    const old = piece.candidates[0];
    const progress: ProgressRecord = {
      puzzleId: 'p',
      placed: {
        [cellKey(old)]: { at: 1, scanId: 's', regionId: piece.regionId },
        // A cell placed by hand far right: moves by its centre.
        [cellKey({ row: 3, col: 18 })]: { at: 2 },
      },
      updatedAt: 2,
    };
    const after = remapScanResult(atWrong, wrong, truthGrid, ref).result;
    const moved = remapProgress(progress, wrong, truthGrid, ref, { before: [{ id: 's', result: atWrong }], after: [{ id: 's', result: after }] });
    const now = after.matches.find((m) => m.regionId === piece.regionId)!.candidates[0];
    expect(moved.progress.placed[cellKey(now)]).toEqual({ at: 1, scanId: 's', regionId: piece.regionId });
    // Column 18 of 19 (centre at 18.5/19 of the width) is column 19 of 20.
    expect(moved.progress.placed[cellKey({ row: 3, col: 19 })]).toEqual({ at: 2 });
    expect(moved.dropped).toBe(0);
  });

  it('two old cells on one new cell keep the earlier', () => {
    const progress: ProgressRecord = { puzzleId: 'p', placed: { '0,0': { at: 5 }, '0,1': { at: 3 } }, updatedAt: 5 };
    // From 40 columns to 20: cells 0 and 1 both become cell 0.
    const r = remapProgress(progress, { rows: 16, cols: 40 }, truthGrid, ref, { before: [], after: [] });
    expect(r.progress.placed).toEqual({ '0,0': { at: 3 } });
    expect(r.dropped).toBe(1);
  });
});
