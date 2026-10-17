/**
 * High-resolution reference compositing: the reference is upscaled and every registered close-up
 * is resampled into it (inverse mapping per output pixel), photometrically matched to the
 * reference and blended with feathered, resolution-aware weights so seams disappear.
 */
import { applyMat3, mat3Invert, mat3Multiply, type Mat3 } from '../../cv/geometry';
import { createRGBA, type RGBAImage } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';
import type { CloseupRegistration } from '../../model/types';
import { analyzePhotometry, identityPhotometric, type ConsistencyMap, type PhotometricModel } from './photometric';
import { sampleCubic, sampleLinear } from './sampling';
import { det3, imageCorners, resizeTransform } from './util';

export interface ComposeHighResOptions {
  /** Output scale relative to the reference (e.g. 2 = twice the resolution). */
  scale: number;
  /** Upper bound for the output's longer side in pixels (default 6000). */
  maxSide?: number;
  /** Feather width as a fraction of each close-up's shorter side (default 0.12). */
  feather?: number;
  /** Fit and apply per-close-up colour compensation and glare/occlusion rejection (default true). */
  photometric?: boolean;
  /** Close-up resampling filter (default 'bicubic'; the reference base is always bilinear). */
  interpolation?: 'bilinear' | 'bicubic';
}

export interface CloseupInput {
  image: RGBAImage;
  registration: CloseupRegistration;
}

interface Layer {
  img: RGBAImage;
  /** Output pixel -> layer pixel. */
  M: Mat3;
  detM: number;
  /** Layer pixels -> original close-up pixels (linear factor). */
  toOrig: number;
  feather: number;
  weight: number;
  model: PhotometricModel;
  consistency: ConsistencyMap | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Round and clamp to 0..255. */
function toByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
}

/** Glare: a close-up pixel whose darkest channel exceeds GLARE_LO fades out until GLARE_HI. */
const GLARE_LO = 236;
const GLARE_HI = 252;

/**
 * Output size for compositing `reference` at `scale`, capped so the longer side is <= maxSide.
 */
export function composeOutputSize(width: number, height: number, scale: number, maxSide = 6000): { width: number; height: number } {
  let s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const long = Math.max(width, height);
  if (long * s > maxSide) s = maxSide / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

function prepareLayer(reference: RGBAImage, c: CloseupInput, outW: number, outH: number, opts: ComposeHighResOptions): Layer | null {
  const { image, registration } = c;
  const H = registration.toReference;
  let Hinv: Mat3;
  try {
    Hinv = mat3Invert(H);
  } catch {
    return null;
  }
  const sOut = Math.sqrt((outW / reference.width) * (outH / reference.height));
  // Prefilter close-ups much sharper than the output so bilinear sampling does not alias.
  const gainOut = registration.scaleGain / sOut;
  let img = image;
  let S: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (gainOut > 1.5) {
    const f = 1.25 / gainOut;
    const w = Math.max(2, Math.round(image.width * f)), h = Math.max(2, Math.round(image.height * f));
    img = resizeRGBA(image, w, h);
    S = resizeTransform(image.width, image.height, w, h);
  }
  const layerToRef = mat3Multiply(H, mat3Invert(S));
  const outToRef = resizeTransform(outW, outH, reference.width, reference.height);
  const refToOut = resizeTransform(reference.width, reference.height, outW, outH);
  const M = mat3Multiply(S, mat3Multiply(Hinv, outToRef));
  const detM = det3(M);
  if (!Number.isFinite(detM) || detM === 0) return null;

  // Output-space bounding box of the close-up outline.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of imageCorners(img.width, img.height)) {
    const w = layerToRef[6] * p.x + layerToRef[7] * p.y + layerToRef[8];
    if (!(w > 0)) return null;
    const q = applyMat3(refToOut, applyMat3(layerToRef, p));
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1);
  x1 = Math.min(outW - 1, Math.ceil(x1) + 1); y1 = Math.min(outH - 1, Math.ceil(y1) + 1);
  if (x1 < x0 || y1 < y0) return null;

  let photo: { model: PhotometricModel; consistency: ConsistencyMap | null } = { model: identityPhotometric(), consistency: null };
  if (opts.photometric !== false) {
    // Compare colours at the reference's resolution: area-downsample a sharper close-up first so
    // block means are not polluted by aliasing. (u, v) are normalised, so the model carries over.
    const layerGain = registration.scaleGain * (img.width / image.width);
    let pimg = img, pH = layerToRef;
    if (layerGain > 1.25) {
      const w = Math.max(2, Math.round(img.width / layerGain)), h = Math.max(2, Math.round(img.height / layerGain));
      pimg = resizeRGBA(img, w, h);
      pH = mat3Multiply(layerToRef, mat3Invert(resizeTransform(img.width, img.height, w, h)));
    }
    photo = analyzePhotometry(reference, pimg, pH);
    // Fully consistent close-ups (the common case) skip the per-pixel lookup.
    if (photo.consistency && photo.consistency.data.every((v) => v >= 0.999)) photo.consistency = null;
  }
  return {
    img,
    M,
    detM,
    toOrig: image.width / img.width,
    feather: Math.max(2, (opts.feather ?? 0.12) * Math.min(img.width, img.height)),
    weight: 0.5 + 0.5 * Math.max(0, Math.min(1, registration.confidence)),
    model: photo.model,
    consistency: photo.consistency,
    x0, y0, x1, y1,
  };
}

