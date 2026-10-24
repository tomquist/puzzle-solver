import { describe, expect, it } from 'vitest';
import { labelComponents } from '../../cv/components';
import { createGray, createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { Rng } from '../../testing/synth';
import { fitBackground } from './background';
import { boxBlurGray } from '../../cv/filter';
import { boxMean, lumaTexture, lumaTextureApplies, lumaTextureForeground, peelFromOutside, separateObjects } from './lumaTexture';

function fillRect(m: Mask, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) m.data.fill(1, y * m.width + x0, y * m.width + x1);
}

function components(m: Mask): number {
  return labelComponents(m, 8).count;
}

function sameComponent(m: Mask, a: [number, number], b: [number, number]): boolean {
  const { labels } = labelComponents(m, 8);
  const la = labels[a[1] * m.width + a[0]], lb = labels[b[1] * m.width + b[0]];
  return la > 0 && la === lb;
}

function union(a: Mask, b: Mask): Mask {
  const out = createMask(a.width, a.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] | b.data[i];
  return out;
}

describe('boxMean', () => {
  it('equals the integral-image box blur, border windows clipped', () => {
    const rng = new Rng(7);
    const img = createGray(37, 23);
    for (let i = 0; i < img.data.length; i++) img.data[i] = rng.uniform(0, 255);
    for (const r of [1, 2, 5, 30]) {
      const a = boxMean(img, r), b = boxBlurGray(img, r);
      for (let i = 0; i < a.data.length; i++) expect(a.data[i]).toBeCloseTo(b.data[i], 3);
    }
  });
});

describe('lumaTextureApplies', () => {
  it('applies on light, neutral, plain tables only', () => {
    const table = (L: number, a: number, b: number, sigmaL: number) => ({ color: [L, a, b] as [number, number, number], sigma: [sigmaL, 1, 1] as [number, number, number] });
    expect(lumaTextureApplies(table(73, 0.5, -1, 1.5))).toBe(true); // grey table
    expect(lumaTextureApplies(table(62, 1, 3, 4.3))).toBe(true); // white board, a little warm
    expect(lumaTextureApplies(table(67, 10, 24, 2.5))).toBe(false); // wood: colour sees grey print
    expect(lumaTextureApplies(table(30, 0, 0, 2))).toBe(false); // dark table
    expect(lumaTextureApplies(table(59, 0, 0.4, 22))).toBe(false); // busy background (a hand, clothes)
  });
});

describe('separateObjects', () => {
  it('cuts texture that would join two objects colour found apart, and keeps what extends them', () => {
    const fg = createMask(120, 60), add = createMask(120, 60);
    fillRect(fg, 10, 10, 50, 50);
    fillRect(fg, 70, 10, 110, 50);
    // Texture fills the 20 px gap and extends the left object upwards.
    fillRect(add, 50, 15, 70, 45);
    fillRect(add, 15, 2, 45, 10);
    expect(components(union(fg, add))).toBe(1);
    separateObjects(add, fg, 1000, 1);
    expect(components(union(fg, add))).toBe(2);
    // The gap is cut by a band at least three pixels wide (a closing of radius 1 cannot bridge it).
    let band = 0;
    for (let x = 50; x < 70; x++) if (!add.data[30 * 120 + x]) band++;
    expect(band).toBeGreaterThanOrEqual(3);
    // Most of the gap texture and all of the extension stay.
    let kept = 0;
    for (let y = 15; y < 45; y++) for (let x = 50; x < 70; x++) kept += add.data[y * 120 + x];
    expect(kept).toBeGreaterThan(0.6 * 20 * 30);
    for (let y = 2; y < 10; y++) for (let x = 15; x < 45; x++) expect(add.data[y * 120 + x]).toBe(1);
  });

  it('joins fragments smaller than an object freely', () => {
    const fg = createMask(120, 60), add = createMask(120, 60);
    fillRect(fg, 10, 20, 25, 35);
    fillRect(fg, 80, 20, 95, 35);
    fillRect(add, 25, 22, 80, 33);
    separateObjects(add, fg, 1000, 1);
    expect(components(union(fg, add))).toBe(1);
  });
});

