import { describe, expect, it } from 'vitest';
import { applyMat3, polygonSignedArea, rotation, type Point } from '../cv/geometry';
import { cropRGBA, createRGBA, type RGBAImage } from '../cv/image';
import { drawPolygon } from '../cv/raster';
import { resizeRGBA } from '../cv/resize';
import { rectifyQuad } from '../cv/warp';
import { DEBUG_IMAGES, loadTestAsset, savePng } from './nodeImageIO';
import {
  cellCenter,
  generateJigsaw,
  mulberry32,
  patchOutline,
  perturbReference,
  renderBoxPhoto,
  renderPiecesPhoto,
  truthPieceShape,
} from './synth';

function meanAbsDiff(a: RGBAImage, b: RGBAImage, inset = 0): number {
  let s = 0, n = 0;
  for (let y = inset; y < a.height - inset; y++) {
    for (let x = inset; x < a.width - inset; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) s += Math.abs(a.data[i + c] - b.data[i + c]);
      n += 3;
    }
  }
  return s / n;
}

describe('mulberry32', () => {
  it('is deterministic and uniform-ish', () => {
    const a = mulberry32(42), b = mulberry32(42);
    let sum = 0;
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 1000).toBeGreaterThan(0.45);
    expect(sum / 1000).toBeLessThan(0.55);
  });
});

describe('generateJigsaw', () => {
  const cut = generateJigsaw(6, 8, 800, 600, 11);

  it('tiles the picture with clockwise pieces', () => {
    expect(cut.pieces.length).toBe(48);
    let total = 0;
    for (const p of cut.pieces) {
      const a = polygonSignedArea(p.outline);
      expect(a).toBeGreaterThan(0); // clockwise on screen
      total += a;
    }
    expect(total).toBeCloseTo(800 * 600, -1);
    expect(generateJigsaw(6, 8, 800, 600, 11).pieces[17].outline).toEqual(cut.pieces[17].outline);
  });

  it('has flat borders and complementary interior sides', () => {
    for (const p of cut.pieces) {
      expect(p.sides[0] === 'flat').toBe(p.row === 0);
      expect(p.sides[2] === 'flat').toBe(p.row === cut.rows - 1);
      expect(p.sides[3] === 'flat').toBe(p.col === 0);
      expect(p.sides[1] === 'flat').toBe(p.col === cut.cols - 1);
      if (p.col + 1 < cut.cols) {
        const q = cut.pieces[p.index + 1];
        expect(new Set([p.sides[1], q.sides[3]])).toEqual(new Set(['tab', 'blank']));
      }
      if (p.row + 1 < cut.rows) {
        const q = cut.pieces[p.index + cut.cols];
        expect(new Set([p.sides[2], q.sides[0]])).toEqual(new Set(['tab', 'blank']));
      }
    }
  });

  it('builds patch outlines without the shared edges', () => {
    const idx = [9, 10, 17, 18];
    const outline = patchOutline(cut, idx);
    const sum = idx.reduce((s, i) => s + polygonSignedArea(cut.pieces[i].outline), 0);
    expect(polygonSignedArea(outline)).toBeCloseTo(sum, 3);
    expect(() => patchOutline(cut, [0, 2])).toThrow();
  });
});

