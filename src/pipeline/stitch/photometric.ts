/**
 * Photometric compensation of a close-up against the reference: per colour channel, a gain and an
 * offset that vary smoothly across the close-up (exposure, white balance, a lighting gradient and
 * radial vignetting):
 *
 *   ref ≈ c · (g0 + gu·u + gv·v + gr·(u² + v²)) + (o0 + ou·u + ov·v),   u, v ∈ [-1, 1] across the close-up
 *
 * (u, v normalised by the close-up image size, so the model also applies to resized copies).
 *
 * Fitted robustly (Huber IRLS) on block means over the overlap, so the comparison happens at a
 * resolution both images share and is insensitive to the close-up's extra detail.
 */
import { mat3Invert, solveLinear, type Mat3 } from '../../cv/geometry';
import { clampRect, type RGBAImage } from '../../cv/image';
import { sampleLinear } from './sampling';
import { imageCorners, mapPolygon, smoothstep } from './util';

/** Per channel R, G, B: [g0, gu, gv, gr, o0, ou, ov] (21 numbers). */
/** Coefficients per channel. */
export const MODEL_TERMS = 7;

export interface PhotometricModel {
  coeffs: Float64Array;
}

export function identityPhotometric(): PhotometricModel {
  const c = new Float64Array(3 * MODEL_TERMS);
  c[0] = c[MODEL_TERMS] = c[2 * MODEL_TERMS] = 1;
  return { coeffs: c };
}

/** Apply the model to channel `ch` of a close-up value at normalised close-up position (u, v). */
export function applyPhotometric(m: PhotometricModel, ch: number, value: number, u: number, v: number): number {
  const k = m.coeffs, o = ch * MODEL_TERMS;
  return value * (k[o] + k[o + 1] * u + k[o + 2] * v + k[o + 3] * (u * u + v * v)) + k[o + 4] + k[o + 5] * u + k[o + 6] * v;
}

export interface PhotometricFitOptions {
  /** Block size in reference pixels for the block means (default 4). */
  block?: number;
}

/**
 * Per-block agreement (0..1) between the compensated close-up and the reference, on a grid of
 * `block`-sized reference-pixel blocks starting at (x0, y0). Low where the close-up shows something
 * the reference does not (glare, shadows, fingers, local misregistration).
 */
export interface ConsistencyMap {
  x0: number;
  y0: number;
  block: number;
  width: number;
  height: number;
  data: Float32Array;
}

export interface PhotometryResult {
  model: PhotometricModel;
  consistency: ConsistencyMap | null;
}

/** Bilinear lookup of a consistency map at reference pixel (x, y); 1 outside the map. */
export function sampleConsistency(m: ConsistencyMap, x: number, y: number): number {
  const gx = (x - m.x0 + 0.5) / m.block - 0.5;
  const gy = (y - m.y0 + 0.5) / m.block - 0.5;
  if (gx < -1 || gy < -1 || gx > m.width || gy > m.height) return 1;
  const x0 = Math.max(0, Math.min(m.width - 1, Math.floor(gx))), y0 = Math.max(0, Math.min(m.height - 1, Math.floor(gy)));
  const x1 = Math.min(m.width - 1, x0 + 1), y1 = Math.min(m.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
  const d = m.data, w = m.width;
  return (
    d[y0 * w + x0] * (1 - fx) * (1 - fy) + d[y0 * w + x1] * fx * (1 - fy) +
    d[y1 * w + x0] * (1 - fx) * fy + d[y1 * w + x1] * fx * fy
  );
}

/**
 * Robust (Huber IRLS) linear least squares. `ridge[a]` damps parameter a relative to its diagonal
 * entry of the normal equations (scale-invariant). Returns null when singular.
 */
function irls(rows: Float64Array, targets: Float64Array, n: number, p: number, ridge: number[]): number[] | null {
  const w = new Float64Array(n).fill(1);
  let beta: number[] | null = null;
  for (let it = 0; it < 5; it++) {
    const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const b = new Array<number>(p).fill(0);
    for (let i = 0; i < n; i++) {
      const wi = w[i];
      if (wi === 0) continue;
      const o = i * p;
      for (let a = 0; a < p; a++) {
        const ra = rows[o + a] * wi;
        b[a] += ra * targets[i];
        for (let c = a; c < p; c++) A[a][c] += ra * rows[o + c];
      }
    }
    for (let a = 0; a < p; a++) {
      for (let c = 0; c < a; c++) A[a][c] = A[c][a];
      A[a][a] *= 1 + 1e-9 + ridge[a];
    }
    const next = solveLinear(A, b);
    if (!next || next.some((v) => !Number.isFinite(v))) return beta;
    beta = next;
    // Huber weights from the residual scale (MAD); gross outliers get zero weight.
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let pred = 0;
      for (let a = 0; a < p; a++) pred += rows[i * p + a] * beta[a];
      res[i] = targets[i] - pred;
    }
    const abs = Array.from(res, Math.abs).sort((x, y) => x - y);
    const sigma = Math.max(1, 1.4826 * abs[abs.length >> 1]);
    const k = 1.5 * sigma;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(res[i]);
      w[i] = a <= k ? 1 : a > 6 * sigma ? 0 : k / a;
    }
  }
  return beta;
}

