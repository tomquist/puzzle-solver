/**
 * Further table colours (palette): a second surface is learned as table; pieces in one colour lying
 * along the photo border are not, however many of them there are. Assembled patches covering the
 * border band: the board is still the table, their print (a nearly plain grey with cut lines) is
 * no table colour, and the phone's hard-edged shadow on the board stays table while grey pieces as
 * dark as the shadowed board do not.
 */
import { describe, expect, it } from 'vitest';
import { rgbToLab } from '../../cv/color';
import { createMask, createRGBA, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { generateJigsaw, Rng, type RGB } from '../../testing/synth';
import { backgroundAt, fitBackground, foregroundScore } from './background';

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

const TAN: RGB = [196, 160, 112];

/**
 * A tan board (fine noise) with assembled patches of print: a nearly plain grey with some detail
 * and dark cut lines between the pieces, as rectangles along the photo sides (`sides`: which of
 * top, right, bottom, left, each `depth` px deep), plus a few grey and dark loose pieces in the
 * middle. Optionally the phone's hard-edged shadow over the middle (darkening `shadow`).
 */
function boardScene(opts: { sides: boolean[]; depth: number; seed: number; shadow?: number; looseGrey?: RGB }): { img: RGBAImage; looseAt: { x: number; y: number }[] } {
  const W = 900, H = 1200, cell = 70;
  const img = createRGBA(W, H);
  const rng = new Rng(opts.seed);
  // Print detail: value noise on an 8 px grid.
  const gw = Math.ceil(W / 8) + 2, gh = Math.ceil(H / 8) + 2;
  const grid = Float32Array.from({ length: gw * gh }, () => rng.uniform(-1, 1));
  const detail = (x: number, y: number) => {
    const fx = x / 8, fy = y / 8, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const g = (a: number, b: number) => grid[b * gw + a];
    return (g(i, j) * (1 - tx) + g(i + 1, j) * tx) * (1 - ty) + (g(i, j + 1) * (1 - tx) + g(i + 1, j + 1) * tx) * ty;
  };
  const [top, right, bottom, left] = opts.sides;
  const d = opts.depth;
  const inPatch = (x: number, y: number) => (top && y < d) || (bottom && y >= H - d) || (left && x < d) || (right && x >= W - d);
  const loose = [{ x: 0.4 * W, y: 0.35 * H }, { x: 0.6 * W, y: 0.55 * H }, { x: 0.45 * W, y: 0.7 * H }];
  const looseGrey = opts.looseGrey ?? [70, 72, 78];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let c: RGB = TAN;
      if (inPatch(x, y)) {
        const cut = x % cell < 3 || y % cell < 3;
        const g = 118 * (1 + 0.3 * detail(x, y)) * (cut ? 0.5 : 1);
        c = [g, g, g + 3];
      } else if (loose.some((p) => Math.abs(x - p.x) < 45 && Math.abs(y - p.y) < 45)) {
        c = looseGrey;
      }
      const shade = opts.shadow && x > 0.3 * W && x < 0.75 * W && y > 0.3 * H ? 1 - opts.shadow : 1;
      for (let k = 0; k < 3; k++) img.data[o + k] = c[k] * shade + rng.uniform(-3, 3);
      img.data[o + 3] = 255;
    }
  }
  return { img, looseAt: loose };
}

describe('fitBackground with the border band covered by assembled patches', () => {
  const tan = rgbToLab(...TAN);
  const isTan = (c: readonly number[]) => Math.abs(c[0] - tan[0]) < 12 && Math.hypot(c[1] - tan[1], c[2] - tan[2]) < 8;

  it('learns the board as table when patches cover most of the border band', () => {
    for (const seed of [1, 2]) {
      const { img } = boardScene({ sides: [true, true, true, true], depth: 90, seed });
      const fit = fitBackground(img);
      // The board in the middle is the main surface; the grey print is no table colour.
      expect(isTan(backgroundAt(fit, 450, 600))).toBe(true);
      expect(fit.palette.every((p) => Math.hypot(p.color[1], p.color[2]) > 8)).toBe(true);
      const score = foregroundScore(img, fit);
      expect(score.data[600 * 900 + 200]).toBeLessThan(3.5);
      expect(score.data[45 * 900 + 450]).toBeGreaterThan(6);
    }
  });

  it('does not take the grey print of a patch along one side for a further table colour', () => {
    for (const seed of [3, 4]) {
      const { img } = boardScene({ sides: [false, true, true, false], depth: 160, seed });
      const fit = fitBackground(img);
      expect(isTan(fit.color)).toBe(true);
      expect(fit.palette.every((p) => Math.hypot(p.color[1], p.color[2]) > 8)).toBe(true);
    }
  });

  it("follows the phone's hard-edged shadow, but keeps grey pieces as dark as the shadowed board", () => {
    // Grey pieces with the lightness of the shadowed board (L* ≈ 54).
    const { img, looseAt } = boardScene({ sides: [false, false, true, false], depth: 90, seed: 5, shadow: 0.3, looseGrey: [128, 128, 132] });
    const fit = fitBackground(img);
    expect(fit.local).toBeDefined();
    const score = foregroundScore(img, fit);
    const at = (x: number, y: number) => score.data[Math.round(y) * 900 + Math.round(x)];
    // Board in the shadow, beside it and next to its edges.
    for (const [x, y] of [[450, 500], [600, 1000], [100, 600], [800, 300], [450, 300]]) expect(at(x, y)).toBeLessThan(3.5);
    for (const p of looseAt) expect(at(p.x, p.y)).toBeGreaterThan(6);
  });
});

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
