/**
 * Background colour model of a scan photo and the per-pixel foreground score.
 *
 * The background (table / cloth) is modelled per CIE Lab channel as a quadratic surface over the
 * photo, which absorbs smooth lighting gradients. It is initialised robustly from the photo's
 * border band and refined iteratively from all samples that look like background. The foreground
 * score is a noise-normalised colour distance to the model that tolerates soft cast shadows
 * (moderately darker pixels with proportionally scaled chroma). A patterned cloth (or the floor
 * beyond a table edge) adds further table colours: the score is then the distance to the nearest
 * table colour or blend of two.
 */
import { rgbToLab } from '../../cv/color';
import { solveLinear } from '../../cv/geometry';
import { createGray, type GrayImage, type Mask, type RGBAImage } from '../../cv/image';
import { dilate } from '../../cv/morphology';
import type { BackgroundModel, LocalTableGrid } from './types';
import { median, quantile } from './util';

const NT = 6;
/** Weight of lightness differences relative to chroma (lighting varies more than colour). */
const W_L = 0.5;
/** Lowest (L* + 16) ratio still explained as a cast shadow (≈ 50 % darkening in linear light). */
const RHO_MIN = 0.8;
/** Cost (in sigmas) of explaining a pixel as the deepest accepted shadow; shallower shadows cost less. */
const SHADOW_PENALTY = 2.5;
/**
 * Darkening beyond this (L* + 16) ratio (≈ 65 % less light) costs extra: cast shadows next to pieces
 * hardly get that deep (large shadow zones are left to the local table model), dark pieces do.
 */
const RHO_DEEP = 0.7;
/** Extra cost (sigmas per unit of ρ) of darkening beyond RHO_DEEP, so dark pieces stay strong. */
const DEEP_SHADOW_SLOPE = 25;
/**
 * Table lightness (L*) from which that extra cost applies: on a dark table, what is darker still is
 * mostly shadow and dark cardboard rims in the gaps between pieces lying close together.
 */
const DEEP_MIN_TABLE_L = 40;
/** Modelled table lightness from which saturated pixels are compared by lightness only (over-exposure). */
const CLIP_TABLE_L = 85;
/** Floors for the per-channel noise sigma (Lab units), so noise-free backgrounds stay sane. */
const SIGMA_FLOOR: [number, number, number] = [1.2, 1, 1];

/** The fitted part of a {@link BackgroundModel} (segmentation statistics are added later). */
export type BackgroundFit = Pick<BackgroundModel, 'color' | 'coefficients' | 'sigma' | 'width' | 'height' | 'lightingRatio' | 'bandFit' | 'palette' | 'local'>;

/** A further table colour (patterned cloth, floor beyond the table edge); see BackgroundModel.palette. */
export type PaletteColour = BackgroundModel['palette'][number];

/** Largest local table residual (sigmas) from which local corrections are used at all. */
const LOCAL_MIN_RESIDUAL = 3;
/** Share of the border band a further table colour must cover. */
const PALETTE_MIN_SHARE = 0.1;
/** Cost (sigmas) of explaining a pixel as a blend of two table colours (pattern edges, mixed weave). */
const MIX_PENALTY = 1;

function evalPoly(k: readonly number[], u: number, v: number): number {
  return k[0] + k[1] * u + k[2] * v + k[3] * u * u + k[4] * u * v + k[5] * v * v;
}

/** Normalised coordinate of pixel index `x` along an axis of length `n` (−1..1). */
function norm(x: number, n: number): number {
  return n > 1 ? (2 * x) / (n - 1) - 1 : 0;
}

/** Modelled background Lab colour at photo pixel (x, y) (smooth surface plus local corrections). */
export function backgroundAt(model: Pick<BackgroundModel, 'coefficients' | 'width' | 'height'> & { local?: LocalTableGrid }, x: number, y: number): [number, number, number] {
  const u = norm(x, model.width), v = norm(y, model.height);
  const k = model.coefficients;
  const c: [number, number, number] = [evalPoly(k[0], u, v), evalPoly(k[1], u, v), evalPoly(k[2], u, v)];
  if (model.local) {
    const r = localAt(model.local, x, y);
    c[0] += r[0]; c[1] += r[1]; c[2] += r[2];
  }
  return c;
}

/** Bilinear interpolation of the local residual grid at photo pixel (x, y). */
export function localAt(g: LocalTableGrid, x: number, y: number): [number, number, number] {
  const res = g.residual;
  const fx = Math.max(0, Math.min(g.cols - 1, (x + 0.5) / g.cellW)), fy = Math.max(0, Math.min(g.rows - 1, (y + 0.5) / g.cellH));
  const j0 = Math.min(g.cols - 2, Math.floor(fx)), i0 = Math.min(g.rows - 2, Math.floor(fy));
  if (g.cols < 2 || g.rows < 2) {
    const j = Math.round(fx), i = Math.round(fy), o = (i * g.cols + j) * 3;
    return [res[o], res[o + 1], res[o + 2]];
  }
  const tx = fx - j0, ty = fy - i0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = res[(i0 * g.cols + j0) * 3 + c], b = res[(i0 * g.cols + j0 + 1) * 3 + c];
    const d = res[((i0 + 1) * g.cols + j0) * 3 + c], e = res[((i0 + 1) * g.cols + j0 + 1) * 3 + c];
    out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }
  return out;
}

