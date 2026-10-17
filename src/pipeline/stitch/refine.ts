/**
 * Direct (intensity-based) refinement of a close-up -> reference homography: robust Gauss–Newton
 * (forward compositional Lucas–Kanade) over 8 homography parameters plus a gain/bias term, on a
 * light coarse-to-fine pyramid. Feature matches give ~0.3–1 px accuracy; this brings it well below
 * one reference pixel, which matters when the close-up is composited at several times the
 * reference resolution.
 */
import { sobel } from '../../cv/filter';
import { applyMat3, mat3Invert, mat3Multiply, solveLinear, translation, type Mat3 } from '../../cv/geometry';
import { clampRect, cropGray, type GrayImage } from '../../cv/image';
import { resizeGray } from '../../cv/resize';
import { sampleGray } from '../../cv/warp';
import { imageCorners, localScale, mapPolygon, resizeTransform } from './util';

export interface DirectRefineOptions {
  /** Max samples per level (default 40000). */
  maxSamples?: number;
  /** Gauss–Newton iterations per level (default 12). */
  iterations?: number;
  /** Reject the refinement when the overlap moves more than this (working px, default 4). */
  maxShift?: number;
}

export interface DirectRefineResult {
  /** Refined close-up -> reference homography (input H when the refinement was rejected). */
  H: Mat3;
  /** Normalised cross-correlation of reference and warped close-up before / after refinement. */
  nccBefore: number;
  nccAfter: number;
  accepted: boolean;
}

interface Samples {
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  n: number;
}

/** Reference pixels (on a regular grid) whose preimage lies inside the close-up. */
function collectSamples(ref: GrayImage, close: GrayImage, G: Mat3, maxSamples: number, margin: number): Samples {
  const { width: w, height: h } = ref;
  const H = mat3Invert(G);
  const poly = mapPolygon(H, imageCorners(close.width, close.height));
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  x0 = Math.max(margin, Math.floor(x0)); y0 = Math.max(margin, Math.floor(y0));
  x1 = Math.min(w - 1 - margin, Math.ceil(x1)); y1 = Math.min(h - 1 - margin, Math.ceil(y1));
  const area = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
  const step = Math.max(1, Math.ceil(Math.sqrt(area / maxSamples)));
  const cap = Math.ceil((x1 - x0 + 1) / step + 1) * Math.ceil((y1 - y0 + 1) / step + 1);
  const xs = new Float32Array(Math.max(0, cap)), ys = new Float32Array(Math.max(0, cap)), rs = new Float32Array(Math.max(0, cap));
  let n = 0;
  const cw = close.width, ch = close.height;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const wq = G[6] * x + G[7] * y + G[8];
      if (!(wq > 0)) continue;
      const u = (G[0] * x + G[1] * y + G[2]) / wq;
      const v = (G[3] * x + G[4] * y + G[5]) / wq;
      if (u < margin || v < margin || u > cw - 1 - margin || v > ch - 1 - margin) continue;
      xs[n] = x; ys[n] = y; rs[n] = ref.data[y * w + x]; n++;
    }
  }
  return { x: xs, y: ys, r: rs, n };
}

/** NCC between the reference samples and the close-up warped by G (ref -> close). */
function nccAt(close: GrayImage, G: Mat3, s: Samples): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < s.n; i++) {
    const x = s.x[i], y = s.y[i];
    const wq = G[6] * x + G[7] * y + G[8];
    const v = sampleGray(close, (G[0] * x + G[1] * y + G[2]) / wq, (G[3] * x + G[4] * y + G[5]) / wq);
    if (Number.isNaN(v)) continue;
    const r = s.r[i];
    n++; sa += r; sb += v; saa += r * r; sbb += v * v; sab += r * v;
  }
  if (n < 16) return 0;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  if (va <= 1e-9 || vb <= 1e-9) return 0;
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

