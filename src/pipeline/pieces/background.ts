/**
 * Background colour model of a scan photo and the per-pixel foreground score.
 *
 * The background (table / cloth) is modelled per CIE Lab channel as a quadratic surface over the
 * photo, which absorbs smooth lighting gradients. It is initialised robustly from the photo's
 * border band and refined iteratively from all samples that look like background. The foreground
 * score is a noise-normalised colour distance to the model that tolerates soft cast shadows
 * (moderately darker pixels with proportionally scaled chroma).
 */
import { rgbToLab } from '../../cv/color';
import { solveLinear } from '../../cv/geometry';
import { createGray, type GrayImage, type RGBAImage } from '../../cv/image';
import { dilate } from '../../cv/morphology';
import type { BackgroundModel } from './types';
import { median, quantile } from './util';

const NT = 6;
/** Weight of lightness differences relative to chroma (lighting varies more than colour). */
const W_L = 0.5;
/** Lowest (L* + 16) ratio still explained as a cast shadow (≈ 50 % darkening in linear light). */
const RHO_MIN = 0.8;
/** Cost (in sigmas) of explaining a pixel as the deepest accepted shadow; shallower shadows cost less. */
const SHADOW_PENALTY = 2.5;
/** Floors for the per-channel noise sigma (Lab units), so noise-free backgrounds stay sane. */
const SIGMA_FLOOR: [number, number, number] = [1.2, 1, 1];

/** The fitted part of a {@link BackgroundModel} (segmentation statistics are added later). */
export type BackgroundFit = Pick<BackgroundModel, 'color' | 'coefficients' | 'sigma' | 'width' | 'height' | 'lightingRatio'>;

function evalPoly(k: readonly number[], u: number, v: number): number {
  return k[0] + k[1] * u + k[2] * v + k[3] * u * u + k[4] * u * v + k[5] * v * v;
}

/** Normalised coordinate of pixel index `x` along an axis of length `n` (−1..1). */
function norm(x: number, n: number): number {
  return n > 1 ? (2 * x) / (n - 1) - 1 : 0;
}

/** Modelled background Lab colour at photo pixel (x, y). */
export function backgroundAt(model: Pick<BackgroundModel, 'coefficients' | 'width' | 'height'>, x: number, y: number): [number, number, number] {
  const u = norm(x, model.width), v = norm(y, model.height);
  const k = model.coefficients;
  return [evalPoly(k[0], u, v), evalPoly(k[1], u, v), evalPoly(k[2], u, v)];
}

/**
 * Ratio of the brightest to the darkest modelled background luminance (CIE Y) over the whole photo
 * (9×9 grid, includes extrapolation into corners), a scale-free measure of the lighting gradient.
 */
export function lightingRatio(model: Pick<BackgroundModel, 'coefficients'>): number {
  let lo = Infinity, hi = -Infinity;
  for (let gy = 0; gy <= 8; gy++) {
    for (let gx = 0; gx <= 8; gx++) {
      const L = Math.max(0, Math.min(100, evalPoly(model.coefficients[0], gx / 4 - 1, gy / 4 - 1)));
      const Y = ((L + 16) / 116) ** 3;
      if (Y < lo) lo = Y;
      if (Y > hi) hi = Y;
    }
  }
  return lo > 1e-4 ? hi / lo : 1;
}

/**
 * Noise-normalised colour distance of a Lab pixel to the background colour (bL, ba, bb), tolerant
 * to cast shadows. `is*` are inverse sigmas. Shared by the model fit and the per-pixel score.
 */
