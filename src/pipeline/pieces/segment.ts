/**
 * Segmentation of a scan photo (loose pieces / assembled patches on a table) into regions.
 *
 * Pipeline: background model (CIE Lab, border band, quadratic lighting surface, iterative
 * refinement) → per-pixel foreground score → Otsu threshold on the log score with hysteresis →
 * close / fill holes / drop specks (no opening: the thin dark cardboard rim often is the only
 * evidence of a piece whose print matches the table, and filling the closed rim recovers it) →
 * connected components → outline tracing and shape analysis → classification (piece / patch /
 * fragment), splitting of touching pieces at narrow necks → reading-order ids → quality.
 */
import { componentMask, labelComponents, labelRuns, removeSmallComponents } from '../../cv/components';
import { traceOuterContour } from '../../cv/contour';
import { distanceTransform } from '../../cv/distance';
import { solveLinear, type Point } from '../../cv/geometry';
import { cloneMask, createGray, createMask, cropMask, cropRGBA, maskArea, maskBounds, type GrayImage, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { close, dilate, erode, fillHoles, open } from '../../cv/morphology';
import { resizeMask } from '../../cv/resize';
import { boxBlurGray, sobel } from '../../cv/filter';
import { simplifyPolygon, smoothContour } from '../../cv/polygon';
import { otsuThreshold, threshold } from '../../cv/threshold';
import type { DetectedRegion, PieceShape, QualityIssue, RegionKind } from '../../model/types';
import { fitBackground, foregroundScore } from './background';
import { assessPhoto, assessRegions } from './quality';
import { analyzePieceShape, bodyOrientation, orientationHistogram } from './shape';
import type { BackgroundModel, RegionDiagnostics, SegmentOptions, Segmentation, SegmentedRegion } from './types';
import { boxBlurRGB, doubleMask, halveGray, median, offsetPoints } from './util';
import { noiseSigma } from '../quality/metrics';
import { rgbaToGray } from '../../cv/color';

/** Minimum shape confidence for a region to serve as a single-piece size reference. */
const REFERENCE_CONFIDENCE = 0.45;
/** Shapes below this confidence are not attached to regions. */
const MIN_SHAPE_CONFIDENCE = 0.3;
/** Shapes below this confidence raise 'shape_uncertain'. */
const UNCERTAIN_CONFIDENCE = 0.5;
/**
 * Opening radius (fraction of the body size) that separates touching pieces: contacts narrower
 * than ~0.4 body sizes break, while pieces of an assembled patch share whole sides and stay joined.
 * Only regions clearly larger than one piece are split, so narrow-waisted single pieces are safe.
 */
const NECK_RADIUS = 0.2;
/**
 * Relative height of a second outline-orientation peak above which a patch looks like loose pieces
 * at different rotations (assembled patches share one grid: measured ≤ 0.31 vs. up to 0.95).
 */
const TOUCHING_SECOND_PEAK = 0.42;
/**
 * Median foreground score just inside an outline (background sigmas) below which an unreliable
 * region counts as hard to see (well-segmented dark pieces on a dark table measure ≈ 3.5–5, so low
 * contrast alone is not a failure; it is reported only together with an unreliable result).
 */
const LOW_REGION_CONTRAST = 6;
/** Fraction of a region found by the texture cue only, above which colour alone could not separate it. */
const TEXTURE_ASSISTED = 0.05;

/** Gray-level noise sigma from which the score is computed on a 3×3 / 5×5 box-filtered photo. */
const NOISE_SMOOTH_1 = 3;
const NOISE_SMOOTH_2 = 4;

/**
 * Sensor-noise estimate (gray levels) from the photo's border bands, which mostly show the table,
 * so piece content does not inflate it.
 */
function estimateNoise(photo: RGBAImage): number {
  const { width: w, height: h } = photo;
  const b = Math.max(8, Math.round(0.05 * Math.min(w, h)));
  if (w < 3 * b || h < 3 * b) return noiseSigma(rgbaToGray(photo));
  const bands: Rect[] = [
    { x: 0, y: 0, width: w, height: b }, { x: 0, y: h - b, width: w, height: b },
    { x: 0, y: b, width: b, height: h - 2 * b }, { x: w - b, y: b, width: b, height: h - 2 * b },
  ];
  let sum = 0, n = 0;
  for (const r of bands) {
    const a = r.width * r.height;
    sum += noiseSigma(rgbaToGray(cropRGBA(photo, r))) * a;
    n += a;
  }
  return sum / n;
}

/** Texture score (table-normalised robust sigmas) above which a pixel counts as piece texture. */
const TEXTURE_THRESHOLD = 6;
/** Texture blobs covered by colour foreground to at least this fraction count as segmented pieces. */
const TEXTURE_COVERED = 0.8;
/** Table lightness (L*) below which luminance texture is used as well (no visible cast shadows). */
const DARK_TABLE_L = 35;

/**
 * Texture foreground that colour missed. Texture energy = mean Sobel magnitude of the (smoothed)
 * foreground score over a (2r+1)² window: on the shadow-tolerant score the table and soft cast
 * shadows are flat (noise only), while brush strokes and print structure vary even where the
 * piece's colour matches the table. It is normalised by the table's own statistics (robust median /
 * MAD away from the colour foreground, so wood grain or patterned cloth stays background),
 * thresholded and eroded by the window radius (the window must neither inflate outlines nor bridge
 * gaps). Large photos are analysed at half resolution.
 */
function textureForeground(score: GrayImage, colourFg: Mask): Mask | null {
  const { width: W, height: H } = score;
  const half = W * H > 2.5e6;
  // At half resolution the 2×2 average already suppresses pixel noise.
  const img = half ? halveGray(score) : boxBlurGray(score, 1);
  const { width: w, height: h } = img;
  const fgS = half ? resizeMask(colourFg, w, h) : colourFg;
  const r = Math.max(2, Math.round(Math.min(w, h) / 300));
  if (w < 8 * r || h < 8 * r) return null;
  const energy = boxBlurGray(sobel(img).magnitude, r);
  // Robust statistics of the table's texture (samples away from the colour foreground).
  const near = dilate(fgS, r + 3);
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 40000)));
  const buf = new Float32Array(Math.ceil(w / step) * Math.ceil(h / step));
  let n = 0;
  for (let y = r; y < h - r; y += step) {
    for (let x = r; x < w - r; x += step) if (!near.data[y * w + x]) buf[n++] = energy.data[y * w + x];
  }
  if (n < 100) return null;
  const vals = buf.subarray(0, n);
  const m = median(vals);
  for (let i = 0; i < n; i++) vals[i] = Math.abs(vals[i] - m);
  const sigma = Math.max(1.4826 * median(vals), 0.03 * m, 0.05);
  const t = m + TEXTURE_THRESHOLD * sigma;
  const mask = createMask(w, h);
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = energy.data[i] > t ? 1 : 0;
  const core = erode(mask, r + 1);
  // Texture blobs that colour already covers well are segmented pieces (the texture would only
  // blur their outline): skip them. Blobs colour mostly missed (dark print on a dark table) are added.
  const { count, y: ry, x0: rx0, x1: rx1, root } = labelRuns(core, 1, 8);
  const area = new Float64Array(count), covered = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const row = ry[i] * w;
    let c = 0;
    for (let x = rx0[i]; x <= rx1[i]; x++) c += fgS.data[row + x];
    area[root[i]] += rx1[i] - rx0[i] + 1;
    covered[root[i]] += c;
  }
  const add = createMask(w, h);
  for (let i = 0; i < count; i++) {
    const k = root[i];
    if (covered[k] < TEXTURE_COVERED * area[k]) add.data.fill(1, ry[i] * w + rx0[i], ry[i] * w + rx1[i] + 1);
  }
  return half ? doubleMask(add, W, H) : add;
}

