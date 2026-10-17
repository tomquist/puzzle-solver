/**
 * FAST-9 corner detection with 3x3 non-maximum suppression, and the Harris corner response used to
 * rank FAST corners (as in ORB).
 */
import type { GrayImage } from '../image';

/** Bresenham circle of radius 3, clockwise starting at the top (index 0, 4, 8, 12 = N, E, S, W). */
const CIRCLE_DX = [0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1];
const CIRCLE_DY = [-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3];

/** ARC9[mask] = 1 when the circular 16-bit mask contains at least 9 contiguous set bits. */
const ARC9 = (() => {
  const t = new Uint8Array(65536);
  for (let m = 0; m < 65536; m++) {
    const m32 = m | (m << 16);
    const a = m32 & (m32 >>> 1);
    const b = a & (a >>> 2);
    const c = b & (b >>> 4);
    const d = c & (m32 >>> 8);
    t[m] = (d & 0xffff) !== 0 ? 1 : 0;
  }
  return t;
})();

/**
 * ARC4[mask] = 1 when the circular 8-bit mask (the even circle positions 0, 2, ..., 14) has at least
 * 4 contiguous set bits — necessary for a 9-arc on the full circle.
 */
const ARC4 = (() => {
  const t = new Uint8Array(256);
  for (let m = 0; m < 256; m++) {
    const m16 = m | (m << 8);
    const a = m16 & (m16 >>> 1);
    const b = a & (a >>> 2);
    t[m] = (b & 0xff) !== 0 ? 1 : 0;
  }
  return t;
})();

export interface FastCorners {
  /** Pixel coordinates of the corners (after non-maximum suppression). */
  x: Int32Array;
  y: Int32Array;
  /** FAST score: summed contrast beyond the threshold of the circle pixels on the corner's side. */
  score: Float32Array;
  count: number;
}

/**
 * FAST-9 segment test on a gray image (values 0..255). Only pixels at least `border` (>= 3) pixels
 * away from the image edge are tested. Corners are kept when their score is a local maximum in
 * their 3x3 neighbourhood (exactly one survivor per plateau).
 */
