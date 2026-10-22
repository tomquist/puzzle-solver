import { beforeAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../cv/image';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, type JigsawCut, type PieceTruth } from '../../testing/synth';
import { segmentPieces } from '../pieces';
import { matchRegionDetailed, patchCoveredCells, sameLatticeGeometry } from './matchRegion';
import { buildReferenceIndex, type MatchInput, type ReferenceIndex } from './index';

/**
 * A large assembled block as the app sees it: segmented from the photo (holes and notches as the
 * segmentation leaves them), placed by the matcher, and its cells decided from its own seams even
 * when the placement transform is somewhat off.
 */
describe('patch cells — a 56-cell block with holes and notches at an odd angle', () => {
  const rows = 16, cols = 20;
  let index: ReferenceIndex;
  let cut: JigsawCut;
  let photo: RGBAImage;
  let truth: PieceTruth[];
  // Rows 3–9, cols 5–12 without two enclosed holes and four notches on the rim.
  const missing = new Set(['5,8', '7,10', '3,5', '3,9', '6,12', '9,7']);
  const cells: string[] = [];
  for (let r = 3; r <= 9; r++) for (let c = 5; c <= 12; c++) if (!missing.has(`${r},${c}`)) cells.push(`${r},${c}`);

  beforeAll(() => {
    const ref = loadTestAsset('starry-night');
    index = buildReferenceIndex(perturbReference(ref, { seed: 5 }), { rows, cols }, 'grid');
    cut = generateJigsaw(rows, cols, ref.width, ref.height, 101);
    const block = cells.map((k) => {
      const [r, c] = k.split(',').map(Number);
      return r * cols + c;
    });
    const cell = (cut.width / cut.cols + cut.height / cut.rows) / 2;
    // The block and three loose pieces (they give the scan its piece size).
    ({ photo, truth } = renderPiecesPhoto(ref, cut, [block, 1 * cols + 17, 13 * cols + 2, 14 * cols + 15], {
      seed: 12, rotation: 23, scale: 72 / cell, background: [196, 208, 218], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1, supersample: 2,
    }));
  });

  function patchInput(): MatchInput {
    const seg = segmentPieces(photo);
    const patches = seg.regions.filter((s) => s.region.kind === 'patch').sort((a, b) => b.region.area - a.region.area);
    expect(patches.length).toBeGreaterThan(0);
    const s = patches[0];
    return {
      regionId: s.region.id, kind: 'patch', image: s.image, mask: s.mask, origin: { x: s.region.bbox.x, y: s.region.bbox.y },
      orientationDeg: s.region.orientationDeg, expectedBodySize: seg.medianBodySize, table: s.table,
    };
  }
  const keys = (cs: { row: number; col: number }[]) => cs.map((c) => `${c.row},${c.col}`).sort();

  it('reports exactly the cells of its pieces', () => {
    expect(truth[0].pieces.length).toBe(50);
    const d = matchRegionDetailed(index, patchInput());
    expect(d.match.status).toBe('confident');
    expect(keys(d.match.coveredCells ?? [])).toEqual([...cells].sort());
  });

  it('still does when the placement transform is off (1.5°, 3 % scale, 0.15 cells)', () => {
    const input = patchInput();
    const d = matchRegionDetailed(index, input);
    const { map, ref } = d.best!;
    const off = { map: { ...map, phi: map.phi + (1.5 * Math.PI) / 180, s: map.s * 1.03 }, ref: { x: ref.x + 0.15 * index.cellW, y: ref.y - 0.15 * index.cellH } };
    // That transform puts the block's far pieces well off their cells (the old test through it
    // lost edge pieces and counted holes): a quarter of a cell or more.
    const cw = cut.width / cut.cols, ch = cut.height / cut.rows;
    let worst = 0;
    for (const m of truth[0].members ?? []) {
      const dx = (m.center.x - off.map.pivot.x) * off.map.s, dy = (m.center.y - off.map.pivot.y) * off.map.s;
      const c = Math.cos(off.map.phi), s = Math.sin(off.map.phi);
      const rx = c * dx - s * dy + off.ref.x, ry = s * dx + c * dy + off.ref.y;
      worst = Math.max(worst, Math.abs(rx / index.cellW - (m.col + 0.5)), Math.abs(ry / index.cellH - (m.row + 0.5)));
    }
    expect(cw).toBeCloseTo(index.cellW, 0);
    expect(ch).toBeCloseTo(index.cellH, 0);
    expect(worst).toBeGreaterThan(0.25);
    expect(keys(patchCoveredCells(index, input, off))).toEqual([...cells].sort());
  });
});

describe('patch cells — which candidates share the best placement\'s lattice', () => {
  const at = (deg: number, s: number) => ({ map: { pivot: { x: 0, y: 0 }, phi: (deg * Math.PI) / 180, s } });
  const square = { cellW: 100, cellH: 100 }, wide = { cellW: 120, cellH: 100 };
  const best = at(10, 2);

  it('shares it at about the same scale and turn', () => {
    expect(sameLatticeGeometry(square, best, at(11.5, 2.08))).toBe(true);
    expect(sameLatticeGeometry(wide, best, at(190, 1.95))).toBe(true);
  });

  it('not at another piece count (scale) or turn', () => {
    // A two-piece hypothesis next to a one-piece one: cells of another size in the photo.
    expect(sameLatticeGeometry(square, best, at(10, 2 * 0.8))).toBe(false);
    expect(sameLatticeGeometry(square, best, at(25, 2))).toBe(false);
  });

  it('a quarter turn keeps square cells but swaps the width and height of oblong ones', () => {
    expect(sameLatticeGeometry(square, best, at(100, 2))).toBe(true);
    expect(sameLatticeGeometry(wide, best, at(100, 2))).toBe(false);
  });
});
