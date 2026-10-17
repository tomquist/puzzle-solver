import { boxBlurGray } from './filter';
import { createMask, type GrayImage, type Mask } from './image';

/**
 * Otsu's threshold over the (optionally masked) values, using `bins` histogram bins spanning the
 * value range (bin k is centered on min + k·(max − min)/(bins − 1), so integer 0..255 data with
 * 256 bins is binned exactly). `threshold` lies halfway between bins, so `value > threshold`
 * selects the upper class; if several splits are equally good the middle one is used.
 * `separability` = between-class variance / total variance (0..1; ≈1 for two clean levels,
 * low for unimodal data). Empty or constant input gives { threshold: min, separability: 0 }.
 */
export function otsuThreshold(values: GrayImage, mask?: Mask, bins = 256): { threshold: number; separability: number } {
  const d = values.data;
  const md = mask?.data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < d.length; i++) {
    if (md && md[i] === 0) continue;
    const v = d[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return { threshold: Number.isFinite(lo) ? lo : 0, separability: 0 };
  const nb = Math.max(2, Math.floor(bins));
  const scale = (nb - 1) / (hi - lo);
  const hist = new Float64Array(nb);
  for (let i = 0; i < d.length; i++) {
    if (md && md[i] === 0) continue;
    hist[Math.round((d[i] - lo) * scale)]++;
  }
  let total = 0, sum = 0;
  for (let k = 0; k < nb; k++) { total += hist[k]; sum += k * hist[k]; }
  const mean = sum / total;
  let varTotal = 0;
  for (let k = 0; k < nb; k++) varTotal += hist[k] * (k - mean) * (k - mean);
  varTotal /= total;
  // Between-class variance for every split "bins 0..k | k+1..nb-1".
  const between = new Float64Array(nb - 1);
  let w0 = 0, s0 = 0, best = -1;
  for (let k = 0; k < nb - 1; k++) {
    w0 += hist[k];
    s0 += k * hist[k];
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) { between[k] = -1; continue; }
    const m0 = s0 / w0, m1 = (sum - s0) / w1;
    const b = (w0 / total) * (w1 / total) * (m0 - m1) * (m0 - m1);
    between[k] = b;
    if (b > best) best = b;
  }
  let first = -1, last = -1;
  const tol = best * 1e-9;
  for (let k = 0; k < nb - 1; k++) {
    if (between[k] >= best - tol) {
      if (first < 0) first = k;
      last = k;
    } else if (first >= 0) break;
  }
  const kMid = (first + last) / 2;
  return { threshold: lo + (kMid + 0.5) / scale, separability: varTotal > 0 ? Math.min(1, best / varTotal) : 0 };
}

/** Binary threshold: 1 where value > t. */
export function threshold(img: GrayImage, t: number): Mask {
  const out = createMask(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] > t ? 1 : 0;
  return out;
}

/**
 * Local threshold: 1 where value > mean of the (2·radius+1)² window (clipped at the border) +
 * `offset`. Use a negative offset to keep flat regions.
 */
export function adaptiveThreshold(img: GrayImage, radius: number, offset: number): Mask {
  const mean = boxBlurGray(img, Math.max(0, Math.round(radius)));
  const out = createMask(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] > mean.data[i] + offset ? 1 : 0;
  return out;
}
