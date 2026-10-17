/**
 * Close-up registration: find the homography mapping a close-up photo of part of the puzzle
 * picture onto the reference image.
 *
 * Pipeline: gray + downscale both images → ORB features → Hamming matching (ratio + cross-check)
 * → RANSAC homography → guided re-matching around the predicted positions → RANSAC refit →
 * direct photometric refinement → validation (inliers, outline geometry, photometric agreement).
 */
import { rgbaToGray } from '../../cv/color';
import { detectFeatures, matchFeatures, ransacHomography, hammingDistance, type FeatureMatch, type Features } from '../../cv/features';
import { applyMat3, mat3Invert, mat3Multiply, polygonSignedArea, type Mat3, type Point } from '../../cv/geometry';
import { clampRect, type GrayImage, type RGBAImage, type Rect } from '../../cv/image';
import { resizeGray } from '../../cv/resize';
import type { CloseupRegistration } from '../../model/types';
import { refineHomographyDirect } from './refine';
import { det3, imageCorners, isConvexClockwise, jacobian, localScale, mapPolygon, projectiveW, resizeTransform } from './util';

export interface RegisterOptions {
  /** Longest side of the reference used for feature detection (default 1280). */
  referenceMaxSide?: number;
  /** Longest side of the close-up used for feature detection (default 800). */
  closeupMaxSide?: number;
  /** Feature budgets (defaults 3000 / 1500). */
  referenceFeatures?: number;
  closeupFeatures?: number;
  /** Minimum RANSAC inliers (default 15). */
  minInliers?: number;
  /** Run the direct photometric refinement (default true). */
  refine?: boolean;
}

export interface RegisterDiagnostics {
  referenceKeypoints: number;
  closeupKeypoints: number;
  matches: number;
  /** Inliers of the first (descriptor-only) RANSAC. */
  initialInliers: number;
  inlierRatio: number;
  /** Inliers after guided matching. */
  inliers: number;
  /** NCC of reference vs. warped close-up over the overlap (after refinement). */
  ncc: number;
  refined: boolean;
  /** Why registration failed (undefined on success). */
  failure?: string;
  /** Inlier correspondences in original close-up / reference pixel coordinates. */
  pairs: { closeup: Point; reference: Point }[];
  timings: Record<string, number>;
}

/**
 * Gray version of `img` with its longer side limited to `maxSide` (plus the orig -> small
 * transform), linearly stretched so its 1st..99th intensity percentiles span 0..255. The stretch
 * makes the FAST threshold independent of exposure (dark or washed-out close-ups).
 */
function grayLimited(img: RGBAImage, maxSide: number): { gray: GrayImage; toSmall: Mat3 } {
  let gray = rgbaToGray(img);
  let toSmall: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const long = Math.max(img.width, img.height);
  if (long > maxSide) {
    const s = maxSide / long;
    const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
    gray = resizeGray(gray, w, h);
    toSmall = resizeTransform(img.width, img.height, w, h);
  }
  const d = gray.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i++) hist[Math.max(0, Math.min(255, Math.round(d[i])))]++;
  const tail = 0.01 * d.length;
  let lo = 0, hi = 255;
  for (let i = 0, c = 0; i < 256; i++) if ((c += hist[i]) >= tail) { lo = i; break; }
  for (let i = 255, c = 0; i >= 0; i--) if ((c += hist[i]) >= tail) { hi = i; break; }
  const scale = 255 / Math.max(32, hi - lo);
  for (let i = 0; i < d.length; i++) d[i] = (d[i] - lo) * scale;
  return { gray, toSmall };
}

