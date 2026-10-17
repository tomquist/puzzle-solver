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
 * Further cost (sigmas per unit of ρ) of darkening beyond RHO_MIN: cast shadows next to pieces
 * hardly get that deep (large shadow zones are left to the local table model), dark pieces do.
 */
const DEEP_SHADOW_SLOPE = Number(globalThis.process?.env?.DSS ?? 25);
const RHO_DEEP = Number(globalThis.process?.env?.RDK ?? 0.8);
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
  const fx = Math.max(0, Math.min(g.cols - 1, (x + 0.5) / g.cellW)), fy = Math.max(0, Math.min(g.rows - 1, (y + 0.5) / g.cellH));
  const j0 = Math.min(g.cols - 2, Math.floor(fx)), i0 = Math.min(g.rows - 2, Math.floor(fy));
  if (g.cols < 2 || g.rows < 2) {
    const j = Math.round(fx), i = Math.round(fy), o = (i * g.cols + j) * 3;
    return [g.residual[o], g.residual[o + 1], g.residual[o + 2]];
  }
  const tx = fx - j0, ty = fy - i0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = g.residual[(i0 * g.cols + j0) * 3 + c], b = g.residual[(i0 * g.cols + j0 + 1) * 3 + c];
    const d = g.residual[((i0 + 1) * g.cols + j0) * 3 + c], e = g.residual[((i0 + 1) * g.cols + j0 + 1) * 3 + c];
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
  const vals: number[][] = [[], [], []];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      vals[0].length = vals[1].length = vals[2].length = 0;
      const cx = j * cellW, cy = i * cellH;
      const x0 = Math.max(0, Math.round(cx - cell / 2)), x1 = Math.min(w, Math.round(cx + cell / 2));
      const y0 = Math.max(0, Math.round(cy - cell / 2)), y1 = Math.min(h, Math.round(cy + cell / 2));
      let n = 0;
      for (let y = y0 + (step >> 1); y < y1; y += step) {
        for (let x = x0 + (step >> 1); x < x1; x += step) {
          n++;
          if (exclude.data[((y * exclude.height) / h | 0) * exclude.width + ((x * exclude.width) / w | 0)]) continue;
          const p = (y * w + x) * 4;
          const lab = rgbToLab(data[p], data[p + 1], data[p + 2]);
          const u = norm(x, w), v = norm(y, h);
          vals[0].push(lab[0] - evalPoly(k[0], u, v));
          vals[1].push(lab[1] - evalPoly(k[1], u, v));
          vals[2].push(lab[2] - evalPoly(k[2], u, v));
        }
      }
      if (vals[0].length < Math.max(20, 0.25 * n)) continue;
      valid[i * cols + j] = 1;
      for (let c = 0; c < 3; c++) res[(i * cols + j) * 3 + c] = median(vals[c]);
    }
  }
  // Fill cells without enough table from their neighbours (repeated averaging).
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
  let big = 0;
  for (let i = 0; i < cols * rows; i++) {
    for (let c = 0; c < 3; c++) big = Math.max(big, Math.abs(res[i * 3 + c]) / fit.sigma[c]);
  }
  return big >= LOCAL_MIN_RESIDUAL ? { cols, rows, cellW, cellH, residual: res } : null;
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
 * to cast shadows. `is*` are inverse sigmas. Shared by the model fit and the per-pixel score; the
 * fit leaves out the cost of darkening beyond RHO_MIN (`deep` = 0), so shadow zones stay table
 * there and are left to the local model rather than becoming a further table colour.
 */
function distance(L: number, a: number, b: number, bL: number, ba: number, bb: number, isL: number, isa: number, isb: number, deep = 0): number {
  const dL = (L - bL) * isL, da = (a - ba) * isa, db = (b - bb) * isb;
  let d2 = W_L * dL * dL + da * da + db * db;
  if (L < bL) {
    // Shadow hypothesis: Lab of an RGB-scaled colour ≈ (ρ(bL + 16) − 16, ρ·ba, ρ·bb).
    const ref = bL + 16;
    const raw = ref > 1 ? (L + 16) / ref : 1;
    const rho = Math.max(RHO_MIN, raw);
    const sL = (L + 16 - rho * ref) * isL, sa = (a - rho * ba) * isa, sb = (b - rho * bb) * isb;
    const pen = (SHADOW_PENALTY * (1 - rho)) / (1 - RHO_MIN) + (raw < RHO_DEEP ? deep * (RHO_DEEP - raw) : 0);
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

/** A palette colour under the lighting at (u, v). */
function paletteAt(fit: BackgroundFit, k: number, u: number, v: number): [number, number, number] {
  const p = fit.palette[k];
  const f = lightFactor(fit, u, v, p.refL);
  return [f * (p.color[0] + 16) - 16, f * p.color[1], f * p.color[2]];
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
    if (footprint < PALETTE_MIN_SHARE * band.length) break;
    // Colour and spread under the lighting at the members' mean.
    let refL = 0;
    for (const i of members) refL += evalPoly(fit.coefficients[0], s.u[i], s.v[i]);
    refL /= members.length;
    const color: [number, number, number] = [0, 0, 0], sigma: [number, number, number] = [0, 0, 0];
    const vals = new Float32Array(members.length);
    for (let ch = 0; ch < 3; ch++) {
      members.forEach((i, j) => { vals[j] = comp(i, refL)[ch]; });
      color[ch] = median(vals);
      members.forEach((i, j) => { vals[j] = Math.abs(comp(i, refL)[ch] - color[ch]); });
      // Spread of the paint itself: the MAD again over the core, without the blends at pattern edges.
      const mad = median(vals);
      const core = Array.from(vals).filter((v) => v <= 2.5 * mad);
      sigma[ch] = Math.max(SIGMA_FLOOR[ch], 1.2 * 1.4826 * (core.length >= 10 ? median(core) : mad));
    }
    // Plain paint is about as uniform as a plain table.
    if (sigma[1] > 3 * mainSigma[1] + 2 || sigma[2] > 3 * mainSigma[2] + 2 || sigma[0] > 3 * mainSigma[0] + 8) break;
    fit.palette.push({ color, sigma, refL, interior: 0 });
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
 * Per-pixel foreground score of a photo: colour distance to the background model in sigma units,
 * tolerant to cast shadows (same formula as used for the fit; Lab via lookup tables).
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
        const pen = pen0 * (1 - rho) + (raw < rhoDeep ? deep * (rhoDeep - raw) : 0);
        const s2 = wl * sL * sL + sa * sa + sb * sb + pen * pen;
        if (s2 < d2) d2 = s2;
      }
      o[row + x] = Math.sqrt(d2);
    }
  }
  return out;
}
