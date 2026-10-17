/**
 * Piece templates: the photographed region resampled into a reference pyramid level for a given
 * similarity hypothesis, and the masked multi-channel NCC score against the reference.
 */
import { rgbaToLab } from '../../cv/color';
import type { Point } from '../../cv/geometry';
import { createFloat, createMask, type FloatImage, type Mask, type RGBAImage } from '../../cv/image';
import { gaussianKernel } from '../../cv/filter';
import { resizeFloat } from '../../cv/resize';
import type { RefLevel } from './types';

/** The photographed region prepared for template extraction. */
export interface PhotoSource {
  /**
   * Pyramid of the crop with channels (weighted L·m, a·m, b·m, m) where m = eroded mask, i.e.
   * premultiplied coverage; f = level px per crop px.
   */
  levels: { fx: number; fy: number; img: FloatImage }[];
  origin: Point;
  /** Mask centroid in photo coordinates. */
  centroid: Point;
  /** Mask area in photo px. */
  area: number;
  /** Mask bounds in photo coordinates (pixel centers). */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

/** Square binary erosion (separable running minimum). */
export function erodeMask(mask: Mask, r: number): Mask {
  const { width: w, height: h } = mask;
  if (r <= 0) return { width: w, height: h, data: new Uint8Array(mask.data) };
  const tmp = createMask(w, h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = -r; k <= r && v; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w || !mask.data[row + xx]) v = 0;
      }
      tmp.data[row + x] = v;
    }
  }
  const out = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = -r; k <= r && v; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h || !tmp.data[yy * w + x]) v = 0;
      }
      out.data[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Affine colour correction in weighted-Lab space: out_c = Σ_k m[4c + k] · in_k + m[4c + 3]
 * (3×4 row-major), mapping photo colours to reference colours.
 */
export interface ColorCorrection {
  m: number[];
}

/** Convert the crop to weighted Lab (optionally colour-corrected), erode the mask and build an area-averaged pyramid. */
export function makePhotoSource(
  image: RGBAImage,
  mask: Mask,
  origin: Point,
  erodeRadius: number,
  weights: readonly number[],
  correction?: ColorCorrection,
): PhotoSource {
  const { width: w, height: h } = image;
  const lab = rgbaToLab(image);
  for (let i = 0; i < lab.data.length; i += 3) {
    lab.data[i] *= weights[0];
    lab.data[i + 1] *= weights[1];
    lab.data[i + 2] *= weights[2];
  }
  if (correction) {
    const M = correction.m;
    for (let i = 0; i < lab.data.length; i += 3) {
      const a = lab.data[i], b = lab.data[i + 1], c = lab.data[i + 2];
      lab.data[i] = M[0] * a + M[1] * b + M[2] * c + M[3];
      lab.data[i + 1] = M[4] * a + M[5] * b + M[6] * c + M[7];
      lab.data[i + 2] = M[8] * a + M[9] * b + M[10] * c + M[11];
    }
  }
  const eroded = erodeMask(mask, erodeRadius);
  const base = createFloat(w, h, 4);
  let sx = 0, sy = 0, n = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Premultiplied by the eroded mask (normalised convolution): background never leaks in.
      const m = eroded.data[i];
      base.data[i * 4] = lab.data[i * 3] * m;
      base.data[i * 4 + 1] = lab.data[i * 3 + 1] * m;
      base.data[i * 4 + 2] = lab.data[i * 3 + 2] * m;
      base.data[i * 4 + 3] = m;
      if (mask.data[i]) {
        sx += x;
        sy += y;
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const levels: PhotoSource['levels'] = [{ fx: 1, fy: 1, img: base }];
  let cur = base;
  while (Math.min(cur.width, cur.height) > 12) {
    const next = resizeFloat(cur, Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
    levels.push({ fx: next.width / w, fy: next.height / h, img: next });
    cur = next;
  }
  return {
    levels,
    origin: { ...origin },
    centroid: n > 0 ? { x: sx / n + origin.x, y: sy / n + origin.y } : { x: origin.x + w / 2, y: origin.y + h / 2 },
    area: n,
    bounds: n > 0 ? { x0: x0 + origin.x, y0: y0 + origin.y, x1: x1 + origin.x, y1: y1 + origin.y } : { x0: origin.x, y0: origin.y, x1: origin.x + w - 1, y1: origin.y + h - 1 },
  };
}

/** Similarity hypothesis: reference-local = R(phi) · s · (photo - pivot); phi clockwise radians. */
export interface Mapping {
  pivot: Point;
  phi: number;
  /** Reference px per photo px. */
  s: number;
}

/** A template in a pyramid level: valid (fully inside the eroded mask) pixels only. */
export interface Template {
  n: number;
  /** Tight size of the valid pixels. */
  w: number;
  h: number;
  /** Pivot position relative to the template's top-left pixel (integers). */
  cx: number;
  cy: number;
  /** Linear offsets (dy · stride + dx) of the valid pixels for the level the template was built for. */
  off: Int32Array;
  /** Zero-mean channel values, 3 per valid pixel. */
  val: Float32Array;
  mean: [number, number, number];
  /** Sum of squared zero-mean values. */
  energy: number;
  /** Mean of the per-pixel squared deviations (variance per pixel, all channels). */
  variance: number;
  /** Lazily computed pixel runs for prefix-sum scoring. */
  runs?: { ro: Int32Array; rl: Int32Array };
}

/**
 * Resample the photo region into `level` coordinates under mapping `m`. Colours are averaged over
 * mask pixels only; template pixels whose footprint is less than `minCov` inside the eroded mask
 * are dropped. Returns null when fewer than `minPixels` remain.
 */
export function buildTemplate(src: PhotoSource, m: Mapping, level: RefLevel, minCov = 0.6, minPixels = 12): Template | null {
  const lx = level.scaleX, ly = level.scaleY;
  const c = Math.cos(m.phi), s = Math.sin(m.phi);
  // Template bounds from the mask bounds mapped into level coordinates (pivot at 0).
  const b = src.bounds;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [px, py] of [[b.x0 - 1, b.y0 - 1], [b.x1 + 1, b.y0 - 1], [b.x1 + 1, b.y1 + 1], [b.x0 - 1, b.y1 + 1]]) {
    const dx = px - m.pivot.x, dy = py - m.pivot.y;
    const u = (c * dx - s * dy) * m.s * lx, v = (s * dx + c * dy) * m.s * ly;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  const iu0 = Math.floor(u0), iu1 = Math.ceil(u1), iv0 = Math.floor(v0), iv1 = Math.ceil(v1);
  const gw = iu1 - iu0 + 1, gh = iv1 - iv0 + 1;
  // Pyramid level: coarsest one that is still at least as fine as the template.
  const t = m.s * (lx + ly) * 0.5;
  let li = 0;
  while (li + 1 < src.levels.length && src.levels[li + 1].fx >= t * 0.98) li++;
  const pl = src.levels[li];
  const img = pl.img, iw = img.width, ih = img.height, D = img.data;
  const fx = pl.fx, fy = pl.fy;
  const ox = src.origin.x, oy = src.origin.y;
  const inv = 1 / m.s;
  const vals = new Float32Array(gw * gh * 3);
  const ok = new Uint8Array(gw * gh);
  let n = 0, mu0 = 0, mu1 = 0, mu2 = 0;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let j = 0; j < gh; j++) {
    const yv = (iv0 + j) / ly;
    for (let i = 0; i < gw; i++) {
      const xu = (iu0 + i) / lx;
      // photo = pivot + R(-phi) (x, y) / s
      const px = m.pivot.x + (c * xu + s * yv) * inv;
      const py = m.pivot.y + (-s * xu + c * yv) * inv;
      const qx = (px - ox + 0.5) * fx - 0.5, qy = (py - oy + 0.5) * fy - 0.5;
      if (qx < 0 || qy < 0 || qx > iw - 1 || qy > ih - 1) continue;
      const x0 = Math.floor(qx), y0 = Math.floor(qy);
      const ax = qx - x0, ay = qy - y0;
      const x1 = x0 + 1 < iw ? x0 + 1 : x0, y1 = y0 + 1 < ih ? y0 + 1 : y0;
      const i00 = (y0 * iw + x0) * 4, i10 = (y0 * iw + x1) * 4, i01 = (y1 * iw + x0) * 4, i11 = (y1 * iw + x1) * 4;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      const cov = D[i00 + 3] * w00 + D[i10 + 3] * w10 + D[i01 + 3] * w01 + D[i11 + 3] * w11;
      if (cov < minCov) continue;
      const k = j * gw + i;
      ok[k] = 1;
      const ic = 1 / cov;
      const a0 = (D[i00] * w00 + D[i10] * w10 + D[i01] * w01 + D[i11] * w11) * ic;
      const a1 = (D[i00 + 1] * w00 + D[i10 + 1] * w10 + D[i01 + 1] * w01 + D[i11 + 1] * w11) * ic;
      const a2 = (D[i00 + 2] * w00 + D[i10 + 2] * w10 + D[i01 + 2] * w01 + D[i11 + 2] * w11) * ic;
      vals[k * 3] = a0;
      vals[k * 3 + 1] = a1;
      vals[k * 3 + 2] = a2;
      mu0 += a0;
      mu1 += a1;
      mu2 += a2;
      n++;
      if (i < minU) minU = i;
      if (i > maxU) maxU = i;
      if (j < minV) minV = j;
      if (j > maxV) maxV = j;
    }
  }
  if (n < minPixels) return null;
  if (level.blur > 0) {
    blurValid(vals, ok, gw, gh, level.blur);
    mu0 = mu1 = mu2 = 0;
    for (let k = 0; k < gw * gh; k++) {
      if (!ok[k]) continue;
      mu0 += vals[k * 3];
      mu1 += vals[k * 3 + 1];
      mu2 += vals[k * 3 + 2];
    }
  }
  mu0 /= n;
  mu1 /= n;
  mu2 /= n;
  const off = new Int32Array(n);
  const val = new Float32Array(n * 3);
  let e = 0, q = 0;
  for (let j = minV; j <= maxV; j++) {
    for (let i = minU; i <= maxU; i++) {
      const k = j * gw + i;
      if (!ok[k]) continue;
      off[q] = (j - minV) * level.stride + (i - minU);
      const d0 = vals[k * 3] - mu0, d1 = vals[k * 3 + 1] - mu1, d2 = vals[k * 3 + 2] - mu2;
      val[q * 3] = d0;
      val[q * 3 + 1] = d1;
      val[q * 3 + 2] = d2;
      e += d0 * d0 + d1 * d1 + d2 * d2;
      q++;
    }
  }
  return {
    n,
    w: maxU - minU + 1,
    h: maxV - minV + 1,
    cx: -iu0 - minU,
    cy: -iv0 - minV,
    off,
    val,
    mean: [mu0, mu1, mu2],
    energy: e,
    variance: e / n,
  };
}

/** Separable Gaussian blur of a 3-channel grid restricted to valid cells (normalised convolution). */
function blurValid(vals: Float32Array, ok: Uint8Array, w: number, h: number, sigma: number): void {
  const k = gaussianKernel(sigma, Math.max(1, Math.ceil(2 * sigma)));
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(vals.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? vals : tmp, dst = pass === 0 ? tmp : vals;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!ok[i]) continue;
        let a0 = 0, a1 = 0, a2 = 0, ws = 0;
        for (let t = -r; t <= r; t++) {
          const xx = pass === 0 ? x + t : x, yy = pass === 0 ? y : y + t;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!ok[j]) continue;
          const wt = k[t + r];
          a0 += src[j * 3] * wt;
          a1 += src[j * 3 + 1] * wt;
          a2 += src[j * 3 + 2] * wt;
          ws += wt;
        }
        dst[i * 3] = a0 / ws;
        dst[i * 3 + 1] = a1 / ws;
        dst[i * 3 + 2] = a2 / ws;
      }
    }
  }
}