/** Local residual grid interpolated along one photo row: 3 values per node column. */
function localRow(g: LocalTableGrid, y: number): Float32Array {
  const fy = Math.max(0, Math.min(g.rows - 1, (y + 0.5) / g.cellH));
  const i0 = Math.min(Math.max(0, g.rows - 2), Math.floor(fy)), i1 = Math.min(g.rows - 1, i0 + 1), ty = fy - i0;
  const row = new Float32Array(g.cols * 3);
  for (let j = 0; j < g.cols; j++) {
    for (let c = 0; c < 3; c++) row[j * 3 + c] = g.residual[(i0 * g.cols + j) * 3 + c] * (1 - ty) + g.residual[(i1 * g.cols + j) * 3 + c] * ty;
  }
  return row;
}

/**
 * Local table-colour corrections: the median Lab residual (photo minus smooth model) of the table
 * pixels (`exclude` = objects; a mask at any resolution, stretched over the photo) in a
 * `cell`-sized window around each node of a grid with half that spacing, so shadow zones and local
 * lighting the quadratic surface cannot follow become table. The outer nodes sit on the photo
 * border (half windows there), so a shadow reaching in from the edge is followed up to the edge.
 * Nodes with too little table are filled from their neighbours. Returns null when the residuals
 * are negligible everywhere (< LOCAL_MIN_RESIDUAL sigmas).
 */
export function fitLocalTable(photo: RGBAImage, fit: BackgroundFit, exclude: Mask, cell: number): LocalTableGrid | null {
  const { width: w, height: h, data } = photo;
  const cols = Math.max(2, Math.round((2 * w) / cell) + 1), rows = Math.max(2, Math.round((2 * h) / cell) + 1);
  const cellW = w / (cols - 1), cellH = h / (rows - 1);
  const step = Math.max(2, Math.round(cell / 18));
  const res = new Float32Array(cols * rows * 3);
  const valid = new Uint8Array(cols * rows);
  const k = fit.coefficients;
  // Residuals of the table samples on one regular grid (NaN = excluded), shared by the overlapping
  // windows.
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
  const samp = new Float32Array(sw * sh * 3).fill(NaN);
  const ew = exclude.width, eh = exclude.height;
  for (let j = 0; j < sh; j++) {
    const y = Math.min(h - 1, j * step + (step >> 1));
    const v = norm(y, h), erow = (((y * eh) / h) | 0) * ew;
    for (let i = 0; i < sw; i++) {
      const x = Math.min(w - 1, i * step + (step >> 1));
      if (exclude.data[erow + (((x * ew) / w) | 0)]) continue;
      const p = (y * w + x) * 4;
      const lab = rgbToLab(data[p], data[p + 1], data[p + 2]);
      const u = norm(x, w), o = (j * sw + i) * 3;
      samp[o] = lab[0] - evalPoly(k[0], u, v);
      samp[o + 1] = lab[1] - evalPoly(k[1], u, v);
      samp[o + 2] = lab[2] - evalPoly(k[2], u, v);
    }
  }
  const vals: number[][] = [[], [], []];
  const first = (lo: number) => Math.max(0, Math.ceil((lo - (step >> 1)) / step - 1e-9));
  const last = (hi: number, n: number) => Math.min(n - 1, Math.floor((hi - (step >> 1)) / step - 1e-9));
  for (let r = 0; r < rows; r++) {
    const cy = r * cellH, j0 = first(cy - cell / 2), j1 = last(cy + cell / 2, sh);
    for (let c = 0; c < cols; c++) {
      const cx = c * cellW, i0 = first(cx - cell / 2), i1 = last(cx + cell / 2, sw);
      vals[0].length = vals[1].length = vals[2].length = 0;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const o = (j * sw + i) * 3;
          if (Number.isNaN(samp[o])) continue;
          vals[0].push(samp[o]);
          vals[1].push(samp[o + 1]);
          vals[2].push(samp[o + 2]);
        }
      }
      const n = Math.max(0, (j1 - j0 + 1) * (i1 - i0 + 1));
      if (vals[0].length < Math.max(20, 0.25 * n)) continue;
      valid[r * cols + c] = 1;
      for (let ch = 0; ch < 3; ch++) res[(r * cols + c) * 3 + ch] = median(vals[ch]);
    }
  }
  fillFromNeighbours(res, valid, cols, rows);
  let big = 0;
  for (let i = 0; i < cols * rows; i++) {
    for (let c = 0; c < 3; c++) big = Math.max(big, Math.abs(res[i * 3 + c]) / fit.sigma[c]);
  }
  return big >= LOCAL_MIN_RESIDUAL ? { cols, rows, cellW, cellH, residual: res } : null;
}