export function detectFast(img: GrayImage, threshold: number, border: number): FastCorners {
  const { width: w, height: h, data } = img;
  const b = Math.max(3, Math.ceil(border));
  const off = new Int32Array(16);
  for (let k = 0; k < 16; k++) off[k] = CIRCLE_DY[k] * w + CIRCLE_DX[k];
  const [o0, o1, o2, o3, o4, o5, o6, o7, o8, o9, o10, o11, o12, o13, o14, o15] = off;
  const scoreMap = new Float32Array(w * h);
  let cand = new Int32Array(1024);
  let n = 0;
  for (let y = b; y < h - b; y++) {
    for (let x = b; x < w - b; x++) {
      const i = y * w + x;
      const p = data[i];
      const hi = p + threshold;
      const lo = p - threshold;
      // Stage 1: a 9-arc always contains two adjacent compass points.
      const v0 = data[i + o0], v4 = data[i + o4], v8 = data[i + o8], v12 = data[i + o12];
      const qb = (v0 > hi ? 1 : 0) | (v4 > hi ? 2 : 0) | (v8 > hi ? 4 : 0) | (v12 > hi ? 8 : 0);
      const qd = (v0 < lo ? 1 : 0) | (v4 < lo ? 2 : 0) | (v8 < lo ? 4 : 0) | (v12 < lo ? 8 : 0);
      if ((qb & ((qb >>> 1) | (qb << 3))) === 0 && (qd & ((qd >>> 1) | (qd << 3))) === 0) continue;
      // Stage 2: ... and four contiguous even positions.
      const v2 = data[i + o2], v6 = data[i + o6], v10 = data[i + o10], v14 = data[i + o14];
      const eb = (qb & 1) | (v2 > hi ? 2 : 0) | ((qb & 2) << 1) | (v6 > hi ? 8 : 0) | ((qb & 4) << 2) | (v10 > hi ? 32 : 0) | ((qb & 8) << 3) | (v14 > hi ? 128 : 0);
      const ed = (qd & 1) | (v2 < lo ? 2 : 0) | ((qd & 2) << 1) | (v6 < lo ? 8 : 0) | ((qd & 4) << 2) | (v10 < lo ? 32 : 0) | ((qd & 8) << 3) | (v14 < lo ? 128 : 0);
      const okB = ARC4[eb], okD = ARC4[ed];
      if (!okB && !okD) continue;
      // Stage 3: full 16-pixel segment test.
      const v1 = data[i + o1], v3 = data[i + o3], v5 = data[i + o5], v7 = data[i + o7];
      const v9 = data[i + o9], v11 = data[i + o11], v13 = data[i + o13], v15 = data[i + o15];
      let s = 0;
      if (okB) {
        const m = (v0 > hi ? 1 : 0) | (v1 > hi ? 2 : 0) | (v2 > hi ? 4 : 0) | (v3 > hi ? 8 : 0) |
          (v4 > hi ? 16 : 0) | (v5 > hi ? 32 : 0) | (v6 > hi ? 64 : 0) | (v7 > hi ? 128 : 0) |
          (v8 > hi ? 256 : 0) | (v9 > hi ? 512 : 0) | (v10 > hi ? 1024 : 0) | (v11 > hi ? 2048 : 0) |
          (v12 > hi ? 4096 : 0) | (v13 > hi ? 8192 : 0) | (v14 > hi ? 16384 : 0) | (v15 > hi ? 32768 : 0);
        if (ARC9[m]) {
          s = Math.max(0, v0 - hi) + Math.max(0, v1 - hi) + Math.max(0, v2 - hi) + Math.max(0, v3 - hi) +
            Math.max(0, v4 - hi) + Math.max(0, v5 - hi) + Math.max(0, v6 - hi) + Math.max(0, v7 - hi) +
            Math.max(0, v8 - hi) + Math.max(0, v9 - hi) + Math.max(0, v10 - hi) + Math.max(0, v11 - hi) +
            Math.max(0, v12 - hi) + Math.max(0, v13 - hi) + Math.max(0, v14 - hi) + Math.max(0, v15 - hi);
        }
      }
      if (okD) {
        const m = (v0 < lo ? 1 : 0) | (v1 < lo ? 2 : 0) | (v2 < lo ? 4 : 0) | (v3 < lo ? 8 : 0) |
          (v4 < lo ? 16 : 0) | (v5 < lo ? 32 : 0) | (v6 < lo ? 64 : 0) | (v7 < lo ? 128 : 0) |
          (v8 < lo ? 256 : 0) | (v9 < lo ? 512 : 0) | (v10 < lo ? 1024 : 0) | (v11 < lo ? 2048 : 0) |
          (v12 < lo ? 4096 : 0) | (v13 < lo ? 8192 : 0) | (v14 < lo ? 16384 : 0) | (v15 < lo ? 32768 : 0);
        if (ARC9[m]) {
          const sd = Math.max(0, lo - v0) + Math.max(0, lo - v1) + Math.max(0, lo - v2) + Math.max(0, lo - v3) +
            Math.max(0, lo - v4) + Math.max(0, lo - v5) + Math.max(0, lo - v6) + Math.max(0, lo - v7) +
            Math.max(0, lo - v8) + Math.max(0, lo - v9) + Math.max(0, lo - v10) + Math.max(0, lo - v11) +
            Math.max(0, lo - v12) + Math.max(0, lo - v13) + Math.max(0, lo - v14) + Math.max(0, lo - v15);
          if (sd > s) s = sd;
        }
      }
      if (s <= 0) continue;
      scoreMap[i] = s;
      if (n === cand.length) {
        const grown = new Int32Array(n * 2);
        grown.set(cand);
        cand = grown;
      }
      cand[n++] = i;
    }
  }
  const xs = new Int32Array(n), ys = new Int32Array(n), sc = new Float32Array(n);
  let m = 0;
  for (let c = 0; c < n; c++) {
    const i = cand[c];
    const s = scoreMap[i];
    // Strictly greater than earlier neighbours, >= later ones.
    if (
      s > scoreMap[i - w - 1] && s > scoreMap[i - w] && s > scoreMap[i - w + 1] && s > scoreMap[i - 1] &&
      s >= scoreMap[i + 1] && s >= scoreMap[i + w - 1] && s >= scoreMap[i + w] && s >= scoreMap[i + w + 1]
    ) {
      const x = i % w;
      xs[m] = x;
      ys[m] = (i - x) / w;
      sc[m] = s;
      m++;
    }
  }
  return { x: xs.subarray(0, m), y: ys.subarray(0, m), score: sc.subarray(0, m), count: m };
}

/**
 * Harris corner response det(M) - k * trace(M)^2 at integer pixel (x, y), with M the structure
 * tensor of 3x3 Sobel gradients summed over a (2 * radius + 1)^2 block. Scaled like OpenCV's ORB
 * (gradients normalised by 4 * blockSize * 255). Needs `radius + 1` pixels of margin.
 */
export function harrisResponse(img: GrayImage, x: number, y: number, radius = 3, k = 0.04): number {
  const { width: w, data } = img;
  let a = 0, bb = 0, c = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    let i = (y + dy) * w + x - radius;
    for (let dx = -radius; dx <= radius; dx++, i++) {
      const tl = data[i - w - 1], t = data[i - w], tr = data[i - w + 1];
      const l = data[i - 1], r = data[i + 1];
      const bl = data[i + w - 1], bo = data[i + w], br = data[i + w + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * bo + br - tl - 2 * t - tr;
      a += gx * gx;
      bb += gy * gy;
      c += gx * gy;
    }
  }
  const scale = 1 / (4 * (2 * radius + 1) * 255);
  const s4 = scale * scale * scale * scale;
  return (a * bb - c * c - k * (a + bb) * (a + bb)) * s4;
}
