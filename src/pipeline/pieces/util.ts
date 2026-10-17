/** Small numeric helpers shared inside the pieces package. */
import type { Point } from '../../cv/geometry';
import { createGray, createMask, type GrayImage, type Mask, type RGBAImage } from '../../cv/image';

/** Median of a list (0 for an empty list). Does not modify the input. */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values).sort();
  return n % 2 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/** q-quantile (0..1, linear interpolation) of a list (0 for an empty list). */
export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values).sort();
  const pos = Math.max(0, Math.min(n - 1, q * (n - 1)));
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < n ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

/** Translate points by (dx, dy). */
export function offsetPoints(pts: readonly Point[], dx: number, dy: number): Point[] {
  return pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Separable (2r+1)² box filter of the RGB channels (alpha copied), with replicated borders.
 * Running sums, O(1) per pixel independent of r.
 */
export function boxBlurRGB(img: RGBAImage, r: number): RGBAImage {
  const { width: w, height: h, data: src } = img;
  if (r < 1 || w === 0 || h === 0) return img;
  const tmp = new Uint16Array(w * h * 3);
  const n = 2 * r + 1;
  // Horizontal sums.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(row + Math.min(w - 1, Math.max(0, k))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 3 + c] = acc;
        acc += src[(row + Math.min(w - 1, x + r + 1)) * 4 + c] - src[(row + Math.max(0, x - r)) * 4 + c];
      }
    }
  }
  // Vertical sums.
  const out = new Uint8ClampedArray(w * h * 4);
  const norm = 1 / (n * n);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = acc * norm + 0.5;
        acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - r) * w + x) * 3 + c];
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = src[i];
  return { width: w, height: h, data: out };
}

/** 2×2 average downsample of a gray image (odd trailing row/column dropped). */
export function halveGray(img: GrayImage): GrayImage {
  const w = img.width >> 1, h = img.height >> 1, W = img.width, s = img.data;
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * W, r1 = r0 + W;
    for (let x = 0; x < w; x++) out.data[y * w + x] = 0.25 * (s[r0 + 2 * x] + s[r0 + 2 * x + 1] + s[r1 + 2 * x] + s[r1 + 2 * x + 1]);
  }
  return out;
}

/** Nearest-neighbour 2× upsample of a mask to `width` × `height` (replicates the last row/column). */
export function doubleMask(m: Mask, width: number, height: number): Mask {
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(m.height - 1, y >> 1);
    const src = sy * m.width, dst = y * width;
    for (let x = 0; x < width; x++) out.data[dst + x] = m.data[src + Math.min(m.width - 1, x >> 1)];
  }
  return out;
}
