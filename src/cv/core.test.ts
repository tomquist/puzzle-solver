import { describe, expect, it } from 'vitest';
import { labToRgba, rgbaToGray, rgbaToLab } from './color';
import { gaussianBlurGray, sobel } from './filter';
import { applyMat3, findHomography, findSimilarity, mat3Invert, mat3Multiply, orderQuad, rotation, similarityAbout } from './geometry';
import { createGray, createMask, createRGBA, maskArea } from './image';
import { fillPolygon } from './raster';
import { resizeRGBA } from './resize';
import { rectifyQuad, sampleRGBA, warpRGBA } from './warp';
import { loadTestAsset } from '../testing/nodeImageIO';

describe('color', () => {
  it('round-trips Lab', () => {
    const img = createRGBA(3, 1);
    img.data.set([255, 0, 0, 255, 10, 200, 30, 255, 128, 128, 128, 255]);
    const back = labToRgba(rgbaToLab(img));
    for (let i = 0; i < img.data.length; i++) expect(Math.abs(back.data[i] - img.data[i])).toBeLessThanOrEqual(1);
  });
  it('computes luma', () => {
    const img = createRGBA(1, 1, [255, 255, 255, 255]);
    expect(rgbaToGray(img).data[0]).toBeCloseTo(255, 3);
  });
});

describe('filters', () => {
  it('blur preserves mean and sobel finds a vertical edge', () => {
    const g = createGray(20, 10);
    for (let y = 0; y < 10; y++) for (let x = 10; x < 20; x++) g.data[y * 20 + x] = 100;
    const b = gaussianBlurGray(g, 1.5);
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    expect(sum(b.data)).toBeCloseTo(sum(g.data), 0);
    const { gx, gy } = sobel(g);
    expect(gx.data[5 * 20 + 9]).toBeGreaterThan(0);
    expect(Math.abs(gy.data[5 * 20 + 9])).toBeLessThan(1e-6);
  });
});

describe('geometry', () => {
  it('recovers a homography from 4 and from many points', () => {
    const H = [1.2, 0.1, 30, -0.05, 0.9, 12, 0.0004, -0.0002, 1];
    const src = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 },
      { x: 50, y: 40 }, { x: 20, y: 70 }, { x: 77, y: 13 },
    ];
    const dst = src.map((p) => applyMat3(H, p));
    for (const n of [4, 7]) {
      const est = findHomography(src.slice(0, n), dst.slice(0, n))!;
      for (const p of src) {
        const a = applyMat3(H, p), b = applyMat3(est, p);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
      }
    }
  });
  it('inverts matrices', () => {
    const m = similarityAbout({ x: 3, y: 4 }, { x: 10, y: -2 }, 0.7, 1.5);
    const id = mat3Multiply(m, mat3Invert(m));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(id[i]).toBeCloseTo(v, 9));
  });
  it('positive rotation is clockwise on screen (y down)', () => {
    // Rotating the "right" vector by +90° must point "down" (positive y).
    const p = applyMat3(rotation(Math.PI / 2), { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
  });
  it('estimates similarity transforms', () => {
    const m = similarityAbout({ x: 0, y: 0 }, { x: 5, y: 7 }, 0.3, 2);
    const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 9 }];
    const est = findSimilarity(src, src.map((p) => applyMat3(m, p)))!;
    expect(est.theta).toBeCloseTo(0.3, 6);
    expect(est.scale).toBeCloseTo(2, 6);
  });
  it('orders quads TL, TR, BR, BL', () => {
    const q = orderQuad([{ x: 90, y: 95 }, { x: 5, y: 3 }, { x: 10, y: 100 }, { x: 100, y: 0 }]);
    expect(q.map((p) => [p.x, p.y])).toEqual([[5, 3], [100, 0], [90, 95], [10, 100]]);
  });
});

describe('resize / warp / raster', () => {
  it('area-downsamples and warps a real image consistently', () => {
    const img = loadTestAsset('starry-night');
    const small = resizeRGBA(img, 320, 254);
    expect(small.width).toBe(320);
    // Identity warp reproduces the image.
    const same = warpRGBA(small, [1, 0, 0, 0, 1, 0, 0, 0, 1], small.width, small.height);
    let diff = 0;
    for (let i = 0; i < same.data.length; i++) diff = Math.max(diff, Math.abs(same.data[i] - small.data[i]));
    expect(diff).toBeLessThanOrEqual(1);
  });
  it('rectifies an axis-aligned quad to a crop', () => {
    const img = createRGBA(40, 30);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) img.data.set([x * 6, y * 8, 0, 255], (y * 40 + x) * 4);
    // Region covering pixels x 10..29, y 5..24 (outer edges at -0.5 offsets).
    const out = rectifyQuad(img, [{ x: 9.5, y: 4.5 }, { x: 29.5, y: 4.5 }, { x: 29.5, y: 24.5 }, { x: 9.5, y: 24.5 }], 20, 20, 1);
    const px = [0, 0, 0, 0];
    sampleRGBA(out, 0, 0, px);
    expect(px[0]).toBeCloseTo(60, 0);
    expect(px[1]).toBeCloseTo(40, 0);
  });
  it('fills polygons at pixel centers', () => {
    const m = createMask(10, 10);
    fillPolygon(m, [{ x: 1.5, y: 1.5 }, { x: 5.5, y: 1.5 }, { x: 5.5, y: 4.5 }, { x: 1.5, y: 4.5 }]);
    expect(maskArea(m)).toBe(4 * 3);
  });
});