/** 3x3 min filter followed by a 3x3 mean (widens and softens low-consistency areas). */
function erodeSmooth(src: Float32Array, w: number, h: number): Float32Array {
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && src[yy * w + xx] < v) v = src[yy * w + xx];
        }
      }
      m[y * w + x] = v;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += m[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/**
 * Fit the photometric model mapping `closeup` colours to `reference` colours and measure where the
 * compensated close-up disagrees with the reference. `toReference` maps `closeup` pixels to
 * reference pixels. The model falls back to a global gain/offset, then to identity, when the
 * overlap is too small or the fit is implausible.
 */
export function analyzePhotometry(reference: RGBAImage, closeup: RGBAImage, toReference: Mat3, opts: PhotometricFitOptions = {}): PhotometryResult {
  const B = Math.max(1, Math.round(opts.block ?? 4));
  const inv = mat3Invert(toReference);
  const outline = mapPolygon(toReference, imageCorners(closeup.width, closeup.height));
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  const r = clampRect(
    { x: Math.min(...xs) + 0.5, y: Math.min(...ys) + 0.5, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    reference.width,
    reference.height,
  );
  const bw = Math.ceil(r.width / B), bh = Math.ceil(r.height / B);
  if (bw < 1 || bh < 1) return { model: identityPhotometric(), consistency: null };
  // Block sums: [refR, refG, refB, cR, cG, cB, count, clippedMask, sumU, sumV].
  const stride = 10;
  const acc = new Float64Array(bw * bh * stride);
  const px = new Float64Array(3);
  const margin = 2;
  for (let y = r.y; y < r.y + r.height; y++) {
    const by = Math.floor((y - r.y) / B);
    for (let x = r.x; x < r.x + r.width; x++) {
      const w = inv[6] * x + inv[7] * y + inv[8];
      if (!(w > 0)) continue;
      const cu = (inv[0] * x + inv[1] * y + inv[2]) / w;
      const cv = (inv[3] * x + inv[4] * y + inv[5]) / w;
      if (cu < margin || cv < margin || cu > closeup.width - 1 - margin || cv > closeup.height - 1 - margin) continue;
      sampleLinear(closeup.data, closeup.width, closeup.height, cu, cv, px);
      const o = (by * bw + Math.floor((x - r.x) / B)) * stride;
      const ri = (y * reference.width + x) * 4;
      let clip = acc[o + 7];
      for (let c = 0; c < 3; c++) {
        const rv = reference.data[ri + c], cvv = px[c];
        acc[o + c] += rv;
        acc[o + 3 + c] += cvv;
        if (rv >= 252 || rv <= 3 || cvv >= 252 || cvv <= 3) clip = clip | (1 << c);
      }
      acc[o + 7] = clip;
      acc[o + 6] += 1;
      acc[o + 8] += (2 * (cu + 0.5)) / closeup.width - 1;
      acc[o + 9] += (2 * (cv + 0.5)) / closeup.height - 1;
    }
  }
  const full = B * B;
  const nBlocks = bw * bh;
  const model = identityPhotometric();
  const sigma = [8, 8, 8];
  for (let c = 0; c < 3; c++) {
    const rows7 = new Float64Array(nBlocks * MODEL_TERMS);
    const rows2 = new Float64Array(nBlocks * 2);
    const t = new Float64Array(nBlocks);
    let n = 0;
    for (let i = 0; i < nBlocks; i++) {
      const o = i * stride;
      if (acc[o + 6] < full || acc[o + 7] & (1 << c)) continue;
      const cnt = acc[o + 6];
      const cm = acc[o + 3 + c] / cnt, rm = acc[o + c] / cnt;
      const u = acc[o + 8] / cnt, v = acc[o + 9] / cnt;
      rows7.set([cm, cm * u, cm * v, cm * (u * u + v * v), 1, u, v], n * MODEL_TERMS);
      rows2.set([cm, 1], n * 2);
      t[n] = rm;
      n++;
    }
    let coeffs: number[] | null = null;
    if (n >= 60) {
      // Mild ridge on the spatial terms keeps narrow overlaps from extrapolating wildly.
      const beta = irls(rows7, t, n, MODEL_TERMS, [0, 0.05, 0.05, 0.05, 0, 0.05, 0.05]);
      if (beta && beta[0] > 0.3 && beta[0] < 3 && Math.abs(beta[1]) < 0.5 && Math.abs(beta[2]) < 0.5 && Math.abs(beta[3]) < 0.6) coeffs = beta;
    }
    if (!coeffs && n >= 12) {
      const beta = irls(rows2, t, n, 2, [0, 0]);
      if (beta && beta[0] > 0.3 && beta[0] < 3) coeffs = [beta[0], 0, 0, 0, beta[1], 0, 0];
    }
    if (coeffs) model.coeffs.set(coeffs, c * MODEL_TERMS);
    // Robust residual scale of the full blocks under the chosen model.
    if (n >= 12) {
      const res: number[] = [];
      for (let i = 0; i < n; i++) {
        const cm = rows7[i * MODEL_TERMS], u = rows7[i * MODEL_TERMS + 5], v = rows7[i * MODEL_TERMS + 6];
        res.push(Math.abs(t[i] - applyPhotometric(model, c, cm, u, v)));
      }
      res.sort((a, b) => a - b);
      sigma[c] = Math.max(2, 1.4826 * res[res.length >> 1]);
    }
  }

  // Consistency: largest per-channel deviation of a block, relative to the residual scale.
  const cons = new Float32Array(nBlocks).fill(1);
  const low = Math.max(24, 4 * Math.max(...sigma));
  const high = low + 24;
  for (let i = 0; i < nBlocks; i++) {
    const o = i * stride;
    const cnt = acc[o + 6];
    if (cnt < Math.max(1, full / 4)) continue;
    const u = acc[o + 8] / cnt, v = acc[o + 9] / cnt;
    let dev = 0;
    for (let c = 0; c < 3; c++) {
      const comp = applyPhotometric(model, c, acc[o + 3 + c] / cnt, u, v);
      dev = Math.max(dev, Math.abs(comp - acc[o + c] / cnt));
    }
    cons[i] = 1 - smoothstep((dev - low) / (high - low));
  }
  return {
    model,
    consistency: { x0: r.x, y0: r.y, block: B, width: bw, height: bh, data: erodeSmooth(cons, bw, bh) },
  };
}

/** Photometric model only (see {@link analyzePhotometry}). */
export function fitPhotometric(reference: RGBAImage, closeup: RGBAImage, toReference: Mat3, opts: PhotometricFitOptions = {}): PhotometricModel {
  return analyzePhotometry(reference, closeup, toReference, opts).model;
}
