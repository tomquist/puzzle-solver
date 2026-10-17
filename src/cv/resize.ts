import { createFloat, createGray, createMask, createRGBA, type FloatImage, type GrayImage, type Mask, type RGBAImage } from './image';

type Arr = Float32Array | Uint8ClampedArray;

interface AxisWeights {
  start: Int32Array; // first source index per destination index
  count: Int32Array; // number of contributing source pixels
  weights: Float32Array; // flattened, maxCount per destination
  maxCount: number;
}

/**
 * Precompute 1-D resampling weights. When shrinking, uses exact area (box) weights so that every
 * source pixel contributes (anti-aliased). When enlarging, uses linear interpolation with pixel
 * centers aligned (OpenCV INTER_LINEAR convention).
 */
function axisWeights(srcLen: number, dstLen: number): AxisWeights {
  const scale = srcLen / dstLen;
  if (scale > 1) {
    const maxCount = Math.ceil(scale) + 2;
    const start = new Int32Array(dstLen);
    const count = new Int32Array(dstLen);
    const weights = new Float32Array(dstLen * maxCount);
    for (let d = 0; d < dstLen; d++) {
      const s0 = d * scale;
      const s1 = s0 + scale;
      const i0 = Math.floor(s0);
      const i1 = Math.min(srcLen, Math.ceil(s1));
      start[d] = i0;
      count[d] = i1 - i0;
      for (let i = i0; i < i1; i++) {
        const overlap = Math.min(s1, i + 1) - Math.max(s0, i);
        weights[d * maxCount + (i - i0)] = overlap / scale;
      }
    }
    return { start, count, weights, maxCount };
  }
  const maxCount = 2;
  const start = new Int32Array(dstLen);
  const count = new Int32Array(dstLen);
  const weights = new Float32Array(dstLen * 2);
  for (let d = 0; d < dstLen; d++) {
    let s = (d + 0.5) * scale - 0.5;
    if (s < 0) s = 0;
    if (s > srcLen - 1) s = srcLen - 1;
    const i0 = Math.floor(s);
    const f = s - i0;
    start[d] = i0;
    if (i0 + 1 < srcLen && f > 0) {
      count[d] = 2;
      weights[d * 2] = 1 - f;
      weights[d * 2 + 1] = f;
    } else {
      count[d] = 1;
      weights[d * 2] = 1;
    }
  }
  return { start, count, weights, maxCount };
}

function resample(src: Arr, sw: number, sh: number, ch: number, dst: Arr, dw: number, dh: number): void {
  const wx = axisWeights(sw, dw);
  const wy = axisWeights(sh, dh);
  const rowLen = dw * ch;
  // Horizontally resampled source rows are produced on demand and kept in a small ring cache, so
  // memory stays O(width) instead of O(width x source height) when shrinking large photos.
  const cacheSize = wy.maxCount + 1;
  const cacheRows: Float32Array[] = [];
  const cacheIdx = new Int32Array(cacheSize).fill(-1);
  for (let i = 0; i < cacheSize; i++) cacheRows.push(new Float32Array(rowLen));
  const hRow = (y: number): Float32Array => {
    const slot = y % cacheSize;
    const row = cacheRows[slot];
    if (cacheIdx[slot] === y) return row;
    cacheIdx[slot] = y;
    const base = y * sw;
    for (let x = 0; x < dw; x++) {
      const s0 = wx.start[x], n = wx.count[x], wo = x * wx.maxCount;
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += src[(base + s0 + k) * ch + c] * wx.weights[wo + k];
        row[x * ch + c] = acc;
      }
    }
    return row;
  };
  const acc = new Float32Array(rowLen);
  for (let y = 0; y < dh; y++) {
    const s0 = wy.start[y], n = wy.count[y], wo = y * wy.maxCount;
    acc.fill(0);
    for (let k = 0; k < n; k++) {
      const row = hRow(s0 + k);
      const w = wy.weights[wo + k];
      for (let i = 0; i < rowLen; i++) acc[i] += row[i] * w;
    }
    dst.set(acc, y * rowLen);
  }
}

/** Resize with area averaging when shrinking and bilinear interpolation when enlarging. */
export function resizeRGBA(img: RGBAImage, width: number, height: number): RGBAImage {
  const out = createRGBA(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  resample(img.data, img.width, img.height, 4, out.data, out.width, out.height);
  return out;
}

export function resizeGray(img: GrayImage, width: number, height: number): GrayImage {
  const out = createGray(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  resample(img.data, img.width, img.height, 1, out.data, out.width, out.height);
  return out;
}

export function resizeFloat(img: FloatImage, width: number, height: number): FloatImage {
  const out = createFloat(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), img.channels);
  resample(img.data, img.width, img.height, img.channels, out.data, out.width, out.height);
  return out;
}

/** Nearest-neighbour mask resize. */
export function resizeMask(m: Mask, width: number, height: number): Mask {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const out = createMask(w, h);
  const sx = m.width / w;
  const sy = m.height / h;
  for (let y = 0; y < h; y++) {
    const yy = Math.min(m.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < w; x++) {
      const xx = Math.min(m.width - 1, Math.floor((x + 0.5) * sx));
      out.data[y * w + x] = m.data[yy * m.width + xx];
    }
  }
  return out;
}

/**
 * Downscale so that the longer side is at most `maxSide` (never upscales).
 * Returns the image and the factor `scale = new / old` (<= 1).
 */
export function limitSize(img: RGBAImage, maxSide: number): { image: RGBAImage; scale: number } {
  const long = Math.max(img.width, img.height);
  if (long <= maxSide) return { image: img, scale: 1 };
  const scale = maxSide / long;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  return { image: resizeRGBA(img, w, h), scale: w / img.width };
}