/** A region candidate: local mask (tight bbox) plus derived geometry. */
interface Candidate {
  mask: Mask;
  bbox: Rect;
  area: number;
  touchesBorder: boolean;
  /** Raw traced outline in photo coordinates (clockwise). */
  contour: Point[];
  /** Smoothed, simplified outline (the region contour). */
  outline: Point[];
  shape: PieceShape | null;
  orientation: number;
  /** Relative strength of a second outline orientation (see orientationHistogram). */
  secondPeak: number;
  /** Candidates split from the same touching cluster share a group number. */
  group?: number;
  /** Number of separate fragments this candidate was reassembled from (low-contrast pieces). */
  merged?: number;
}

/** Fraction of a region (bbox-local `mask` at `bbox`) covered by the full-photo mask `m`. */
function maskFraction(m: Mask, mask: Mask, bbox: Rect): number {
  let n = 0, hit = 0;
  for (let y = 0; y < bbox.height; y++) {
    const row = (y + bbox.y) * m.width + bbox.x;
    for (let x = 0; x < bbox.width; x++) {
      if (!mask.data[y * bbox.width + x]) continue;
      n++;
      hit += m.data[row + x];
    }
  }
  return n > 0 ? hit / n : 0;
}

/** Gap (px) between two rectangles; 0 when they overlap. */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

