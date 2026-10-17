/**
 * Working image for box detection: a fast downscale of the photo plus its gradient field, and the
 * soft "edge support" measure used to score straight lines and quad sides.
 */
import { rgbaToGray } from '../../cv/color';
import { sobel } from '../../cv/filter';
import type { Point } from '../../cv/geometry';
import { createRGBA, type GrayImage, type RGBAImage } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';

export interface WorkImage {
  /** Downscaled photo. */
  rgba: RGBAImage;
  gray: GrayImage;
  /** Edge coordinate scale working/photo per axis: x_work_edge = x_photo_edge · sx. */
  sx: number;
  sy: number;
}

/**
 * Integer-factor box downscale (exact area average of k×k blocks); much faster than the general
 * resampler for the large first step from camera resolution.
 */
function blockDownscale(img: RGBAImage, k: number): RGBAImage {
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
  const out = createRGBA(w, h);
  const src = img.data, dst = out.data;
  const W = img.width;
  const acc = new Uint32Array(w * 3);
  const inv = 1 / (k * k);
  // Read whole pixels as 32-bit words when the buffer is aligned (one load instead of three).
  const aligned = src.byteOffset % 4 === 0;
  const src32 = aligned ? new Uint32Array(src.buffer, src.byteOffset, img.width * img.height) : null;
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let dy = 0; dy < k; dy++) {
      if (src32 && little) {
        let p = (y * k + dy) * W;
        for (let x = 0, a = 0; x < w; x++, a += 3) {
          let r = 0, g = 0, b = 0;
          for (let dx = 0; dx < k; dx++) {
            const v = src32[p++];
            r += v & 255;
            g += (v >>> 8) & 255;
            b += (v >>> 16) & 255;
          }
          acc[a] += r;
          acc[a + 1] += g;
          acc[a + 2] += b;
        }
        continue;
      }
      let p = ((y * k + dy) * W) * 4;
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dx = 0; dx < k; dx++, p += 4) {
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
        }
        acc[x * 3] += r;
        acc[x * 3 + 1] += g;
        acc[x * 3 + 2] += b;
      }
    }
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      dst[o] = acc[x * 3] * inv;
      dst[o + 1] = acc[x * 3 + 1] * inv;
      dst[o + 2] = acc[x * 3 + 2] * inv;
      dst[o + 3] = 255;
    }
  }
  return out;
}

/** Downscale so the longer side is about `target` px (never upscales). */
export function makeWorkImage(photo: RGBAImage, target: number): WorkImage {
  const long = Math.max(photo.width, photo.height);
  let img = photo;
  let sx = 1, sy = 1;
  const k = Math.floor(long / target);
  if (k >= 2) {
    img = blockDownscale(photo, k);
    sx = sy = 1 / k;
  }
  const l2 = Math.max(img.width, img.height);
  if (l2 > target * 1.15) {
    const f = target / l2;
    const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
    sx *= w / img.width;
    sy *= h / img.height;
    img = resizeRGBA(img, w, h);
  }
  return { rgba: img, gray: rgbaToGray(img), sx, sy };
}

/** Working (pixel-centre) coordinates → photo coordinates. */
export function toPhoto(w: WorkImage, p: Point): Point {
  return { x: (p.x + 0.5) / w.sx - 0.5, y: (p.y + 0.5) / w.sy - 0.5 };
}

/** Photo coordinates → working coordinates. */
export function toWork(w: WorkImage, p: Point): Point {
  return { x: (p.x + 0.5) * w.sx - 0.5, y: (p.y + 0.5) * w.sy - 0.5 };
}

export interface GradientField {
  width: number;
  height: number;
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
  /** Soft-threshold range for the normal gradient component (Sobel units). */
  lo: number;
  hi: number;
}

/** cos(25°): gradient direction must lie within 25° of the tested normal. */
const COS_TOL = 0.906;

/** Sobel gradient field of the working image with noise-adaptive support thresholds. */
export function makeGradientField(gray: GrayImage): GradientField {
  const { gx, gy, magnitude } = sobel(gray);
  const mag = magnitude.data;
  // Robust noise level: median gradient magnitude over a sparse sample.
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(mag.length / 20000));
  for (let i = 0; i < mag.length; i += step) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const med = sample[Math.floor(sample.length / 2)] ?? 0;
  const lo = Math.max(10, Math.min(40, 1.5 * med));
  return { width: gray.width, height: gray.height, gx: gx.data, gy: gy.data, mag, lo, hi: lo * 3 };
}

/**
 * Soft edge support (0..1) at the pixel nearest to (x, y) for an edge with unit normal (nx, ny):
 * the gradient must be aligned with the normal; strength ramps from `lo` to `hi`.
 */
export function supportAt(f: GradientField, x: number, y: number, nx: number, ny: number): number {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= f.width || yi >= f.height) return 0;
  const i = yi * f.width + xi;
  const gx = f.gx[i], gy = f.gy[i];
  const proj = Math.abs(gx * nx + gy * ny);
  if (proj < f.lo || proj < COS_TOL * f.mag[i]) return 0;
  return Math.min(1, (proj - f.lo) / (f.hi - f.lo));
}

/** Max of {@link supportAt} over normal offsets −r..r (1 px steps). */
export function supportNear(f: GradientField, x: number, y: number, nx: number, ny: number, r: number): number {
  let best = 0;
  for (let o = -r; o <= r; o++) {
    const v = supportAt(f, x + o * nx, y + o * ny, nx, ny);
    if (v > best) {
      best = v;
      if (best >= 1) break;
    }
  }
  return best;
}