function distance(L: number, a: number, b: number, bL: number, ba: number, bb: number, isL: number, isa: number, isb: number): number {
  const dL = (L - bL) * isL, da = (a - ba) * isa, db = (b - bb) * isb;
  let d2 = W_L * dL * dL + da * da + db * db;
  if (L < bL) {
    // Shadow hypothesis: Lab of an RGB-scaled colour ≈ (ρ(bL + 16) − 16, ρ·ba, ρ·bb).
    const ref = bL + 16;
    const rho = ref > 1 ? Math.max(RHO_MIN, (L + 16) / ref) : 1;
    const sL = (L + 16 - rho * ref) * isL, sa = (a - rho * ba) * isa, sb = (b - rho * bb) * isb;
    const pen = (SHADOW_PENALTY * (1 - rho)) / (1 - RHO_MIN);
    const s2 = W_L * sL * sL + sa * sa + sb * sb + pen * pen;
    if (s2 < d2) d2 = s2;
  }
  return Math.sqrt(d2);
}

// ---------------------------------------------------------------------------------------------
// Fast sRGB → Lab for whole images (lookup tables; |error| < 0.01 L*a*b* units)
// ---------------------------------------------------------------------------------------------

const LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();
const F_N = 4096;
const F_LUT = (() => {
  const t = new Float32Array(F_N + 2);
  for (let i = 0; i <= F_N + 1; i++) {
    const v = i / F_N;
    t[i] = v > 0.008856451679035631 ? Math.cbrt(v) : v * 7.787037037037037 + 16 / 116;
  }
  return t;
})();

// ---------------------------------------------------------------------------------------------
// Model fit
// ---------------------------------------------------------------------------------------------

interface Samples {
  n: number;
  u: Float32Array;
  v: Float32Array;
  lab: Float32Array; // 3 per sample
  band: Uint8Array;
  gw: number;
  gh: number;
}

function takeSamples(photo: RGBAImage): Samples {
  const { width: w, height: h, data } = photo;
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 25000)));
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step);
  const n = gw * gh;
  const u = new Float32Array(n), v = new Float32Array(n), c = new Float32Array(n * 3), band = new Uint8Array(n);
  const bw = Math.max(2 * step, Math.round(0.04 * Math.min(w, h)));
  for (let gy = 0, i = 0; gy < gh; gy++) {
    const y = Math.min(h - 1, gy * step + (step >> 1));
    for (let gx = 0; gx < gw; gx++, i++) {
      const x = Math.min(w - 1, gx * step + (step >> 1));
      u[i] = norm(x, w);
      v[i] = norm(y, h);
      const p = (y * w + x) * 4;
      const lab = rgbToLab(data[p], data[p + 1], data[p + 2]);
      c[i * 3] = lab[0];
      c[i * 3 + 1] = lab[1];
      c[i * 3 + 2] = lab[2];
      band[i] = x < bw || y < bw || x >= w - bw || y >= h - bw ? 1 : 0;
    }
  }
  return { n, u, v, lab: c, band, gw, gh };
}

/** Weighted least-squares quadratic fit of one channel; null when singular. */
function fitChannel(s: Samples, ch: number, weight: Float32Array): number[] | null {
  const A = new Float64Array(NT * NT);
  const rhs = new Float64Array(NT);
  const f = new Float64Array(NT);
  let total = 0;
  for (let i = 0; i < s.n; i++) {
    const w = weight[i];
    if (w <= 0) continue;
    total += w;
    const u = s.u[i], v = s.v[i];
    f[0] = 1; f[1] = u; f[2] = v; f[3] = u * u; f[4] = u * v; f[5] = v * v;
    const val = s.lab[i * 3 + ch];
    for (let r = 0; r < NT; r++) {
      const fr = f[r] * w;
      rhs[r] += fr * val;
      for (let q = r; q < NT; q++) A[r * NT + q] += fr * f[q];
    }
  }
  if (total < 3 * NT) return null;
  const M: number[][] = [];
  for (let r = 0; r < NT; r++) {
    const row: number[] = [];
    for (let q = 0; q < NT; q++) row.push(q >= r ? A[r * NT + q] : A[q * NT + r]);
    // Tiny ridge towards a constant surface keeps one-sided sample sets (e.g. only the border band) stable.
    if (r > 0) row[r] += 1e-3 * total;
    M.push(row);
  }
  return solveLinear(M, Array.from(rhs));
}

