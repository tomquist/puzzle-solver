/**
 * ORB-style features: image pyramid, FAST-9 corners ranked by Harris response with spatial
 * bucketing, intensity-centroid orientation and steered 256-bit BRIEF descriptors computed on
 * box-smoothed intensities (5x5 sums from an integral image).
 */
import { integralImage } from '../filter';
import type { GrayImage } from '../image';
import { resizeGray } from '../resize';
import { detectFast, harrisResponse } from './fast';
import { createRng, gaussianSample } from './random';

export interface Keypoint {
  /** Position in full-resolution (level 0) pixel coordinates. */
  x: number;
  y: number;
  /** Diameter of the described patch in full-resolution pixels. */
  size: number;
  /** Orientation in radians, clockwise on screen (intensity-centroid direction). */
  angle: number;
  /** Harris response (higher = more corner-like). */
  response: number;
  /** Pyramid level the keypoint was detected on. */
  octave: number;
}

export interface DetectOptions {
  /** Upper bound on the number of keypoints (default 2000). */
  maxFeatures?: number;
  /** Number of pyramid levels (default 8). */
  levels?: number;
  /** Scale ratio between consecutive levels (default 1.3). */
  scaleFactor?: number;
  /** FAST intensity threshold on the 0..255 scale (default 15). */
  fastThreshold?: number;
  /** Grid cells along the longer image side used to spread keypoints evenly (default 8). */
  gridCells?: number;
}

export interface Features {
  keypoints: Keypoint[];
  /** 32 bytes (256 bits) per keypoint, in keypoint order. */
  descriptors: Uint8Array;
}

/** Bytes per descriptor. */
export const DESCRIPTOR_BYTES = 32;

/** Patch diameter at level 0 (as in ORB). */
const PATCH_SIZE = 31;
const HALF_PATCH = 15;
/** Radius of BRIEF test locations; plus the 5x5 box half-width (2) it stays inside the patch. */
const PATTERN_RADIUS = 12.5;
/** Pixels kept free at each pyramid level (patch radius + box + rounding). */
const EDGE = HALF_PATCH + 3;

/**
 * Fixed BRIEF sampling pattern: 256 pairs (x1, y1, x2, y2), isotropic Gaussian (sigma = patch/5,
 * "G II" in the BRIEF paper) restricted to a disk so rotated tests stay inside the patch. Generated
 * once from a fixed seed.
 */
const PATTERN = (() => {
  const rng = createRng(0x0b1ef);
  const sigma = PATCH_SIZE / 5;
  const p = new Float32Array(256 * 4);
  const point = (): [number, number] => {
    for (;;) {
      const x = gaussianSample(rng) * sigma;
      const y = gaussianSample(rng) * sigma;
      if (x * x + y * y <= PATTERN_RADIUS * PATTERN_RADIUS) return [x, y];
    }
  };
  for (let i = 0; i < 256; i++) {
    let a: [number, number], b: [number, number];
    do {
      a = point();
      b = point();
    } while (Math.hypot(a[0] - b[0], a[1] - b[1]) < 2);
    p[i * 4] = a[0];
    p[i * 4 + 1] = a[1];
    p[i * 4 + 2] = b[0];
    p[i * 4 + 3] = b[1];
  }
  return p;
})();

/** Half-widths of the circular orientation patch per row offset 0..HALF_PATCH. */
const UMAX = (() => {
  const u = new Int32Array(HALF_PATCH + 1);
  for (let v = 0; v <= HALF_PATCH; v++) u[v] = Math.floor(Math.sqrt(HALF_PATCH * HALF_PATCH + 0.5 - v * v));
  return u;
})();

/** Intensity-centroid orientation (radians, clockwise on screen) of the circular patch at (x, y). */
function centroidAngle(img: GrayImage, x: number, y: number): number {
  const { width: w, data } = img;
  const c = y * w + x;
  let m10 = 0, m01 = 0;
  for (let u = -HALF_PATCH; u <= HALF_PATCH; u++) m10 += u * data[c + u];
  for (let v = 1; v <= HALF_PATCH; v++) {
    const d = UMAX[v];
    let sumDiff = 0;
    const dn = c + v * w, up = c - v * w;
    for (let u = -d; u <= d; u++) {
      const a = data[dn + u], b = data[up + u];
      m10 += u * (a + b);
      sumDiff += a - b;
    }
    m01 += v * sumDiff;
  }
  return Math.atan2(m01, m10);
}

/** Steered BRIEF descriptor of the keypoint at integer (x, y) using 5x5 box sums of `ii`. */
function describe(ii: Float64Array, stride: number, x: number, y: number, angle: number, out: Uint8Array, offset: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let byte = 0; byte < DESCRIPTOR_BYTES; byte++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) {
      const k = (byte * 8 + bit) * 4;
      const ax = PATTERN[k], ay = PATTERN[k + 1], bx = PATTERN[k + 2], by = PATTERN[k + 3];
      const pxa = x + Math.round(c * ax - s * ay), pya = y + Math.round(s * ax + c * ay);
      const pxb = x + Math.round(c * bx - s * by), pyb = y + Math.round(s * bx + c * by);
      // Box [p-2, p+2] in pixels -> integral rows/cols p-2 .. p+3.
      const a0 = (pya - 2) * stride + pxa - 2, a1 = (pya + 3) * stride + pxa - 2;
      const sa = ii[a1 + 5] - ii[a0 + 5] - ii[a1] + ii[a0];
      const b0 = (pyb - 2) * stride + pxb - 2, b1 = (pyb + 3) * stride + pxb - 2;
      const sb = ii[b1 + 5] - ii[b0 + 5] - ii[b1] + ii[b0];
      if (sa < sb) v |= 1 << bit;
    }
    out[offset + byte] = v;
  }
}