/** Give grid nodes without enough table the mean of their valid neighbours (repeated). */
function fillFromNeighbours(res: Float32Array, valid: Uint8Array, cols: number, rows: number): void {
  for (let guard = 0; guard < cols + rows; guard++) {
    let missing = 0;
    const next = Uint8Array.from(valid);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (valid[i * cols + j]) continue;
        let n = 0;
        const sum = [0, 0, 0];
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= rows || jj >= cols || !valid[ii * cols + jj]) continue;
          n++;
          for (let c = 0; c < 3; c++) sum[c] += res[(ii * cols + jj) * 3 + c];
        }
        if (n === 0) { missing++; continue; }
        for (let c = 0; c < 3; c++) res[(i * cols + j) * 3 + c] = sum[c] / n;
        next[i * cols + j] = 1;
      }
    }
    valid.set(next);
    if (missing === 0) break;
  }
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
 * to cast shadows. `is*` are inverse sigmas. Used by the model fit and the palette score; unlike
 * the main per-pixel score ({@link foregroundScore}) it adds no extra cost for darkening beyond
 * RHO_DEEP, so deep shadow zones stay table for the fit (and are left to the local model) rather
 * than becoming a further table colour.
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
  /** 1 = a channel is saturated (≥ 254): no noise, colour unreliable (over-exposed table). */
  clip: Uint8Array;
  gw: number;
  gh: number;
}

function takeSamples(photo: RGBAImage): Samples {
  const { width: w, height: h, data } = photo;
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 25000)));
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step);
  const n = gw * gh;
  const u = new Float32Array(n), v = new Float32Array(n), c = new Float32Array(n * 3), band = new Uint8Array(n), clip = new Uint8Array(n);
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
      clip[i] = Math.max(data[p], data[p + 1], data[p + 2]) >= 254 ? 1 : 0;
    }
  }
  return { n, u, v, lab: c, band, clip, gw, gh };
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
  // Over-exposed (clipped) table has no noise: leave it out of the spread estimates unless it is
  // most of the table (it would make the spread, and so every score threshold, far too tight).
  let clipped = 0;
  for (let i = 0; i < s.n; i++) clipped += s.clip[i];
  const skipClipped = clipped > 0 && s.n - clipped >= 0.3 * s.n;
  // 1) Robust start from the border band: per-channel median and spread.
  let bandIdx: number[] = [];
  for (let i = 0; i < s.n; i++) if (s.band[i] && !(skipClipped && s.clip[i])) bandIdx.push(i);
  if (bandIdx.length < 3 * NT) {
    bandIdx = [];
    for (let i = 0; i < s.n; i++) if (s.band[i]) bandIdx.push(i);
  }
  const color: [number, number, number] = [0, 0, 0];
  const sigma: [number, number, number] = [0, 0, 0];
  const tmp = new Float32Array(bandIdx.length);
  // Local spread: differences between neighbouring band samples (noise + texture, but not a second
  // surface such as the floor beyond the table edge, which would inflate the global spread and let
  // that surface into the first fit).
  const inBand = new Uint8Array(s.n);
  for (const i of bandIdx) inBand[i] = 1;
  const diffs: number[][] = [[], [], []];
  for (const i of bandIdx) {
    const gx = i % s.gw;
    for (const j of [gx + 1 < s.gw ? i + 1 : -1, i + s.gw < s.n ? i + s.gw : -1]) {
      if (j < 0 || !inBand[j]) continue;
      for (let ch = 0; ch < 3; ch++) diffs[ch].push(Math.abs(s.lab[i * 3 + ch] - s.lab[j * 3 + ch]));
    }
  }
  const bandAll: number[] = [];
  for (let i = 0; i < s.n; i++) if (s.band[i]) bandAll.push(i);
  const all = new Float32Array(bandAll.length);
  for (let ch = 0; ch < 3; ch++) {
    for (let j = 0; j < bandAll.length; j++) all[j] = s.lab[bandAll[j] * 3 + ch];
    color[ch] = median(all);
    for (let j = 0; j < bandIdx.length; j++) tmp[j] = Math.abs(s.lab[bandIdx[j] * 3 + ch] - color[ch]);
    const global = 1.4826 * median(tmp);
    const local = diffs[ch].length >= 20 ? (1.4826 * median(diffs[ch])) / Math.SQRT2 : Infinity;
    // Lightness also varies with the lighting gradient (fitted next), so only chroma is limited.
    sigma[ch] = Math.max(SIGMA_FLOOR[ch], ch === 0 ? global : Math.min(global, 2 * local));
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
      if (weight[i] <= 0.3 || (skipClipped && s.clip[i])) continue;
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
  const fit: BackgroundFit = { color, coefficients, sigma, width, height, lightingRatio: ratio, bandFit: 1, palette: [] };
  findPalette(s, fit);
  // How well the table model explains the border band (low for a patterned cloth it cannot follow).
  let bandN = 0, bandIn = 0;
  for (let i = 0; i < s.n; i++) {
    if (!s.band[i]) continue;
    bandN++;
    if (sampleDistance(s, i, fit) < 3.5) bandIn++;
  }
  fit.bandFit = bandN > 0 ? bandIn / bandN : 1;
  return fit;
}

