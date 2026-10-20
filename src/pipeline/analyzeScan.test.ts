/**
 * A small puzzle end to end (analyzeScan): 18 pieces, 6 rows × 3 columns of a portrait picture
 * (cells 1.6× wider than tall, pieces large on the photo), assembled but for two pieces taken out
 * of its middle, which lie beside it. The block must cover exactly its 16 cells – not the holes,
 * not a few rows only – and both loose pieces must be placed in their holes and linked to the block
 * by a fit hint (with the holes counted as covered, the hints between them were silently dropped).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../cv/image';
import { resizeRGBA } from '../cv/resize';
import { cellKey, type ScanResult } from '../model/types';
import { loadTestAsset } from '../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, type PieceTruth } from '../testing/synth';
import { analyzeScan } from './analyzeScan';
import { buildReferenceIndex } from './match';

/** The painting's middle as a portrait picture (aspect 0.79). */
function portrait(img: RGBAImage): RGBAImage {
  const w = Math.round(0.79 * img.height), x0 = Math.round((img.width - w) / 2);
  const out = { width: w, height: img.height, data: new Uint8ClampedArray(w * img.height * 4) };
  for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x0 + w) * 4), y * w * 4);
  return out;
}

describe('analyzeScan: an 18-piece portrait puzzle with two holes', () => {
  const grid = { rows: 6, cols: 3 };
  const holes = [2 * 3 + 1, 4 * 3 + 1];
  let result: ScanResult;
  let truth: PieceTruth[];
  beforeAll(() => {
    const picture = portrait(loadTestAsset('starry-night'));
    const cut = generateJigsaw(grid.rows, grid.cols, picture.width, picture.height, 40);
    const block = cut.pieces.map((p) => p.index).filter((i) => !holes.includes(i));
    const scene = renderPiecesPhoto(picture, cut, [holes[0], block, holes[1]], {
      seed: 90, scale: 0.5, background: [200, 196, 190], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1, rim: {}, shadow: 0.35, shadowOffset: [5, 4], shadowBlur: 3,
    });
    truth = scene.truth;
    // A box picture of high resolution: reference cells about 2.4× the pieces' size on the photo (as
    // in the user's photos).
    const big = resizeRGBA(picture, picture.width * 1.6, picture.height * 1.6);
    const index = buildReferenceIndex(perturbReference(big, { seed: 40 }), grid, 'grid');
    result = analyzeScan(index, scene.photo, { maxSide: Math.max(scene.photo.width, scene.photo.height) }).result;
  }, 120_000);

  const regionAt = (t: PieceTruth) => {
    const c = t.pieces.length > 1 ? t.members![0].center : t.center;
    return result.regions.find((r) => c.x >= r.bbox.x && c.y >= r.bbox.y && c.x < r.bbox.x + r.bbox.width && c.y < r.bbox.y + r.bbox.height && r.kind !== 'unknown');
  };

  it('covers exactly the block’s 16 cells', () => {
    const t = truth.find((x) => x.pieces.length > 1)!;
    const r = regionAt(t)!;
    expect(r.kind).toBe('patch');
    const m = result.matches.find((x) => x.regionId === r.id)!;
    expect(m.status).toBe('confident');
    const want = t.pieces.map((i) => cellKey({ row: Math.floor(i / 3), col: i % 3 })).sort();
    expect((m.coveredCells ?? []).map(cellKey).sort()).toEqual(want);
  });

  it('places the loose pieces in the holes and links them to the block', () => {
    const block = regionAt(truth.find((x) => x.pieces.length > 1)!)!;
    for (const t of truth.filter((x) => x.pieces.length === 1)) {
      const r = regionAt(t)!;
      const m = result.matches.find((x) => x.regionId === r.id)!;
      expect(m.candidates[0]).toMatchObject({ row: t.row, col: t.col });
      expect(result.fits.some((h) => (h.a === r.id && h.b === block.id) || (h.a === block.id && h.b === r.id))).toBe(true);
    }
  });
});