/** Scoring constants (weighted-Lab units). */
export interface ScoreParams {
  /** Variance floor per pixel added to both energies (keeps flat regions from producing wild NCC). */
  eps: number;
  /** Weight of the mean-colour difference penalty. */
  beta: number;
  /** Colour difference at which the penalty saturates. */
  cap: number;
}

export const DEFAULT_SCORE: ScoreParams = { eps: 1, beta: 0.2, cap: 30 };

/**
 * Masked zero-mean NCC over the three channels jointly, minus a saturating penalty on the mean
 * colour difference. (X, Y) = top-left of the template in padded level coordinates; the caller
 * guarantees the template lies inside the padded level.
 */
export function scoreAt(level: RefLevel, t: Template, X: number, Y: number, p: ScoreParams): number {
  const D = level.data, SQ = level.sq, off = t.off, V = t.val, n = t.n;
  const base = Y * level.stride + X;
  let num = 0, s0 = 0, s1 = 0, s2 = 0, ss = 0;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const pi = base + off[i];
    const q = pi * 3;
    const r0 = D[q], r1 = D[q + 1], r2 = D[q + 2];
    num += V[j] * r0 + V[j + 1] * r1 + V[j + 2] * r2;
    s0 += r0;
    s1 += r1;
    s2 += r2;
    ss += SQ[pi];
  }
  const invN = 1 / n;
  const m0 = s0 * invN, m1 = s1 * invN, m2 = s2 * invN;
  const varR = ss - (s0 * m0 + s1 * m1 + s2 * m2);
  const fl = p.eps * n;
  const ncc = num / Math.sqrt((t.energy + fl) * (Math.max(0, varR) + fl));
  const d0 = t.mean[0] - m0, d1 = t.mean[1] - m1, d2 = t.mean[2] - m2;
  const dm = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  return ncc - (p.beta * Math.min(dm, p.cap)) / p.cap;
}

