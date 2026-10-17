/**
 * Segmentation of a scan photo (loose pieces / assembled patches on a table) into regions.
 *
 * Pipeline: background model (CIE Lab, border band, quadratic lighting surface, iterative
 * refinement, further table colours of a patterned cloth) → per-pixel foreground score → Otsu
 * threshold on the log score with hysteresis, plus a texture cue → close / fill holes / drop specks
 * (no opening: the thin dark cardboard rim often is the only evidence of a piece whose print matches
 * the table, and filling the closed rim recovers it) → connected components → outline tracing and
 * shape analysis → peeling of glare halos and soft shadows → splitting of touching pieces at narrow
 * necks or along the edges between them → reassembly of fragments → outlines snapped to brightness
 * edges in blocky JPEGs → classification (piece / patch / fragment / clutter at the photo border) →
 * reading-order ids → quality.
 */
import { componentMask, labelComponents, labelRuns, removeSmallComponents } from '../../cv/components';
import { traceOuterContour } from '../../cv/contour';
import { distanceTransform } from '../../cv/distance';
import { solveLinear, type Point } from '../../cv/geometry';
import { cloneMask, createGray, createMask, cropMask, cropRGBA, maskArea, maskBounds, type GrayImage, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { close, dilate, erode, fillHoles, open } from '../../cv/morphology';
import { resizeMask } from '../../cv/resize';
import { boxBlurGray } from '../../cv/filter';
import { simplifyPolygon, smoothContour } from '../../cv/polygon';
import { otsuThreshold, threshold } from '../../cv/threshold';
import type { DetectedRegion, PieceShape, QualityIssue, RegionKind } from '../../model/types';
import { backgroundAt, fitBackground, fitLocalTable, foregroundScore, type BackgroundFit } from './background';
import { assessPhoto, assessRegions } from './quality';
import { analyzePieceShape, bodyOrientation, orientationHistogram } from './shape';
import type { BackgroundModel, RegionDiagnostics, SegmentOptions, Segmentation, SegmentedRegion } from './types';
import { boxBlurRGB, doubleMask, halveGray, median, offsetPoints } from './util';
import { noiseSigma } from '../quality/metrics';
import { rgbaToGray, rgbToLab } from '../../cv/color';

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
  // High-pass energy (deviation from the local mean): print structure and outlines respond, smooth
  // ramps such as soft cast shadows and lighting gradients do not.
  const local = boxBlurGray(img, r);
  const dev = createGray(w, h);
  for (let i = 0; i < dev.data.length; i++) dev.data[i] = Math.abs(img.data[i] - local.data[i]);
  const energy = boxBlurGray(dev, r);
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
 * A thin elongated region (seam stub, crack, piece of cable): mean width (area per length) below
 * THIN_WIDTH and at least THIN_ELONGATION times longer than wide (a knob that fell off is compact).
 */
function isThin(c: Candidate, body: number): boolean {
  const len = Math.max(c.bbox.width, c.bbox.height);
  return len >= 0.3 * body && c.area / len < THIN_WIDTH * body && len * len >= THIN_ELONGATION * c.area;
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
      if (f.touchesBorder || f.area >= 0.5 * ra || isThin(f, refBody)) continue;
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

/** Weak specks below this fraction of a piece are noise, not regions. */
const NOISE_SPECK = 0.15;

/** Median foreground score over a candidate's pixels (subsampled). */
function medianScore(score: GrayImage, c: Candidate): number {
  const step = Math.max(1, Math.round(Math.sqrt(c.area / 400)));
  const v: number[] = [];
  for (let y = 0; y < c.bbox.height; y += step) {
    for (let x = 0; x < c.bbox.width; x += step) if (c.mask.data[y * c.bbox.width + x]) v.push(score.data[(y + c.bbox.y) * score.width + x + c.bbox.x]);
  }
  return v.length > 0 ? median(v) : 0;
}

/** Width (fraction of the piece body size) below which a long structure counts as thin (seam, crack, cable). */
const THIN_WIDTH = 0.3;
/** Length (fraction of the body size) from which a thin structure is removed (shorter ones: corners, necks, knobs). */
const THIN_LENGTH = 0.7;
/** Length² / area from which a small region counts as elongated (a disc: 1.27; a 3:1 bar: 3). */
const THIN_ELONGATION = 2.5;

/**
 * Remove thin elongated structures from a region: plank gaps and tile seams, cracks, cables and
 * cloth folds score like a dark object and grow into every piece they touch. An opening with a disk
 * of THIN_WIDTH/2 body sizes (re-grown by one pixel) keeps the bodies of pieces; what it removes,
 * together with small leftovers it cut off (bulges of a seam), is a thin structure when it is long
 * (≥ THIN_LENGTH body sizes) and is dropped. Everything else goes back: rounded-off corners, necks
 * and knobs of pieces, short stubs. Returns the remaining parts as candidates (empty when the whole
 * region was a thin structure), or null when nothing changed.
 */
function removeThin(c: Candidate, body: number, refArea: number, minArea: number, W: number, H: number): Candidate[] | null {
  const r = Math.max(2, Math.round((THIN_WIDTH / 2) * body));
  const pad = r + 2;
  const { width: w, height: h } = c.mask;
  const pw = w + 2 * pad, ph = h + 2 * pad;
  const m = createMask(pw, ph);
  for (let y = 0; y < h; y++) m.data.set(c.mask.data.subarray(y * w, (y + 1) * w), (y + pad) * pw + pad);
  const kept = dilate(erode(m, r, 'disk'), r + 1, 'disk');
  for (let i = 0; i < m.data.length; i++) kept.data[i] &= m.data[i];
  // Pieces: kept blobs of at least a third of a piece. Everything else may belong to a strand.
  const kc = labelComponents(kept, 8);
  const big = new Set(kc.stats.filter((st) => st.area >= 0.3 * refArea).map((st) => st.label));
  const loose = createMask(pw, ph);
  let any = 0;
  for (let i = 0; i < m.data.length; i++) {
    if (m.data[i] && !big.has(kc.labels[i])) { loose.data[i] = 1; any++; }
  }
  if (any === 0) return null;
  const { labels, stats } = labelComponents(loose, 8);
  const thin = new Set<number>();
  for (const st of stats) {
    const len = Math.max(st.bbox.width, st.bbox.height);
    // Long, and thin on average (a compact blob far from any piece is a crumb, not a strand).
    if (len >= THIN_LENGTH * body && st.area / len < THIN_WIDTH * body) thin.add(st.label);
  }
  if (thin.size === 0) return null;
  const out = createMask(pw, ph);
  for (let i = 0; i < m.data.length; i++) out.data[i] = m.data[i] && !thin.has(labels[i]) ? 1 : 0;
  const parts = labelComponents(out, 8);
  return parts.stats
    .filter((st) => st.area >= minArea)
    .map((st) => makeCandidate(componentMask(parts.labels, pw, st.label, st.bbox), { x: st.bbox.x + c.bbox.x - pad, y: st.bbox.y + c.bbox.y - pad, width: st.bbox.width, height: st.bbox.height }, W, H, st.area));
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

/** Outline orientations (degrees mod 90) closer than this look like one assembled grid. */
const SAME_GRID_DEG = 5;

/** Difference of two orientations modulo 90° (0..45). */
function quarterDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 90) + 90) % 90);
  return Math.min(d, 90 - d);
}