/** Cheap content hash (two 32-bit FNV-style lanes over the pixel words) for the reference cache. */
function imageKey(img: RGBAImage): string {
  const d = img.data;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  if (d.byteOffset % 4 === 0) {
    const u = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
    for (let i = 0; i < u.length; i++) {
      const v = u[i];
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 + v, 0x85ebca6b) ^ (h2 >>> 13);
    }
  } else {
    for (let i = 0; i < d.length; i++) {
      h1 = Math.imul(h1 ^ d[i], 0x01000193);
      h2 = Math.imul(h2 + d[i], 0x85ebca6b) ^ (h2 >>> 13);
    }
  }
  return `${img.width}x${img.height}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

interface ReferenceFeatures {
  key: string;
  gray: GrayImage;
  toSmall: Mat3;
  features: Features;
}

/**
 * The reference is the same for every close-up of a puzzle, so its working image and features are
 * cached (single entry, ~6 MB). Results are identical with or without the cache.
 */
let referenceCache: ReferenceFeatures | null = null;

function referenceFeatures(reference: RGBAImage, maxSide: number, maxFeatures: number): ReferenceFeatures {
  const key = `${imageKey(reference)}:${maxSide}:${maxFeatures}`;
  if (referenceCache && referenceCache.key === key) return referenceCache;
  const { gray, toSmall } = grayLimited(reference, maxSide);
  const features = detectFeatures(gray, { maxFeatures });
  referenceCache = { key, gray, toSmall, features };
  return referenceCache;
}

function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/**
 * Re-match query keypoints against train keypoints near their predicted position under H, with
 * consistent scale and orientation. Much denser than global matching because the ratio test only
 * competes against nearby candidates.
 */
function guidedMatches(q: Features, t: Features, H: Mat3, width: number, height: number, radius: number, maxDistance: number): FeatureMatch[] {
  const cell = Math.max(2, radius);
  const gx = Math.max(1, Math.ceil(width / cell)), gy = Math.max(1, Math.ceil(height / cell));
  const head = new Int32Array(gx * gy).fill(-1);
  const next = new Int32Array(t.keypoints.length).fill(-1);
  t.keypoints.forEach((k, j) => {
    const cx = Math.floor(k.x / cell), cy = Math.floor(k.y / cell);
    if (cx < 0 || cy < 0 || cx >= gx || cy >= gy) return;
    next[j] = head[cy * gx + cx];
    head[cy * gx + cx] = j;
  });
  const maxLogScale = Math.log(1.3) * 1.6;
  const best = new Map<number, FeatureMatch>();
  for (let i = 0; i < q.keypoints.length; i++) {
    const k = q.keypoints[i];
    if (!(projectiveW(H, k) > 0)) continue;
    const p = applyMat3(H, k);
    const J = jacobian(H, k);
    const scale = Math.sqrt(Math.abs(J[0] * J[3] - J[1] * J[2]));
    const rot = Math.atan2(J[2] - J[1], J[0] + J[3]);
    const expSize = k.size * scale, expAngle = k.angle + rot;
    let d1 = 1e9, d2 = 1e9, j1 = -1;
    const c0x = Math.floor((p.x - radius) / cell), c1x = Math.floor((p.x + radius) / cell);
    const c0y = Math.floor((p.y - radius) / cell), c1y = Math.floor((p.y + radius) / cell);
    for (let cy = Math.max(0, c0y); cy <= Math.min(gy - 1, c1y); cy++) {
      for (let cx = Math.max(0, c0x); cx <= Math.min(gx - 1, c1x); cx++) {
        for (let j = head[cy * gx + cx]; j >= 0; j = next[j]) {
          const tk = t.keypoints[j];
          if ((tk.x - p.x) ** 2 + (tk.y - p.y) ** 2 > radius * radius) continue;
          if (Math.abs(Math.log(tk.size / expSize)) > maxLogScale) continue;
          if (Math.abs(wrapAngle(tk.angle - expAngle)) > 0.6) continue;
          const d = hammingDistance(q.descriptors, i, t.descriptors, j);
          if (d < d1) { d2 = d1; d1 = d; j1 = j; }
          else if (d < d2) d2 = d;
        }
      }
    }
    if (j1 < 0 || d1 > maxDistance || !(d1 < 0.9 * d2)) continue;
    const prev = best.get(j1);
    if (!prev || prev.distance > d1) best.set(j1, { queryIdx: i, trainIdx: j1, distance: d1 });
  }
  return [...best.values()].sort((a, b) => a.queryIdx - b.queryIdx);
}

function pointsOf(f: Features, matches: FeatureMatch[], side: 'query' | 'train'): Point[] {
  return matches.map((m) => {
    const k = f.keypoints[side === 'query' ? m.queryIdx : m.trainIdx];
    return { x: k.x, y: k.y };
  });
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Register a close-up and return the registration together with diagnostics (counts, timings,
 * inlier correspondences and the failure reason).
 */
export function registerCloseupDetailed(
  reference: RGBAImage,
  closeup: RGBAImage,
  opts: RegisterOptions = {},
): { registration: CloseupRegistration | null; diagnostics: RegisterDiagnostics } {
  const timings: Record<string, number> = {};
  let t0 = performance.now();
  const lap = (name: string) => {
    const t = performance.now();
    timings[name] = t - t0;
    t0 = t;
  };
  const diag: RegisterDiagnostics = {
    referenceKeypoints: 0, closeupKeypoints: 0, matches: 0, initialInliers: 0, inlierRatio: 0,
    inliers: 0, ncc: 0, refined: false, pairs: [], timings,
  };
  const fail = (failure: string) => {
    diag.failure = failure;
    return { registration: null, diagnostics: diag };
  };
  const minInliers = opts.minInliers ?? 15;

  const ref = referenceFeatures(reference, opts.referenceMaxSide ?? 1280, opts.referenceFeatures ?? 3000);
  const fr = ref.features;
  lap('reference');
  const close = grayLimited(closeup, opts.closeupMaxSide ?? 800);
  const fc = detectFeatures(close.gray, { maxFeatures: opts.closeupFeatures ?? 1500 });
  diag.referenceKeypoints = fr.keypoints.length;
  diag.closeupKeypoints = fc.keypoints.length;
  lap('closeup');
  const matches = matchFeatures(fc.descriptors, fr.descriptors, { ratio: 0.8, crossCheck: true });
  diag.matches = matches.length;
  lap('match');
  if (matches.length < minInliers) return fail('too few matches');
  const first = ransacHomography(pointsOf(fc, matches, 'query'), pointsOf(fr, matches, 'train'), { threshold: 3, maxIterations: 3000, seed: 0x5717c4 });
  diag.initialInliers = first?.inlierCount ?? 0;
  diag.inlierRatio = diag.initialInliers / matches.length;
  if (!first || first.inlierCount < minInliers) return fail('no consistent homography');
  lap('ransac');

  // Guided matching around the predicted positions, then a tighter refit.
  let H = first.H;
  let inlierMatches = matches.filter((_, i) => first.inliers[i]);
  const guided = guidedMatches(fc, fr, H, ref.gray.width, ref.gray.height, 5, 90);
  if (guided.length >= inlierMatches.length) {
    const second = ransacHomography(pointsOf(fc, guided, 'query'), pointsOf(fr, guided, 'train'), { threshold: 2, maxIterations: 1000, seed: 0x5717c5 });
    if (second && second.inlierCount >= first.inlierCount) {
      H = second.H;
      inlierMatches = guided.filter((_, i) => second.inliers[i]);
    }
  }
  diag.inliers = inlierMatches.length;
  lap('guided');

  // Direct refinement in working coordinates.
  if (opts.refine ?? true) {
    const r = refineHomographyDirect(ref.gray, close.gray, H);
    diag.ncc = r.nccAfter;
    diag.refined = r.accepted;
    H = r.H;
  }
  lap('refine');

  // Back to original pixel coordinates: close-up (orig) -> close (small) -> ref (small) -> ref (orig).
  let Horig = mat3Multiply(mat3Invert(ref.toSmall), mat3Multiply(H, close.toSmall));
  Horig = Horig.map((v) => v / Horig[8]);
  const toSmallInvR = mat3Invert(ref.toSmall), toSmallInvC = mat3Invert(close.toSmall);
  diag.pairs = inlierMatches.map((m) => ({
    closeup: applyMat3(toSmallInvC, fc.keypoints[m.queryIdx]),
    reference: applyMat3(toSmallInvR, fr.keypoints[m.trainIdx]),
  }));

  // Geometric validation of the mapped close-up outline.
  const corners = imageCorners(closeup.width, closeup.height);
  if (corners.some((p) => !(projectiveW(Horig, p) > 0))) return fail('outline crosses the horizon');
  const outline = mapPolygon(Horig, corners);
  if (!isConvexClockwise(outline)) return fail('outline not convex');
  const area = polygonSignedArea(outline);
  const refArea = reference.width * reference.height;
  if (area < 5e-4 * refArea || area > 9 * refArea) return fail('implausible outline size');
  const scales = corners.map((p) => localScale(Horig, p));
  if (Math.max(...scales) / Math.min(...scales) > 4) return fail('excessive perspective');
  if (!(Math.abs(det3(Horig)) > 0)) return fail('singular homography');

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of outline) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const coverage: Rect = clampRect({ x: x0 + 0.5, y: y0 + 0.5, width: x1 - x0, height: y1 - y0 }, reference.width, reference.height);
  if (coverage.width < 2 || coverage.height < 2) return fail('outline outside the reference');
  const center = { x: coverage.x + coverage.width / 2 - 0.5, y: coverage.y + coverage.height / 2 - 0.5 };
  const scaleGain = localScale(mat3Invert(Horig), center);

  if (diag.refined && diag.ncc < 0.2) return fail('close-up does not resemble the reference');

  const cInliers = 1 - Math.exp(-Math.max(0, diag.inliers - 10) / 40);
  const cRatio = clamp01((diag.inlierRatio - 0.1) / 0.3);
  const cNcc = diag.refined ? clamp01((diag.ncc - 0.2) / 0.5) : 0.5;
  const confidence = clamp01(cInliers * (0.5 + 0.5 * cRatio) * (0.4 + 0.6 * cNcc));
  lap('validate');

  return {
    registration: { toReference: Horig, inliers: diag.inliers, confidence, coverage, scaleGain },
    diagnostics: diag,
  };
}

/**
 * Register a close-up photo of part of the puzzle picture against the reference image.
 * Returns the homography mapping close-up pixels to reference pixels (both in original image
 * coordinates) with coverage, resolution gain and confidence, or null when the close-up cannot be
 * located reliably.
 */
export function registerCloseup(reference: RGBAImage, closeup: RGBAImage): CloseupRegistration | null {
  return registerCloseupDetailed(reference, closeup).registration;
}