/**
 * A light grey table (with sensor noise) and pale grey "print" rectangles: brightness blotches of
 * ±`amp` around the table's grey, no chroma (what colour alone cannot tell from the table).
 */
function palePhoto(w: number, h: number, rects: [number, number, number, number][], amp: number, seed: number): RGBAImage {
  const rng = new Rng(seed);
  const img = createRGBA(w, h, [205, 205, 203, 255]);
  const cell = 6;
  const blotch = Float32Array.from({ length: Math.ceil(w / cell) * Math.ceil(h / cell) }, () => rng.uniform(-amp, amp));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
      const v = inside ? blotch[((y / cell) | 0) * Math.ceil(w / cell) + ((x / cell) | 0)] : 0;
      const nz = 1.5 * (rng.random() + rng.random() + rng.random() - 1.5);
      const p = (y * w + x) * 4;
      img.data[p] = 205 + v + nz;
      img.data[p + 1] = 205 + v + nz;
      img.data[p + 2] = 203 + v + nz;
    }
  }
  return img;
}

describe('peelFromOutside', () => {
  it('peels qualifying pixels from the outside in, at most `depth` deep, never across colour or other pixels', () => {
    const fg = createMask(60, 20), add = createMask(60, 20);
    fillRect(fg, 25, 5, 35, 15);
    // A band of texture around the colour object: shade on its left (columns 15–24), print on its right.
    fillRect(add, 15, 5, 25, 15);
    fillRect(add, 35, 5, 45, 15);
    peelFromOutside(add, fg, 3, (i) => i % 60 < 25);
    for (let x = 15; x < 25; x++) expect(add.data[10 * 60 + x]).toBe(x < 18 ? 0 : 1);
    for (let x = 35; x < 45; x++) expect(add.data[10 * 60 + x]).toBe(1);
  });
});

describe('lumaTextureForeground', () => {
  const W = 400, H = 300;
  const rects: [number, number, number, number][] = [[80, 90, 190, 210], [195, 90, 305, 210]];
  const share = (m: Mask, [x0, y0, x1, y1]: [number, number, number, number]) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += m.data[y * W + x];
    return n / ((x1 - x0) * (y1 - y0));
  };

  it('finds pale print colour cannot see, without bridging the 5 px gap between two pieces', () => {
    const photo = palePhoto(W, H, rects, 28, 3);
    const model = fitBackground(photo);
    // Colour found a fragment of each piece.
    const fg = createMask(W, H);
    fillRect(fg, 110, 130, 140, 160);
    fillRect(fg, 240, 130, 270, 160);
    const tex = lumaTextureForeground(lumaTexture(photo), fg, model);
    expect(tex).not.toBeNull();
    for (const r of rects) expect(share(tex!, r)).toBeGreaterThan(0.6);
    // Nothing on the open table.
    expect(share(tex!, [0, 0, W, 60])).toBe(0);
    // Two objects, not one: the gap is not bridged.
    expect(sameComponent(union(fg, tex!), [135, 150], [255, 150])).toBe(false);
  });

  it('does not bridge an 8 px gap by the table carve alone (nothing found by colour)', () => {
    // (Narrower gaps between pieces colour found nothing of stay open only through the colour
    // fragments: the fine flatness window spans ±2 px.)
    const photo = palePhoto(W, H, [rects[0], [198, 90, 305, 210]], 28, 5);
    const tex = lumaTextureForeground(lumaTexture(photo), createMask(W, H), fitBackground(photo));
    expect(tex).not.toBeNull();
    for (const r of rects) expect(share(tex!, r)).toBeGreaterThan(0.5);
    expect(sameComponent(tex!, [135, 150], [255, 150])).toBe(false);
  });

  it('adds nothing on a plain table', () => {
    const photo = palePhoto(W, H, [], 0, 4);
    const tex = lumaTextureForeground(lumaTexture(photo), createMask(W, H), fitBackground(photo));
    expect(tex === null || share(tex, [0, 0, W, H]) === 0).toBe(true);
  });
});
