/**
 * Further table colours (palette): a second surface is learned as table; pieces in one colour lying
 * along the photo border are not, however many of them there are.
 */
import { describe, expect, it } from 'vitest';
import { rgbToLab } from '../../cv/color';
import { createMask, createRGBA, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { generateJigsaw, Rng, type RGB } from '../../testing/synth';
import { fitBackground } from './background';

/**
 * A light grey table with an olive cloth (or a dark mat) over the left quarter, and dark grey
 * piece-shaped blobs (with lighter print streaks) scattered over the table, many of them along
 * and across the photo border.
 */
function scene(opts: { leftSurface: RGB | null; darkPieces: number; seed: number }): RGBAImage {
  const W = 1200, H = 900;
  const img = createRGBA(W, H);
  const rng = new Rng(opts.seed);
  const table: RGB = [168, 170, 174];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const base = opts.leftSurface && x < 0.25 * W ? opts.leftSurface : table;
      const light = 1 + 0.08 * (y / H - 0.5);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = base[c] * light + rng.uniform(-3, 3);
      img.data[o + 3] = 255;
    }
  }
  const cut = generateJigsaw(6, 8, 800, 600, opts.seed);
  const mask = createMask(W, H);
  // Spots along the right, top and bottom border (spaced, half cut off by it), and some inside.
  const spots: { x: number; y: number }[] = [];
  for (let y = 60; y < H; y += 170) spots.push({ x: W - rng.uniform(10, 50), y });
  for (let x = 0.35 * W; x < W - 80; x += 170) spots.push({ x, y: rng.uniform(10, 50) }, { x, y: H - rng.uniform(10, 50) });
  for (let k = 0; k < 8; k++) spots.push({ x: rng.uniform(0.35 * W, 0.85 * W), y: rng.uniform(0.2 * H, 0.8 * H) });
  for (let k = 0; k < Math.min(opts.darkPieces, spots.length); k++) {
    const piece = cut.pieces[k % cut.pieces.length];
    const cx = spots[k].x, cy = spots[k].y;
    const a = rng.uniform(0, 2 * Math.PI), s = 1.1;
    const px = piece.outline.reduce((v, p) => v + p.x, 0) / piece.outline.length, py = piece.outline.reduce((v, p) => v + p.y, 0) / piece.outline.length;
    mask.data.fill(0);
    fillPolygon(mask, piece.outline.map((p) => {
      const dx = (p.x - px) * s, dy = (p.y - py) * s;
      return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
    }));
    const grey = rng.uniform(50, 64);
    for (let i = 0; i < W * H; i++) {
      if (!mask.data[i]) continue;
      const x = i % W, y = (i - x) / W;
      const streak = Math.sin((x + 2 * y) / 9 + k) > 0.85 ? 60 : 0;
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = grey + streak + (c === 2 ? 6 : 0) + rng.uniform(-3, 3);
    }
  }
  return img;
}

function paletteLabs(img: RGBAImage) {
  return fitBackground(img).palette.map((p) => p.color);
}

describe('fitBackground further table colours', () => {
  it('learns an olive cloth as table, but not dark grey pieces lying along the border', () => {
    const olive = rgbToLab(150, 142, 96);
    for (const seed of [1, 2, 3]) {
      const labs = paletteLabs(scene({ leftSurface: [150, 142, 96], darkPieces: 40, seed }));
      expect(labs.some((c) => Math.abs(c[0] - olive[0]) < 12 && Math.hypot(c[1] - olive[1], c[2] - olive[2]) < 8)).toBe(true);
      expect(labs.every((c) => c[0] > 45)).toBe(true);
    }
  });

  it('still learns a dark mat as table (main surface or further colour)', () => {
    for (const seed of [4, 5]) {
      const fit = fitBackground(scene({ leftSurface: [58, 58, 64], darkPieces: 12, seed }));
      const labs = [fit.color, ...fit.palette.map((p) => p.color)];
      expect(labs.some((c) => c[0] < 35)).toBe(true);
      expect(labs.some((c) => c[0] > 60)).toBe(true);
    }
  });
});
