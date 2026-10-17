/**
 * Content-normalised photo measurements shared by every quality check (box photos, piece photos,
 * live camera frames). This module only MEASURES; deciding what counts as a problem (thresholds,
 * messages) is up to the caller.
 */
import { saturationValue } from '../../cv/color';
import { createMask, type GrayImage, type Mask, type RGBAImage } from '../../cv/image';

/**
 * No-reference blur metric (Crété-Roffet et al. 2007): compares local variation of the image with
 * that of a re-blurred copy. Returns 0 (sharp) .. 1 (very blurry), largely independent of content
 * contrast. Pixels outside `mask` (when given) are ignored. `radius` is the re-blur half-width;
 * increase it for high-resolution images.
 */
export function blurMetric(gray: GrayImage, mask?: Mask, radius = 4): number {
  const { width: w, height: h, data } = gray;
  const n = 2 * radius + 1;
  let worst = 0;
  for (const dir of [0, 1] as const) {
    let sumOrig = 0;
    let sumDiff = 0;
    const outer = dir === 0 ? h : w;
    const inner = dir === 0 ? w : h;
    const line = new Float32Array(inner);
    const blurred = new Float32Array(inner);
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < inner; i++) line[i] = dir === 0 ? data[o * w + i] : data[i * w + o];
      // Box blur along the line (clamped border) with a running sum.
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += line[Math.min(inner - 1, Math.max(0, k))];
      for (let i = 0; i < inner; i++) {
        blurred[i] = acc / n;
        acc += line[Math.min(inner - 1, i + radius + 1)] - line[Math.max(0, i - radius)];
      }
      for (let i = 1; i < inner; i++) {
        if (mask) {
          const idx = dir === 0 ? o * w + i : i * w + o;
          const prev = dir === 0 ? o * w + i - 1 : (i - 1) * w + o;
          if (!mask.data[idx] || !mask.data[prev]) continue;
        }
        const dOrig = Math.abs(line[i] - line[i - 1]);
        const dBlur = Math.abs(blurred[i] - blurred[i - 1]);
        sumOrig += dOrig;
        sumDiff += Math.max(0, dOrig - dBlur);
      }
    }
    if (sumOrig > 1e-6) worst = Math.max(worst, (sumOrig - sumDiff) / sumOrig);
  }
  return worst;
}

/**
 * Variance of the 4-neighbour Laplacian (classic focus measure). Depends on content and contrast,
 * so only compare values between similar images (e.g. consecutive camera frames).
 */
export function laplacianVariance(gray: GrayImage, mask?: Mask): number {
  const { width: w, height: h, data } = gray;
  let n = 0, s = 0, s2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask && !mask.data[i]) continue;
      const v = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

export interface ExposureStats {
  /** Mean luminance 0..1. */
  mean: number;
  /** Fraction of pixels with luminance <= 6 (crushed blacks). */
  clippedLow: number;
  /** Fraction of pixels with any channel >= 250 (blown highlights). */
  clippedHigh: number;
  /** 5th and 95th luminance percentiles, 0..1. */
  p05: number;
  p95: number;
}

/** Exposure statistics of an RGBA image, optionally restricted to a mask. */
export function exposureStats(img: RGBAImage, mask?: Mask): ExposureStats {
  const hist = new Uint32Array(256);
  let n = 0, low = 0, high = 0, sum = 0;
  const d = img.data;
  for (let i = 0, p = 0; i < img.width * img.height; i++, p += 4) {
    if (mask && !mask.data[i]) continue;
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    hist[y]++;
    sum += y;
    n++;
    if (y <= 6) low++;
    if (r >= 250 || g >= 250 || b >= 250) high++;
  }
  if (n === 0) return { mean: 0, clippedLow: 0, clippedHigh: 0, p05: 0, p95: 0 };
  const pct = (q: number) => {
    const target = q * n;
    let c = 0;
    for (let v = 0; v < 256; v++) {
      c += hist[v];
      if (c >= target) return v / 255;
    }
    return 1;
  };
  return { mean: sum / n / 255, clippedLow: low / n, clippedHigh: high / n, p05: pct(0.05), p95: pct(0.95) };
}

/**
 * Specular glare candidates: very bright, nearly colourless pixels. Glossy box lids and pieces
 * reflect lamps as white blobs that destroy the picture content underneath.
 */
export function glareMask(img: RGBAImage, opts: { minValue?: number; maxSaturation?: number } = {}): Mask {
  const minValue = opts.minValue ?? 0.94;
  const maxSat = opts.maxSaturation ?? 0.12;
  const out = createMask(img.width, img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) {
    const [s, v] = saturationValue(d[p], d[p + 1], d[p + 2]);
    if (v >= minValue && s <= maxSat) out.data[i] = 1;
  }
  return out;
}

/**
 * Fast sensor-noise estimate (Immerkær 1996): standard deviation of additive Gaussian noise in
 * luminance units (0..255). Edges inflate it slightly; good enough to flag very noisy photos.
 */
export function noiseSigma(gray: GrayImage): number {
  const { width: w, height: h, data } = gray;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        data[i - w - 1] - 2 * data[i - w] + data[i - w + 1] -
        2 * data[i - 1] + 4 * data[i] - 2 * data[i + 1] +
        data[i + w - 1] - 2 * data[i + w] + data[i + w + 1];
      sum += Math.abs(v);
    }
  }
  return (Math.sqrt(Math.PI / 2) * sum) / (6 * (w - 2) * (h - 2));
}