function median(values: Float32Array, n: number): number {
  const stride = Math.max(1, Math.floor(n / 4000));
  const tmp: number[] = [];
  for (let i = 0; i < n; i += stride) tmp.push(values[i]);
  tmp.sort((a, b) => a - b);
  return tmp.length ? tmp[tmp.length >> 1] : 0;
}

/** Robust Gauss–Newton alignment on one level. Returns the refined G (ref -> close). */
function alignLevel(ref: GrayImage, close: GrayImage, G0: Mat3, maxSamples: number, iterations: number): Mat3 {
  const s = collectSamples(ref, close, G0, maxSamples, 2);
  if (s.n < 200) return G0;
  const { gx, gy } = sobel(close);
  // Normalisation of reference coordinates for conditioning.
  let cx = 0, cy = 0;
  for (let i = 0; i < s.n; i++) { cx += s.x[i]; cy += s.y[i]; }
  cx /= s.n; cy /= s.n;
  let rad = 0;
  for (let i = 0; i < s.n; i++) rad += (s.x[i] - cx) ** 2 + (s.y[i] - cy) ** 2;
  const sc = Math.sqrt(rad / s.n) || 1;
  const N: Mat3 = [1 / sc, 0, -cx / sc, 0, 1 / sc, -cy / sc, 0, 0, 1];
  const Ninv = mat3Invert(N);

  let G = G0;
  // Photometric init from moments.
  let alpha = 1, beta = 0;
  {
    let n = 0, sr = 0, si = 0, srr = 0, sii = 0;
    for (let i = 0; i < s.n; i++) {
      const x = s.x[i], y = s.y[i];
      const wq = G[6] * x + G[7] * y + G[8];
      const v = sampleGray(close, (G[0] * x + G[1] * y + G[2]) / wq, (G[3] * x + G[4] * y + G[5]) / wq);
      if (Number.isNaN(v)) continue;
      n++; sr += s.r[i]; si += v; srr += s.r[i] ** 2; sii += v * v;
    }
    if (n > 0) {
      const vr = srr / n - (sr / n) ** 2, vi = sii / n - (si / n) ** 2;
      alpha = vi > 1e-6 ? Math.sqrt(Math.max(vr, 1e-6) / vi) : 1;
      beta = sr / n - (alpha * si) / n;
    }
  }
  const res = new Float32Array(s.n);
  const valid = new Uint8Array(s.n);
  const JtJ = new Float64Array(100);
  const Jte = new Float64Array(10);
  const row = new Float64Array(10);
  let sigma = -1;
  for (let it = 0; it < iterations; it++) {
    JtJ.fill(0);
    Jte.fill(0);
    // Pass 1: residuals (for the robust scale).
    for (let i = 0; i < s.n; i++) {
      const x = s.x[i], y = s.y[i];
      const wq = G[6] * x + G[7] * y + G[8];
      const u = (G[0] * x + G[1] * y + G[2]) / wq, v = (G[3] * x + G[4] * y + G[5]) / wq;
      const I = wq > 0 ? sampleGray(close, u, v) : NaN;
      if (Number.isNaN(I) || u < 1 || v < 1 || u > close.width - 2 || v > close.height - 2) { valid[i] = 0; continue; }
      valid[i] = 1;
      res[i] = alpha * I + beta - s.r[i];
    }
    let nv = 0;
    const absRes = new Float32Array(s.n);
    for (let i = 0; i < s.n; i++) if (valid[i]) absRes[nv++] = Math.abs(res[i]);
    if (nv < 200) return G0;
    sigma = Math.max(0.5, 1.4826 * median(absRes, nv));
    const k = 1.345 * sigma;
    // Pass 2: weighted normal equations.
    for (let i = 0; i < s.n; i++) {
      if (!valid[i]) continue;
      const x = s.x[i], y = s.y[i];
      const wq = G[6] * x + G[7] * y + G[8];
      const u = (G[0] * x + G[1] * y + G[2]) / wq, v = (G[3] * x + G[4] * y + G[5]) / wq;
      const I = sampleGray(close, u, v);
      const gu = sampleGray(gx, u, v) / 8, gv = sampleGray(gy, u, v) / 8;
      const ja = (G[0] - G[6] * u) / wq, jb = (G[1] - G[7] * u) / wq;
      const jc = (G[3] - G[6] * v) / wq, jd = (G[4] - G[7] * v) / wq;
      const Ix = alpha * (gu * ja + gv * jc) * sc, Iy = alpha * (gu * jb + gv * jd) * sc;
      const xn = (x - cx) / sc, yn = (y - cy) / sc;
      const e = res[i];
      const ae = Math.abs(e);
      const wgt = ae <= k ? 1 : k / ae;
      const rr = Ix * xn + Iy * yn;
      row[0] = Ix * xn; row[1] = Ix * yn; row[2] = Ix;
      row[3] = Iy * xn; row[4] = Iy * yn; row[5] = Iy;
      row[6] = -xn * rr; row[7] = -yn * rr;
      row[8] = I; row[9] = 1;
      for (let a = 0; a < 10; a++) {
        const ra = row[a] * wgt;
        Jte[a] += ra * e;
        for (let b = a; b < 10; b++) JtJ[a * 10 + b] += ra * row[b];
      }
    }
    const A: number[][] = [];
    const rhs: number[] = [];
    for (let a = 0; a < 10; a++) {
      const r: number[] = [];
      for (let b = 0; b < 10; b++) r.push(a <= b ? JtJ[a * 10 + b] : JtJ[b * 10 + a]);
      r[a] *= 1 + 1e-6; // tiny Levenberg damping
      A.push(r);
      rhs.push(-Jte[a]);
    }
    const d = solveLinear(A, rhs);
    if (!d || d.some((v) => !Number.isFinite(v))) break;
    const Dn: Mat3 = [1 + d[0], d[1], d[2], d[3], 1 + d[4], d[5], d[6], d[7], 1];
    G = mat3Multiply(G, mat3Multiply(Ninv, mat3Multiply(Dn, N)));
    G = G.map((v) => v / G[8]);
    alpha += d[8];
    beta += d[9];
    // Converged when the update moves the sample-region extremes by < 0.01 px.
    const shift = Math.max(Math.abs(d[2]) + Math.abs(d[0]) + Math.abs(d[1]), Math.abs(d[5]) + Math.abs(d[3]) + Math.abs(d[4]), 2 * (Math.abs(d[6]) + Math.abs(d[7]))) * sc;
    if (shift < 0.01) break;
  }
  return G;
}

