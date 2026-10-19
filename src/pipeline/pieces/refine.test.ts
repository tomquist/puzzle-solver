/**
 * Graph-cut outline refinement on a synthetic close-up: a printed piece on light wood with a soft
 * shadow halo that the threshold took in. The cut must trim the halo back to the piece's edge.
 */
import { describe, expect, it } from 'vitest';
import { distanceTransform } from '../../cv/distance';
import { createMask, createRGBA, type Mask, type Rect, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { generateJigsaw, Rng } from '../../testing/synth';
import { refineByGraphCut } from './refine';

const W = 360, H = 360;

/** The piece mask, the photo (piece with a soft shadow down-right on wood) and the halo'd region. */
function closeUp(seed: number): { photo: RGBAImage; piece: Mask; region: Mask } {
  const rng = new Rng(seed);
  const cut = generateJigsaw(3, 3, 600, 600, seed);
  const p = cut.pieces[4];
  const cx = p.outline.reduce((v, q) => v + q.x, 0) / p.outline.length, cy = p.outline.reduce((v, q) => v + q.y, 0) / p.outline.length;
  const a = rng.uniform(0, Math.PI / 2);
  const piece = createMask(W, H);
  fillPolygon(piece, p.outline.map((q) => {
    const dx = (q.x - cx) * 0.8, dy = (q.y - cy) * 0.8;
    return { x: W / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: H / 2 + dx * Math.sin(a) + dy * Math.cos(a) };
  }));
  // Soft shadow: the piece shifted by (6, 5) px, spread over ~6 px, darkening the table by up to 35 %.
  const shifted = createMask(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x >= 6 && y >= 5 && piece.data[(y - 5) * W + x - 6]) shifted.data[y * W + x] = 1;
  const inv = createMask(W, H);
  for (let i = 0; i < W * H; i++) inv.data[i] = shifted.data[i] ? 0 : 1;
  const dist = distanceTransform(inv).data;
  const photo = createRGBA(W, H);
  const region = createMask(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = 4 * i;
      const shade = shifted.data[i] ? 0.65 : 1 - 0.35 * Math.exp(-((dist[i] / 4) ** 2));
      const grain = 6 * Math.sin(y / 3 + Math.sin(x / 40));
      let rgb = [196 + grain, 172 + grain, 140 + grain].map((v) => v * shade);
      if (piece.data[i]) {
        // Print: dark blue and red stripes with a lighter band.
        const s = Math.sin((x * Math.cos(a) + y * Math.sin(a)) / 14);
        rgb = s > 0.5 ? [200, 60, 70] : s > -0.3 ? [40, 60, 120] : [230, 220, 200];
      }
      for (let c = 0; c < 3; c++) photo.data[o + c] = Math.max(0, Math.min(255, rgb[c] + rng.uniform(-4, 4)));
      photo.data[o + 3] = 255;
      // What a threshold takes: the piece and the darker part of the shadow next to it.
      region.data[i] = piece.data[i] || shade < 0.8 ? 1 : 0;
    }
  }
  return { photo, piece, region };
}

function iou(a: Mask, b: Mask, rb: Rect = { x: 0, y: 0, width: a.width, height: a.height }): number {
  let inter = 0, uni = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const bx = x - rb.x, by = y - rb.y;
      const vb = bx >= 0 && by >= 0 && bx < rb.width && by < rb.height ? b.data[by * rb.width + bx] : 0;
      const va = a.data[y * a.width + x];
      if (va && vb) inter++;
      if (va || vb) uni++;
    }
  }
  return inter / uni;
}

function crop(m: Mask, r: Rect): Mask {
  const out = createMask(r.width, r.height);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) out.data[y * r.width + x] = m.data[(y + r.y) * m.width + x + r.x];
  return out;
}

function bounds(m: Mask): Rect {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

describe('refineByGraphCut', () => {
  it('trims a soft shadow halo back to the piece edge', () => {
    for (const seed of [1, 2, 3]) {
      const { photo, piece, region } = closeUp(seed);
      const bb = bounds(region);
      const before = iou(piece, region);
      const r = refineByGraphCut(photo, crop(region, bb), bb, [], { inner: 20, outer: 8, ring: 14 });
      expect(r).not.toBeNull();
      const after = iou(piece, r!.mask, r!.rect);
      expect(before).toBeLessThan(0.88);
      expect(after).toBeGreaterThan(0.95);
    }
  });

  it('gives a similar outline when the first cut runs at a reduced scale', () => {
    const { photo, piece, region } = closeUp(4);
    const bb = bounds(region);
    const r = refineByGraphCut(photo, crop(region, bb), bb, [], { inner: 20, outer: 8, ring: 14, scale: 3 });
    expect(iou(piece, r!.mask, r!.rect)).toBeGreaterThan(0.94);
  });

  it('never gives pixels of other regions to the refined one', () => {
    const { photo, region } = closeUp(5);
    const bb = bounds(region);
    // Another region overlapping the window on the right: a 30 px strip next to the bounding box.
    const other = { bbox: { x: bb.x + bb.width - 10, y: bb.y, width: 30, height: bb.height }, mask: createMask(30, bb.height) };
    other.mask.data.fill(1);
    const r = refineByGraphCut(photo, crop(region, bb), bb, [other], { inner: 20, outer: 12, ring: 14 })!;
    let overlap = 0;
    for (let y = 0; y < r.rect.height; y++) {
      for (let x = 0; x < r.rect.width; x++) {
        const X = x + r.rect.x, Y = y + r.rect.y;
        const inOther = X >= other.bbox.x && X < other.bbox.x + 30 && Y >= other.bbox.y && Y < other.bbox.y + bb.height;
        const inRegion = region.data[Y * W + X];
        if (r.mask.data[y * r.rect.width + x] && inOther && !inRegion) overlap++;
      }
    }
    expect(overlap).toBe(0);
  });

  it('returns null when the window holds too little table', () => {
    const { photo } = closeUp(6);
    const full = createMask(W, H);
    full.data.fill(1);
    expect(refineByGraphCut(photo, full, { x: 0, y: 0, width: W, height: H }, [], { inner: 10, outer: 4, ring: 6 })).toBeNull();
  });
});
