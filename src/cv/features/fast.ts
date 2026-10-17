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

export interface FastCorners {
  /** Pixel coordinates of the corners (after non-maximum suppression). */
  x: Int32Array;
  y: Int32Array;
  /** FAST score: summed absolute contrast of the arc pixels beyond the threshold. */
  score: Float32Array;
  count: number;
}

/**
 * FAST-9 segment test on a gray image (values 0..255). Only pixels at least `border` (>= 3) pixels
 * away from the image edge are tested. Corners are suppressed unless their score is a strict local
 * maximum in their 3x3 neighbourhood (ties resolved in scan order).
 */
export function detectFast(img: GrayImage, threshold: number, border: number): FastCorners {
  const { width: w, height: h, data } = img;
  const b = Math.max(3, Math.ceil(border));
  const off = new Int32Array(16);
  for (let k = 0; k < 16; k++) off[k] = CIRCLE_DY[k] * w + CIRCLE_DX[k];
  const scoreMap = new Float32Array(w * h);
  let cand = new Int32Array(1024);
  let n = 0;
  const o0 = off[0], o4 = off[4], o8 = off[8], o12 = off[12];
  for (let y = b; y < h - b; y++) {
    for (let x = b; x < w - b; x++) {
      const i = y * w + x;
      const p = data[i];
      const hi = p + threshold;
      const lo = p - threshold;
      const v0 = data[i + o0], v4 = data[i + o4], v8 = data[i + o8], v12 = data[i + o12];
      // A 9-arc always contains two adjacent compass points.
      const b0 = v0 > hi, b4 = v4 > hi, b8 = v8 > hi, b12 = v12 > hi;
      const d0 = v0 < lo, d4 = v4 < lo, d8 = v8 < lo, d12 = v12 < lo;
      const brightOk = (b0 && b4) || (b4 && b8) || (b8 && b12) || (b12 && b0);
      const darkOk = (d0 && d4) || (d4 && d8) || (d8 && d12) || (d12 && d0);
      if (!brightOk && !darkOk) continue;
      let bright = 0, dark = 0;
      let sb = 0, sd = 0;
      for (let k = 0; k < 16; k++) {
        const v = data[i + off[k]];
        if (v > hi) { bright |= 1 << k; sb += v - hi; }
        else if (v < lo) { dark |= 1 << k; sd += lo - v; }
      }
      let s = 0;
      if (brightOk && ARC9[bright]) s = sb;
      if (darkOk && ARC9[dark] && sd > s) s = sd;
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
    // Strictly greater than earlier neighbours, >= later ones: exactly one survivor per plateau.
    if (
      s > scoreMap[i - w - 1] && s > scoreMap[i - w] && s > scoreMap[i - w + 1] && s > scoreMap[i - 1] &&
      s >= scoreMap[i + 1] && s >= scoreMap[i + w - 1] && s >= scoreMap[i + w] && s >= scoreMap[i + w + 1]
    ) {
      xs[m] = i % w;
      ys[m] = (i - xs[m]) / w;
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
