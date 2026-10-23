import { createFloat, createGray, type FloatImage, type GrayImage } from './image';

/** Normalized 1-D Gaussian kernel. Radius defaults to ceil(3 * sigma). */
export function gaussianKernel(sigma: number, radius = Math.max(1, Math.ceil(3 * sigma))): Float32Array {
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Separable convolution of a multi-channel float image with a 1-D kernel applied horizontally and
 * vertically. Borders are handled by clamping (replicate border).
 */
export function convolveSeparable(img: FloatImage, kx: Float32Array, ky: Float32Array = kx): FloatImage {
  const { width: w, height: h, channels: c } = img;
  const rx = (kx.length - 1) >> 1;
  const ry = (ky.length - 1) >> 1;
  const tmp = new Float32Array(img.data.length);
  const src = img.data;
  // Every sum runs over the taps in kernel order from 0 (as a plain loop with clamped indices
  // would), so the result does not depend on how the loops below are arranged.
  const xa = Math.min(rx, w), xb = Math.max(xa, w - rx);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (x === xa && x < xb) {
        // Interior: no clamping.
        for (; x < xb; x++) {
          for (let ch = 0; ch < c; ch++) {
            let acc = 0;
            for (let k = 0, q = (row + x - rx) * c + ch; k <= 2 * rx; k++, q += c) acc += src[q] * kx[k];
            tmp[(row + x) * c + ch] = acc;
          }
        }
        x--;
        continue;
      }
      for (let ch = 0; ch < c; ch++) {
        let acc = 0;
        for (let k = -rx; k <= rx; k++) {
          let xx = x + k;
          if (xx < 0) xx = 0;
          else if (xx >= w) xx = w - 1;
          acc += src[(row + xx) * c + ch] * kx[k + rx];
        }
        tmp[(row + x) * c + ch] = acc;
      }
    }
  }
  const out = createFloat(w, h, c);
  const dst = out.data;
  // Vertical: a row of sums at a time (in float64, as a scalar sum would be), taps in kernel order.
  const rowLen = w * c;
  const acc = new Float64Array(rowLen);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let k = -ry; k <= ry; k++) {
      let yy = y + k;
      if (yy < 0) yy = 0;
      else if (yy >= h) yy = h - 1;
      const wk = ky[k + ry], o = yy * rowLen;
      for (let i = 0; i < rowLen; i++) acc[i] += tmp[o + i] * wk;
    }
    dst.set(acc, y * rowLen);
  }
  return out;
}

function grayAsFloat(g: GrayImage): FloatImage {
  return { width: g.width, height: g.height, channels: 1, data: g.data };
}

function floatAsGray(f: FloatImage): GrayImage {
  return { width: f.width, height: f.height, data: f.data };
}

export function gaussianBlurGray(img: GrayImage, sigma: number): GrayImage {
  if (sigma <= 0) return { width: img.width, height: img.height, data: new Float32Array(img.data) };
  return floatAsGray(convolveSeparable(grayAsFloat(img), gaussianKernel(sigma)));
}

export function gaussianBlurFloat(img: FloatImage, sigma: number): FloatImage {
  if (sigma <= 0) return { ...img, data: new Float32Array(img.data) };
  return convolveSeparable(img, gaussianKernel(sigma));
}

/** Mean filter over a (2r+1)x(2r+1) window using an integral image (O(1) per pixel). */
export function boxBlurGray(img: GrayImage, r: number): GrayImage {
  const { width: w, height: h } = img;
  const ii = integralImage(img);
  const out = createGray(w, h);
  const W = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
      out.data[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Summed-area table of size (w+1)*(h+1) in float64 (row-major, stride w+1). */
export function integralImage(img: GrayImage): Float64Array {
  const { width: w, height: h } = img;
  const W = w + 1;
  const ii = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += img.data[y * w + x];
      ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + rowSum;
    }
  }
  return ii;
}

export interface Gradient {
  gx: GrayImage;
  gy: GrayImage;
  /** sqrt(gx^2 + gy^2) */
  magnitude: GrayImage;
}

/** 3x3 Sobel gradients with replicate border. */
export function sobel(img: GrayImage): Gradient {
  const { width: w, height: h } = img;
  const gx = createGray(w, h);
  const gy = createGray(w, h);
  const mag = createGray(w, h);
  const s = img.data;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const a = s[ym + xm], b = s[ym + x], c = s[ym + xp];
      const d = s[y0 + xm], f = s[y0 + xp];
      const g = s[yp + xm], hh = s[yp + x], k = s[yp + xp];
      const dx = c + 2 * f + k - a - 2 * d - g;
      const dy = g + 2 * hh + k - a - 2 * b - c;
      gx.data[y0 + x] = dx;
      gy.data[y0 + x] = dy;
      mag.data[y0 + x] = Math.sqrt(dx * dx + dy * dy);
    }
  }
  return { gx, gy, magnitude: mag };
}

/** 4-neighbour Laplacian with replicate border. */
export function laplacian(img: GrayImage): GrayImage {
  const { width: w, height: h } = img;
  const out = createGray(w, h);
  const s = img.data;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      out.data[y0 + x] = s[ym + x] + s[yp + x] + s[y0 + xm] + s[y0 + xp] - 4 * s[y0 + x];
    }
  }
  return out;
}

/** Mean and (population) variance of a gray image, optionally restricted to a mask. */
export function meanVariance(img: GrayImage, mask?: { data: Uint8Array }): { mean: number; variance: number; count: number } {
  let n = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (mask && !mask.data[i]) continue;
    const v = img.data[i];
    sum += v;
    sum2 += v * v;
    n++;
  }
  if (n === 0) return { mean: 0, variance: 0, count: 0 };
  const mean = sum / n;
  return { mean, variance: Math.max(0, sum2 / n - mean * mean), count: n };
}