/**
 * Colour gradient magnitude (Sobel over R, G, B) of `img` in `rect`, quantised to 0..255 by the
 * crop's maximum.
 */
function colourGradient(img: RGBAImage, rect: Rect): Uint8Array {
  const { width: W, height: H, data } = img;
  const { x: x0, y: y0, width: w, height: h } = rect;
  const mag = new Float32Array(w * h);
  let max = 1e-6;
  const at = (x: number, y: number, c: number) => data[((Math.min(H - 1, Math.max(0, y)) * W) + Math.min(W - 1, Math.max(0, x))) * 4 + c];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = x + x0, Y = y + y0;
      let m2 = 0;
      for (let c = 0; c < 3; c++) {
        const gx = at(X + 1, Y - 1, c) + 2 * at(X + 1, Y, c) + at(X + 1, Y + 1, c) - at(X - 1, Y - 1, c) - 2 * at(X - 1, Y, c) - at(X - 1, Y + 1, c);
        const gy = at(X - 1, Y + 1, c) + 2 * at(X, Y + 1, c) + at(X + 1, Y + 1, c) - at(X - 1, Y - 1, c) - 2 * at(X, Y - 1, c) - at(X + 1, Y - 1, c);
        m2 += gx * gx + gy * gy;
      }
      const m = Math.sqrt(m2);
      mag[y * w + x] = m;
      if (m > max) max = m;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round((255 * mag[i]) / max));
  return out;
}

/**
 * Marker-controlled watershed inside `mask` on the (quantised) gradient: every pixel goes to the
 * marker whose flood reaches it over the lowest edges, so boundaries settle on the strongest edges
 * between markers. `labels` holds marker ids (> 0) and is filled in place.
 */
function watershed(mask: Mask, grad: Uint8Array, labels: Int32Array): void {
  const { width: w, height: h } = mask;
  const buckets: number[][] = Array.from({ length: 256 }, () => []);
  for (let i = 0; i < labels.length; i++) if (labels[i] > 0) buckets[grad[i]].push(i);
  for (let level = 0; level < 256; level++) {
    const b = buckets[level];
    while (b.length > 0) {
      const i = b.pop()!;
      const x = i % w, y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || !mask.data[j] || labels[j] !== 0) continue;
        labels[j] = labels[i];
        buckets[Math.max(level, grad[j])].push(j);
      }
    }
  }
}