/**
 * Fit the background model of a photo. Robust to pieces lying on the border band (median start,
 * Tukey-weighted refits that exclude samples near foreground).
 */
export function fitBackground(photo: RGBAImage): BackgroundFit {
  const { width, height } = photo;
  const s = takeSamples(photo);
  // 1) Robust start from the border band: per-channel median and MAD.
  const bandIdx: number[] = [];
  for (let i = 0; i < s.n; i++) if (s.band[i]) bandIdx.push(i);
  const color: [number, number, number] = [0, 0, 0];
  const sigma: [number, number, number] = [0, 0, 0];
  const tmp = new Float32Array(bandIdx.length);
  for (let ch = 0; ch < 3; ch++) {
    for (let j = 0; j < bandIdx.length; j++) tmp[j] = s.lab[bandIdx[j] * 3 + ch];
    color[ch] = median(tmp);
    for (let j = 0; j < bandIdx.length; j++) tmp[j] = Math.abs(tmp[j] - color[ch]);
    sigma[ch] = Math.max(SIGMA_FLOOR[ch], 1.4826 * median(tmp));
  }
  const coefficients: [number[], number[], number[]] = [
    [color[0], 0, 0, 0, 0, 0],
    [color[1], 0, 0, 0, 0, 0],
    [color[2], 0, 0, 0, 0, 0],
  ];
  const weight = new Float32Array(s.n);
  const dist = new Float32Array(s.n);
  const res = [new Float32Array(s.n), new Float32Array(s.n), new Float32Array(s.n)];
  // 2) Iterate: classify all samples, exclude the neighbourhood of foreground, Tukey-weighted refit.
  const C = 4.5;
  const gridMask = { width: s.gw, height: s.gh, data: new Uint8Array(s.n) };
  for (let iter = 0; iter < 4; iter++) {
    const isL = 1 / sigma[0], isa = 1 / sigma[1], isb = 1 / sigma[2];
    for (let i = 0; i < s.n; i++) {
      const u = s.u[i], v = s.v[i];
      dist[i] = distance(
        s.lab[i * 3], s.lab[i * 3 + 1], s.lab[i * 3 + 2],
        evalPoly(coefficients[0], u, v), evalPoly(coefficients[1], u, v), evalPoly(coefficients[2], u, v),
        isL, isa, isb,
      );
      gridMask.data[i] = dist[i] >= 3.5 ? 1 : 0;
    }
    const near = dilate(gridMask, 1);
    const bandOnly = iter === 0;
    let used = 0;
    for (let i = 0; i < s.n; i++) {
      const d = dist[i];
      if ((bandOnly && !s.band[i]) || near.data[i] || d >= C) weight[i] = 0;
      else {
        const t = d / C;
        weight[i] = (1 - t * t) * (1 - t * t);
        used++;
      }
    }
    if (used < 3 * NT) break;
    for (let ch = 0; ch < 3; ch++) {
      const k = fitChannel(s, ch, weight);
      if (k) coefficients[ch] = k;
    }
    // Re-estimate the spread from the residuals of confidently-background samples.
    let m = 0;
    for (let i = 0; i < s.n; i++) {
      if (weight[i] <= 0.3) continue;
      for (let ch = 0; ch < 3; ch++) res[ch][m] = Math.abs(s.lab[i * 3 + ch] - evalPoly(coefficients[ch], s.u[i], s.v[i]));
      m++;
    }
    if (m > 20) for (let ch = 0; ch < 3; ch++) sigma[ch] = Math.max(SIGMA_FLOOR[ch], 1.4826 * median(res[ch].subarray(0, m)));
  }
  // Lighting ratio where the table actually is (no extrapolation into corners covered by pieces):
  // 95th / 5th percentile of the modelled luminance at the samples used for the final fit.
  const Ys: number[] = [];
  for (let i = 0; i < s.n; i++) {
    if (weight[i] <= 0.3) continue;
    const L = Math.max(0, Math.min(100, evalPoly(coefficients[0], s.u[i], s.v[i])));
    Ys.push(((L + 16) / 116) ** 3);
  }
  const lo = quantile(Ys, 0.05), hi = quantile(Ys, 0.95);
  const ratio = Ys.length >= 20 && lo > 1e-4 ? hi / lo : lightingRatio({ coefficients });
  return { color, coefficients, sigma, width, height, lightingRatio: ratio };
}

