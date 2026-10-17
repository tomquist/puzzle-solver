import { describe, expect, it } from 'vitest';
import { canny } from './edges';
import type { Point } from './geometry';
import { createGray, createMask, maskArea, maskToRGBA, type GrayImage } from './image';
import { fillPolygon } from './raster';
import { DEBUG_IMAGES, savePng } from '../testing/nodeImageIO';

function rotatedRect(cx: number, cy: number, w: number, h: number, angle: number): Point[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + c * x - s * y, y: cy + s * x + c * y }));
}

/** Gray image with a bright polygon on a dark background plus Gaussian noise. */
function polygonImage(w: number, h: number, poly: Point[], noise: number, seed = 1): GrayImage {
  const m = createMask(w, h);
  fillPolygon(m, poly);
  const g = createGray(w, h);
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < w * h; i++) {
    const n = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    g.data[i] = (m.data[i] ? 190 : 50) + noise * n;
  }
  return g;
}

function distToPolygon(p: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

describe('canny', () => {
  it('finds thin, complete edges of a noisy rotated rectangle and nothing else', () => {
    const w = 160, h = 120;
    const poly = rotatedRect(80, 60, 100, 60, 0.3);
    const img = polygonImage(w, h, poly, 8);
    const e = canny(img, 60, 150, 1.2);
    if (DEBUG_IMAGES) savePng('.debug/cv/canny-rect.png', maskToRGBA(e));
    const pts: Point[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (e.data[y * w + x]) pts.push({ x, y });
    // Every edge pixel is on the outline.
    for (const p of pts) expect(distToPolygon(p, poly)).toBeLessThan(1.6);
    // The outline is covered.
    let covered = 0, samples = 0;
    for (let i = 0; i < 4; i++) {
      const a = poly[i], b = poly[(i + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 2; t < len - 2; t += 1) {
        const q = { x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len };
        samples++;
        if (pts.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < 1.6)) covered++;
      }
    }
    expect(covered / samples).toBeGreaterThan(0.97);
    // Thin: roughly one pixel per unit of outline length (8-connected diagonal steps are shorter).
    expect(pts.length).toBeGreaterThan(0.75 * 320);
    expect(pts.length).toBeLessThan(1.15 * 320);
  });

  it('returns an empty mask for flat or tiny images and honours sigma = 0', () => {
    expect(maskArea(canny(createGray(20, 20, 100), 10, 20))).toBe(0);
    expect(maskArea(canny(createGray(2, 2), 10, 20))).toBe(0);
    const g = createGray(10, 10);
    for (let y = 0; y < 10; y++) for (let x = 5; x < 10; x++) g.data[y * 10 + x] = 100;
    const e = canny(g, 100, 200, 0);
    // A vertical step yields a single-pixel-wide vertical edge (interior rows only).
    for (let y = 1; y < 9; y++) {
      let n = 0;
      for (let x = 0; x < 10; x++) n += e.data[y * 10 + x];
      expect(n).toBe(1);
    }
  });
});