/**
 * Split a cluster of touching or slightly overlapping loose pieces along the edges between them.
 * Markers come from the foreground before closing (pieces 1–3 px apart are separate there) or,
 * failing that, from k-means of the interior (k = area / piece area). A watershed on the colour
 * gradient puts the cut on the gap or on the outline of the upper piece. The split is kept only when
 * every part is piece-sized with a plausible piece outline and the parts lie at clearly different
 * angles (pieces of an assembled grid share one angle and stay together).
 */
function splitAtEdges(c: Candidate, ra: number, body: number, preClose: Mask, img: RGBAImage, W: number, H: number): Candidate[] | null {
  const k = Math.round(c.area / ra);
  if (k < 2 || k > 4) return null;
  const { width: w, height: h } = c.mask;
  const { x: bx, y: by } = c.bbox;
  const labels = new Int32Array(w * h);
  // Markers 1: separate blobs of the foreground before closing.
  const sub = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      sub.data[i] = c.mask.data[i] & preClose.data[(y + by) * W + x + bx];
    }
  }
  // Holes inside a piece (dark print) are filled; gaps between pieces open to the outside and stay.
  const comps = labelComponents(open(fillHoles(sub), 1), 4);
  const big = comps.stats.filter((st) => st.area >= 0.3 * ra);
  let viaGap = false;
  if (big.length >= 2 && big.length <= 4) {
    viaGap = true;
    big.forEach((st, n) => {
      for (let i = 0; i < labels.length; i++) if (comps.labels[i] === st.label) labels[i] = n + 1;
    });
  } else {
    // Markers 2: k-means of interior pixel positions (farthest-point start).
    const dt = distanceTransform(c.mask).data;
    const pts: number[] = [];
    for (let i = 0; i < w * h; i++) if (dt[i] >= 0.12 * body) pts.push(i);
    if (pts.length < 10 * k) return null;
    const cx: number[] = [], cy: number[] = [];
    let far = pts[0], farD = -1;
    for (const i of pts) if (dt[i] > farD) { farD = dt[i]; far = i; }
    cx.push(far % w); cy.push(Math.floor(far / w));
    while (cx.length < k) {
      let bi = pts[0], bd = -1;
      for (const i of pts) {
        const x = i % w, y = (i - x) / w;
        let d = Infinity;
        for (let m = 0; m < cx.length; m++) d = Math.min(d, (x - cx[m]) ** 2 + (y - cy[m]) ** 2);
        if (d > bd) { bd = d; bi = i; }
      }
      cx.push(bi % w); cy.push(Math.floor(bi / w));
    }
    for (let iter = 0; iter < 10; iter++) {
      const sx = new Float64Array(k), sy = new Float64Array(k), n = new Float64Array(k);
      for (const i of pts) {
        const x = i % w, y = (i - x) / w;
        let best = 0, bd = Infinity;
        for (let m = 0; m < k; m++) {
          const d = (x - cx[m]) ** 2 + (y - cy[m]) ** 2;
          if (d < bd) { bd = d; best = m; }
        }
        sx[best] += x; sy[best] += y; n[best]++;
      }
      for (let m = 0; m < k; m++) if (n[m] > 0) { cx[m] = sx[m] / n[m]; cy[m] = sy[m] / n[m]; }
    }
    const r2 = (0.15 * body) ** 2;
    pts.forEach((i) => {
      const x = i % w, y = (i - x) / w;
      for (let m = 0; m < k; m++) if ((x - cx[m]) ** 2 + (y - cy[m]) ** 2 <= r2) { labels[i] = m + 1; break; }
    });
  }
  const nLabels = viaGap ? big.length : k;
  watershed(c.mask, colourGradient(img, c.bbox), labels);
  const parts: Candidate[] = [];
  for (let m = 1; m <= nLabels; m++) {
    const pm = createMask(w, h);
    for (let i = 0; i < labels.length; i++) if (labels[i] === m) pm.data[i] = 1;
    // Keep the main blob of the part (stray pixels go nowhere).
    const lc = labelComponents(pm, 4);
    if (lc.stats.length === 0) return null;
    const main = lc.stats.reduce((a, b2) => (b2.area > a.area ? b2 : a));
    const b = main.bbox;
    const mm = componentMask(lc.labels, w, main.label, b);
    parts.push(makeCandidate(fillHoles(mm), { x: b.x + bx, y: b.y + by, width: b.width, height: b.height }, W, H));
  }
  const conf = parts.map((p) => p.shape?.confidence ?? 0);
  if (parts.some((p) => p.area < 0.5 * ra || p.area > 1.6 * ra)) return null;
  // Gap markers are strong evidence; k-means markers need at least one convincing piece outline.
  if (Math.max(...conf) < (viaGap ? REFERENCE_CONFIDENCE : 0.7)) return null;
  // Pieces of an assembled grid share one angle and sit exactly one body apart on that grid. The
  // angles are only trusted from convincing outlines; otherwise the cluster's own outline must
  // show two grid directions.
  if (Math.min(...conf) < UNCERTAIN_CONFIDENCE && c.secondPeak <= TOUCHING_SECOND_PEAK) return null;
  const ang = parts.map((p) => (p.shape ? bodyOrientation(p.shape) : p.orientation));
  let loose = false;
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (quarterDiff(ang[i], ang[j]) > SAME_GRID_DEG) loose = true;
      const a = parts[i].shape, b = parts[j].shape;
      if (!a || !b) continue;
      const t = (-ang[i] * Math.PI) / 180;
      const dx = b.center.x - a.center.x, dy = b.center.y - a.center.y;
      const u = Math.abs(dx * Math.cos(t) - dy * Math.sin(t)) / a.bodySize, v = Math.abs(dx * Math.sin(t) + dy * Math.cos(t)) / a.bodySize;
      const onGrid = (Math.abs(Math.max(u, v) - 1) < 0.15 && Math.min(u, v) < 0.15);
      if (!onGrid) loose = true;
    }
  }
  return loose ? parts : null;
}