/** Lighting factor of the main surface at (u, v) relative to lightness `ref` ((L + 16) ratio). */
function lightFactor(fit: BackgroundFit, u: number, v: number, ref: number): number {
  return Math.max(0.2, (evalPoly(fit.coefficients[0], u, v) + 16) / (ref + 16));
}

/** Own lighting of a palette colour at (u, v) relative to the main surface's (factor on L* + 16). */
function ownLight(p: PaletteColour, u: number, v: number): number {
  return Math.exp(p.light[0] + p.light[1] * u + p.light[2] * v);
}

/** A palette colour under the lighting at (u, v). */
function paletteAt(fit: BackgroundFit, k: number, u: number, v: number): [number, number, number] {
  const p = fit.palette[k];
  const f = lightFactor(fit, u, v, p.refL) * ownLight(p, u, v);
  return [f * (p.color[0] + 16) - 16, f * p.color[1], f * p.color[2]];
}

/** Range of (L* + 16) ratios to the main-lit colour within which a sample may show a second surface. */
const OWN_LIGHT_RANGE: [number, number] = [0.6, 1.6];
/** Ridge weight (per sample) that keeps a palette colour's own lighting near the main surface's. */
const OWN_LIGHT_RIDGE = 0.05;

/**
 * Own lighting of a further table colour: a second surface (another table, a board, the floor
 * beyond the table edge) faces the light differently from the main one, so its brightness follows
 * a gradient of its own. Fitted as a plane of log (L* + 16) ratios over the samples `idx` that show
 * the colour under some brightness (chroma scaled alike, ratio within OWN_LIGHT_RANGE), with robust
 * refits and a ridge towards the main surface's lighting; zero (the main lighting) with too few
 * samples.
 */
function fitOwnLight(s: Samples, fit: BackgroundFit, idx: readonly number[], p: PaletteColour): [number, number, number] {
  const us: number[] = [], vs: number[] = [], ys: number[] = [];
  const ta = 3 * Math.max(1.5, p.sigma[1]), tb = 3 * Math.max(1.5, p.sigma[2]);
  for (const i of idx) {
    const u = s.u[i], v = s.v[i];
    const f = lightFactor(fit, u, v, p.refL);
    const L = s.lab[i * 3], a = s.lab[i * 3 + 1], b = s.lab[i * 3 + 2];
    const rho = (L + 16) / (f * (p.color[0] + 16));
    if (!(rho >= OWN_LIGHT_RANGE[0] && rho <= OWN_LIGHT_RANGE[1])) continue;
    if (Math.abs(a - rho * f * p.color[1]) > ta || Math.abs(b - rho * f * p.color[2]) > tb) continue;
    us.push(u);
    vs.push(v);
    ys.push(Math.log(rho));
  }
  const n = ys.length;
  if (n < 20) return [0, 0, 0];
  let g: number[] = [0, 0, 0];
  const w = new Float64Array(n).fill(1);
  for (let iter = 0; iter < 4; iter++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
    let total = 0;
    for (let j = 0; j < n; j++) {
      const f = [1, us[j], vs[j]];
      for (let a = 0; a < 3; a++) {
        r[a] += w[j] * f[a] * ys[j];
        for (let b = 0; b < 3; b++) A[a][b] += w[j] * f[a] * f[b];
      }
      total += w[j];
    }
    for (let a = 0; a < 3; a++) A[a][a] += OWN_LIGHT_RIDGE * total;
    const sol = solveLinear(A, r);
    if (!sol) break;
    g = sol;
    const res = ys.map((y, j) => Math.abs(y - g[0] - g[1] * us[j] - g[2] * vs[j]));
    const c = 4.685 * Math.max(0.02, 1.4826 * median(res));
    for (let j = 0; j < n; j++) {
      const t = res[j] / c;
      w[j] = t < 1 ? (1 - t * t) ** 2 : 0;
    }
  }
  return [g[0], g[1], g[2]];
}

