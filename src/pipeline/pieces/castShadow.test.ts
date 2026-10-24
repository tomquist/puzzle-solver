/**
 * Deep cast shadows of pieces lying on a board (castShadow.ts), weak areas fading into the table
 * (smoothWeak.ts) and a dark table colour of mixed shades kept from explaining dark pieces
 * (background.ts findPalette: its lightness spread capped like the light it gets).
 */
import { describe, expect, it } from 'vitest';
import { rgbToLab } from '../../cv/color';
import { createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { fitBackground, foregroundScore, type BackgroundFit } from './background';
import { castShadow } from './castShadow';
import { crispOpenOutline } from './smoothWeak';

const toSrgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
const toLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
/** An sRGB colour with every linear channel scaled by `k` (the same surface under less light). */
const dimmed = (rgb: number[], k: number) => rgb.map((c) => toSrgb(k * toLinear(c)));

/** Deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
}

/** A flat table model of colour `rgb` (Lab sigma 1.5, 1, 1) over a w × h photo. */
function flatFit(rgb: number[], w: number, h: number): BackgroundFit {
  const [L, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return {
    color: [L, a, b],
    coefficients: [[L, 0, 0, 0, 0, 0], [a, 0, 0, 0, 0, 0], [b, 0, 0, 0, 0, 0]],
    sigma: [1.5, 1, 1],
    width: w,
    height: h,
    lightingRatio: 1,
    bandFit: 1,
    palette: [],
  } as BackgroundFit;
}

function fill(photo: RGBAImage, x0: number, y0: number, x1: number, y1: number, rgb: number[]): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) photo.data.set([rgb[0], rgb[1], rgb[2], 255], (y * photo.width + x) * 4);
}

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask {
  const m = createMask(w, h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.data[y * w + x] = 1;
  return m;
}

const board = [128, 104, 84];

describe('castShadow', () => {
  // A 60 px piece at (30, 30) on a brown board; its shadow (the board at 0.2 of its light, L*+16
  // ratio ≈ 0.6) 8 px wide along its top and left, taken into the region.
  const W = 120, H = 120;
  const setup = (piece: number[], shadowOf: number[]) => {
    const photo = createRGBA(W, H);
    fill(photo, 0, 0, W, H, board);
    fill(photo, 22, 22, 90, 90, shadowOf);
    fill(photo, 30, 30, 90, 90, piece);
    return photo;
  };
  const region = rect(W, H, 22, 22, 90, 90);
  const fit = flatFit(board, W, H);

  it('finds the board in deep shadow along a light piece', () => {
    const photo = setup([210, 200, 120], dimmed(board, 0.2));
    const cast = castShadow(region, 0, 0, photo, fit, 10)!;
    expect(cast).not.toBeNull();
    // The shadow band, not the piece.
    expect(cast.shadow[25 * W + 50]).toBe(1);
    expect(cast.shadow[50 * W + 25]).toBe(1);
    expect(cast.shadow[35 * W + 50]).toBe(0);
    expect(cast.count).toBeGreaterThan(0.8 * (68 * 68 - 60 * 60));
    expect(cast.count).toBeLessThan(1.1 * (68 * 68 - 60 * 60));
  });

  it('leaves a dark grey rim of print alone (not the board\'s hue)', () => {
    const grey = dimmed([128, 128, 132], 0.2);
    const photo = setup([210, 200, 120], grey);
    expect(castShadow(region, 0, 0, photo, fit, 10)).toBeNull();
  });

  it('leaves the edge of a dark piece alone where its own print is about as dark', () => {
    // A dark brown piece (the board at 0.12 of its light): its rim, at 0.2, is its print.
    const photo = setup(dimmed(board, 0.12), dimmed(board, 0.2));
    expect(castShadow(region, 0, 0, photo, fit, 10)).toBeNull();
  });
});

describe('crispOpenOutline', () => {
  const W = 120, H = 80;
  const table = [150, 170, 190];
  /** A weak area (cols 20–54) near a piece (cols 60–100) in one region; `crisp`: the area ends at a cut edge, else it fades into the table. */
  const setup = (crisp: boolean) => {
    const photo = createRGBA(W, H);
    const rnd = noise(7);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let k = 0;
        if (x >= 20 && x < 55 && y >= 20 && y < 60) {
          // Distance into the area from its open sides.
          const d = Math.min(x - 20, y - 20, 59 - y);
          k = crisp ? 1 : Math.min(1, d / 15);
        }
        const c = table.map((v) => Math.round(v * (1 - 0.12 * k) + 1.5 * rnd()));
        photo.data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
      }
    }
    fill(photo, 60, 20, 100, 60, [90, 40, 120]);
    const region = rect(W, H, 20, 20, 100, 60);
    const labels = new Int32Array(W * H);
    for (let y = 20; y < 60; y++) for (let x = 20; x < 55; x++) labels[y * W + x] = 1;
    return { photo, region, labels };
  };
  const box = { x: 20, y: 20, width: 35, height: 40 };

  it('finds no crisp edge where a shading fades into the table', () => {
    const { photo, region, labels } = setup(false);
    expect(crispOpenOutline(photo, labels, 1, box, region, 0, 0)!).toBeLessThan(0.03);
  });

  it('finds the cut edge of a pale piece', () => {
    const { photo, region, labels } = setup(true);
    expect(crispOpenOutline(photo, labels, 1, box, region, 0, 0)!).toBeGreaterThan(0.3);
  });
});

describe('findPalette', () => {
  it('does not let a dark colour of mixed shades along the border explain dark grey pieces lighter than it', () => {
    // A brown board; along the left border black and dark grey print in blocks of many shades (the
    // dark pieces of an assembled group), along the bottom loose pieces of such print; in the middle
    // a loose dark grey piece a little lighter than all of them.
    const W = 300, H = 400;
    const photo = createRGBA(W, H);
    const rnd = noise(3);
    const shade = noise(11);
    const blocks = new Map<number, number>();
    const pieceGrey = [55, 55, 60];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // (The bottom strip: loose dark pieces of 40 px with board between them.)
        const dark = x < 70 || (y > 300 && x < 280 && (x - 70) % 52 < 40 && (y - 300) % 52 < 40 && y < 392);
        const piece = x >= 150 && x < 200 && y >= 150 && y < 200;
        const key = (y >> 4) * 64 + (x >> 4);
        if (!blocks.has(key)) blocks.set(key, Math.round(24 + 16 * shade()));
        const g = blocks.get(key)!;
        const base = piece ? pieceGrey : dark ? [g, g, g + 3] : board;
        const c = base.map((v) => Math.max(0, Math.min(255, Math.round(v + 2 * rnd()))));
        photo.data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
      }
    }
    const fit = fitBackground(photo);
    const score = foregroundScore(photo, fit);
    expect(score.data[175 * W + 175]).toBeGreaterThan(6);
    // The board stays table.
    expect(score.data[100 * W + 200]).toBeLessThan(3);
  });
});