/** Per-row accumulators shared by all layers. */
interface RowBuffers {
  acc: Float32Array;
  wsum: Float32Array;
  keep: Float32Array;
  refX: Float32Array;
  /** Scratch RGB sample. */
  px: Float64Array;
}

/**
 * Add one layer's contributions to output row Y: inverse-map each pixel into the close-up,
 * bilinear-sample it, compensate colours and accumulate the blend weight.
 */
function accumulateRow(l: Layer, Y: number, ry: number, sAvg: number, cubic: boolean, row: RowBuffers): void {
  const M = l.M;
  const wr = M[7] * Y + M[8], ur = M[1] * Y + M[2], vr = M[4] * Y + M[5];
  const m0 = M[0], m3 = M[3], m6 = M[6];
  const lw = l.img.width, lh = l.img.height, data = l.img.data;
  const absDet = Math.abs(l.detM), toOrig = l.toOrig, invF = 1 / l.feather, weight = l.weight;
  const k = l.model.coeffs;
  const cm = l.consistency;
  // Consistency map row (bilinear in y), or null when the row is outside the map.
  let cRow0 = -1, cRow1 = -1, cfy = 0;
  if (cm) {
    const gy = (ry - cm.y0 + 0.5) / cm.block - 0.5;
    if (gy >= -1 && gy <= cm.height) {
      cRow0 = Math.max(0, Math.min(cm.height - 1, Math.floor(gy)));
      cRow1 = Math.min(cm.height - 1, cRow0 + 1);
      cfy = Math.max(0, Math.min(1, gy - cRow0));
    }
  }
  const { acc, wsum, keep, refX, px } = row;
  // With w > 0, "u >= -0.5" etc. are linear in X: intersect the four half-lines (plus w > 0).
  let xa = l.x0, xb = l.x1;
  const clip = (a: number, b: number) => {
    // a * X + b >= 0
    if (Math.abs(a) < 1e-12) {
      if (b < 0) { xa = 1; xb = 0; }
    } else if (a > 0) xa = Math.max(xa, Math.ceil(-b / a - 1e-9));
    else xb = Math.min(xb, Math.floor(-b / a + 1e-9));
  };
  clip(m6, wr);
  clip(m0 + 0.5 * m6, ur + 0.5 * wr); // u >= -0.5
  clip(m3 + 0.5 * m6, vr + 0.5 * wr); // v >= -0.5
  clip((lw - 0.5) * m6 - m0, (lw - 0.5) * wr - ur); // u <= lw - 0.5
  clip((lh - 0.5) * m6 - m3, (lh - 0.5) * wr - vr); // v <= lh - 0.5
  for (let X = Math.max(l.x0, xa - 1); X <= Math.min(l.x1, xb + 1); X++) {
    const w = wr + m6 * X;
    if (!(w > 0)) continue;
    const iw = 1 / w;
    const u = (ur + m0 * X) * iw, v = (vr + m3 * X) * iw;
    const d = Math.min(Math.min(u + 0.5, v + 0.5), Math.min(lw - 0.5 - u, lh - 0.5 - v));
    if (d <= 0) continue;
    // Close-up pixels per output pixel (|det J| = |det M| / w^3); useless when <= reference res.
    const g = Math.sqrt(absDet * iw * iw * iw) * toOrig;
    let useful = (g * sAvg - 1) * 2;
    if (useful <= 0) continue;
    useful = useful >= 1 ? 1 : useful * useful * (3 - 2 * useful);
    let feather = d * invF;
    feather = feather >= 1 ? 1 : feather * feather * (3 - 2 * feather);

    if (cubic) sampleCubic(data, lw, lh, u, v, px);
    else sampleLinear(data, lw, lh, u, v, px);
    const r = px[0], gg = px[1], b = px[2];

    const darkest = Math.min(r, gg, b);
    let glare = 1;
    if (darkest > GLARE_LO) {
      const t = (darkest - GLARE_LO) / (GLARE_HI - GLARE_LO);
      glare = t >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
    }
    let agree = 1;
    if (cm && cRow0 >= 0) {
      const gx = (refX[X] - cm.x0 + 0.5) / cm.block - 0.5;
      if (gx >= -1 && gx <= cm.width) {
        const c0 = Math.max(0, Math.min(cm.width - 1, Math.floor(gx)));
        const c1 = Math.min(cm.width - 1, c0 + 1);
        const cfx = Math.max(0, Math.min(1, gx - c0));
        const cd = cm.data, cw = cm.width;
        agree =
          (cd[cRow0 * cw + c0] * (1 - cfx) + cd[cRow0 * cw + c1] * cfx) * (1 - cfy) +
          (cd[cRow1 * cw + c0] * (1 - cfx) + cd[cRow1 * cw + c1] * cfx) * cfy;
      }
    }
    const a = feather * useful * glare * agree;
    if (a <= 0) continue;
    const q = g < 1 ? g : 1;
    const wk = a * q * q * q * q * weight + 1e-9;
    const un = (2 * (u + 0.5)) / lw - 1, vn = (2 * (v + 0.5)) / lh - 1, rr = un * un + vn * vn;
    const o = X * 3;
    acc[o] += wk * (r * (k[0] + k[1] * un + k[2] * vn + k[3] * rr) + k[4] + k[5] * un + k[6] * vn);
    acc[o + 1] += wk * (gg * (k[7] + k[8] * un + k[9] * vn + k[10] * rr) + k[11] + k[12] * un + k[13] * vn);
    acc[o + 2] += wk * (b * (k[14] + k[15] * un + k[16] * vn + k[17] * rr) + k[18] + k[19] * un + k[20] * vn);
    wsum[X] += wk;
    keep[X] *= 1 - a;
  }
}

