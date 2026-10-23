/**
 * The table in shade between pieces lying close (background.ts tableShade) and the pixels around
 * the cuts of a split given out again with it carved out (segment.ts shadeGaps, reownCuts).
 */
import { describe, expect, it } from 'vitest';
import { rgbToLab } from '../../cv/color';
import { createMask, createRGBA, type Mask } from '../../cv/image';
import { tableShade } from './background';
import { reownCuts, shadeGaps } from './segment';

/** sRGB value of a linear channel value. */
const toSrgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
const toLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
/** An sRGB colour with every linear channel scaled by `k` (the same surface under less light). */
const dimmed = (rgb: number[], k: number) => rgb.map((c) => toSrgb(k * toLinear(c)));

/** A flat table model of colour `rgb` over a w × h photo. */
function flatModel(rgb: number[], w: number, h: number) {
  const [L, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return { coefficients: [[L, 0, 0, 0, 0, 0], [a, 0, 0, 0, 0, 0], [b, 0, 0, 0, 0, 0]] as [number[], number[], number[]], width: w, height: h };
}

/** Mask of the rectangles [x0, y0, x1, y1] (inclusive). */
function rects(w: number, h: number, ...rs: number[][]): Mask {
  const m = createMask(w, h);
  for (const [x0, y0, x1, y1] of rs) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.data[y * w + x] = 1;
  return m;
}

describe('tableShade', () => {
  const table = [170, 182, 205];
  const W = 8, H = 1;
  // One pixel each: the table, the table at 0.42 of its light (L*+16 ratio ≈ 0.75), at 0.08 (≈ 0.43:
  // dark print), a grey and an orange of the shaded table's lightness, and the shaded table again
  // outside `within`.
  const shaded = dimmed(table, 0.42);
  const [Ls] = rgbToLab(shaded[0], shaded[1], shaded[2]);
  const grey = [0, 1, 2].map(() => toSrgb(Math.pow((Ls + 16) / 116, 3)));
  const orange = dimmed([230, 150, 90], 0.42);
  const pixels = [table, shaded, dimmed(table, 0.08), grey, orange, shaded, shaded, shaded];
  const photo = createRGBA(W, H);
  pixels.forEach((p, i) => photo.data.set([p[0], p[1], p[2], 255], i * 4));
  const within = createMask(W, H);
  within.data.set([1, 1, 1, 1, 1, 0, 1, 1]);

  it('marks the table under less light, not the table itself, dark print, other colours or pixels outside the mask', () => {
    const s = tableShade(photo, flatModel(table, W, H), within, 0.6, 0.9, 4);
    expect(Array.from(s.data)).toEqual([0, 1, 0, 0, 0, 0, 1, 1]);
  });

  it('follows the lightness range it is given', () => {
    const s = tableShade(photo, flatModel(table, W, H), within, 0.8, 0.9, 4);
    expect(s.data[1]).toBe(0);
  });
});

describe('shadeGaps', () => {
  it('keeps shaded table open to the outside of the part and drops shade enclosed by it', () => {
    const w = 40, h = 30;
    const part = { mask: rects(w, h, [0, 0, w - 1, h - 1]), bbox: { x: 10, y: 5, width: w, height: h } };
    // Photo-sized shade map: a strip from the part's top edge inwards, and an enclosed blob.
    const shade = createMask(100, 60);
    const at = (x: number, y: number) => (shade.data[(y + 5) * 100 + x + 10] = 1);
    for (let y = 0; y < 12; y++) for (let x = 18; x < 21; x++) at(x, y);
    for (let y = 18; y < 23; y++) for (let x = 8; x < 13; x++) at(x, y);
    const g = shadeGaps(part, shade);
    expect(g).not.toBeNull();
    expect(g!.data[5 * w + 19]).toBe(1);
    expect(g!.data[20 * w + 10]).toBe(0);
  });

  it('is null without shade inside the part', () => {
    const part = { mask: rects(20, 20, [0, 0, 19, 19]), bbox: { x: 0, y: 0, width: 20, height: 20 } };
    expect(shadeGaps(part, createMask(40, 40))).toBeNull();
  });
});

describe('reownCuts', () => {
  // Piece A (left) with a narrow knob to the right that reaches piece B; between the knob tip and B
  // the shaded table (shadow-tolerant score: foreground, so the cluster is one). The neck split cut
  // the knob halfway (labels: x ≤ 55 → A, beyond → B).
  const w = 120, h = 60;
  const cluster = rects(w, h, [5, 10, 50, 50], [51, 27, 60, 33], [61, 22, 63, 38], [64, 10, 115, 50]);
  const c = { mask: cluster, bbox: { x: 0, y: 0, width: w, height: h } };
  const labels = new Int32Array(w * h);
  for (let i = 0; i < labels.length; i++) if (cluster.data[i]) labels[i] = i % w <= 55 ? 1 : 2;
  const gap = rects(w, h, [61, 22, 63, 38]);

  it('gives a knob tip cut off by the neck split back to its own piece around the shaded gap', () => {
    const re = reownCuts(c, labels, 2, 5, 40, gap);
    expect(re).not.toBeNull();
    for (let y = 27; y <= 33; y++) for (let x = 51; x <= 60; x++) expect(re![y * w + x]).toBe(1);
    // The pieces' bodies keep their labels.
    for (const [x, y] of [[10, 15], [45, 45], [70, 15], [110, 45]]) expect(re![y * w + x]).toBe(labels[y * w + x]);
  });

  it('leaves pixels beyond reach of the shaded gap as they are', () => {
    // The far end of piece B labelled as A (as another cut might have left it): a flood from the
    // cores over the whole cluster would give it to B, but it lies beyond reach of the gap.
    const far = new Int32Array(labels);
    for (let y = 10; y <= 50; y++) for (let x = 108; x <= 115; x++) far[y * w + x] = 1;
    const re = reownCuts(c, far, 2, 5, 40, gap);
    expect(re).not.toBeNull();
    for (let y = 10; y <= 50; y++) for (let x = 108; x <= 115; x++) expect(re![y * w + x]).toBe(1);
    for (let y = 27; y <= 33; y++) for (let x = 51; x <= 60; x++) expect(re![y * w + x]).toBe(1);
  });

  it('changes nothing without shade near a cut', () => {
    expect(reownCuts(c, labels, 2, 5, 40, createMask(w, h))).toBeNull();
    // Shade at the far end of piece B, open to the outside but beyond reach of the cut.
    expect(reownCuts(c, labels, 2, 5, 40, rects(w, h, [113, 20, 115, 30]))).toBeNull();
  });

  it('is null when a label keeps no core', () => {
    const thin = new Int32Array(labels);
    for (let i = 0; i < thin.length; i++) if (thin[i] === 2 && i % w < 64) thin[i] = 3;
    expect(reownCuts(c, thin, 3, 5, 40, gap)).toBeNull();
  });
});