/**
 * Reassemble pieces that fell apart because parts of their print match the table: a fragment
 * (< half the expected piece area) is merged with its nearest neighbour within `gap` px when the
 * union is still at most one piece in area and extent, and a closing bridges them into one blob.
 */
function mergeFragments(cands: Candidate[], refAreaAt: (c: Candidate) => number, refBody: number, W: number, H: number): Candidate[] {
  const gap = Math.max(3, 0.12 * refBody);
  let list = [...cands];
  for (let guard = 0; guard < 200; guard++) {
    let merged = false;
    const order = list.map((_, i) => i).sort((i, j) => list[i].area - list[j].area);
    for (const fi of order) {
      const f = list[fi];
      const ra = refAreaAt(f);
      if (f.touchesBorder || f.area >= 0.5 * ra) continue;
      let best = -1, bestGap = Infinity;
      list.forEach((t, ti) => {
        if (ti === fi || t.touchesBorder || t.area + f.area > 1.35 * ra) return;
        const g = rectGap(f.bbox, t.bbox);
        if (g <= gap && g < bestGap) { bestGap = g; best = ti; }
      });
      if (best < 0) continue;
      const t = list[best];
      const x0 = Math.min(f.bbox.x, t.bbox.x), y0 = Math.min(f.bbox.y, t.bbox.y);
      const x1 = Math.max(f.bbox.x + f.bbox.width, t.bbox.x + t.bbox.width), y1 = Math.max(f.bbox.y + f.bbox.height, t.bbox.y + t.bbox.height);
      const ext = 1.6 * Math.sqrt(ra);
      if (x1 - x0 > ext || y1 - y0 > ext) continue;
      const pad = Math.ceil(gap) + 2;
      const U = createMask(x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
      const notT = createMask(U.width, U.height);
      notT.data.fill(1);
      for (const c of [f, t]) {
        for (let y = 0; y < c.bbox.height; y++) {
          for (let x = 0; x < c.bbox.width; x++) {
            if (!c.mask.data[y * c.bbox.width + x]) continue;
            const i = (y + c.bbox.y - y0 + pad) * U.width + x + c.bbox.x - x0 + pad;
            U.data[i] = 1;
            if (c === t) notT.data[i] = 0;
          }
        }
      }
      // True pixel gap between the fragment and the target.
      const dist = distanceTransform(notT).data;
      let d = Infinity;
      for (let y = 0; y < f.bbox.height; y++) {
        for (let x = 0; x < f.bbox.width; x++) {
          if (f.mask.data[y * f.bbox.width + x]) d = Math.min(d, dist[(y + f.bbox.y - y0 + pad) * U.width + x + f.bbox.x - x0 + pad]);
        }
      }
      if (!(d <= gap)) continue;
      const joined = fillHoles(close(U, Math.ceil(d / 2) + 1, 'disk'));
      const { stats } = labelComponents(joined, 8);
      if (stats.length !== 1) continue;
      const b = maskBounds(joined)!;
      const bbox = { x: b.x + x0 - pad, y: b.y + y0 - pad, width: b.width, height: b.height };
      const m = { ...makeCandidate(cropMask(joined, b), bbox, W, H), merged: (f.merged ?? 1) + (t.merged ?? 1) };
      list = list.filter((_, i) => i !== fi && i !== best);
      list.push(m);
      merged = true;
      break;
    }
    if (!merged) break;
  }
  return list;
}

function makeCandidate(mask: Mask, bbox: Rect, photoW: number, photoH: number, area?: number): Candidate {
  const contour = offsetPoints(traceOuterContour(mask), bbox.x, bbox.y);
  const outline = simplifyPolygon(smoothContour(contour, 0.7), 0.5);
  const touchesBorder = bbox.x <= 0 || bbox.y <= 0 || bbox.x + bbox.width >= photoW || bbox.y + bbox.height >= photoH;
  const shape = touchesBorder ? null : analyzePieceShape(contour);
  const o = orientationHistogram(outline);
  return { mask, bbox, area: area ?? maskArea(mask), touchesBorder, contour, outline, shape, orientation: o.angle, secondPeak: o.secondPeak };
}

/** Foreground mask by hysteresis: pixels above `low` 8-connected to a pixel above `high`. */
function hysteresis(score: GrayImage, high: number, low: number): Mask {
  const { width: w, height: h } = score;
  const runs = labelRuns(threshold(score, low), 1, 8);
  const { count, y: ry, x0: rx0, x1: rx1, root } = runs;
  const keep = new Uint8Array(count);
  const s = score.data;
  for (let i = 0; i < count; i++) {
    const r = root[i];
    if (keep[r]) continue;
    const row = ry[i] * w;
    for (let x = rx0[i]; x <= rx1[i]; x++) {
      if (s[row + x] > high) { keep[r] = 1; break; }
    }
  }
  const out = createMask(w, h);
  for (let i = 0; i < count; i++) if (keep[root[i]]) out.data.fill(1, ry[i] * w + rx0[i], ry[i] * w + rx1[i] + 1);
  return out;
}

/** Otsu on the log foreground score (subsampled), clamped to a statistically sensible range. */
function chooseThreshold(score: GrayImage): { high: number; low: number; separability: number } {
  const n = score.data.length;
  const step = Math.max(1, Math.round(Math.sqrt(n / 250000)));
  const vals: number[] = [];
  for (let y = 0; y < score.height; y += step) {
    for (let x = 0; x < score.width; x += step) vals.push(Math.log1p(Math.min(300, score.data[y * score.width + x])));
  }
  const g = createGray(vals.length, 1);
  g.data.set(vals);
  const o = otsuThreshold(g);
  const t = Math.expm1(o.threshold);
  const high = Math.max(4.5, Math.min(14, t));
  return { high, low: Math.max(3.2, 0.55 * high), separability: o.separability };
}

/**
 * Split a cluster at narrow necks: open with a disk of radius `r` (removes tabs and thin contacts),
 * keep cores of at least `minCore` pixels and give every cluster pixel to the core it reaches
 * first (8-connected BFS inside the cluster). Returns null when there are fewer than two cores.
 */
function splitAtNecks(c: Candidate, r: number, minCore: number): { mask: Mask; bbox: Rect }[] | null {
  const p = Math.ceil(r) + 1;
  const { width: w, height: h } = c.mask;
  const W = w + 2 * p, H = h + 2 * p;
  const padded = createMask(W, H);
  for (let y = 0; y < h; y++) padded.data.set(c.mask.data.subarray(y * w, (y + 1) * w), (y + p) * W + p);
  const core = open(padded, r, 'disk');
  const { labels, stats } = labelComponents(core, 8);
  const seeds = stats.filter((s) => s.area >= minCore);
  if (seeds.length < 2) return null;
  const owner = new Int32Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const seedIndex = new Int32Array(stats.length + 1);
  seeds.forEach((s, i) => { seedIndex[s.label] = i + 1; });
  for (let i = 0; i < W * H; i++) {
    const sIdx = seedIndex[labels[i]];
    if (labels[i] > 0 && sIdx > 0) { owner[i] = sIdx; queue[tail++] = i; }
  }
  const md = padded.data;
  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W || (dx === 0 && dy === 0)) continue;
        const j = yy * W + xx;
        if (md[j] && owner[j] === 0) { owner[j] = owner[i]; queue[tail++] = j; }
      }
    }
  }
  const parts: { mask: Mask; bbox: Rect }[] = [];
  for (let k = 1; k <= seeds.length; k++) {
    const pm = createMask(W, H);
    for (let i = 0; i < W * H; i++) if (owner[i] === k) pm.data[i] = 1;
    const b = maskBounds(pm);
    if (!b) continue;
    parts.push({ mask: cropMask(pm, b), bbox: { x: b.x + c.bbox.x - p, y: b.y + c.bbox.y - p, width: b.width, height: b.height } });
  }
  return parts.length >= 2 ? parts : null;
}