/** Per-level feature budget, proportional to the level's linear scale (as OpenCV's ORB). */
function levelBudgets(maxFeatures: number, levels: number, scaleFactor: number): number[] {
  const f = 1 / scaleFactor;
  let desired = (maxFeatures * (1 - f)) / (1 - Math.pow(f, levels));
  const out: number[] = [];
  let sum = 0;
  for (let l = 0; l < levels - 1; l++) {
    const n = Math.round(desired);
    out.push(n);
    sum += n;
    desired *= f;
  }
  out.push(Math.max(0, maxFeatures - sum));
  return out;
}

interface Candidate {
  x: number;
  y: number;
  response: number;
}

/**
 * Keep up to `budget` candidates, spread over a grid: candidates are ranked within their cell by
 * response, then taken rank by rank (strongest first within a rank).
 */
function bucketSelect(cands: Candidate[], budget: number, width: number, height: number, cell: number): Candidate[] {
  if (cands.length <= budget) return cands;
  cands.sort((a, b) => b.response - a.response);
  const gx = Math.max(1, Math.ceil(width / cell));
  const gy = Math.max(1, Math.ceil(height / cell));
  const counts = new Int32Array(gx * gy);
  const rank = new Int32Array(cands.length);
  let maxRank = 0;
  for (let i = 0; i < cands.length; i++) {
    const cx = Math.min(gx - 1, Math.floor(cands[i].x / cell));
    const cy = Math.min(gy - 1, Math.floor(cands[i].y / cell));
    const r = counts[cy * gx + cx]++;
    rank[i] = r;
    if (r > maxRank) maxRank = r;
  }
  // Stable counting sort by rank keeps the response order inside each rank.
  const start = new Int32Array(maxRank + 2);
  for (let i = 0; i < cands.length; i++) start[rank[i] + 1]++;
  for (let r = 1; r < start.length; r++) start[r] += start[r - 1];
  const order = new Array<Candidate>(cands.length);
  for (let i = 0; i < cands.length; i++) order[start[rank[i]]++] = cands[i];
  return order.slice(0, budget);
}

/**
 * Detect ORB-style keypoints and compute their 256-bit descriptors.
 *
 * Keypoint coordinates are in the pixel-center coordinates of `img` regardless of the pyramid level
 * they were found on. Deterministic for a given image and options.
 */
export function detectFeatures(img: GrayImage, opts: DetectOptions = {}): Features {
  const maxFeatures = Math.max(0, Math.floor(opts.maxFeatures ?? 2000));
  const levels = Math.max(1, Math.floor(opts.levels ?? 8));
  const scaleFactor = Math.max(1.05, opts.scaleFactor ?? 1.3);
  const fastThreshold = opts.fastThreshold ?? 15;
  const gridCells = Math.max(1, Math.round(opts.gridCells ?? 8));
  const budgets = levelBudgets(maxFeatures, levels, scaleFactor);
  const cellSize0 = Math.max(img.width, img.height) / gridCells;

  const keypoints: Keypoint[] = [];
  const blocks: { desc: Uint8Array; n: number }[] = [];
  let level: GrayImage = img;
  for (let l = 0; l < levels; l++) {
    if (l > 0) {
      const w = Math.round(img.width / Math.pow(scaleFactor, l));
      const h = Math.round(img.height / Math.pow(scaleFactor, l));
      if (w <= 2 * EDGE + 8 || h <= 2 * EDGE + 8) break;
      level = resizeGray(level, w, h);
    } else if (img.width <= 2 * EDGE + 8 || img.height <= 2 * EDGE + 8) {
      break;
    }
    const budget = budgets[l];
    if (budget <= 0) continue;
    const sx = img.width / level.width;
    const sy = img.height / level.height;

    const fast = detectFast(level, fastThreshold, EDGE);
    const cands: Candidate[] = [];
    for (let i = 0; i < fast.count; i++) {
      const r = harrisResponse(level, fast.x[i], fast.y[i]);
      if (r > 0) cands.push({ x: fast.x[i], y: fast.y[i], response: r });
    }
    const chosen = bucketSelect(cands, budget, level.width, level.height, cellSize0 / sx);
    if (chosen.length === 0) continue;

    const ii = integralImage(level);
    const desc = new Uint8Array(chosen.length * DESCRIPTOR_BYTES);
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      const angle = centroidAngle(level, c.x, c.y);
      describe(ii, level.width + 1, c.x, c.y, angle, desc, i * DESCRIPTOR_BYTES);
      keypoints.push({
        x: (c.x + 0.5) * sx - 0.5,
        y: (c.y + 0.5) * sy - 0.5,
        size: PATCH_SIZE * sx,
        angle,
        response: c.response,
        octave: l,
      });
    }
    blocks.push({ desc, n: chosen.length });
  }
  const descriptors = new Uint8Array(keypoints.length * DESCRIPTOR_BYTES);
  let o = 0;
  for (const b of blocks) {
    descriptors.set(b.desc, o);
    o += b.n * DESCRIPTOR_BYTES;
  }
  return { keypoints, descriptors };
}