/** Noise and texture of a set of samples: robust spread of the differences between neighbouring members. */
function localSpread(s: Samples, idx: readonly number[]): [number, number, number] {
  const member = new Uint8Array(s.n);
  for (const i of idx) member[i] = 1;
  const d: number[][] = [[], [], []];
  for (const i of idx) {
    const gx = i % s.gw;
    for (const j of [gx + 1 < s.gw ? i + 1 : -1, i + s.gw < s.n ? i + s.gw : -1]) {
      if (j < 0 || !member[j]) continue;
      for (let ch = 0; ch < 3; ch++) d[ch].push(Math.abs(s.lab[i * 3 + ch] - s.lab[j * 3 + ch]));
    }
  }
  return [0, 1, 2].map((ch) => (d[ch].length >= 20 ? (1.4826 * median(d[ch])) / Math.SQRT2 : Infinity)) as [number, number, number];
}

/**
 * Distance (sigmas) of Lab colour (L, a, b) from the segment between table colours P and Q: a blend
 * of two colours of a patterned cloth (anti-aliased pattern edges, blur). `is*` are inverse sigmas.
 */
function mixDistance(L: number, a: number, b: number, P: readonly number[], Q: readonly number[], isL: number, isa: number, isb: number): number {
  const wl = Math.sqrt(W_L);
  const px = P[0] * isL * wl, py = P[1] * isa, pz = P[2] * isb;
  const dx = Q[0] * isL * wl - px, dy = Q[1] * isa - py, dz = Q[2] * isb - pz;
  const cx = L * isL * wl - px, cy = a * isa - py, cz = b * isb - pz;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (cx * dx + cy * dy + cz * dz) / len2)) : 0;
  const ex = cx - t * dx, ey = cy - t * dy, ez = cz - t * dz;
  return Math.sqrt(ex * ex + ey * ey + ez * ez + MIX_PENALTY * MIX_PENALTY);
}

/** Distance of a colour at (u, v) to the whole table model (main surface, palette colours, blends). */
function modelDistance(L: number, a: number, b: number, u: number, v: number, fit: BackgroundFit): number {
  const k = fit.coefficients;
  const main = [evalPoly(k[0], u, v), evalPoly(k[1], u, v), evalPoly(k[2], u, v)];
  const is = fit.sigma;
  let d = distance(L, a, b, main[0], main[1], main[2], 1 / is[0], 1 / is[1], 1 / is[2]);
  const cols = [main];
  for (let j = 0; j < fit.palette.length; j++) {
    const c = paletteAt(fit, j, u, v);
    const sg = fit.palette[j].sigma;
    d = Math.min(d, distance(L, a, b, c[0], c[1], c[2], 1 / sg[0], 1 / sg[1], 1 / sg[2]));
    for (let m = 0; m < cols.length; m++) {
      const sm = m === 0 ? is : fit.palette[m - 1].sigma;
      d = Math.min(d, mixDistance(L, a, b, cols[m], c, 1 / Math.max(sm[0], sg[0]), 1 / Math.max(sm[1], sg[1]), 1 / Math.max(sm[2], sg[2])));
    }
    cols.push(c);
  }
  return d;
}

function sampleDistance(s: Samples, i: number, fit: BackgroundFit): number {
  return modelDistance(s.lab[i * 3], s.lab[i * 3 + 1], s.lab[i * 3 + 2], s.u[i], s.v[i], fit);
}

/**
 * Further table colours: a patterned cloth (check, dots) or the floor beyond the table edge shows
 * as compact colour clusters in the border band that the smooth main surface does not explain. Up
 * to two are added, each the densest colour of the unexplained band samples (lighting-compensated,
 * so one paint under a gradient stays one colour), covering ≥ 10 % of the band with a spread like
 * plain paint (pieces lying on the border are too varied and too small a share).
 */