/**
 * Relative piece-size trend over the photo: robust least-squares plane of √area / median √area of
 * the reference pieces against normalised position. Returns null with fewer than 6 references or
 * when the trend is negligible (< 8 % across the references).
 */
function fitSizeTrend(refs: Candidate[], w: number, h: number): ((x: number, y: number) => number) | null {
  if (refs.length < 6) return null;
  const pts = refs.map((c) => ({ u: (c.bbox.x + c.bbox.width / 2) / w - 0.5, v: (c.bbox.y + c.bbox.height / 2) / h - 0.5, s: Math.sqrt(c.area) }));
  const m = median(pts.map((p) => p.s));
  let use = pts;
  let coef: number[] | null = null;
  for (let iter = 0; iter < 2; iter++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (const p of use) {
      const f = [1, p.u, p.v];
      for (let i = 0; i < 3; i++) {
        b[i] += (f[i] * p.s) / m;
        for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j];
      }
    }
    coef = solveLinear(A, b);
    if (!coef) return null;
    const k = coef;
    // Drop outliers (> 15 % off the plane) and refit.
    const kept = pts.filter((p) => Math.abs(p.s / m - (k[0] + k[1] * p.u + k[2] * p.v)) < 0.15);
    if (kept.length < 6) break;
    use = kept;
  }
  const k = coef!;
  let lo = Infinity, hi = -Infinity;
  for (const p of use) {
    const f = k[0] + k[1] * p.u + k[2] * p.v;
    lo = Math.min(lo, f);
    hi = Math.max(hi, f);
  }
  if (!(lo > 0) || hi / lo < 1.08) return null;
  return (x, y) => Math.max(0.1, (k[0] + k[1] * (x / w - 0.5) + k[2] * (y / h - 0.5)) / k[0]);
}