/**
 * Peel soft illumination effects off a region: glare halos and cast shadows change the table's
 * brightness smoothly, while a piece ends at a crisp cut edge. Region pixels reachable from outside
 * through smooth pixels (local high-pass energy of the luminance at table level) are given back to
 * the table. Kept only when it leaves piece-sized parts with clearly better outlines.
 */
function peelSoft(c: Candidate, img: RGBAImage, ra: number, W: number, H: number): Candidate[] | null {
  const pad = 6;
  const x0 = Math.max(0, c.bbox.x - pad), y0 = Math.max(0, c.bbox.y - pad);
  const x1 = Math.min(W, c.bbox.x + c.bbox.width + pad), y1 = Math.min(H, c.bbox.y + c.bbox.height + pad);
  const w = x1 - x0, h = y1 - y0;
  const Y = createGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + y0) * W + x + x0) * 4;
      Y.data[y * w + x] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    }
  }
  const local = boxBlurGray(Y, 2);
  const dev = createGray(w, h);
  for (let i = 0; i < dev.data.length; i++) dev.data[i] = Math.abs(Y.data[i] - local.data[i]);
  const energy = boxBlurGray(dev, 1).data;
  // Region mask in the padded frame; table statistics from the ring outside it.
  const m = createMask(w, h);
  for (let y = 0; y < c.bbox.height; y++) {
    for (let x = 0; x < c.bbox.width; x++) m.data[(y + c.bbox.y - y0) * w + x + c.bbox.x - x0] = c.mask.data[y * c.bbox.width + x];
  }
  const ring = dilate(m, 3);
  const tv: number[] = [];
  for (let i = 0; i < m.data.length; i++) if (!ring.data[i]) tv.push(energy[i]);
  if (tv.length < 50) return null;
  const med = median(tv);
  const mad = median(tv.map((v) => Math.abs(v - med)));
  const t = med + 5 * Math.max(1.4826 * mad, 0.25);
  // Flood from outside through smooth region pixels (4-connected).
  const flooded = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (let i = 0; i < w * h; i++) if (!m.data[i]) { flooded[i] = 1; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || flooded[j] || energy[j] > t) continue;
      flooded[j] = 1;
      queue[tail++] = j;
    }
  }
  const rest = createMask(w, h);
  let removed = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m.data[i]) continue;
    if (flooded[i]) removed++;
    else rest.data[i] = 1;
  }
  if (removed < 0.08 * c.area) return null;
  const cleaned = fillHoles(open(rest, 1));
  const { labels, stats } = labelComponents(cleaned, 8);
  const parts = stats
    .filter((st) => st.area >= 0.5 * ra)
    .map((st) => makeCandidate(componentMask(labels, w, st.label, st.bbox), { x: st.bbox.x + x0, y: st.bbox.y + y0, width: st.bbox.width, height: st.bbox.height }, W, H, st.area));
  if (parts.length === 0) return null;
  const before = c.shape?.confidence ?? 0;
  const ok = Math.max(...parts.map((p) => p.shape?.confidence ?? 0)) >= Math.max(0.6, before + 0.2);
  return ok ? parts : null;
}