function findPalette(s: Samples, fit: BackgroundFit): void {
  const band: number[] = [];
  let meanL = 0;
  for (let i = 0; i < s.n; i++) {
    if (!s.band[i]) continue;
    band.push(i);
    meanL += evalPoly(fit.coefficients[0], s.u[i], s.v[i]);
  }
  if (band.length < 50) return;
  meanL /= band.length;
  const wl = Math.sqrt(W_L);
  // Lighting-compensated Lab of a sample (as if lit like the band's mean).
  const comp = (i: number, ref: number): [number, number, number] => {
    const f = lightFactor(fit, s.u[i], s.v[i], ref);
    return [(s.lab[i * 3] + 16) / f - 16, s.lab[i * 3 + 1] / f, s.lab[i * 3 + 2] / f];
  };
  // Lab of a sample as if lit like a palette colour's reference (main and own lighting compensated).
  const lit = (i: number, p: PaletteColour): [number, number, number] => {
    const f = lightFactor(fit, s.u[i], s.v[i], p.refL) * ownLight(p, s.u[i], s.v[i]);
    return [(s.lab[i * 3] + 16) / f - 16, s.lab[i * 3 + 1] / f, s.lab[i * 3 + 2] / f];
  };
  const mainSigma: [number, number, number] = [fit.sigma[0], fit.sigma[1], fit.sigma[2]];
  for (let round = 0; round < 2; round++) {
    const out = band.filter((i) => sampleDistance(s, i, fit) >= 3.5);
    if (out.length < PALETTE_MIN_SHARE * band.length) break;
    // Densest colour: 4-unit Lab bins, counted over each bin's 3×3×3 neighbourhood.
    const pts = out.map((i) => comp(i, meanL));
    const key = (q: readonly number[]) => `${Math.floor((q[0] * wl) / 4)},${Math.floor(q[1] / 4)},${Math.floor(q[2] / 4)}`;
    const bins = new Map<string, number>();
    for (const q of pts) bins.set(key(q), (bins.get(key(q)) ?? 0) + 1);
    let bestKey = '', bestN = -1;
    for (const k of bins.keys()) {
      const [x, y, z] = k.split(',').map(Number);
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) n += bins.get(`${x + dx},${y + dy},${z + dz}`) ?? 0;
      if (n > bestN) { bestN = n; bestKey = k; }
    }
    const [bx, by, bz] = bestKey.split(',').map(Number);
    const centre = [(bx + 0.5) * 4 / wl, (by + 0.5) * 4, (bz + 0.5) * 4];
    // Members: within 8 units (lightness weighted) of the mode, refined once around their median;
    // the share also counts the blends around the colour (pattern edges, within 16 units).
    const within = (c: readonly number[], q: readonly number[], r: number) => Math.hypot((q[0] - c[0]) * wl, q[1] - c[1], q[2] - c[2]) <= r;
    let members = out.filter((_, j) => within(centre, pts[j], 8));
    if (members.length < 10) break;
    const med = [0, 1, 2].map((ch) => median(members.map((i) => comp(i, meanL)[ch])));
    members = out.filter((_, j) => within(med, pts[j], 8));
    if (members.length < 10) break;
    // Its footprint: the colour itself plus its blends with the main surface (pattern edges).
    let footprint = 0;
    const is = [1 / Math.max(2, mainSigma[0]), 1 / Math.max(2, mainSigma[1]), 1 / Math.max(2, mainSigma[2])];
    out.forEach((i, j) => {
      const q = pts[j];
      if (within(med, q, 16)) { footprint++; return; }
      const f = lightFactor(fit, s.u[i], s.v[i], meanL);
      const k = fit.coefficients;
      const m = [(evalPoly(k[0], s.u[i], s.v[i]) + 16) / f - 16, evalPoly(k[1], s.u[i], s.v[i]) / f, evalPoly(k[2], s.u[i], s.v[i]) / f];
      if (mixDistance(q[0], q[1], q[2], m, med, is[0], is[1], is[2]) < 3.5) footprint++;
    });
    if (globalThis.process?.env?.PALDBG) globalThis.console.log('PALDBG round', round, 'band', band.length, 'out', out.length, 'members', members.length, 'med', med.map((v) => v.toFixed(1)).join(','), 'footprint', footprint, 'need', (PALETTE_MIN_SHARE * band.length).toFixed(0));
    if (footprint < PALETTE_MIN_SHARE * band.length) break;
    // Colour and spread under the lighting at the members' mean.
    let refL = 0;
    for (const i of members) refL += evalPoly(fit.coefficients[0], s.u[i], s.v[i]);
    refL /= members.length;
    const colour: PaletteColour = { color: [0, 0, 0], sigma: [0, 0, 0], refL, light: [0, 0, 0], interior: 0 };
    const estimate = (idx: readonly number[]) => {
      const vals = new Float32Array(idx.length);
      for (let ch = 0; ch < 3; ch++) {
        idx.forEach((i, j) => { vals[j] = lit(i, colour)[ch]; });
        colour.color[ch] = median(vals);
        idx.forEach((i, j) => { vals[j] = Math.abs(lit(i, colour)[ch] - colour.color[ch]); });
        // Spread of the paint itself: the MAD again over the core, without the blends at pattern edges.
        const mad = median(vals);
        const core = Array.from(vals).filter((v) => v <= 2.5 * mad);
        colour.sigma[ch] = Math.max(SIGMA_FLOOR[ch], 1.2 * 1.4826 * (core.length >= 10 ? median(core) : mad));
      }
    };
    estimate(members);
    // A second surface is lit in its own way: with that lighting, its members are all the samples
    // showing it (not only those lit like the mode), and colour and spread come from them.
    colour.light = fitOwnLight(s, fit, out, colour);
    const litMembers = out.filter((i) => within(colour.color, lit(i, colour), 8));
    if (litMembers.length >= members.length) estimate(litMembers);
    // Plain paint is about as uniform as a plain table: judged by the differences between
    // neighbouring samples showing it (a lighting gradient adds nothing to them, print does).
    const localSigma = localSpread(s, litMembers.length >= members.length ? litMembers : members);
    if (globalThis.process?.env?.PALDBG) globalThis.console.log('PALDBG local', localSigma.map((v) => v.toFixed(2)).join(','), 'sigma', colour.sigma.map((v) => v.toFixed(2)).join(','), 'main', mainSigma.map((v) => v.toFixed(2)).join(','), 'color', colour.color.map((v) => v.toFixed(1)).join(','), 'light', colour.light.map((v) => v.toFixed(3)).join(','), 'members', members.length, litMembers.length);
    if (localSigma[1] > 2 * mainSigma[1] + 1 || localSigma[2] > 2 * mainSigma[2] + 1 || localSigma[0] > 2 * mainSigma[0] + 1.5) break;
    fit.palette.push(colour);
  }
  if (fit.palette.length === 0) return;
  // With the other colours known, the main surface's own spread (a fine pattern inflates it).
  const res: number[][] = [[], [], []];
  for (const i of band) {
    const L = s.lab[i * 3], a = s.lab[i * 3 + 1], b = s.lab[i * 3 + 2];
    const k = fit.coefficients;
    const m = [evalPoly(k[0], s.u[i], s.v[i]), evalPoly(k[1], s.u[i], s.v[i]), evalPoly(k[2], s.u[i], s.v[i])];
    const dm = distance(L, a, b, m[0], m[1], m[2], 1 / fit.sigma[0], 1 / fit.sigma[1], 1 / fit.sigma[2]);
    if (dm >= 3.5) continue;
    let closerElsewhere = false;
    for (let j = 0; j < fit.palette.length && !closerElsewhere; j++) {
      const c = paletteAt(fit, j, s.u[i], s.v[i]), sg = fit.palette[j].sigma;
      if (distance(L, a, b, c[0], c[1], c[2], 1 / sg[0], 1 / sg[1], 1 / sg[2]) < dm) closerElsewhere = true;
    }
    if (closerElsewhere) continue;
    res[0].push(Math.abs(L - m[0]));
    res[1].push(Math.abs(a - m[1]));
    res[2].push(Math.abs(b - m[2]));
  }
  if (res[0].length >= 30) for (let ch = 0; ch < 3; ch++) fit.sigma[ch] = Math.max(SIGMA_FLOOR[ch], Math.min(fit.sigma[ch], 1.4826 * median(res[ch])));
  // How much of the middle of the photo (central 70 % per axis) shows each further colour: a pattern
  // spreads over the whole table, the floor beyond a table edge stays near the border.
  if (fit.palette.length === 0) return;
  const count = new Float64Array(fit.palette.length);
  let n = 0;
  for (let i = 0; i < s.n; i++) {
    if (Math.abs(s.u[i]) > 0.7 || Math.abs(s.v[i]) > 0.7) continue;
    n++;
    for (let k = 0; k < fit.palette.length; k++) {
      const c = paletteAt(fit, k, s.u[i], s.v[i]), sg = fit.palette[k].sigma;
      if (distance(s.lab[i * 3], s.lab[i * 3 + 1], s.lab[i * 3 + 2], c[0], c[1], c[2], 1 / sg[0], 1 / sg[1], 1 / sg[2]) < 3) count[k]++;
    }
  }
  fit.palette.forEach((p, k) => { p.interior = n > 0 ? count[k] / n : 0; });
}