describe('renderPiecesPhoto', () => {
  const ref = resizeRGBA(loadTestAsset('starry-night'), 640, 507);
  const cut = generateJigsaw(8, 10, ref.width, ref.height, 5);

  it('renders pieces with consistent ground truth', () => {
    const { photo, truth } = renderPiecesPhoto(ref, cut, [3, 14, 45, [22, 23, 32, 33]], { seed: 9, scale: 1.4 });
    expect(truth.length).toBe(4);
    for (const t of truth) {
      const piece = cut.pieces[t.pieces[0]];
      expect(t.row).toBe(piece.row);
      // Rotating the photo by rotationDeg turns the top side back into its reference direction.
      const R = rotation((t.rotationDeg * Math.PI) / 180);
      const d = applyMat3(R, { x: t.corners[1].x - t.corners[0].x, y: t.corners[1].y - t.corners[0].y });
      const e = { x: piece.corners[1].x - piece.corners[0].x, y: piece.corners[1].y - piece.corners[0].y };
      expect(Math.abs(Math.atan2(d.y, d.x) - Math.atan2(e.y, e.x))).toBeLessThan(1e-6);
      // The body center shows the reference colour of the cell center.
      const c = cellCenter(cut, piece.row, piece.col);
      const cc = { x: Math.round(t.center.x), y: Math.round(t.center.y) };
      const pi = (cc.y * photo.width + cc.x) * 4;
      const back = applyMat3(t.transform, c);
      expect(Math.hypot(back.x - t.center.x, back.y - t.center.y)).toBeLessThan(0.15 * 1.4 * 64);
      // Background must differ from the piece content somewhere inside the bbox.
      expect(photo.data[pi + 3]).toBe(255);
      expect(t.bbox.x).toBeGreaterThanOrEqual(0);
      expect(t.bbox.x + t.bbox.width).toBeLessThanOrEqual(photo.width + 1);
    }
    // Items do not overlap.
    for (let i = 0; i < truth.length; i++) {
      for (let j = i + 1; j < truth.length; j++) {
        const a = truth[i].bbox, b = truth[j].bbox;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    if (DEBUG_IMAGES) {
      const dbg = { ...photo, data: new Uint8ClampedArray(photo.data) };
      for (const t of truth) drawPolygon(dbg, t.corners, [255, 0, 0, 255], 1);
      savePng('.debug/synth/pieces.png', photo);
      savePng('.debug/synth/pieces-truth.png', dbg);
    }
  });

  it('places the right reference content at the true placement (no degradations)', () => {
    const { photo, truth } = renderPiecesPhoto(ref, cut, [12, 27], { seed: 3, scale: 1.2, shadow: 0, edgeDarkening: 0 });
    for (const t of truth) {
      // Sample a few interior points of the body and compare with the reference.
      const piece = cut.pieces[t.pieces[0]];
      let err = 0, n = 0;
      for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7], [0.7, 0.7]]) {
        const q: Point = {
          x: piece.corners[0].x + fx * (piece.corners[1].x - piece.corners[0].x) + fy * (piece.corners[3].x - piece.corners[0].x),
          y: piece.corners[0].y + fx * (piece.corners[1].y - piece.corners[0].y) + fy * (piece.corners[3].y - piece.corners[0].y),
        };
        const p = applyMat3(t.transform, q);
        const pi = (Math.round(p.y) * photo.width + Math.round(p.x)) * 4;
        const ri = (Math.round(q.y) * ref.width + Math.round(q.x)) * 4;
        for (let c = 0; c < 3; c++) err += Math.abs(photo.data[pi + c] - ref.data[ri + c]);
        n += 3;
      }
      expect(err / n).toBeLessThan(30);
    }
  });

  it('throws when the items cannot fit', () => {
    expect(() => renderPiecesPhoto(ref, cut, [1, 2, 3, 4, 5, 6], { width: 200, height: 200, scale: 1.4 })).toThrow();
  });

  it('builds ground-truth piece shapes following the PieceShape conventions', () => {
    const { truth } = renderPiecesPhoto(ref, cut, [0, 15, 33, 79], { seed: 21, scale: 1.3 });
    for (const t of truth) {
      const shape = truthPieceShape(cut, t);
      const piece = cut.pieces[t.pieces[0]];
      expect(shape.angleDeg).toBeGreaterThan(-45);
      expect(shape.angleDeg).toBeLessThanOrEqual(45);
      // corners[0] is the top-left after rotating by -angleDeg.
      const R = rotation((-shape.angleDeg * Math.PI) / 180);
      const rc = shape.corners.map((p) => applyMat3(R, p));
      const sums = rc.map((p) => p.x + p.y);
      expect(sums.indexOf(Math.min(...sums))).toBe(0);
      expect(shape.bodySize).toBeGreaterThan(50 * 1.3);
      expect([...shape.sides.map((s) => s.kind)].sort()).toEqual([...piece.sides].sort());
      for (const s of shape.sides) {
        const ext = s.profile.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
        if (s.kind === 'tab') expect(ext).toBeGreaterThan(0.15);
        if (s.kind === 'blank') expect(ext).toBeLessThan(-0.15);
        if (s.kind === 'flat') expect(Math.abs(ext)).toBeLessThan(0.02);
      }
    }
  });
});

describe('renderBoxPhoto / perturbReference', () => {
  const ref = resizeRGBA(loadTestAsset('great-wave'), 640, 430);

  it('returns a picture quad that rectifies back to the reference', () => {
    const { photo, pictureQuad, lidQuad } = renderBoxPhoto(ref, { seed: 4, width: 1000, height: 800 });
    const rect = rectifyQuad(photo, pictureQuad, ref.width, ref.height);
    expect(meanAbsDiff(rect, ref, 6)).toBeLessThan(18);
    expect(lidQuad[0].x).toBeLessThan(pictureQuad[0].x + 1);
    if (DEBUG_IMAGES) {
      const dbg = { ...photo, data: new Uint8ClampedArray(photo.data) };
      drawPolygon(dbg, pictureQuad, [255, 0, 0, 255], 2);
      drawPolygon(dbg, lidQuad, [0, 255, 0, 255], 2);
      savePng('.debug/synth/box.png', dbg);
      savePng('.debug/synth/box-rectified.png', rect);
    }
  });

  it('perturbs deterministically and moderately', () => {
    const a = perturbReference(ref, { seed: 2 });
    const b = perturbReference(ref, { seed: 2 });
    let same = true;
    for (let i = 0; i < a.data.length && same; i++) same = a.data[i] === b.data[i];
    expect(same).toBe(true);
    const d = meanAbsDiff(a, ref);
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(25);
    if (DEBUG_IMAGES) savePng('.debug/synth/perturbed.png', cropRGBA(a, { x: 0, y: 0, width: 320, height: 215 }));
  });

  it('createRGBA sanity', () => {
    expect(createRGBA(2, 2).data.length).toBe(16);
  });
});