/**
 * Build a higher-resolution reference: `reference` upscaled by `opts.scale` (longer side capped at
 * `opts.maxSide`, default 6000) with the registered close-ups blended in. Pixels not covered by any
 * useful close-up equal the bilinearly upscaled reference (as `resizeRGBA`).
 *
 * Per output pixel and close-up: inverse mapping output → reference → close-up, bilinear sample,
 * per-close-up colour compensation, and a blend weight from border feathering, resolution gain over
 * the reference, glare and agreement with the reference. Close-ups replace the reference smoothly
 * (coverage alpha = 1 - Π(1 - a_k)); overlapping close-ups are mixed, favouring higher resolution.
 * Memory: the output plus one row of float accumulators (and down-filtered copies of close-ups
 * that are much sharper than the output).
 */
export function composeHighRes(reference: RGBAImage, closeups: CloseupInput[], opts: ComposeHighResOptions): RGBAImage {
  const { width: W, height: Hh } = composeOutputSize(reference.width, reference.height, opts.scale, opts.maxSide);
  const rw = reference.width, rh = reference.height, rd = reference.data;
  const sx = W / rw, sy = Hh / rh;
  const sAvg = Math.sqrt(sx * sy);
  const out = createRGBA(W, Hh);
  const od = out.data;
  // Packed RGBA stores are much faster than four clamped byte stores.
  const o32 = LITTLE_ENDIAN ? new Uint32Array(od.buffer, od.byteOffset, W * Hh) : null;
  // Downscaling needs an area-filtered base; upscaling interpolates the reference on the fly.
  const base = sx < 1 || sy < 1 ? resizeRGBA(reference, W, Hh) : null;
  const layers: Layer[] = [];
  for (const c of closeups) {
    const l = prepareLayer(reference, c, W, Hh, opts);
    if (l) layers.push(l);
  }
  // Column interpolation table for the base (same convention as resizeRGBA's linear upscaling).
  const bx0 = new Int32Array(W), bx1 = new Int32Array(W), bfx = new Float32Array(W);
  const row: RowBuffers = { acc: new Float32Array(W * 3), wsum: new Float32Array(W), keep: new Float32Array(W), refX: new Float32Array(W), px: new Float64Array(3) };
  const cubic = (opts.interpolation ?? 'bicubic') === 'bicubic';
  for (let X = 0; X < W; X++) {
    const rx = (X + 0.5) / sx - 0.5;
    row.refX[X] = rx;
    const s = Math.max(0, Math.min(rw - 1, rx));
    const i0 = Math.floor(s);
    bx0[X] = i0 * 4;
    bfx[X] = i0 + 1 < rw ? s - i0 : 0;
    bx1[X] = (i0 + 1 < rw ? i0 + 1 : i0) * 4;
  }
  for (let Y = 0; Y < Hh; Y++) {
    const ry = (Y + 0.5) / sy - 0.5;
    let any = false;
    for (const l of layers) {
      if (Y < l.y0 || Y > l.y1) continue;
      if (!any) {
        row.acc.fill(0);
        row.wsum.fill(0);
        row.keep.fill(1);
        any = true;
      }
      accumulateRow(l, Y, ry, sAvg, cubic, row);
    }
    const sY = Math.max(0, Math.min(rh - 1, ry));
    const y0 = Math.floor(sY);
    const fy = y0 + 1 < rh ? sY - y0 : 0;
    const r0 = y0 * rw * 4, r1 = (y0 + 1 < rh ? y0 + 1 : y0) * rw * 4;
    for (let X = 0; X < W; X++) {
      const o = (Y * W + X) * 4;
      let b0: number, b1: number, b2: number;
      if (base) {
        b0 = base.data[o]; b1 = base.data[o + 1]; b2 = base.data[o + 2];
      } else {
        const fx = bfx[X], a = bx0[X], c = bx1[X];
        const t0 = r0 + a, t1 = r0 + c, t2 = r1 + a, t3 = r1 + c;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        b0 = rd[t0] * w00 + rd[t1] * w10 + rd[t2] * w01 + rd[t3] * w11;
        b1 = rd[t0 + 1] * w00 + rd[t1 + 1] * w10 + rd[t2 + 1] * w01 + rd[t3 + 1] * w11;
        b2 = rd[t0 + 2] * w00 + rd[t1 + 2] * w10 + rd[t2 + 2] * w01 + rd[t3 + 2] * w11;
      }
      let r = b0, g = b1, b = b2;
      const ws = any ? row.wsum[X] : 0;
      if (ws > 0) {
        const A = 1 - row.keep[X];
        const inv = A / ws;
        r = row.acc[X * 3] * inv + (1 - A) * b0;
        g = row.acc[X * 3 + 1] * inv + (1 - A) * b1;
        b = row.acc[X * 3 + 2] * inv + (1 - A) * b2;
      }
      if (o32) {
        o32[Y * W + X] = toByte(r) | (toByte(g) << 8) | (toByte(b) << 16) | 0xff000000;
      } else {
        od[o] = r;
        od[o + 1] = g;
        od[o + 2] = b;
        od[o + 3] = 255;
      }
    }
  }
  return out;
}