/** Runs of consecutive valid template pixels: prefix offsets (relative to a position) and lengths, ×4 channels. */
function templateRuns(t: Template, stride: number): { ro: Int32Array; rl: Int32Array } {
  const off = t.off, n = t.n, W1 = stride + 1;
  const runOff: number[] = [], runLen: number[] = [];
  for (let q = 0; q < n; ) {
    let e = q + 1;
    while (e < n && off[e] === off[e - 1] + 1) e++;
    const j = Math.floor(off[q] / stride), i = off[q] - j * stride;
    runOff.push((j * W1 + i) * 4);
    runLen.push((e - q) * 4);
    q = e;
  }
  return { ro: Int32Array.from(runOff), rl: Int32Array.from(runLen) };
}

/**
 * Dense score map over top-left positions [x0, x1] × [y0, y1] (stride 1) using the level's prefix
 * sums for the masked reference statistics (cost ≈ 3 MACs per template pixel per position).
 * `out` receives (y1 - y0 + 1) × (x1 - x0 + 1) scores, row-major.
 */
export function scoreMap(level: RefLevel, t: Template, x0: number, x1: number, y0: number, y1: number, p: ScoreParams, out: Float32Array): void {
  const P = level.prefix;
  if (!P) throw new Error('scoreMap: level has no prefix sums');
  const D = level.data, off = t.off, V = t.val, n = t.n, stride = level.stride, W1 = stride + 1;
  if (!t.runs) t.runs = templateRuns(t, stride);
  const { ro, rl } = t.runs;
  const R = ro.length;
  const invN = 1 / n, fl = p.eps * n, cap = p.cap, beta = p.beta;
  const tm0 = t.mean[0] - level.center[0], tm1 = t.mean[1] - level.center[1], tm2 = t.mean[2] - level.center[2];
  const te = t.energy + fl;
  const nx = x1 - x0 + 1;
  for (let Y = y0; Y <= y1; Y++) {
    for (let X = x0; X <= x1; X++) {
      const base = Y * stride + X;
      let num = 0;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const q = (base + off[i]) * 3;
        num += V[j] * D[q] + V[j + 1] * D[q + 1] + V[j + 2] * D[q + 2];
      }
      const pb = (Y * W1 + X) * 4;
      let s0 = 0, s1 = 0, s2 = 0, ss = 0;
      for (let r = 0; r < R; r++) {
        const a = pb + ro[r], b = a + rl[r];
        s0 += P[b] - P[a];
        s1 += P[b + 1] - P[a + 1];
        s2 += P[b + 2] - P[a + 2];
        ss += P[b + 3] - P[a + 3];
      }
      const m0 = s0 * invN, m1 = s1 * invN, m2 = s2 * invN;
      const varR = ss - (s0 * m0 + s1 * m1 + s2 * m2);
      const ncc = num / Math.sqrt(te * ((varR > 0 ? varR : 0) + fl));
      const d0 = tm0 - m0, d1 = tm1 - m1, d2 = tm2 - m2;
      const dm = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
      out[(Y - y0) * nx + (X - x0)] = ncc - (beta * (dm < cap ? dm : cap)) / cap;
    }
  }
}