/**
 * Colour blockiness of a photo: mean colour-difference step across 8-px block boundaries relative
 * to elsewhere (1 = none; JPEGs at their original pixel grid measure ≈ 1.8–3.7).
 */
function chromaBlockiness(img: RGBAImage): number {
  const { width: w, height: h, data } = img;
  let bs = 0, bn = 0, is = 0, inn = 0;
  const step = Math.max(2, Math.round(h / 400));
  for (let y = 0; y < h; y += step) {
    for (let x = 1; x < w; x++) {
      const o = (y * w + x) * 4, p = o - 4;
      const d = Math.abs(data[o] - data[o + 1] - data[p] + data[p + 1]) + Math.abs(data[o + 2] - data[o + 1] - data[p + 2] + data[p + 1]);
      if ((x & 7) === 0) { bs += d; bn++; } else { is += d; inn++; }
    }
  }
  return bn > 0 && is > 0 ? bs / bn / (is / inn) : 1;
}

/** Blockiness from which outlines are snapped to luminance edges (JPEG colour bleeding). */
const JPEG_BLOCKINESS = 1.3;
/** Smallest kept foreground component in blocky JPEGs (about two 8×8 colour blocks). */
const JPEG_MIN_AREA = 160;

/** Luminance step (table sigmas) from which a region's outline is snapped to the luminance edge. */
const SNAP_MIN_STEP = 8;
/** Fraction of the step (and minimum deviation in sigmas) a boundary pixel must reach to stay. */
const SNAP_FRACTION = 0.15;
const SNAP_MIN_DEV = 2.5;
/** Width of the snapped outer band, fraction of the body size (at least 3 px). */
const SNAP_BAND = 0.035;
/** Median colour score just inside the outline (or of the whole region) below which a region is not snapped. */
const SNAP_MIN_CONTRAST = 12;

/**
 * Snap an outline to the luminance edge where the piece clearly differs in brightness from the
 * table. Phone JPEGs store colour at half resolution in 8–16 px blocks, so colour bleeds a few
 * pixels into the table around every piece and the colour score grows the region into those blocks;
 * brightness is stored at full resolution. Boundary pixels (outer 3 px) whose brightness is still
 * table-like (below 30 % of the piece's brightness step, measured just inside) are dropped unless
 * their colour score is clearly piece-like.
 */
function snapOutline(c: Candidate, img: RGBAImage, score: GrayImage, high: number, noise: number, body: number, W: number, H: number): Candidate | null {
  // Band width: 3 px, more on large pieces in blurry photos (the colour halo scales with the blur).
  const k = Math.max(3, Math.round(SNAP_BAND * body));
  const pad = k + 9;
  const x0 = Math.max(0, c.bbox.x - pad), y0 = Math.max(0, c.bbox.y - pad);
  const x1 = Math.min(W, c.bbox.x + c.bbox.width + pad), y1 = Math.min(H, c.bbox.y + c.bbox.height + pad);
  const w = x1 - x0, h = y1 - y0;
  const m = createMask(w, h);
  for (let y = 0; y < c.bbox.height; y++) {
    for (let x = 0; x < c.bbox.width; x++) m.data[(y + c.bbox.y - y0) * w + x + c.bbox.x - x0] = c.mask.data[y * c.bbox.width + x];
  }
  const Y = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + y0) * W + x + x0) * 4;
      Y[y * w + x] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    }
  }
  // Table brightness and spread from a ring just outside the region.
  const near = dilate(m, k), far = dilate(m, k + 5);
  const ring: number[] = [];
  for (let i = 0; i < w * h; i++) if (far.data[i] && !near.data[i]) ring.push(Y[i]);
  if (ring.length < 30) return null;
  const tY = median(ring);
  const sY = Math.max(noise, 1.4826 * median(ring.map((v) => Math.abs(v - tY))), 1);
  // The piece's brightness just inside the band (k–2k px in), averaged locally along the outline.
  const band = erode(m, k);
  const deep = erode(m, 2 * k);
  const D = createGray(w, h), In = createGray(w, h);
  const ringScore: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!band.data[i] || deep.data[i]) continue;
    D.data[i] = (Y[i] - tY) / sY;
    In.data[i] = 1;
    const x = i % w, yy = (i - x) / w;
    ringScore.push(score.data[(yy + y0) * W + x + x0]);
  }
  // Pieces that barely stand out (dark print on a dark table) keep their outline: their edge is
  // not a clean brightness step.
  if (ringScore.length < 20 || Math.max(median(ringScore), medianScore(score, c)) < SNAP_MIN_CONTRAST) return null;
  const sumD = boxBlurGray(D, k + 1).data, cnt = boxBlurGray(In, k + 1).data;
  let removed = 0;
  const keep = cloneMask(m);
  for (let i = 0; i < w * h; i++) {
    if (!m.data[i] || band.data[i] || cnt[i] < 0.05) continue;
    const din = sumD[i] / cnt[i];
    if (Math.abs(din) < SNAP_MIN_STEP) continue;
    const x = i % w, yy = (i - x) / w;
    if (score.data[(yy + y0) * W + x + x0] >= high) continue;
    if ((Math.sign(din) * (Y[i] - tY)) / sY >= Math.max(SNAP_MIN_DEV, SNAP_FRACTION * Math.abs(din))) continue;
    keep.data[i] = 0;
    removed++;
  }
  if (removed < 0.005 * c.area) return null;
  const cleaned = fillHoles(keep);
  const { labels, stats } = labelComponents(cleaned, 8);
  if (stats.length === 0) return null;
  const main = stats.reduce((a, b) => (b.area > a.area ? b : a));
  if (main.area < 0.85 * c.area) return null;
  return { ...makeCandidate(componentMask(labels, w, main.label, main.bbox), { x: main.bbox.x + x0, y: main.bbox.y + y0, width: main.bbox.width, height: main.bbox.height }, W, H, main.area), group: c.group, merged: c.merged };
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