/**
 * Foreground score against a table with several colours (see {@link foregroundScore}): distance to
 * the nearest table colour or blend of two. The table colours are evaluated once per 8-px run
 * (lighting changes slowly).
 */
function paletteScore(photo: RGBAImage, model: BackgroundFit, out: GrayImage): GrayImage {
  const { width: w, height: h, data: d } = photo;
  const nc = model.palette.length + 1;
  const sig = [model.sigma, ...model.palette.map((p) => p.sigma)];
  const inv = sig.map((s) => [1 / s[0], 1 / s[1], 1 / s[2]]);
  const pairInv: number[][][] = [];
  for (let i = 0; i < nc; i++) {
    pairInv.push([]);
    for (let j = 0; j < nc; j++) pairInv[i].push([1 / Math.max(sig[i][0], sig[j][0]), 1 / Math.max(sig[i][1], sig[j][1]), 1 / Math.max(sig[i][2], sig[j][2])]);
  }
  const k = model.coefficients;
  const lut = F_LUT, lin = LIN;
  const cols: number[][] = Array.from({ length: nc }, () => [0, 0, 0]);
  for (let y = 0; y < h; y++) {
    const v = norm(y, h);
    for (let x0 = 0; x0 < w; x0 += 8) {
      const u = norm(Math.min(w - 1, x0 + 4), w);
      cols[0][0] = evalPoly(k[0], u, v); cols[0][1] = evalPoly(k[1], u, v); cols[0][2] = evalPoly(k[2], u, v);
      for (let j = 1; j < nc; j++) {
        const c = paletteAt(model, j - 1, u, v);
        cols[j][0] = c[0]; cols[j][1] = c[1]; cols[j][2] = c[2];
      }
      for (let x = x0; x < Math.min(w, x0 + 8); x++) {
        const p = (y * w + x) << 2;
        const rl = lin[d[p]], gl = lin[d[p + 1]], bl = lin[d[p + 2]];
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
        let best = Infinity;
        for (let a = 0; a < nc; a++) {
          const c = cols[a], q = inv[a];
          const dd = distance(L, A, B, c[0], c[1], c[2], q[0], q[1], q[2]);
          if (dd < best) best = dd;
          for (let b2 = 0; b2 < a; b2++) {
            const r = pairInv[a][b2];
            const m = mixDistance(L, A, B, cols[b2], c, r[0], r[1], r[2]);
            if (m < best) best = m;
          }
        }
        out.data[y * w + x] = best;
      }
    }
  }
  return out;
}

