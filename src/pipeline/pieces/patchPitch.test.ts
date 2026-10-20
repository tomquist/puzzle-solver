import { describe, expect, it } from 'vitest';
import { createMask, cropRGBA } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, type JigsawCut, type PieceTruth } from '../../testing/synth';
import { estimatePatchPitch } from './patchPitch';

/** Crop and outline mask of one rendered item. */
function itemCrop(photo: Parameters<typeof cropRGBA>[0], t: PieceTruth) {
  const image = cropRGBA(photo, t.bbox);
  const mask = createMask(image.width, image.height);
  fillPolygon(mask, t.outline.map((p) => ({ x: p.x - t.bbox.x, y: p.y - t.bbox.y })), 1);
  let area = 0;
  for (const v of mask.data) area += v;
  return { image, mask, area };
}

/** A 7×7 block at rows 4–10, cols 6–12 with four outline pieces missing (45 pieces). */
function raggedBlock(cut: JigsawCut): number[] {
  const missing = new Set(['4,6', '4,9', '7,12', '10,8']);
  const out: number[] = [];
  for (let r = 4; r <= 10; r++) for (let c = 6; c <= 12; c++) if (!missing.has(`${r},${c}`)) out.push(r * cut.cols + c);
  return out;
}

describe('estimatePatchPitch', () => {
  const ref = loadTestAsset('starry-night');
  const cut = generateJigsaw(16, 20, ref.width, ref.height, 7);
  const cell = (cut.width / cut.cols + cut.height / cut.rows) / 2;

  it('measures the piece size of a large turned block from its seams', () => {
    for (const [rotation, body] of [[32, 70], [205, 100]]) {
      const { photo, truth } = renderPiecesPhoto(ref, cut, [raggedBlock(cut)], { seed: 3, rotation, scale: body / cell, background: [196, 208, 218], noiseSigma: 3, blurSigma: 0.7, supersample: 2 });
      const { image, mask, area } = itemCrop(photo, truth[0]);
      const est = estimatePatchPitch(image, mask, rotation + 1.5)!;
      expect(est, `rotation ${rotation}`).not.toBeNull();
      expect(Math.abs(est.pitch / body - 1), `rotation ${rotation}: pitch ${est.pitch.toFixed(1)} vs ${body}`).toBeLessThan(0.08);
      // Seen as ~45 pieces: a large block (see segment.ts LARGE_BLOCK_PIECES).
      expect(area / est.pitch ** 2).toBeGreaterThan(30);
    }
  });

  it('never makes a single piece look like a large block', () => {
    const items = [0, 21, 47, 66, 93, 118, 155, 170, 203, 250];
    const { photo, truth } = renderPiecesPhoto(ref, cut, items, { seed: 5, scale: 100 / cell, noiseSigma: 3, blurSigma: 0.7 });
    for (const t of truth) {
      const { image, mask, area } = itemCrop(photo, t);
      const est = estimatePatchPitch(image, mask, -t.rotationDeg);
      if (est) expect(area / est.pitch ** 2).toBeLessThan(30);
    }
  });

  it('gives up on regions too small to show a few seams', () => {
    const mask = createMask(20, 20);
    mask.data.fill(1);
    const image = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(128) };
    expect(estimatePatchPitch(image, mask, 0)).toBeNull();
    expect(estimatePatchPitch(image, createMask(20, 20), 0)).toBeNull();
  });
});
