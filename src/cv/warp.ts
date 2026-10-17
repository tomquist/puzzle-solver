import { applyMat3, findHomography, mat3Invert, type Mat3, type Quad } from './geometry';
import { createFloat, createGray, createMask, createRGBA, type FloatImage, type GrayImage, type Mask, type RGBAImage } from './image';

/**
 * Bilinear sample of an RGBA image at (x, y) (integer coordinates = pixel centers).
 * Writes RGBA into `out` and returns false when (x, y) is outside the image (out untouched).
 */
export function sampleRGBA(img: RGBAImage, x: number, y: number, out: Float32Array | number[]): boolean {
  const { width: w, height: h, data } = img;
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return false;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0;
  if (x0 < 0) { x0 = 0; fx = 0; }
  if (y0 < 0) { y0 = 0; fy = 0; }
  if (x0 >= w - 1) { x0 = w - 1; fx = 0; }
  if (y0 >= h - 1) { y0 = h - 1; fy = 0; }
  const x1 = fx > 0 ? x0 + 1 : x0;
  const y1 = fy > 0 ? y0 + 1 : y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  for (let c = 0; c < 4; c++) out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  return true;
}

/** Bilinear sample of a multi-channel float image; returns false when outside. */
export function sampleFloat(img: FloatImage, x: number, y: number, out: Float32Array | number[]): boolean {
  const { width: w, height: h, channels: ch, data } = img;
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return false;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0;
  if (x0 < 0) { x0 = 0; fx = 0; }
  if (y0 < 0) { y0 = 0; fy = 0; }
  if (x0 >= w - 1) { x0 = w - 1; fx = 0; }
  if (y0 >= h - 1) { y0 = h - 1; fy = 0; }
  const x1 = fx > 0 ? x0 + 1 : x0;
  const y1 = fy > 0 ? y0 + 1 : y0;
  const i00 = (y0 * w + x0) * ch, i10 = (y0 * w + x1) * ch, i01 = (y1 * w + x0) * ch, i11 = (y1 * w + x1) * ch;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  for (let c = 0; c < ch; c++) out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  return true;
}

/** Bilinear sample of a gray image; returns NaN when outside. */
export function sampleGray(img: GrayImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return NaN;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0;
  if (x0 < 0) { x0 = 0; fx = 0; }
  if (y0 < 0) { y0 = 0; fy = 0; }
  if (x0 >= w - 1) { x0 = w - 1; fx = 0; }
  if (y0 >= h - 1) { y0 = h - 1; fy = 0; }
  const x1 = fx > 0 ? x0 + 1 : x0;
  const y1 = fy > 0 ? y0 + 1 : y0;
  return (
    data[y0 * w + x0] * (1 - fx) * (1 - fy) +
    data[y0 * w + x1] * fx * (1 - fy) +
    data[y1 * w + x0] * (1 - fx) * fy +
    data[y1 * w + x1] * fx * fy
  );
}

export interface WarpOptions {
  /** Supersampling factor per axis (1..4). Use >1 when the warp shrinks the source a lot. */
  supersample?: number;
  /** RGBA used for destination pixels that map outside the source. Default transparent black. */
  fill?: [number, number, number, number];
}

/**
 * Warp `src` into a new `width` x `height` image. `H` maps SOURCE coordinates to DESTINATION
 * coordinates (it is inverted internally). Works for affine and projective matrices.
 */
export function warpRGBA(src: RGBAImage, H: Mat3, width: number, height: number, opts: WarpOptions = {}): RGBAImage {
  const inv = mat3Invert(H);
  const out = createRGBA(width, height, opts.fill);
  const ss = Math.max(1, Math.min(4, Math.round(opts.supersample ?? 1)));
  const px = new Float32Array(4);
  const acc = new Float64Array(4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      let n = 0;
      for (let sy = 0; sy < ss; sy++) {
        const yy = y + (sy + 0.5) / ss - 0.5;
        for (let sx = 0; sx < ss; sx++) {
          const xx = x + (sx + 0.5) / ss - 0.5;
          const w = inv[6] * xx + inv[7] * yy + inv[8];
          const u = (inv[0] * xx + inv[1] * yy + inv[2]) / w;
          const v = (inv[3] * xx + inv[4] * yy + inv[5]) / w;
          if (sampleRGBA(src, u, v, px)) {
            acc[0] += px[0]; acc[1] += px[1]; acc[2] += px[2]; acc[3] += px[3];
            n++;
          }
        }
      }
      if (n > 0) {
        const o = (y * width + x) * 4;
        // Coverage-weighted alpha so partially covered border pixels fade out.
        const cov = n / (ss * ss);
        out.data[o] = acc[0] / n;
        out.data[o + 1] = acc[1] / n;
        out.data[o + 2] = acc[2] / n;
        out.data[o + 3] = (acc[3] / n) * cov;
      }
    }
  }
  return out;
}

/** Warp a float image; pixels outside the source are set to NaN in every channel. */
export function warpFloat(src: FloatImage, H: Mat3, width: number, height: number): FloatImage {
  const inv = mat3Invert(H);
  const out = createFloat(width, height, src.channels);
  const px = new Float32Array(src.channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyMat3(inv, { x, y });
      const o = (y * width + x) * src.channels;
      if (sampleFloat(src, p.x, p.y, px)) out.data.set(px, o);
      else out.data.fill(NaN, o, o + src.channels);
    }
  }
  return out;
}

/** Warp a gray image; pixels outside the source become NaN. */
export function warpGray(src: GrayImage, H: Mat3, width: number, height: number): GrayImage {
  const inv = mat3Invert(H);
  const out = createGray(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyMat3(inv, { x, y });
      out.data[y * width + x] = sampleGray(src, p.x, p.y);
    }
  }
  return out;
}

/** Warp a mask with nearest-neighbour sampling; outside = 0. */
export function warpMask(src: Mask, H: Mat3, width: number, height: number): Mask {
  const inv = mat3Invert(H);
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyMat3(inv, { x, y });
      const u = Math.round(p.x), v = Math.round(p.y);
      if (u >= 0 && v >= 0 && u < src.width && v < src.height) out.data[y * width + x] = src.data[v * src.width + u];
    }
  }
  return out;
}

/**
 * Homography mapping the quad (TL, TR, BR, BL — the outer edges of the region) onto a
 * `width` x `height` rectangle. Quad corners are interpreted as the outer corners of the region, so
 * they map to (-0.5, -0.5) ... (width - 0.5, height - 0.5) in pixel-center coordinates.
 */
export function quadToRectHomography(quad: Quad, width: number, height: number): Mat3 {
  const dst = [
    { x: -0.5, y: -0.5 },
    { x: width - 0.5, y: -0.5 },
    { x: width - 0.5, y: height - 0.5 },
    { x: -0.5, y: height - 0.5 },
  ];
  const H = findHomography(quad, dst);
  if (!H) throw new Error('quadToRectHomography: degenerate quad');
  return H;
}

/** Perspective-correct the quad region of `img` into a `width` x `height` image. */
export function rectifyQuad(img: RGBAImage, quad: Quad, width: number, height: number, supersample = 2): RGBAImage {
  const H = quadToRectHomography(quad, width, height);
  return warpRGBA(img, H, width, height, { supersample, fill: [0, 0, 0, 255] });
}