/**
 * Per-pixel foreground score of a photo: colour distance to the background model (plus the local
 * corrections, when present) in sigma units, tolerant to cast shadows (the fit's formula, plus an
 * extra cost for darkening beyond RHO_DEEP so dark table-coloured pieces stay strong; Lab via
 * lookup tables).
 */
export function foregroundScore(photo: RGBAImage, model: BackgroundFit): GrayImage {
  const { width: w, height: h, data: d } = photo;
  const out = createGray(w, h);
  if (model.palette.length > 0) return paletteScore(photo, model, out);
  const o = out.data;
  const [kL, ka, kb] = model.coefficients;
  const isL = 1 / model.sigma[0], isa = 1 / model.sigma[1], isb = 1 / model.sigma[2];
  const us = new Float32Array(w);
  for (let x = 0; x < w; x++) us[x] = norm(x, w);
  const lut = F_LUT, lin = LIN;
  const wl = W_L, rhoMin = RHO_MIN, pen0 = SHADOW_PENALTY / (1 - RHO_MIN), deep = DEEP_SHADOW_SLOPE, rhoDeep = RHO_DEEP;
  // Local corrections per pixel column for the current row (bilinear in the grid).
  const g = model.local;
  const corr = g ? new Float32Array(w * 3) : null;
  const colPos = g ? Float32Array.from({ length: w }, (_, x) => Math.max(0, Math.min(g.cols - 1, (x + 0.5) / g.cellW))) : null;
  for (let y = 0; y < h; y++) {
    const v = norm(y, h);
    // c(u) = A + B·u + k3·u² per channel for this row.
    const AL = kL[0] + kL[2] * v + kL[5] * v * v, BL = kL[1] + kL[4] * v, CL = kL[3];
    const Aa = ka[0] + ka[2] * v + ka[5] * v * v, Ba = ka[1] + ka[4] * v, Ca = ka[3];
    const Ab = kb[0] + kb[2] * v + kb[5] * v * v, Bb = kb[1] + kb[4] * v, Cb = kb[3];
    if (g && corr && colPos) {
      const nodes = localRow(g, y);
      for (let x = 0; x < w; x++) {
        const f = colPos[x], j0 = Math.min(Math.max(0, g.cols - 2), Math.floor(f)), j1 = Math.min(g.cols - 1, j0 + 1), t = f - j0;
        for (let c = 0; c < 3; c++) corr[x * 3 + c] = nodes[j0 * 3 + c] * (1 - t) + nodes[j1 * 3 + c] * t;
      }
    }
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
      let bL = AL + BL * u + CL * uu, ba = Aa + Ba * u + Ca * uu, bb = Ab + Bb * u + Cb * uu;
      if (corr) {
        bL += corr[x * 3];
        ba += corr[x * 3 + 1];
        bb += corr[x * 3 + 2];
      }
      const dL = (L - bL) * isL, da = (A - ba) * isa, db = (B - bb) * isb;
      let d2 = wl * dL * dL + da * da + db * db;
      if (bL >= CLIP_TABLE_L && d[p] >= 254 && d[p + 1] >= 254 && d[p + 2] >= 254) {
        // Over-exposed light table: the clipped colour is meaningless, compare lightness only.
        d2 = Math.min(d2, wl * dL * dL);
      } else if (L < bL) {
        const ref = bL + 16;
        const raw = ref > 1 ? (L + 16) / ref : 1;
        const rho = raw < rhoMin ? rhoMin : raw;
        const sL = (L + 16 - rho * ref) * isL, sa = (A - rho * ba) * isa, sb = (B - rho * bb) * isb;
        const pen = pen0 * (1 - rho) + (raw < rhoDeep && bL >= DEEP_MIN_TABLE_L ? deep * (rhoDeep - raw) : 0);
        const s2 = wl * sL * sL + sa * sa + sb * sb + pen * pen;
        if (s2 < d2) d2 = s2;
      }
      o[row + x] = Math.sqrt(d2);
    }
  }
  return out;
}