/** Order regions top-to-bottom in rows, left-to-right within a row. */
function readingOrder<T extends { bbox: Rect }>(items: T[]): T[] {
  if (items.length < 2) return [...items];
  const cy = (t: T) => t.bbox.y + t.bbox.height / 2;
  const cx = (t: T) => t.bbox.x + t.bbox.width / 2;
  const rowTol = 0.5 * median(items.map((t) => t.bbox.height));
  const byY = [...items].sort((a, b) => cy(a) - cy(b));
  const rows: T[][] = [];
  let rowStart = -Infinity;
  for (const t of byY) {
    if (rows.length === 0 || cy(t) - rowStart > rowTol) {
      rows.push([t]);
      rowStart = cy(t);
    } else rows[rows.length - 1].push(t);
  }
  return rows.flatMap((r) => r.sort((a, b) => cx(a) - cx(b)));
}

function isPlausibleSingle(c: Candidate): boolean {
  if (!c.shape || c.touchesBorder || c.shape.confidence < REFERENCE_CONFIDENCE) return false;
  const r = c.area / (c.shape.bodySize * c.shape.bodySize);
  return r > 0.6 && r < 1.6;
}

/** Shape confidence of clean single pieces (assembled patches rarely exceed ≈ 0.8). */
const STRONG_SINGLE = 0.85;

/**
 * The regions that define the single-piece size. Assembled patches sometimes get a plausible
 * "piece" outline (four corners at the patch corners), so: prefer very clean shapes, and when the
 * sizes are clearly multi-modal take the smallest well-supported size cluster (patches are multiples
 * of a piece, never smaller).
 */
function referenceSingles(cands: Candidate[]): Candidate[] {
  const plausible = cands.filter(isPlausibleSingle);
  const strong = plausible.filter((c) => c.shape!.confidence >= STRONG_SINGLE);
  const pool = strong.length >= 2 ? strong : plausible;
  if (pool.length < 2) return pool;
  const size = (c: Candidate) => Math.sqrt(c.area);
  const sorted = [...pool].sort((a, b) => size(a) - size(b));
  if (size(sorted[sorted.length - 1]) < 1.35 * size(sorted[0])) return pool;
  const need = Math.max(2, Math.ceil(0.25 * pool.length));
  for (const c of sorted) {
    const cluster = sorted.filter((d) => size(d) >= size(c) && size(d) <= 1.3 * size(c));
    if (cluster.length >= need) return cluster;
  }
  // No supported cluster (e.g. two very different sizes): trust the cleanest shape.
  const best = sorted.reduce((a, b) => (b.shape!.confidence > a.shape!.confidence ? b : a));
  return sorted.filter((d) => size(d) <= 1.3 * size(best) && size(d) >= size(best) / 1.3);
}

/**
 * Find every piece / patch in a scan photo. Regions get ids 1..n in reading order, a kind
 * ('piece' | 'patch' | 'unknown'), outline, shape (single pieces), orientation and issues; the
 * result also carries the foreground mask, background model and the photo quality report.
 */
