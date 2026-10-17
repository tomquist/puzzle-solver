import type { Point } from './geometry';
import type { Mask, RGBAImage } from './image';

/**
 * Rasterize a closed polygon into `mask` (sets covered pixels to `value`). A pixel is covered when
 * its center (integer coordinates) lies inside the polygon (even-odd rule).
 */
export function fillPolygon(mask: Mask, pts: Point[], value = 1): void {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.ceil(minY));
  const y1 = Math.min(mask.height - 1, Math.floor(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(mask.width - 1, Math.floor(xs[k + 1]));
      const row = y * mask.width;
      for (let x = xa; x <= xb; x++) mask.data[row + x] = value;
    }
  }
}

/** Draw a line segment (debug overlays). Color is RGBA 0..255; thickness in pixels. */
export function drawLine(img: RGBAImage, a: Point, b: Point, color: [number, number, number, number], thickness = 1): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len * 2));
  const r = Math.max(0, (thickness - 1) / 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = a.x + (b.x - a.x) * t;
    const cy = a.y + (b.y - a.y) * t;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy > r * r + 0.25) continue;
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const o = (y * img.width + x) * 4;
        img.data[o] = color[0];
        img.data[o + 1] = color[1];
        img.data[o + 2] = color[2];
        img.data[o + 3] = color[3];
      }
    }
  }
}

/** Draw a closed polyline. */
export function drawPolygon(img: RGBAImage, pts: Point[], color: [number, number, number, number], thickness = 1): void {
  for (let i = 0; i < pts.length; i++) drawLine(img, pts[i], pts[(i + 1) % pts.length], color, thickness);
}