/**
 * Per-pixel foreground score of a photo: colour distance to the background model in sigma units,
 * tolerant to cast shadows (same formula as used for the fit; Lab via lookup tables).
 */
export function foregroundScore(photo: RGBAImage, model: BackgroundFit): GrayImage {
  const { width: w, height: h, data: d } = photo;
  const out = createGray(w, h);
  const o = out.data;
  const [kL, ka, kb] = model.coefficients;
  const isL = 1 / model.sigma[0], isa = 1 / model.sigma[1], isb = 1 / model.sigma[2];
  const us = new Float32Array(w);
  for (let x = 0; x < w; x++) us[x] = norm(x, w);
  const lut = F_LUT, lin = LIN;
  const wl = W_L, rhoMin = RHO_MIN, pen0 = SHADOW_PENALTY / (1 - RHO_MIN);
  for (let y = 0; y < h; y++) {
    const v = norm(y, h);
    // c(u) = A + B·u + k3·u² per channel for this row.
    const AL = kL[0] + kL[2] * v + kL[5] * v * v, BL = kL[1] + kL[4] * v, CL = kL[3];
    const Aa = ka[0] + ka[2] * v + ka[5] * v * v, Ba = ka[1] + ka[4] * v, Ca = ka[3];
    const Ab = kb[0] + kb[2] * v + kb[5] * v * v, Bb = kb[1] + kb[4] * v, Cb = kb[3];
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = (row + x) << 2;
      const rl = lin[d[p]], gl = lin[d[p + 1]], bl = lin[d[p + 2]];
      // f(t) by linear interpolation in the cube-root table (t in [0, 1]).
      let t = (0.4339499 * rl + 0.3762098 * gl + 0.1898403 * bl) * F_N;
      let i = t | 0;
      const fx = lut[i] + (t - i) * (lut[i + 1] - lut[i]);
      t = (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) * F_N;
      i = t | 0;
      const fy = lut[i] + (t - i) * (lut[i + 1] - lut[i]);
      t = (0.0177566 * rl + 0.109468 * gl + 0.8727755 * bl) * F_N;
      i = t | 0;
      const fz = lut[i] + (t - i) * (lut[i + 1] - lut[i]);
      const L = 116 * fy - 16, A = 500 * (fx - fy), B = 200 * (fy - fz);
      const u = us[x], uu = u * u;
      const bL = AL + BL * u + CL * uu, ba = Aa + Ba * u + Ca * uu, bb = Ab + Bb * u + Cb * uu;
      const dL = (L - bL) * isL, da = (A - ba) * isa, db = (B - bb) * isb;
      let d2 = wl * dL * dL + da * da + db * db;
      if (L < bL) {
        const ref = bL + 16;
        let rho = ref > 1 ? (L + 16) / ref : 1;
        if (rho < rhoMin) rho = rhoMin;
        const sL = (L + 16 - rho * ref) * isL, sa = (A - rho * ba) * isa, sb = (B - rho * bb) * isb;
        const pen = pen0 * (1 - rho);
        const s2 = wl * sL * sL + sa * sa + sb * sb + pen * pen;
        if (s2 < d2) d2 = s2;
      }
      o[row + x] = Math.sqrt(d2);
    }
  }
  return out;
}