export function segmentPieces(photo: RGBAImage, opts: SegmentOptions = {}): Segmentation {
  const W = photo.width, H = photo.height;
  const patchRatio = opts.patchAreaRatio ?? 1.8;
  const fragRatio = opts.fragmentAreaRatio ?? 0.35;
  const minArea = opts.minArea ?? Math.max(48, Math.round(5e-5 * W * H));

  const timings = opts.timings;
  let t0 = performance.now();
  const lap = (name: string) => {
    const t = performance.now();
    if (timings) timings[name] = (timings[name] ?? 0) + (t - t0);
    t0 = t;
  };
  // Noisy photos (dim light): score a box-filtered copy, so that white noise does not drown the
  // small colour difference of dark pieces on a dark table (clean photos keep full sharpness).
  const noise = estimateNoise(photo);
  const smoothing = noise < NOISE_SMOOTH_1 ? 0 : noise < NOISE_SMOOTH_2 ? 1 : 2;
  const scored = smoothing > 0 ? boxBlurRGB(photo, smoothing) : photo;
  const fit = fitBackground(scored);
  lap('background');
  const score = foregroundScore(scored, fit);
  lap('score');
  const th = chooseThreshold(score);
  let fg = hysteresis(score, th.high, th.low);
  lap('threshold');
  const diag = opts.diagnostics;
  if (diag) Object.assign(diag, { score, high: th.high, low: th.low, colour: cloneMask(fg), minArea });
  // Pixels only the texture cue found (colour could not separate them): kept for reporting.
  const texOnly = createMask(W, H);
  const addTexture = (tex: Mask | null) => {
    if (!tex) return;
    for (let i = 0; i < fg.data.length; i++) {
      if (tex.data[i] && !fg.data[i]) { fg.data[i] = 1; texOnly.data[i] = 1; }
    }
  };
  addTexture(textureForeground(score, fg));
  // On a dark table cast shadows are invisible, so luminance texture is safe there and catches dark
  // print whose colour equals the table (on light tables it would also catch the shadows).
  if (fit.color[0] < DARK_TABLE_L) addTexture(textureForeground(rgbaToGray(scored), fg));
  lap('texture');
  fg = close(fg, 2);
  fg = fillHoles(fg);
  const unfiltered = diag ? cloneMask(fg) : null;
  fg = removeSmallComponents(fg, minArea);
  if (diag && unfiltered) {
    for (let i = 0; i < fg.data.length; i++) unfiltered.data[i] &= fg.data[i] ^ 1;
    Object.assign(diag, { texture: texOnly, removed: unfiltered });
  }
  lap('morphology');
  const { labels, stats } = labelComponents(fg, 8);
  lap('components');

  let cands: Candidate[] = stats.map((s) => makeCandidate(componentMask(labels, W, s.label, s.bbox), s.bbox, W, H, s.area));
  lap('shapes');

  // Single-piece reference size.
  const singles = referenceSingles(cands);
  const others = cands.filter((c) => !c.touchesBorder);
  const refArea = singles.length > 0 ? median(singles.map((c) => c.area)) : others.length > 0 ? median(others.map((c) => c.area)) : 0;
  const refBody = singles.length > 0 ? median(singles.map((c) => c.shape!.bodySize)) : Math.sqrt(refArea);
  const noReference = singles.length === 0 && others.length < 3;
  if (diag) Object.assign(diag, { refArea, refBody });
  // Expected single-piece area at a position (follows perspective size trends when measurable).
  const sizeTrend = fitSizeTrend(singles, W, H);
  const refAreaAt = (c: Candidate): number => {
    if (!sizeTrend || refArea <= 0) return refArea;
    const f = sizeTrend(c.bbox.x + c.bbox.width / 2, c.bbox.y + c.bbox.height / 2);
    return refArea * Math.max(0.5, Math.min(2, f * f));
  };

  // Split touching pieces at narrow necks.
  let group = 0;
  if (refArea > 0 && opts.splitTouching !== false) {
    const out: Candidate[] = [];
    for (const c of cands) {
      const confidentSingle = c.shape !== null && c.shape.confidence >= 0.7;
      const ra = refAreaAt(c);
      if (c.area > 1.4 * ra && !confidentSingle) {
        const parts = splitAtNecks(c, Math.max(2, NECK_RADIUS * refBody * Math.sqrt(ra / refArea)), 0.3 * ra);
        // Accept the split when every part is piece-sized and at least one is a convincing piece
        // (the contact area may spoil the other outline).
        const cand = parts?.map((p) => makeCandidate(p.mask, p.bbox, W, H)) ?? [];
        const plausible = cand.length >= 2 && cand.every((p) => p.area >= 0.5 * ra) &&
          cand.some((p) => p.area > patchRatio * ra || (p.shape !== null && p.shape.confidence >= REFERENCE_CONFIDENCE));
        if (plausible) {
          group++;
          for (const p of cand) out.push({ ...p, group });
          continue;
        }
      }
      out.push(c);
    }
    cands = out;
  }
  if (refArea > 0) cands = mergeFragments(cands, refAreaAt, refBody, W, H);
  lap('split');

  // Classify and build regions.
  const ordered = readingOrder(cands);
  const regions: SegmentedRegion[] = ordered.map((c, i) => {
    const ra = refAreaAt(c);
    const ratio = ra > 0 ? c.area / ra : 1;
    // A very clean single-piece shape overrides a moderately large area (e.g. closer to the camera).
    const confidentSingle = c.shape !== null && c.shape.confidence >= 0.9 && ratio <= 2.5;
    // Single pieces vary by ≈ ±25 % in area (tabs vs. blanks), two pieces are ≥ 1.5× the median:
    // between 1.4× and the patch ratio, a region without a convincing single-piece shape is a patch.
    const weakShape = !c.shape || c.shape.confidence < UNCERTAIN_CONFIDENCE;
    let kind: RegionKind = 'piece';
    if (ratio < fragRatio) kind = 'unknown';
    else if ((ratio > patchRatio && !confidentSingle) || (ratio > 1.4 && weakShape)) kind = 'patch';
    // Without any size reference (no convincing single piece, < 3 regions), a region without a
    // convincing single-piece shape is taken as an assembled patch (lone patches score ≤ 0.4,
    // lone pieces ≥ 0.9).
    else if (noReference && weakShape) kind = 'patch';
    const shape = kind === 'piece' && c.shape && c.shape.confidence >= MIN_SHAPE_CONFIDENCE ? c.shape : undefined;
    const orientationDeg = shape ? bodyOrientation(shape) : c.orientation;
    const region: DetectedRegion = {
      id: i + 1,
      kind,
      bbox: c.bbox,
      contour: c.outline,
      area: c.area,
      touchesBorder: c.touchesBorder,
      orientationDeg,
      issues: [],
    };
    if (shape) region.shape = shape;
    return { region, mask: c.mask, image: cropRGBA(photo, c.bbox) };
  });

  // Region-level structural issues.
  const groups = new Map<number, number[]>();
  ordered.forEach((c, i) => {
    if (c.group !== undefined) groups.set(c.group, [...(groups.get(c.group) ?? []), i + 1]);
  });
  const regionDiag: RegionDiagnostics[] = [];
  ordered.forEach((c, i) => {
    const r = regions[i].region;
    const issues: QualityIssue[] = r.issues;
    if (c.touchesBorder) {
      issues.push({ code: 'cut_off', severity: 'warning', message: 'Piece is cut off by the photo edge.', hint: 'Keep all pieces fully inside the frame.', regionIds: [r.id], area: r.bbox });
    }
    if (r.kind === 'unknown' && refArea > 0 && c.area < fragRatio * refAreaAt(c)) {
      issues.push({ code: 'fragment', severity: 'info', message: 'Small fragment, not a whole piece.', hint: 'Remove crumbs and dust from the table.', regionIds: [r.id], area: r.bbox });
    }
    if (c.group !== undefined) {
      issues.push({ code: 'touching_pieces', severity: 'warning', message: 'Touching pieces were separated automatically.', hint: 'Leave a small gap between pieces.', regionIds: groups.get(c.group), area: r.bbox });
    } else if (r.kind === 'patch' && c.secondPeak > TOUCHING_SECOND_PEAK) {
      issues.push({ code: 'touching_pieces', severity: 'warning', message: 'Several pieces seem to touch.', hint: 'Leave a small gap between loose pieces.', regionIds: [r.id], area: r.bbox });
    }
    // Regions colour could not separate (texture had to help, reassembled from fragments, or very
    // weak outlines) whose result is unreliable (fragment, no convincing shape): say so clearly.
    const contrast = median(outlineScores(score, fg, regions[i]));
    const texFrac = maskFraction(texOnly, c.mask, c.bbox);
    const reassembled = (c.merged ?? 1) > 1;
    const unreliable = r.kind === 'unknown' || reassembled || (r.kind === 'piece' && (!c.shape || c.shape.confidence < UNCERTAIN_CONFIDENCE)) ||
      (r.kind === 'patch' && texFrac > 3 * TEXTURE_ASSISTED);
    const hardToSee = reassembled || contrast < LOW_REGION_CONTRAST || (texFrac > TEXTURE_ASSISTED && contrast < 2.5 * LOW_REGION_CONTRAST);
    if (diag) {
      const ra = refAreaAt(c);
      regionDiag.push({ id: r.id, contrast, textureFraction: texFrac, merged: c.merged ?? 1, areaRatio: ra > 0 ? c.area / ra : 1, shapeConfidence: c.shape?.confidence ?? 0, split: c.group !== undefined });
    }
    if (!c.touchesBorder && unreliable && hardToSee) {
      issues.push({ code: 'low_contrast', severity: 'warning', message: 'This piece is hard to tell from the background; its outline may be wrong.', hint: 'Use a plain background that contrasts with the pieces.', regionIds: [r.id], area: r.bbox });
    }
    if (r.kind === 'piece' && !c.touchesBorder && (!c.shape || c.shape.confidence < UNCERTAIN_CONFIDENCE)) {
      issues.push({ code: 'shape_uncertain', severity: 'info', message: 'Piece outline is unclear.', hint: 'Use a plain background and spread the pieces out.', regionIds: [r.id], area: r.bbox });
    }
  });

  if (diag) diag.regions = regionDiag;
  const bodies = regions.filter((r) => r.region.shape).map((r) => r.region.shape!.bodySize);
  const background: BackgroundModel = {
    ...fit,
    noise,
    smoothing,
    coverage: 1 - maskArea(fg) / (W * H),
    threshold: th.high,
    separability: th.separability,
    outlineContrast: outlineContrast(score, fg, regions),
  };
  const seg: Segmentation = {
    regions,
    foreground: fg,
    background,
    quality: { score: 1, issues: [], metrics: {} },
    medianBodySize: bodies.length > 0 ? median(bodies) : undefined,
  };
  lap('regions');
  if (opts.assessQuality !== false) {
    assessRegions(seg);
    seg.quality = assessPhoto(photo, seg);
    lap('quality');
  }
  return seg;
}