/**
 * Something lying along the photo border, much longer than deep: the table edge with the floor
 * beyond, the edge of the box lid, a sleeve. Not offered as a piece (a piece or an assembled grid
 * cut off by the border is at most a few pieces long and at least a sliver deep).
 */
function isBorderClutter(c: Candidate, body: number, W: number, H: number): boolean {
  const { x: bx, y: by, width: w, height: h } = c.bbox;
  // Measured without thin attachments (a highlight along the table edge, a cable).
  const m = open(c.mask, 3, 'disk');
  const b = maskBounds(m);
  if (!b) return false;
  const side = [0, 0, 0, 0]; // top, right, bottom, left
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m.data[y * w + x]) continue;
      const X = x + bx, Y = y + by;
      if (Y === 0) side[0]++;
      if (X === W - 1) side[1]++;
      if (Y === H - 1) side[2]++;
      if (X === 0) side[3]++;
    }
  }
  const k = side.indexOf(Math.max(...side));
  const contact = side[k];
  const depth = k % 2 === 0 ? b.height : b.width;
  return contact > CLUTTER_CONTACT * body && contact > CLUTTER_ELONGATION * depth;
}

const CLUTTER_CONTACT = 3;
const CLUTTER_ELONGATION = 3;

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
  // JPEG photos at their original pixel grid: colour bleeds into the table around every piece, in
  // blocks of up to 16×16 px (outlines are snapped to brightness edges below; specks of one or two
  // such blocks are noise).
  const blockiness = chromaBlockiness(photo);
  const blocky = blockiness >= JPEG_BLOCKINESS;
  const minArea = opts.minArea ?? Math.max(blocky ? JPEG_MIN_AREA : 48, Math.round(5e-5 * W * H));

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
  let fit: BackgroundFit = fitBackground(scored);
  lap('background');
  const diag = opts.diagnostics;

  /** Score → threshold → texture → morphology → candidates → reference size → strands removed. */
  const pass = (model: BackgroundFit) => {
    const score = foregroundScore(scored, model);
    lap('score');
    const th = chooseThreshold(score);
    let fg = hysteresis(score, th.high, th.low);
    lap('threshold');
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
    // (Not on a patterned table: its pattern is all brightness structure.)
    if (model.color[0] < DARK_TABLE_L && model.palette.length === 0) addTexture(textureForeground(rgbaToGray(scored), fg));
    lap('texture');
    // Pieces lying 1–3 px apart are still separate here (closing bridges them): kept for splitting.
    const preClose = cloneMask(fg);
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
    const references = () => {
      const singles = referenceSingles(cands);
      const others = cands.filter((c) => !c.touchesBorder);
      const refArea = singles.length > 0 ? median(singles.map((c) => c.area)) : others.length > 0 ? median(others.map((c) => c.area)) : 0;
      const refBody = singles.length > 0 ? median(singles.map((c) => c.shape!.bodySize)) : Math.sqrt(refArea);
      return { singles, refArea, refBody, noReference: singles.length === 0 && others.length < 3 };
    };
    let ref = references();
    // Plank gaps, tile seams, cracks, cables: thin long structures must neither join a piece nor
    // become a region of their own.
    if (ref.refBody > 0) {
      const out: Candidate[] = [];
      let changed = false;
      for (const c of cands) {
        const parts = removeThin(c, ref.refBody, ref.refArea, minArea, W, H);
        if (parts) changed = true;
        out.push(...(parts ?? [c]));
      }
      if (changed) {
        cands = out;
        ref = references();
      }
    }
    lap('thin');
    return { score, th, fg, texOnly, preClose, cands, ref };
  };

  let p = pass(fit);
  // Shadow zones and local lighting the smooth surface cannot follow: learn them from the table
  // around the pieces found so far (coarse grid, cells of at least two pieces) and segment again.
  if (p.ref.refBody > 0 && fit.palette.length === 0) {
    // Excluded (on a 4× coarser grid): clear objects (median score above the high threshold) and
    // anything piece-shaped, plus the surroundings of every strong pixel of other blobs (print of
    // weak pieces and patches is speckled with them). Smooth weak blobs, which may be the shadow
    // zone itself, stay in the estimate (a cell spans several pieces, so the median is robust).
    const f = 4, cw = Math.ceil(W / f), ch = Math.ceil(H / f);
    const whole = createMask(cw, ch), strong = createMask(cw, ch);
    const sd = p.score.data, high = p.th.high;
    for (const c of p.cands) {
      if (c.area < 0.25 * p.ref.refArea) continue;
      const pieceLike = c.area >= 0.5 * p.ref.refArea && c.shape !== null && c.shape.confidence >= MIN_SHAPE_CONFIDENCE;
      const all = pieceLike || medianScore(p.score, c) >= high;
      for (let y = 0; y < c.bbox.height; y++) {
        const Y = y + c.bbox.y, crow = ((Y / f) | 0) * cw;
        for (let x = 0; x < c.bbox.width; x++) {
          if (!c.mask.data[y * c.bbox.width + x]) continue;
          const X = x + c.bbox.x;
          if (all) whole.data[crow + ((X / f) | 0)] = 1;
          else if (sd[Y * W + X] >= high) strong.data[crow + ((X / f) | 0)] = 1;
        }
      }
    }
    const exclude = dilate(whole, Math.max(1, Math.round((0.1 * p.ref.refBody) / f)));
    const near = dilate(strong, Math.max(1, Math.round((0.3 * p.ref.refBody) / f)));
    for (let i = 0; i < exclude.data.length; i++) exclude.data[i] |= near.data[i];
    const local = fitLocalTable(scored, fit, exclude, Math.max(2 * p.ref.refBody, Math.min(W, H) / 10));
    lap('local');
    if (local) {
      fit = { ...fit, local };
      p = pass(fit);
    }
  }
  const { score, th, texOnly, preClose, ref } = p;
  let { fg, cands } = p;
  const { singles, refArea, refBody, noReference } = ref;
  if (diag) Object.assign(diag, { refArea, refBody });
  // Expected single-piece area at a position (follows perspective size trends when measurable).
  const sizeTrend = fitSizeTrend(singles, W, H);
  const refAreaAt = (c: Candidate): number => {
    if (!sizeTrend || refArea <= 0) return refArea;
    const f = sizeTrend(c.bbox.x + c.bbox.width / 2, c.bbox.y + c.bbox.height / 2);
    return refArea * Math.max(0.5, Math.min(2, f * f));
  };

  // Glare halos and cast shadows grown onto pieces: peel them off where that clearly helps.
  if (refArea > 0) {
    const out: Candidate[] = [];
    for (const c of cands) {
      const ra = refAreaAt(c);
      const doubtful = !c.touchesBorder && c.area >= 0.6 * ra && (c.area > 1.3 * ra || !c.shape || c.shape.confidence < 0.7);
      out.push(...((doubtful ? peelSoft(c, scored, ra, W, H) : null) ?? [c]));
    }
    cands = out;
  }

  // Split touching pieces at narrow necks.
  let group = 0;
  if (refArea > 0 && opts.splitTouching !== false) {
    const out: Candidate[] = [];
    for (const c of cands) {
      const ra = refAreaAt(c);
      // A clean four-corner outline clearly larger than a piece is two pieces side by side.
      const confidentSingle = c.shape !== null && c.shape.confidence >= 0.7 && c.shape.bodySize <= 1.2 * refBody * Math.sqrt(ra / refArea);
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
        // Pieces touching along a whole side or slightly overlapping: cut along the edges between them.
        const cut = splitAtEdges(c, ra, refBody * Math.sqrt(ra / refArea), preClose, scored, W, H);
        if (cut) {
          group++;
          for (const p of cut) out.push({ ...p, group });
          continue;
        }
      }
      out.push(c);
    }
    cands = out;
  }
  if (refArea > 0) cands = mergeFragments(cands, refAreaAt, refBody, W, H);
  lap('split');
  if (diag) diag.blockiness = blockiness;
  if (blocky) cands = cands.map((c) => (c.touchesBorder ? c : snapOutline(c, scored, score, th.high, noise, refBody * Math.sqrt(refAreaAt(c) / Math.max(1, refArea)), W, H) ?? c));
  lap('snap');

  // Noise is no region: strands (seam stubs, cracks) and small weak specks (shadow or grain noise
  // that only the low threshold picked up). Strong crumbs and larger weak blobs, which may be a
  // piece that is hard to see, stay.
  if (refArea > 0) {
    cands = cands.filter((c) => {
      const ra = refAreaAt(c);
      if (c.area >= fragRatio * ra) return !isThin(c, refBody * Math.sqrt(ra / refArea));
      return !isThin(c, refBody * Math.sqrt(ra / refArea)) && (c.area >= NOISE_SPECK * ra || medianScore(score, c) >= th.high);
    });
  }

  // Classify and build regions.
  const ordered = readingOrder(cands);
  const clutterAt = new Set<number>();
  const regions: SegmentedRegion[] = ordered.map((c, i) => {
    const ra = refAreaAt(c);
    const ratio = ra > 0 ? c.area / ra : 1;
    // A very clean single-piece shape overrides a moderately large area (e.g. closer to the camera).
    const confidentSingle = c.shape !== null && c.shape.confidence >= 0.9 && ratio <= 2.5;
    // Single pieces vary by ≈ ±25 % in area (tabs vs. blanks), two pieces are ≥ 1.5× the median:
    // between 1.4× and the patch ratio, a region without a convincing single-piece shape is a patch.
    const weakShape = !c.shape || c.shape.confidence < UNCERTAIN_CONFIDENCE;
    const clutter = c.touchesBorder && ra > 0 && isBorderClutter(c, refBody * Math.sqrt(ra / refArea), W, H);
    if (clutter) clutterAt.add(i);
    // Much longer than a piece for at most a piece's area: a strand (seam, crack, shadow edge).
    const bodyAt = refBody * Math.sqrt(ra / Math.max(1, refArea));
    const strand = refArea > 0 && (isThin(c, bodyAt) || (Math.max(c.bbox.width, c.bbox.height) > 2.2 * bodyAt && ratio < 1.2));
    let kind: RegionKind = 'piece';
    if (ratio < fragRatio || clutter || strand) kind = 'unknown';
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
    return { region, mask: c.mask, image: cropRGBA(photo, c.bbox), borderTable: 0 };
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
    if (c.touchesBorder && !clutterAt.has(i)) {
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
    // Specks (far below a piece) are fragments, not pieces that are hard to see; border clutter is no piece.
    const speck = r.kind === 'unknown' && (clutterAt.has(i) || (refArea > 0 && c.area < 0.15 * refAreaAt(c)));
    const unreliable = (r.kind === 'unknown' && !speck) || reassembled || (r.kind === 'piece' && (!c.shape || c.shape.confidence < UNCERTAIN_CONFIDENCE)) ||
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
  const bodyRef = bodies.length > 0 ? median(bodies) : refBody;
  if (fit.palette.length === 0 && fit.color[0] >= BORDER_TABLE_MIN_L && bodyRef > 0) {
    for (const r of regions) r.borderTable = borderTableFraction(photo, fit, r, bodyRef);
  }
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

/** Table lightness from which cast shadows are visible and the border-table fraction is measured. */
const BORDER_TABLE_MIN_L = 60;

/**
 * How much more of a region's outer band (≈ 0.12 body sizes wide) looks like the table than the
 * ring just inside it: table-like = the modelled table colour, possibly darkened by a cast shadow
 * ((L* + 16) scaled by 0.5…1.08, a*, b* alike ± 5). Comparing with the inner ring discounts piece
 * content that happens to be table-coloured (a pale sky on a cream table).
 */
function borderTableFraction(photo: RGBAImage, model: Pick<BackgroundModel, 'coefficients' | 'width' | 'height'>, r: SegmentedRegion, body: number): number {
  const { mask } = r;
  const { x: bx, y: by } = r.region.bbox;
  const k = Math.max(2, Math.round(0.12 * body));
  const core = erode(mask, k), inner = erode(mask, 2 * k);
  // [pixels, table-like] for the outer band and the inner ring.
  const n = [0, 0], t = [0, 0];
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const i = y * mask.width + x;
      if (!mask.data[i] || inner.data[i]) continue;
      const ring = core.data[i] ? 1 : 0;
      n[ring]++;
      const X = x + bx, Y = y + by;
      const o = (Y * photo.width + X) * 4;
      const lab = rgbToLab(photo.data[o], photo.data[o + 1], photo.data[o + 2]);
      const tb = backgroundAt(model, X, Y);
      const rho = (lab[0] + 16) / (tb[0] + 16);
      if (rho > 0.5 && rho < 1.08 && Math.abs(lab[1] - rho * tb[1]) < 5 && Math.abs(lab[2] - rho * tb[2]) < 5) t[ring]++;
    }
  }
  if (n[0] === 0) return 0;
  return Math.max(0, t[0] / n[0] - (n[1] > 0 ? t[1] / n[1] : 0));
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
