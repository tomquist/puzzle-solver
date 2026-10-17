import { describe, expect, it } from 'vitest';
import { createRGBA, type RGBAImage } from '../cv/image';
import type { PuzzleSide } from '../model/types';
import { createMockPipeline } from './mockPipeline';

function noise(w: number, h: number, seed = 1): RGBAImage {
  const img = createRGBA(w, h);
  let s = seed;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) >>> 0;
    img.data[i] = s & 255;
    img.data[i + 1] = (s >> 8) & 255;
    img.data[i + 2] = (s >> 16) & 255;
    img.data[i + 3] = 255;
  }
  return img;
}

const SIDES: PuzzleSide[] = ['top', 'right', 'bottom', 'left'];

describe('mock pipeline', () => {
  const pipeline = createMockPipeline({ delayScale: 0 });

  it('detects a box quad with candidates and rectifies to the suggested size', async () => {
    const photo = noise(400, 300);
    const det = await pipeline.detectBox(photo);
    expect(det.candidates.length).toBe(3);
    const size = await pipeline.suggestRectifiedSize(det.quad, 1.5);
    expect(size.width / size.height).toBeCloseTo(1.5, 1);
    const ref = await pipeline.rectify(photo, det.quad, size.width, size.height);
    expect([ref.width, ref.height]).toEqual([size.width, size.height]);
  });

  it('requires loadReference before analyzeScan', async () => {
    await expect(pipeline.analyzeScan('missing', noise(100, 80))).rejects.toThrow();
  });

  it('produces results that follow the model conventions', async () => {
    const grid = { rows: 20, cols: 30 };
    await pipeline.loadReference('p', createRGBA(900, 600, [200, 200, 200, 255]), grid, 'grid');
    expect(await pipeline.hasReference('p')).toBe(true);
    const stages: string[] = [];
    const { result, analysedImage } = await pipeline.analyzeScan('p', noise(1200, 900), { maxSide: 1000 }, (e) => stages.push(e.stage));
    expect(analysedImage.width).toBe(1000);
    expect(result.width).toBe(1000);
    expect(stages).toContain('match');
    expect(stages[stages.length - 1]).toBe('done');
    expect(result.regions.map((r) => r.id)).toEqual(result.regions.map((_, i) => i + 1));
    expect(result.regions.some((r) => r.kind === 'patch')).toBe(true);
    for (const r of result.regions) {
      const m = result.matches.find((x) => x.regionId === r.id)!;
      expect(m).toBeDefined();
      // Contours are clockwise on screen (positive shoelace area with y down).
      let a = 0;
      for (let i = 0, j = r.contour.length - 1; i < r.contour.length; j = i++) a += r.contour[j].x * r.contour[i].y - r.contour[i].x * r.contour[j].y;
      expect(a).toBeGreaterThan(0);
      for (const c of m.candidates) {
        expect(c.row).toBeGreaterThanOrEqual(0);
        expect(c.row).toBeLessThan(grid.rows);
        expect(c.col).toBeGreaterThanOrEqual(0);
        expect(c.col).toBeLessThan(grid.cols);
        expect(c.rotationDeg).toBeGreaterThanOrEqual(0);
        expect(c.rotationDeg).toBeLessThan(360);
      }
      // Edge pieces: after rotating by rotationDeg, the flat side faces the border of its cell.
      if (r.shape?.kind === 'edge' && m.candidates[0]) {
        const best = m.candidates[0];
        const k = (((Math.round((r.shape.angleDeg + best.rotationDeg) / 90) % 4) + 4) % 4);
        const flat = r.shape.sides.findIndex((s) => s.kind === 'flat');
        const side = SIDES[(flat + k) % 4];
        const onBorder =
          (side === 'top' && best.row === 0) ||
          (side === 'bottom' && best.row === grid.rows - 1) ||
          (side === 'left' && best.col === 0) ||
          (side === 'right' && best.col === grid.cols - 1);
        expect(onBorder).toBe(true);
      }
    }
    for (const f of result.fits) {
      expect(result.regions.some((r) => r.id === f.a)).toBe(true);
      expect(result.regions.some((r) => r.id === f.b)).toBe(true);
    }
  });

  it('assesses frames: dark frames are not ok', async () => {
    const dark = createRGBA(64, 48, [5, 5, 5, 255]);
    const q = await pipeline.assessFrame(dark);
    expect(q.ok).toBe(false);
    expect(q.message).toBe('Too dark');
    const sharp = await pipeline.assessFrame(noise(64, 48));
    expect(sharp.sharpness).toBeGreaterThan(0.5);
  });
});
