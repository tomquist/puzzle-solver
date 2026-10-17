/**
 * Core image containers. Everything in `src/cv` and `src/pipeline` is pure TypeScript operating on
 * typed arrays: no DOM, no canvas. That keeps it usable in Web Workers and testable in Node.
 *
 * Coordinate convention: x to the right, y down, origin at the top-left corner of the top-left
 * pixel. Pixel (i, j) covers [i, i+1) x [j, j+1); its center is at (i + 0.5, j + 0.5) but all
 * samplers in this module treat integer coordinates as pixel centers (OpenCV convention), i.e.
 * sampling at (i, j) returns exactly pixel (i, j).
 */

/** 8-bit RGBA, row-major, interleaved. Structurally compatible with the DOM `ImageData`. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Single-channel float image (e.g. luminance 0..255, gradient magnitude, distance map). */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Multi-channel float image, row-major, interleaved (e.g. CIE Lab with channels = 3). */
export interface FloatImage {
  width: number;
  height: number;
  channels: number;
  data: Float32Array;
}

/** Binary mask: 1 = set, 0 = unset. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createRGBA(width: number, height: number, fill?: [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

export function createGray(width: number, height: number, fill = 0): GrayImage {
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function createFloat(width: number, height: number, channels: number): FloatImage {
  return { width, height, channels, data: new Float32Array(width * height * channels) };
}

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function cloneRGBA(img: RGBAImage): RGBAImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function cloneGray(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: new Float32Array(img.data) };
}

export function cloneMask(m: Mask): Mask {
  return { width: m.width, height: m.height, data: new Uint8Array(m.data) };
}

/** Clamp a rectangle to the image bounds (integer coordinates). */
export function clampRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export function cropRGBA(img: RGBAImage, rect: Rect): RGBAImage {
  const r = clampRect(rect, img.width, img.height);
  const out = createRGBA(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4;
    out.data.set(img.data.subarray(src, src + r.width * 4), y * r.width * 4);
  }
  return out;
}

export function cropGray(img: GrayImage, rect: Rect): GrayImage {
  const r = clampRect(rect, img.width, img.height);
  const out = createGray(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = (r.y + y) * img.width + r.x;
    out.data.set(img.data.subarray(src, src + r.width), y * r.width);
  }
  return out;
}

export function cropMask(m: Mask, rect: Rect): Mask {
  const r = clampRect(rect, m.width, m.height);
  const out = createMask(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = (r.y + y) * m.width + r.x;
    out.data.set(m.data.subarray(src, src + r.width), y * r.width);
  }
  return out;
}

export function cropFloat(img: FloatImage, rect: Rect): FloatImage {
  const r = clampRect(rect, img.width, img.height);
  const c = img.channels;
  const out = createFloat(r.width, r.height, c);
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * c;
    out.data.set(img.data.subarray(src, src + r.width * c), y * r.width * c);
  }
  return out;
}

/** Copy `src` into `dst` with its top-left corner at (dx, dy). Out-of-bounds parts are skipped. */
export function blitRGBA(dst: RGBAImage, src: RGBAImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = src.data[s + 3];
    }
  }
}

/** Number of set pixels in a mask. */
export function maskArea(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i] ? 1 : 0;
  return n;
}

/** Tight bounding box of the set pixels, or null when the mask is empty. */
export function maskBounds(m: Mask): Rect | null {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (m.data[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Render a mask as an opaque black/white RGBA image (handy for debugging). */
export function maskToRGBA(m: Mask): RGBAImage {
  const out = createRGBA(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i] ? 255 : 0;
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Render a gray image as RGBA, linearly mapping [min, max] (default: data range) to [0, 255]. */
export function grayToRGBA(g: GrayImage, min?: number, max?: number): RGBAImage {
  let lo = min ?? Infinity, hi = max ?? -Infinity;
  if (min === undefined || max === undefined) {
    for (let i = 0; i < g.data.length; i++) {
      const v = g.data[i];
      if (min === undefined && v < lo) lo = v;
      if (max === undefined && v > hi) hi = v;
    }
  }
  const scale = hi > lo ? 255 / (hi - lo) : 0;
  const out = createRGBA(g.width, g.height);
  for (let i = 0; i < g.data.length; i++) {
    const v = (g.data[i] - lo) * scale;
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}