/**
 * Foreground scores just inside a region outline (2–3 px in, ~40 samples): how clearly the region
 * stands out from the background along its border.
 */
function outlineScores(score: GrayImage, fg: Mask, r: SegmentedRegion): number[] {
  const vals: number[] = [];
  const { width: w, height: h } = score;
  const c = r.region.contour;
  if (c.length < 3) return vals;
  const step = Math.max(1, Math.floor(c.length / 40));
  for (let i = 0; i < c.length; i += step) {
    const a = c[(i - 1 + c.length) % c.length], b = c[(i + 1) % c.length];
    const tx = b.x - a.x, ty = b.y - a.y;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) continue;
    // Inward normal of a clockwise outline: (−ty, tx).
    const x = Math.round(c[i].x - (2.5 * ty) / tl), y = Math.round(c[i].y + (2.5 * tx) / tl);
    if (x < 0 || y < 0 || x >= w || y >= h || !fg.data[y * w + x]) continue;
    vals.push(score.data[y * w + x]);
  }
  return vals;
}

/**
 * Median foreground score just inside the region outlines (2–3 px in), a measure of how clearly the
 * pieces stand out from the background at their borders.
 */
function outlineContrast(score: GrayImage, fg: Mask, regions: SegmentedRegion[]): number {
  const vals: number[] = [];
  const { width: w, height: h } = score;
  for (const r of regions) {
    const c = r.region.contour;
    if (c.length < 3) continue;
    const step = Math.max(1, Math.floor(c.length / 40));
    for (let i = 0; i < c.length; i += step) {
      const a = c[(i - 1 + c.length) % c.length], b = c[(i + 1) % c.length];
      const tx = b.x - a.x, ty = b.y - a.y;
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) continue;
      // Inward normal of a clockwise outline: (−ty, tx).
      const x = Math.round(c[i].x - (2.5 * ty) / tl), y = Math.round(c[i].y + (2.5 * tx) / tl);
      if (x < 0 || y < 0 || x >= w || y >= h || !fg.data[y * w + x]) continue;
      vals.push(score.data[y * w + x]);
    }
  }
  return median(vals);
}