/**
 * Refine `H` (close-up -> reference, in the pixel coordinates of the given gray images) by direct
 * photometric alignment, at the coarser of the two resolutions: a sharper close-up is
 * area-downsampled to the reference's resolution, a sharper reference crop to the close-up's.
 * The result is only accepted when it does not lower the normalised cross-correlation and moves
 * the overlap by at most `maxShift` pixels of that working resolution.
 */
export function refineHomographyDirect(ref: GrayImage, close: GrayImage, H: Mat3, opts: DirectRefineOptions = {}): DirectRefineResult {
  const maxSamples = opts.maxSamples ?? 40000;
  const iterations = opts.iterations ?? 12;
  const maxShift = opts.maxShift ?? 4;
  // Close-up px per reference px around the mapped close-up center.
  const center = applyMat3(H, { x: (close.width - 1) / 2, y: (close.height - 1) / 2 });
  const gain = localScale(mat3Invert(H), center);
  let C = close;
  let Hd = H;
  if (gain > 1.2) {
    const w = Math.max(8, Math.round(close.width / gain)), h = Math.max(8, Math.round(close.height / gain));
    C = resizeGray(close, w, h);
    Hd = mat3Multiply(H, mat3Invert(resizeTransform(close.width, close.height, w, h)));
  }
  // Work on the reference crop around the overlap only.
  const outline = mapPolygon(Hd, imageCorners(C.width, C.height));
  const margin = 8;
  const crop = clampRect(
    {
      x: Math.min(...outline.map((p) => p.x)) - margin,
      y: Math.min(...outline.map((p) => p.y)) - margin,
      width: Math.max(...outline.map((p) => p.x)) - Math.min(...outline.map((p) => p.x)) + 2 * margin + 1,
      height: Math.max(...outline.map((p) => p.y)) - Math.min(...outline.map((p) => p.y)) + 2 * margin + 1,
    },
    ref.width,
    ref.height,
  );
  const failed: DirectRefineResult = { H, nccBefore: 0, nccAfter: 0, accepted: false };
  if (crop.width < 16 || crop.height < 16) return failed;
  // No pre-blur: the fine level keeps all detail (most accurate); the half-resolution level
  // (area-downsampled, hence smooth) widens the convergence basin.
  let refB = cropGray(ref, crop);
  let toWork = translation(-crop.x, -crop.y);
  if (gain < 0.8) {
    const w = Math.max(16, Math.round(crop.width * gain)), h = Math.max(16, Math.round(crop.height * gain));
    refB = resizeGray(refB, w, h);
    toWork = mat3Multiply(resizeTransform(crop.width, crop.height, w, h), toWork);
  }
  const closeB = C;
  const G0 = mat3Invert(mat3Multiply(toWork, Hd));
  const s0 = collectSamples(refB, closeB, G0, maxSamples, 2);
  if (s0.n < 200) return failed;
  const nccBefore = nccAt(closeB, G0, s0);

  // Coarse level (half resolution) then full resolution.
  let G = G0;
  if (Math.min(C.width, C.height) >= 64 && Math.min(refB.width, refB.height) >= 64) {
    const rh = resizeGray(refB, Math.round(refB.width / 2), Math.round(refB.height / 2));
    const chh = resizeGray(closeB, Math.round(C.width / 2), Math.round(C.height / 2));
    const Sr = resizeTransform(refB.width, refB.height, rh.width, rh.height);
    const Sc = resizeTransform(C.width, C.height, chh.width, chh.height);
    const Gh = mat3Multiply(Sc, mat3Multiply(G, mat3Invert(Sr)));
    const Gh2 = alignLevel(rh, chh, Gh, maxSamples / 2, iterations);
    G = mat3Multiply(mat3Invert(Sc), mat3Multiply(Gh2, Sr));
  }
  G = alignLevel(refB, closeB, G, maxSamples, iterations);
  const nccAfter = nccAt(closeB, G, s0);

  // Displacement of the sampled overlap region's extremes, in working pixels.
  const Hc2 = mat3Invert(G);
  let shift = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s0.n; i++) {
    x0 = Math.min(x0, s0.x[i]); y0 = Math.min(y0, s0.y[i]);
    x1 = Math.max(x1, s0.x[i]); y1 = Math.max(y1, s0.y[i]);
  }
  for (const p of [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]) {
    const q = applyMat3(Hc2, applyMat3(G0, p));
    shift = Math.max(shift, Math.hypot(q.x - p.x, q.y - p.y));
  }
  const accepted = nccAfter >= nccBefore - 1e-3 && shift <= maxShift && Number.isFinite(shift);
  if (!accepted) return { H, nccBefore, nccAfter: nccBefore, accepted: false };
  // Back to reference and caller close-up coordinates: H' = toWork^-1 * Hc2 * (Hd^-1 * H).
  const refined = mat3Multiply(mat3Invert(toWork), mat3Multiply(Hc2, mat3Multiply(mat3Invert(Hd), H)));
  return { H: refined.map((v) => v / refined[8]), nccBefore, nccAfter, accepted: true };
}
