/**
 * Segmentation of a scan photo (loose pieces / assembled patches on a table) into regions.
 *
 * Pipeline: background model (CIE Lab, border band, quadratic lighting surface, iterative
 * refinement, further table colours of a patterned cloth; on strongly grained wood the table colour
 * along the grain, grain.ts, around the pieces of a first pass) → per-pixel foreground score → Otsu
 * threshold on the log score with hysteresis, plus a texture cue (on light neutral tables also of the
 * luminance, kept from bridging pieces lying close: lumaTexture.ts) → close / fill holes / drop specks
 * (no opening: the thin dark cardboard rim often is the only evidence of a piece whose print matches
 * the table, and filling the closed rim recovers it) → connected components → outline tracing and
 * shape analysis → peeling of glare halos and soft shadows (a weak region without a crisp edge
 * anywhere is a stain or shading of the table and dropped) → splitting of touching pieces at narrow
 * necks where a seam runs along the cut (loose pieces lying against a large patch peeled off at
 * wider ones, with the table they enclose opened) or along the edges between them (dark creases
 * count as cuts only between pieces at their own angles or cores apart along a seam; without gaps or
 * cores, k-means markers whose floods may run compact), two halves of one piece the stages left
 * joined again, the pixels around the cuts given out again with the table in shade (narrow gaps
 * between pieces lying close) carved out, so knob tips pressed against a neighbour go back to their
 * own piece → reassembly of fragments → outlines snapped to brightness edges in blocky JPEGs → (option) graph-cut
 * refinement of outlines in doubt, trimming halos the colour models clearly take for table
 * (refine.ts) → classification (piece / patch / fragment / clutter at the photo border) →
 * reading-order ids → quality.
 */
import { componentMask, labelComponents, labelRuns, removeSmallComponents } from '../../cv/components';
import { traceOuterContour } from '../../cv/contour';
import { distanceTransform, squaredDistanceTransform } from '../../cv/distance';
import { gmmNegLogLikBest } from '../../cv/gmm';
import { solveLinear, type Point } from '../../cv/geometry';
import { cloneMask, createGray, createMask, cropMask, cropRGBA, maskArea, maskBounds, type GrayImage, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { close, dilate, erode, fillHoles, open } from '../../cv/morphology';
import { resizeMask } from '../../cv/resize';
import { boxBlurGray } from '../../cv/filter';
import { polygonPerimeter, resampleContour, simplifyPolygon, smoothContour } from '../../cv/polygon';
import { otsuThreshold, threshold } from '../../cv/threshold';
import type { DetectedRegion, PieceShape, QualityIssue, RegionKind } from '../../model/types';
import { backgroundAt, fitBackground, fitLocalTable, foregroundScore, tableChromaDistance, tableChromasAt, tableShade, type BackgroundFit } from './background';
import { assessPhoto, assessRegions } from './quality';
import { lumaTexture, lumaTextureApplies, lumaTextureForeground, type LumaTexture } from './lumaTexture';
import { estimatePatchPitch } from './patchPitch';
import { fitGrainTable, grainCoherence, GRAIN_MIN_COHERENCE, type GrainTable } from './grain';
import { refineByGraphCut } from './refine';
import { crispOpenOutline } from './smoothWeak';
import { CAST_BAND, CAST_BAND_MIN, castShadow } from './castShadow';
import { analyzePieceShape, bodyOrientation, orientationHistogram } from './shape';
import type { BackgroundModel, RegionDiagnostics, SegmentOptions, Segmentation, SegmentedRegion } from './types';
import { boxBlurRGB, doubleMask, halveGray, interpolateReplicatedChroma, median, offsetPoints, smoothChroma } from './util';
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
/** Neck radii (body sizes) tried in turn: narrow contacts first, then wider ones for what is still too large. */
const NECK_RADII = [0.2, 0.25, 0.3];
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
 * Parts of a split cluster (each at most HALF_JOIN piece areas, together at most 1.35) that touch
 * and make one convincing piece together are one piece cut in two: a neck cut through a piece's
 * waist and an edge cut of what was left can each leave half a piece, at different stages, so the
 * edge split's own check for halves sees only one of them. Joined while the union's outline is
 * convincing (REFERENCE_CONFIDENCE) and better than both halves' (`cluster`: the split cluster,
 * within which the slit along the cut is closed).
 */
function rejoinHalves(parts: Candidate[], cluster: Candidate, ra: number, W: number, H: number): Candidate[] {
  let list = parts;
  for (let guard = 0; guard < parts.length; guard++) {
    let joined: { i: number; j: number; u: Candidate } | null = null;
    for (let i = 0; i < list.length && !joined; i++) {
      for (let j = i + 1; j < list.length && !joined; j++) {
        const a = list[i], b = list[j];
        if (a.area > HALF_JOIN * ra || b.area > HALF_JOIN * ra || a.area + b.area > 1.35 * ra || rectGap(a.bbox, b.bbox) > 1) continue;
        const x0 = Math.min(a.bbox.x, b.bbox.x), y0 = Math.min(a.bbox.y, b.bbox.y);
        const x1 = Math.max(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width), y1 = Math.max(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height);
        const U = createMask(x1 - x0, y1 - y0);
        for (const q of [a, b]) {
          for (let y = 0; y < q.bbox.height; y++) {
            for (let x = 0; x < q.bbox.width; x++) if (q.mask.data[y * q.bbox.width + x]) U.data[(y + q.bbox.y - y0) * U.width + x + q.bbox.x - x0] = 1;
          }
        }
        if (labelComponents(U, 4).stats.length !== 1) continue;
        // Without what the cuts leave along it: a slit between the halves is closed (within the
        // cluster), slivers of the neighbours' cuts (thin whiskers) are opened away.
        const pad = 3, pw = U.width + 2 * pad, ph = U.height + 2 * pad;
        const P = createMask(pw, ph);
        for (let y = 0; y < U.height; y++) P.data.set(U.data.subarray(y * U.width, (y + 1) * U.width), (y + pad) * pw + pad);
        const closed = fillHoles(close(P, 2));
        const J = createMask(pw, ph);
        for (let y = 0; y < ph; y++) {
          for (let x = 0; x < pw; x++) {
            const X = x - pad + x0 - cluster.bbox.x, Y = y - pad + y0 - cluster.bbox.y;
            if (closed.data[y * pw + x] && X >= 0 && Y >= 0 && X < cluster.bbox.width && Y < cluster.bbox.height && cluster.mask.data[Y * cluster.bbox.width + X]) J.data[y * pw + x] = 1;
          }
        }
        // (Opened, then given back what lies within the opening's reach: corners stay sharp.)
        const near = dilate(open(J, 2), 2);
        for (let i = 0; i < J.data.length; i++) J.data[i] &= near.data[i];
        const { labels: jl, stats: js } = labelComponents(J, 8);
        if (js.length === 0) continue;
        const main = js.reduce((p, q) => (q.area > p.area ? q : p));
        const u = makeCandidate(componentMask(jl, pw, main.label, main.bbox), { x: x0 - pad + main.bbox.x, y: y0 - pad + main.bbox.y, width: main.bbox.width, height: main.bbox.height }, W, H, main.area);
        const conf = u.shape?.confidence ?? 0;
        if (conf >= REFERENCE_CONFIDENCE && conf > Math.max(a.shape?.confidence ?? 0, b.shape?.confidence ?? 0)) joined = { i, j, u };
      }
    }
    if (!joined) break;
    const { i, j, u } = joined;
    list = [...list.filter((_, k) => k !== i && k !== j), u];
  }
  return list;
}

/** Largest part (piece areas) rejoinHalves takes for half a piece. */
const HALF_JOIN = 0.7;

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

/**
 * A region peelSoft floods from outside through smooth pixels for at least SMOOTH_THROUGH of its
 * area, with less than SMOOTH_CRISP of its rim (2 px on either side of its outline) on a crisp
 * edge, has no cut edge anywhere: a stain or a shading of the table (dropped when its colour is
 * weak too), not a piece.
 */
const SMOOTH_THROUGH = 0.9;
const SMOOTH_CRISP = 0.03;
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

/** Share of strong pixels (score above the high threshold) from which a blob is no table for the local model. */
const LOCAL_STRONG_SHARE = 0.2;
/** Width (fraction of the piece body size) below which a long structure counts as thin (seam, crack, cable). */
const THIN_WIDTH = 0.3;
/** Length (fraction of the body size) from which a thin structure is removed (shorter ones: corners, necks, knobs). */
const THIN_LENGTH = 0.7;
/** Share of a long loose part the opening removed from which it is thin as a whole (gap networks). */
const THIN_REMOVED = 0.75;
/** Length² / area from which a small region counts as elongated (a disc: 1.27; a 3:1 bar: 3). */
const THIN_ELONGATION = 2.5;

/** How far (body sizes) weak foreground may reach from the nearest strong pixel. */
const WEAK_REACH = 0.2;
/** Smallest strong area (piece areas) that anchors weak foreground around it. */
const ANCHOR_MIN = 0.02;
/** Share of a far weak area's outline along the rest of its region below which it hangs off it (dropFarWeak). */
const HANGING_CONTACT = 0.2;

/**
 * Keep a region's weak pixels (score below `high`, not added by the texture cue) only within
 * `reach` px of a strong area of at least `minAnchor` px; holes enclosed by what remains stay
 * filled. `measured`: `refArea` comes from single pieces (only then is a region known to be a few
 * pieces, see below). Returns the remaining parts as candidates, or null when nothing changed.
 * Exported for tests.
 */
export function dropFarWeak(c: Pick<Candidate, 'mask' | 'bbox' | 'area'>, score: GrayImage, high: number, texOnly: Mask, reach: number, minAnchor: number, refArea: number, minArea: number, W: number, H: number, measured: boolean, img?: RGBAImage): Candidate[] | null {
  const r = Math.ceil(reach), pad = r + 1;
  const { width: w, height: h } = c.mask;
  const pw = w + 2 * pad, ph = h + 2 * pad;
  const m = createMask(pw, ph), anchor = createMask(pw, ph);
  let weak = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!c.mask.data[y * w + x]) continue;
      const i = (y + pad) * pw + x + pad, g = (y + c.bbox.y) * W + x + c.bbox.x;
      m.data[i] = 1;
      if (score.data[g] >= high || texOnly.data[g]) anchor.data[i] = 1;
      else weak++;
    }
  }
  if (weak === 0) return null;
  // Only solid strong areas anchor (not stray strong pixels inside a weak band).
  const ac = labelComponents(anchor, 8);
  for (const st of ac.stats) {
    if (st.area >= minAnchor) continue;
    const { x: ax, y: ay, width: aw, height: ah } = st.bbox;
    for (let y = ay; y < ay + ah; y++) for (let x = ax; x < ax + aw; x++) if (ac.labels[y * pw + x] === st.label) anchor.data[y * pw + x] = 0;
  }
  const near = dilate(anchor, reach, 'disk');
  const keep = createMask(pw, ph);
  let dropped = 0;
  for (let i = 0; i < m.data.length; i++) {
    if (!m.data[i]) continue;
    if (near.data[i]) keep.data[i] = 1;
    else dropped++;
  }
  if (dropped === 0) return null;
  const filled = fillHoles(keep);
  const gone = createMask(pw, ph);
  for (let i = 0; i < m.data.length; i++) {
    filled.data[i] &= m.data[i];
    if (m.data[i] && !filled.data[i]) gone.data[i] = 1;
  }
  // Only weak areas that are no part of a piece go: a band (much longer than wide), a large
  // surface, anything reaching the photo border (the floor beyond the table edge), or (in a cluster
  // of a few touching pieces, which the split takes apart) an area hanging off the region by a short
  // stretch of its outline. A weak piece interior far from strong pixels stays.
  const body = Math.sqrt(refArea);
  const fewPieces = measured && c.area >= 1.4 * refArea && c.area <= EDGE_RECUT_MAX_PIECES * refArea;
  const gc = labelComponents(gone, 8);
  dropped = 0;
  let hang: Mask | null = null;
  for (const st of gc.stats) {
    const len = Math.max(st.bbox.width, st.bbox.height);
    const X0 = st.bbox.x + c.bbox.x - pad, Y0 = st.bbox.y + c.bbox.y - pad;
    const atBorder = X0 <= 0 || Y0 <= 0 || X0 + st.bbox.width >= W || Y0 + st.bbox.height >= H;
    const band = len >= 1.5 * body && st.area / len < 0.5 * body;
    const { x: gx, y: gy, width: gw, height: gh } = st.bbox;
    // Hanging off the region by a short stretch of its outline (the rest along the table): shaded
    // table grown onto touching pieces, tying them together beyond any neck (a piece's own weak print
    // lies along its strong rim; a weak area on its own, all table round, may be a pale piece).
    let hanging = false;
    if (fewPieces) {
      let along = 0, open = 0;
      for (let y = gy; y < gy + gh; y++) {
        for (let x = gx; x < gx + gw; x++) {
          const i = y * pw + x;
          if (gc.labels[i] !== st.label) continue;
          for (const j of [i - 1, i + 1, i - pw, i + pw]) {
            if (gc.labels[j] === st.label) continue;
            if (filled.data[j]) along++;
            else open++;
          }
        }
      }
      hanging = along > 0 && along < HANGING_CONTACT * (along + open);
      // Or mostly facing the table and fading into it all along there (no crisp cut edge, as in
      // peelSoft's stain test): a sheen or a shading of the table spread between the pieces, not a
      // pale piece, which ends at a cut edge (smoothWeak.ts).
      if (!hanging && img && along > 0 && open > along) hanging = (crispOpenOutline(img, gc.labels, st.label, st.bbox, m, c.bbox.x - pad, c.bbox.y - pad) ?? 1) < SMOOTH_CRISP;
    }
    if (atBorder || band || hanging || st.area >= 2 * refArea) {
      dropped += st.area;
      if (hanging) {
        hang ??= createMask(pw, ph);
        for (let y = gy; y < gy + gh; y++) for (let x = gx; x < gx + gw; x++) if (gc.labels[y * pw + x] === st.label) hang.data[y * pw + x] = 1;
      }
      continue;
    }
    for (let y = gy; y < gy + gh; y++) for (let x = gx; x < gx + gw; x++) if (gc.labels[y * pw + x] === st.label) filled.data[y * pw + x] = 1;
  }
  if (dropped < 0.02 * c.area) return null;
  // The weak foot of a hanging area (within reach of the strong pixels, so kept above) goes with it.
  if (hang) {
    const foot = dilate(hang, reach, 'disk');
    for (let i = 0; i < filled.data.length; i++) if (foot.data[i] && !anchor.data[i]) filled.data[i] = 0;
  }
  const parts = labelComponents(filled, 8);
  return parts.stats
    .filter((st) => st.area >= minArea)
    .map((st) => makeCandidate(componentMask(parts.labels, pw, st.label, st.bbox), { x: st.bbox.x + c.bbox.x - pad, y: st.bbox.y + c.bbox.y - pad, width: st.bbox.width, height: st.bbox.height }, W, H, st.area, SHAPE_MAX_PIECES * refArea));
}

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
  // Pixels of each loose part the opening removed (thin everywhere) versus kept (crumbs, bulges).
  const removed = new Float64Array(stats.length + 1);
  for (let i = 0; i < m.data.length; i++) if (labels[i] > 0 && !kept.data[i]) removed[labels[i]]++;
  const thin = new Set<number>();
  for (const st of stats) {
    const len = Math.max(st.bbox.width, st.bbox.height);
    // Long, and thin: on average (a compact blob far from any piece is a crumb, not a strand), or
    // nearly all of it too thin for the opening (a network of gaps, whose bbox is no length).
    if (len >= THIN_LENGTH * body && (st.area / len < THIN_WIDTH * body || removed[st.label] >= THIN_REMOVED * st.area)) thin.add(st.label);
  }
  if (thin.size === 0) return null;
  const out = createMask(pw, ph);
  for (let i = 0; i < m.data.length; i++) out.data[i] = m.data[i] && !thin.has(labels[i]) ? 1 : 0;
  const parts = labelComponents(out, 8);
  return parts.stats
    .filter((st) => st.area >= minArea)
    .map((st) => makeCandidate(componentMask(parts.labels, pw, st.label, st.bbox), { x: st.bbox.x + c.bbox.x - pad, y: st.bbox.y + c.bbox.y - pad, width: st.bbox.width, height: st.bbox.height }, W, H, st.area, SHAPE_MAX_PIECES * refArea));
}

function makeCandidate(mask: Mask, bbox: Rect, photoW: number, photoH: number, area?: number, shapeUpTo = Infinity): Candidate {
  const contour = offsetPoints(traceOuterContour(mask), bbox.x, bbox.y);
  const outline = simplifyPolygon(smoothContour(contour, 0.7), 0.5);
  const touchesBorder = bbox.x <= 0 || bbox.y <= 0 || bbox.x + bbox.width >= photoW || bbox.y + bbox.height >= photoH;
  // Shapes only for what may be a single piece (the analysis of a large cluster's outline is slow).
  const shape = touchesBorder || (area ?? maskArea(mask)) > shapeUpTo ? null : analyzePieceShape(contour);
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
 * first (8-connected BFS inside the cluster). Cores whose share ends up below `minPart` pixels (a
 * knob, a corner) are dropped and their pixels go to the others. Returns null when fewer than two
 * parts remain.
 */
function splitAtNecks(c: Candidate, r: number, minCore: number, minPart: number): { mask: Mask; bbox: Rect }[] | null {
  const p = Math.ceil(r) + 1;
  const { width: w, height: h } = c.mask;
  const W = w + 2 * p, H = h + 2 * p;
  const padded = createMask(W, H);
  for (let y = 0; y < h; y++) padded.data.set(c.mask.data.subarray(y * w, (y + 1) * w), (y + p) * W + p);
  const core = open(padded, r, 'disk');
  const { labels, stats } = labelComponents(core, 8);
  let seeds = stats.filter((s) => s.area >= minCore);
  if (seeds.length < 2) return null;
  const owner = new Int32Array(W * H);
  const queue = new Int32Array(W * H);
  const md = padded.data;
  let share = new Float64Array(0);
  for (;;) {
    owner.fill(0);
    let head = 0, tail = 0;
    const seedIndex = new Int32Array(stats.length + 1);
    seeds.forEach((s, i) => { seedIndex[s.label] = i + 1; });
    for (let i = 0; i < W * H; i++) {
      const sIdx = seedIndex[labels[i]];
      if (labels[i] > 0 && sIdx > 0) { owner[i] = sIdx; queue[tail++] = i; }
    }
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
    share = new Float64Array(seeds.length + 1);
    for (let i = 0; i < W * H; i++) share[owner[i]]++;
    // Drop every core whose share is too small (the largest of them stays when all are).
    const small = seeds.map((_, i) => share[i + 1] < minPart);
    if (!small.some((v) => v)) break;
    const keep = seeds.filter((_, i) => !small[i]);
    if (keep.length < 2) return null;
    seeds = keep;
  }
  // Part bounds in one sweep, then crop.
  const n = seeds.length;
  const x0 = new Int32Array(n + 1).fill(W), y0 = new Int32Array(n + 1).fill(H), x1 = new Int32Array(n + 1).fill(-1), y1 = new Int32Array(n + 1).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = owner[y * W + x];
      if (k === 0) continue;
      if (x < x0[k]) x0[k] = x;
      if (x > x1[k]) x1[k] = x;
      if (y < y0[k]) y0[k] = y;
      if (y > y1[k]) y1[k] = y;
    }
  }
  const parts: { mask: Mask; bbox: Rect }[] = [];
  for (let k = 1; k <= n; k++) {
    if (x1[k] < 0) continue;
    const bw = x1[k] - x0[k] + 1, bh = y1[k] - y0[k] + 1;
    const pm = createMask(bw, bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) if (owner[(y + y0[k]) * W + x + x0[k]] === k) pm.data[y * bw + x] = 1;
    }
    parts.push({ mask: pm, bbox: { x: x0[k] + c.bbox.x - p, y: y0[k] + c.bbox.y - p, width: bw, height: bh } });
  }
  return parts.length >= 2 ? parts : null;
}

/**
 * The mask of a cluster with the table it encloses opened again (bbox-local), or null when it
 * encloses none: background before closing of at least `minHole` pixels inside it. Filling holes
 * up to 1.5 pieces keeps pieces whose print matches the table whole, but also closes the table
 * between a patch and loose pieces lying against it, which then ties them to the patch beyond any
 * neck. (Used for peeling only: between loose pieces alone, the cuts of the opened mask are cruder
 * than the edge split.)
 */
function openTableHoles(c: Candidate, preClose: Mask, minHole: number, W: number): Mask | null {
  const { width: w, height: h } = c.mask;
  const { x: bx, y: by } = c.bbox;
  const bg = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      bg.data[i] = c.mask.data[i] & (preClose.data[(y + by) * W + x + bx] ^ 1);
    }
  }
  const { labels, stats } = labelComponents(bg, 4);
  const holes = stats.filter((st) => st.area >= minHole);
  if (holes.length === 0) return null;
  const isHole = new Uint8Array(stats.length + 1);
  for (const st of holes) isHole[st.label] = 1;
  const out = cloneMask(c.mask);
  for (let i = 0; i < out.data.length; i++) if (isHole[labels[i]]) out.data[i] = 0;
  return out;
}

/**
 * Smallest blob (piece areas) of table inside a patch's mask that {@link tableInside} reports:
 * a hole of a missing piece whose neighbours' tabs reach into it shows less than half a piece of
 * table (too little for {@link TABLE_HOLE}), but far more than specks of table-coloured print.
 */
const TABLE_SPECK = 0.04;

/**
 * The pixels of a patch's mask (at `bbox`) that look like the table: below the strong foreground
 * threshold `high` (the table in a hole between pieces lies in their shadow, which the hysteresis
 * ties to them), not found by texture, and the table's colour, possibly darkened by a shadow (as
 * in {@link borderTableFraction}; weak print of another colour stays print), in blobs of at least
 * `minArea` px once thin gaps along the seams are opened away; undefined when there are none.
 * These are the holes and notches of missing pieces the segmentation took into the patch (too
 * small for {@link TABLE_HOLE}, shadowed, or open to the table through a narrow gap), for deciding
 * which cells the patch covers.
 */
function tableInside(photo: RGBAImage, model: BackgroundFit, mask: Mask, bbox: Rect, score: GrayImage, high: number, texOnly: Mask, minArea: number): Mask | undefined {
  const { width: w, height: h } = mask;
  const W = score.width;
  let bg = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = (y + bbox.y) * W + x + bbox.x;
      if (!mask.data[i] || score.data[j] >= high || texOnly.data[j]) continue;
      const lab = rgbToLab(photo.data[j * 4], photo.data[j * 4 + 1], photo.data[j * 4 + 2]);
      const tb = backgroundAt(model, x + bbox.x, y + bbox.y);
      const rho = (lab[0] + 16) / (tb[0] + 16);
      if (rho > 0.5 && rho < 1.08 && Math.abs(lab[1] - rho * tb[1]) < 5 && Math.abs(lab[2] - rho * tb[2]) < 5) bg.data[i] = 1;
    }
  }
  bg = open(bg, 2);
  const { labels, stats } = labelComponents(bg, 4);
  const keep = new Uint8Array(stats.length + 1);
  let any = false;
  for (const st of stats) {
    if (st.area < minArea) continue;
    keep[st.label] = 1;
    any = true;
  }
  if (!any) return undefined;
  for (let i = 0; i < bg.data.length; i++) bg.data[i] = keep[labels[i]];
  return bg;
}

/**
 * A part's mask (at `bbox`) with the opened holes it encloses given back (print inside one piece;
 * table between several pieces stays open): `cluster` as it was, `opened` its mask with the holes.
 */
function refill(mask: Mask, bbox: Rect, cluster: Candidate, opened: Mask): Mask {
  const filled = fillHoles(mask);
  const { mask: cm, bbox: cb } = cluster;
  for (let y = 0; y < bbox.height; y++) {
    for (let x = 0; x < bbox.width; x++) {
      const i = y * bbox.width + x;
      if (!filled.data[i] || mask.data[i]) continue;
      const cx = x + bbox.x - cb.x, cy = y + bbox.y - cb.y;
      const j = cy * cm.width + cx;
      if (cx < 0 || cy < 0 || cx >= cm.width || cy >= cm.height || !cm.data[j] || opened.data[j]) filled.data[i] = 0;
    }
  }
  return filled;
}

/**
 * Maximum over (2r+1)² squares (clamped at the edges) of a w×h image, in O(w·h) whatever the radius:
 * van Herk / Gil-Werman, the running maxima from the start and from the end of blocks of 2r+1
 * samples, first along the rows, then along the columns (whole rows at a time).
 */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const k = 2 * r + 1;
  const g = new Float32Array(w * h), f = new Float32Array(w * h), rows = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let b = o; b < o + w; b += k) {
      const e = Math.min(o + w, b + k) - 1;
      g[b] = src[b];
      for (let i = b + 1; i <= e; i++) g[i] = src[i] > g[i - 1] ? src[i] : g[i - 1];
      f[e] = src[e];
      for (let i = e - 1; i >= b; i--) f[i] = src[i] > f[i + 1] ? src[i] : f[i + 1];
    }
    for (let x = 0; x < w; x++) {
      const a = f[o + (x > r ? x - r : 0)], c = g[o + (x + r < w ? x + r : w - 1)];
      rows[o + x] = a > c ? a : c;
    }
  }
  for (let b = 0; b < h; b += k) {
    const e = Math.min(h, b + k) - 1;
    g.set(rows.subarray(b * w, (b + 1) * w), b * w);
    for (let i = (b + 1) * w; i < (e + 1) * w; i++) g[i] = rows[i] > g[i - w] ? rows[i] : g[i - w];
    f.set(rows.subarray(e * w, (e + 1) * w), e * w);
    for (let i = e * w - 1; i >= b * w; i--) f[i] = rows[i] > f[i + w] ? rows[i] : f[i + w];
  }
  for (let y = 0; y < h; y++) {
    const a = (y > r ? y - r : 0) * w, c = (y + r < h ? y + r : h - 1) * w, o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = f[a + x] > g[c + x] ? f[a + x] : g[c + x];
  }
  return out;
}

/** Side (px) of the tiles in which black top-hats are computed and kept per photo (blackTopHat). */
const TOP_HAT_TILE = 128;
/** Black top-hat tiles per photo and radius (blackTopHat). */
const topHatTiles = new WeakMap<RGBAImage, Map<number, (Float32Array | undefined)[]>>();

/**
 * Black top-hat of the luminance over `rect` ((2r+1)² closing minus luminance, gray levels): high on
 * thin dark valleys such as the crease between two touching pieces (cardboard edge, shadow), low on
 * the step edges of a piece's print. Computed in tiles of the photo as they are first needed and
 * kept with the photo: the clusters asked about overlap (a cluster at several neck radii, its parts,
 * its edges).
 */
function blackTopHat(img: RGBAImage, rect: Rect, r: number): Float32Array {
  const T = TOP_HAT_TILE, cols = Math.ceil(img.width / T);
  let byRadius = topHatTiles.get(img);
  if (!byRadius) topHatTiles.set(img, (byRadius = new Map()));
  let tiles = byRadius.get(r);
  if (!tiles) byRadius.set(r, (tiles = []));
  const { x: x0, y: y0, width: w, height: h } = rect;
  const out = new Float32Array(w * h);
  for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + h - 1) / T); ty++) {
    for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + w - 1) / T); tx++) {
      const tw = Math.min(T, img.width - tx * T), th = Math.min(T, img.height - ty * T);
      const tile = (tiles[ty * cols + tx] ??= topHatTile(img, { x: tx * T, y: ty * T, width: tw, height: th }, r));
      // The part of the tile inside `rect`.
      const X0 = Math.max(x0, tx * T), X1 = Math.min(x0 + w, tx * T + tw);
      for (let y = Math.max(y0, ty * T); y < Math.min(y0 + h, ty * T + th); y++) {
        out.set(tile.subarray((y - ty * T) * tw + X0 - tx * T, (y - ty * T) * tw + X1 - tx * T), (y - y0) * w + X0 - x0);
      }
    }
  }
  return out;
}

/**
 * The black top-hat (blackTopHat) over `rect`, from the photo around it (the edge pixels of the photo
 * repeated beyond it).
 */
function topHatTile(img: RGBAImage, rect: Rect, r: number): Float32Array {
  const { width: W, height: H, data } = img;
  const { x: x0, y: y0, width: w, height: h } = rect;
  // (The closing at a pixel takes in every pixel within 2r.)
  const pad = 2 * r + 1, pw = w + 2 * pad, ph = h + 2 * pad;
  const Y = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const yy = Math.min(H - 1, Math.max(0, y + y0 - pad));
    for (let x = 0; x < pw; x++) {
      const o = (yy * W + Math.min(W - 1, Math.max(0, x + x0 - pad))) * 4;
      Y[y * pw + x] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
  }
  // Closing = min filter of the max filter (r-px radius squares, separable; a min filter is the max
  // filter of the negated values).
  const negate = (a: Float32Array) => {
    for (let i = 0; i < a.length; i++) a[i] = -a[i];
    return a;
  };
  const closed = negate(maxFilter(negate(maxFilter(Y, pw, ph, r)), pw, ph, r));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = closed[(y + pad) * pw + x + pad] - Y[(y + pad) * pw + x + pad];
  return out;
}

/** Half width (body sizes, at least 3 px) of the dark valleys measured as creases between pieces. */
const CREASE_WIDTH = 0.03;
/** Median crease strength (top-hat gray levels, see blackTopHat) from which a cut needs no further evidence. */
const CREASE_MIN = 10;
/**
 * Second orientation peak of a cluster outline from which creases count as cuts: an assembled patch
 * shows one grid direction, touching loose pieces at their own angles add more.
 */
const LOOSE_SECOND_PEAK = 0.15;
/** Angle tolerance (degrees) of outer edges on one assembled grid (parts need not be whole pieces). */
const OUTER_GRID_DEG = 12;
/**
 * Straight outer edge (body sizes) along its direction from which a part's angle counts in the grid
 * vote: parts of a cluster split inside an assembled group may reach its outline with a few pixels
 * only (a tab's flank), whose direction is noise.
 */
const OUTER_MIN_SUPPORT = 0.15;
/** Offset tolerance (body sizes) of neighbours on one assembled grid. */
const GRID_TOLERANCE = 0.3;
/** Share of a part's outline along its neighbour from which the neighbour wraps around it. */
const HALO_WRAP = 0.75;
/** Parts of an edge split below this (piece areas) on both sides of a cut may be halves of one piece. */
const HALF_PART = 0.65;
/**
 * Colour score (multiple of the high threshold) from which pixels belong to a piece's core: cast
 * shadows and colour bled into the table between pieces lying close together score far lower than
 * the pieces themselves.
 */
const VALLEY_CORE = 2;
/** Share of the cluster's median colour score that a piece's core reaches as well. */
const VALLEY_SHARE = 0.4;
/** Gradient levels (of 255) added per body size of distance from a k-means marker's centre (compact watershed). */
const COMPACT_LEVELS = 16;
/** Piece areas by which the compact cut's parts must be closer to whole pieces to be taken. */
const COMPACT_GAIN = 0.3;
/** Most pieces a cluster is split into along edges. */
const MAX_EDGE_SPLIT = 12;
/** Distance (body sizes, at least 2 px) from a cut within which a seam supports it (cutSupport). */
const SEAM_TOLERANCE = 0.04;
/** Band along a cluster's outline (body sizes, at least 3 px) where its rim and shadow look like a seam. */
const OUTLINE_BAND = 0.06;
/** Smallest stretch of seam evidence (pixels per body size): shorter specks are print or noise. */
const SEAM_MIN_LENGTH = 0.3;
/** Margin (opening radii) around a cut within which it is settled and judged (seamCuts). */
const SEAM_WINDOW = 3;
/** Share of a cut that must run along a seam for it to stand (seamCuts). */
const SEAM_SHARE = 0.5;
/** Share of a cut between cores apart that must run along a seam for them to be separate pieces (splitAtEdges). */
const SEAM_APART = 0.8;
/**
 * Cores apart along a seam count as separate pieces (splitAtEdges) only for parts of at least
 * SEAM_APART_PART piece areas, within SEAM_APART_WHOLE of a whole number of pieces, turned against
 * each other by SEAM_APART_TURN degrees or more.
 */
const SEAM_APART_PART = 0.75;
const SEAM_APART_WHOLE = 0.2;
const SEAM_APART_TURN = 4;
/**
 * Two whole pieces of an edge split (within SEAM_APART_WHOLE of one piece each) with a crease
 * along the cut between them stay apart when their outer edges are turned against each other by
 * LOOSE_TURN_DEG degrees or more (modulo 90) and at most LOOSE_TURN_CROSS as much straight outer
 * edge runs along the other part's direction as along the part's own (within LOOSE_TURN_WINDOW
 * degrees): loose pieces lying end to end. An assembled pair cut through one of its pieces has
 * parts whose dominant directions may differ by as much (13° measured on a photo), but along edges
 * of one shared grid: their straight edges run along both directions alike (cross share 0.48 there,
 * ≤ 0.23 for loose pieces).
 */
const LOOSE_TURN_DEG = 7;
const LOOSE_TURN_WINDOW = 3;
const LOOSE_TURN_CROSS = 0.33;

/** Per pair of parts (key min·PAIR_KEY + max): judged cut pixels, and those along a seam. */
export type CutSupport = Map<number, { n: number; seam: number }>;
/** Key base of a pair of labels in CutSupport. */
export const PAIR_KEY = 4096;

type Part = { mask: Mask; bbox: Rect };

/**
 * Seam evidence of a cluster (bbox-local mask): pixels where the table shows between pieces before
 * closing (`preClose` off inside the cluster), or a thin dark crease runs (black top-hat ≥
 * CREASE_MIN, see blackTopHat: the cardboard edges and shadow between the pieces), in stretches of
 * at least SEAM_MIN_LENGTH body sizes (shorter specks are print or noise). The band along the
 * cluster outline (OUTLINE_BAND body sizes: every outline's rim and soft shadow) holds none.
 * Returns the evidence and the squared distance to the outside of the cluster.
 */
function seamEvidence(c: Part, preClose: Mask, img: RGBAImage, body: number): { seam: Mask; d2: Float32Array; band: number } {
  const { width: w, height: h } = c.mask;
  const { x: bx, y: by } = c.bbox;
  const r = Math.max(3, Math.round(CREASE_WIDTH * body));
  const dark = blackTopHat(img, c.bbox, r);
  const d2 = squaredDistanceTransform(c.mask, 0, true);
  const band = Math.max(3, OUTLINE_BAND * body);
  const seam = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d2[i] > band * band && (dark[i] >= CREASE_MIN || !preClose.data[(y + by) * preClose.width + x + bx])) seam.data[i] = 1;
    }
  }
  return { seam: removeSmallComponents(seam, Math.max(8, Math.round(SEAM_MIN_LENGTH * body))), d2, band };
}

/**
 * Seam support of the cuts of a label map over a cluster (bbox-local, labels > 0): per pair of
 * neighbouring labels, the cut pixels judged and those with seam evidence (seamEvidence) within
 * SEAM_TOLERANCE body sizes. Cut pixels within reach of the outline band are not judged: a cut
 * that short is a narrow contact, which is how loose pieces touch. Exported for tests.
 */
export function cutSupport(c: Part, labels: Int32Array, preClose: Mask, img: RGBAImage, body: number): CutSupport {
  const { width: w, height: h } = c.mask;
  const { seam, d2, band } = seamEvidence(c, preClose, img, body);
  const tol = Math.max(2, Math.round(SEAM_TOLERANCE * body));
  const near = dilate(seam, tol).data;
  const judged = (band + tol) ** 2;
  const out: CutSupport = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l === 0 || d2[i] <= judged) continue;
      // Each cut pixel once per neighbouring label (4-neighbours).
      let seen = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0) continue;
        const m = labels[j];
        if (m === 0 || m === l || m === seen) continue;
        seen = m;
        const key = Math.min(l, m) * PAIR_KEY + Math.max(l, m);
        const s = out.get(key) ?? { n: 0, seam: 0 };
        s.n++;
        if (near[i]) s.seam++;
        out.set(key, s);
      }
    }
  }
  return out;
}

/** Parts (photo coordinates, inside the cluster's bbox) as a label map over the cluster's bbox (1, 2, …). */
function partLabels(c: Part, parts: Part[]): Int32Array {
  const { width: w, height: h } = c.mask;
  const labels = new Int32Array(w * h);
  parts.forEach((p, k) => {
    for (let y = 0; y < p.bbox.height; y++) {
      for (let x = 0; x < p.bbox.width; x++) {
        if (!p.mask.data[y * p.bbox.width + x]) continue;
        const X = x + p.bbox.x - c.bbox.x, Y = y + p.bbox.y - c.bbox.y;
        if (X >= 0 && Y >= 0 && X < w && Y < h) labels[Y * w + X] = k + 1;
      }
    }
  });
  return labels;
}

/** The pixels of a label map carrying one of `ids`, as a part in photo coordinates (null: none). */
function labelsPart(c: Part, labels: Int32Array, ids: number[]): Part | null {
  const { width: w, height: h } = c.mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ids.includes(labels[y * w + x])) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
  const mask = createMask(mw, mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (ids.includes(labels[(y + y0) * w + x + x0])) mask.data[y * mw + x] = 1;
  return { mask, bbox: { x: x0 + c.bbox.x, y: y0 + c.bbox.y, width: mw, height: mh } };
}

/**
 * A label map of a cluster's parts (`labels`, parts 1…n, see partLabels) with the cuts settled on
 * the strongest colour edges between the parts' cores (the cluster opened with a disc of radius `r`, as splitAtNecks
 * found them): a watershed from the cores over everything the opening took off (necks, knobs,
 * narrow ends of a piece). The opening's own cut lies where the cores' floods meet, on a knob
 * pressed against a neighbour halfway along the knob: the contact itself is the strongest edge
 * nearby.
 */
function settleCuts(c: Part, labels: Int32Array, n: number, img: RGBAImage, r: number): Int32Array {
  const { width: w, height: h } = c.mask;
  const p = Math.ceil(r) + 1, pw = w + 2 * p, ph = h + 2 * p;
  const padded = createMask(pw, ph);
  for (let y = 0; y < h; y++) padded.data.set(c.mask.data.subarray(y * w, (y + 1) * w), (y + p) * pw + p);
  // Each part's marker is the largest core within it (splitAtNecks gives the pixels of cores too
  // small to stand, such as a narrow piece end, to a neighbouring part: they are no evidence).
  const cores = labelComponents(open(padded, r, 'disk'), 8);
  const coreAt = (x: number, y: number) => cores.labels[(y + p) * pw + x + p];
  const size = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x], k = coreAt(x, y);
      if (l > 0 && k > 0) size.set(k * PAIR_KEY + l, (size.get(k * PAIR_KEY + l) ?? 0) + 1);
    }
  }
  const best = new Int32Array(n + 1), bestSize = new Float64Array(n + 1);
  for (const [key, n] of size) {
    const l = key % PAIR_KEY;
    if (n > bestSize[l]) { bestSize[l] = n; best[l] = Math.floor(key / PAIR_KEY); }
  }
  const markers = new Int32Array(w * h);
  const inside = createMask(w, h);
  const marked = new Uint8Array(n + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l === 0) continue;
      inside.data[i] = 1;
      if (best[l] > 0 && coreAt(x, y) === best[l]) { markers[i] = l; marked[l] = 1; }
    }
  }
  // (A part without a core of its own keeps its pixels as they are.)
  for (let i = 0; i < labels.length; i++) if (labels[i] > 0 && !marked[labels[i]]) markers[i] = labels[i];
  watershed(inside, colourGradient(img, c.bbox), markers);
  return markers;
}

/**
 * The parts of a cluster split at necks (opening radius `r`) with every cut that runs through a
 * piece undone: settled on the strongest edges between the parts' cores (settleCuts), a cut that
 * lies on a seam along less than SEAM_SHARE of its judged length (cutSupport) has no seam to
 * follow, and its two parts are joined again (the cuts that stand are kept as the opening made
 * them; settling only judges them). A narrowest neck is not always a contact: a piece with blanks
 * on opposite sides has a waist, and in an assembled pair that waist is narrower than the side the
 * two pieces share, so the neck cut went through the piece's even print while the real seam ran
 * elsewhere. Null when fewer than two parts remain.
 */
function seamCuts(c: Part, parts: Part[], preClose: Mask, img: RGBAImage, body: number, r: number): Part[] | null {
  const { width: w, height: h } = c.mask;
  const labels = partLabels(c, parts);
  // Bounding box of the cut between each pair of neighbouring parts.
  const boxes = new Map<number, number[]>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l === 0) continue;
      for (const j of [x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1]) {
        const m = j < 0 ? 0 : labels[j];
        if (m === 0 || m === l) continue;
        const key = Math.min(l, m) * PAIR_KEY + Math.max(l, m), b = boxes.get(key);
        if (!b) boxes.set(key, [x, y, x, y]);
        else [b[0], b[1], b[2], b[3]] = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
      }
    }
  }
  // Each cut judged within SEAM_WINDOW opening radii around it (the cluster beyond counts as
  // outside): the cores whose floods settle it lie there, and a large cluster is not gone over again
  // for every cut.
  const support: CutSupport = new Map();
  const m = Math.ceil(SEAM_WINDOW * r);
  for (const [key, [x0, y0, x1, y1]] of boxes) {
    const X0 = Math.max(0, x0 - m), Y0 = Math.max(0, y0 - m), ww = Math.min(w, x1 + m + 1) - X0, wh = Math.min(h, y1 + m + 1) - Y0;
    const win: Part = { mask: cropMask(c.mask, { x: X0, y: Y0, width: ww, height: wh }), bbox: { x: c.bbox.x + X0, y: c.bbox.y + Y0, width: ww, height: wh } };
    const wl = new Int32Array(ww * wh);
    for (let y = 0; y < wh; y++) wl.set(labels.subarray((y + Y0) * w + X0, (y + Y0) * w + X0 + ww), y * ww);
    const st = cutSupport(win, settleCuts(win, wl, parts.length, img, r), preClose, img, body).get(key);
    if (st) support.set(key, st);
  }
  const root = parts.map((_, i) => i + 1);
  root.unshift(0);
  const find = (l: number): number => (root[l] === l ? l : (root[l] = find(root[l])));
  const minJudged = Math.max(3, Math.round(SEAM_TOLERANCE * body));
  for (const [key, s] of support) {
    if (s.n < minJudged || s.seam >= SEAM_SHARE * s.n) continue;
    const a = find(Math.floor(key / PAIR_KEY)), b = find(key % PAIR_KEY);
    if (a !== b) root[a] = b;
  }
  const groups = new Map<number, number[]>();
  for (let l = 1; l <= parts.length; l++) groups.set(find(l), [...(groups.get(find(l)) ?? []), l]);
  if (groups.size < 2) return null;
  const out = [...groups.values()].map((ids) => labelsPart(c, labels, ids)).filter((q): q is Part => q !== null);
  return out.length >= 2 ? out : null;
}

/** Lightness ratio (L* + 16, to the table's) above which a pixel can be the table in shade (tableShade). */
const SHADE_RHO_MIN = 0.6;
/** Lightness ratio below which a pixel can be the table in shade (above: the table itself or a rim). */
const SHADE_RHO_MAX = 0.9;
/** Chroma tolerance (a*, b* each) of the table in shade against the table's scaled chroma. */
const SHADE_TOL = 4;
/** Reach (body sizes) around a neck cut within which the shaded table is carved out (reownCuts). */
const SHADE_NEAR = 0.35;
/** Smallest connected change (body sizes squared) reownCuts makes: a knob tip, not a sliver along a cut. */
const REOWN_MIN_AREA = 0.005;
/**
 * Smallest piece body (px) whose cuts are given out again (reownParts): below it a gap between
 * pieces lying close is a pixel or two, its colour the rims' and the JPEG's half-resolution chroma
 * rather than the table's, and a knob tip only a few pixels.
 */
const REOWN_MIN_BODY = 40;

/**
 * The pixels of part `c` (bbox-local) in the shade map (photo-sized, see tableShade) whose
 * 8-connected components come within 2 px of the part's outside: the table in shade reaching in
 * between two pieces from outside (a narrow gap). Table-coloured print inside a piece is enclosed
 * and left out. Null without any.
 */
export function shadeGaps(c: Part, shade: Mask): Mask | null {
  const { width: w, height: h } = c.mask;
  const { x: bx, y: by } = c.bbox;
  const W = shade.width, md = c.mask.data;
  const s = createMask(w, h);
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (md[i] && shade.data[(y + by) * W + x + bx]) { s.data[i] = 1; any = true; }
    }
  }
  if (!any) return null;
  const { labels, count } = labelComponents(s, 8);
  const open = new Uint8Array(count + 1);
  // (A component is open when one of its pixels lies within 2 px of the outside of the part.)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (l === 0 || open[l]) continue;
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) { open[l] = 1; continue; }
      for (let dy = -2; dy <= 2 && !open[l]; dy++) for (let dx = -2; dx <= 2; dx++) if (!md[(y + dy) * w + x + dx]) { open[l] = 1; break; }
    }
  }
  any = false;
  for (let i = 0; i < s.data.length; i++) {
    s.data[i] = open[labels[i]];
    if (s.data[i]) any = true;
  }
  return any ? s : null;
}

/**
 * A part label map (1…n over cluster `c`, bbox-local) given out again around its cuts: the
 * shaded table open to the outside (shadeGaps) within SHADE_NEAR body sizes of a cut is carved out
 * of the cluster, and within reach of it (SHADE_NEAR body sizes plus the opening radius `r`) every
 * pixel outside the cores of the carved cluster (opened with a disc of radius `r`, as splitAtNecks)
 * is flooded again from the cores and the labels around that reach, first through the carved
 * cluster, then through the rest. A knob pressed against a neighbour, which the split's flood cut
 * halfway or gave to the neighbour, is reached from its own piece around the gap. The cuts'
 * decisions stay (labels only; unlabelled pixels stay out, pixels beyond reach keep their label),
 * and only connected changes of at least REOWN_MIN_AREA body sizes squared are made (slivers along
 * a cut keep their label). Null when no shade lies near a cut, a label within reach has no marker,
 * or nothing that large changes.
 */
export function reownCuts(c: Part, labels: Int32Array, n: number, r: number, body: number, shade: Mask): Int32Array | null {
  const gaps = shadeGaps(c, shade);
  if (!gaps) return null;
  const { width: w, height: h } = c.mask;
  const near = Math.max(2, Math.round(SHADE_NEAR * body));
  // Only cuts within reach of the gaps matter: the zone is computed around them.
  const gb = maskBounds(gaps)!;
  const zx0 = Math.max(0, gb.x - near - 1), zy0 = Math.max(0, gb.y - near - 1);
  const zw = Math.min(w, gb.x + gb.width + near + 1) - zx0, zh = Math.min(h, gb.y + gb.height + near + 1) - zy0;
  const cut = createMask(zw, zh);
  for (let y = 0; y < zh; y++) {
    for (let x = 0; x < zw; x++) {
      const i = (y + zy0) * w + x + zx0, l = labels[i];
      if (l === 0) continue;
      if ((x + zx0 < w - 1 && labels[i + 1] > 0 && labels[i + 1] !== l) || (y + zy0 < h - 1 && labels[i + w] > 0 && labels[i + w] !== l)) cut.data[y * zw + x] = 1;
    }
  }
  const zone = dilate(cut, near, 'disk').data;
  const carve = createMask(w, h);
  let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1;
  for (let y = 0; y < zh; y++) {
    for (let x = 0; x < zw; x++) {
      const X = x + zx0, Y = y + zy0;
      if (!zone[y * zw + x] || !gaps.data[Y * w + X]) continue;
      carve.data[Y * w + X] = 1;
      if (X < cx0) cx0 = X;
      if (X > cx1) cx1 = X;
      if (Y < cy0) cy0 = Y;
      if (Y > cy1) cy1 = Y;
    }
  }
  if (cx1 < 0) return null;
  // The window: the reach around the carve (pixels given out again) and a band of the opening's
  // radius beyond it (labels kept, markers for the floods; the window's edge erodes the cores there).
  const reach = Math.ceil(near + r), band = Math.ceil(r) + 1;
  const fx0 = Math.max(0, cx0 - reach), fy0 = Math.max(0, cy0 - reach), fx1 = Math.min(w - 1, cx1 + reach), fy1 = Math.min(h - 1, cy1 + reach);
  const ox = Math.max(0, fx0 - band), oy = Math.max(0, fy0 - band);
  const ow = Math.min(w - 1, fx1 + band) - ox + 1, oh = Math.min(h - 1, fy1 + band) - oy + 1;
  const inside = createMask(ow, oh), carved = createMask(ow, oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const i = (y + oy) * w + x + ox, j = y * ow + x;
      if (labels[i] > 0) { inside.data[j] = 1; carved.data[j] = carve.data[i] ? 0 : 1; }
    }
  }
  const p = band, pw = ow + 2 * p, ph = oh + 2 * p;
  const padded = createMask(pw, ph);
  for (let y = 0; y < oh; y++) padded.data.set(carved.data.subarray(y * ow, (y + 1) * ow), (y + p) * pw + p);
  const core = open(padded, r, 'disk').data;
  const out = new Int32Array(ow * oh);
  const queue = new Int32Array(ow * oh);
  let tail = 0;
  const present = new Uint8Array(n + 1), marked = new Uint8Array(n + 1);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const X = x + ox, Y = y + oy, l = labels[Y * w + X];
      if (l === 0) continue;
      present[l] = 1;
      const free = X >= fx0 && X <= fx1 && Y >= fy0 && Y <= fy1;
      if (!free || core[(y + p) * pw + x + p]) { out[y * ow + x] = l; marked[l] = 1; queue[tail++] = y * ow + x; }
    }
  }
  for (let l = 1; l <= n; l++) if (present[l] && !marked[l]) return null;
  for (const allowed of [carved.data, inside.data]) {
    if (allowed === inside.data) {
      tail = 0;
      for (let i = 0; i < out.length; i++) if (out[i] > 0) queue[tail++] = i;
    }
    let head = 0;
    while (head < tail) {
      const i = queue[head++];
      const x = i % ow, y = (i - x) / ow;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= oh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= ow || (dx === 0 && dy === 0)) continue;
          const j = yy * ow + xx;
          if (allowed[j] && out[j] === 0) { out[j] = out[i]; queue[tail++] = j; }
        }
      }
    }
  }
  // (Pixels the floods did not reach keep their label.) Only a knob tip's worth of pixels moves:
  // slivers along a cut keep their label.
  const diff = createMask(ow, oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const j = y * ow + x, l = labels[(y + oy) * w + x + ox];
      if (out[j] === 0) out[j] = l;
      diff.data[j] = out[j] !== l ? 1 : 0;
    }
  }
  const dc = labelComponents(diff, 8);
  const minMoved = REOWN_MIN_AREA * body * body;
  const keep = new Uint8Array(dc.count + 1);
  let moved = false;
  for (const st of dc.stats) if (st.area >= minMoved) { keep[st.label] = 1; moved = true; }
  if (!moved) return null;
  const res = labels.slice();
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const j = y * ow + x;
      if (diff.data[j] && keep[dc.labels[j]]) res[(y + oy) * w + x + ox] = out[j];
    }
  }
  return res;
}

/** Share of a part's pixels after reownCuts that its largest component must hold (else nothing changes). */
const REOWN_CONNECTED = 0.95;

/**
 * The parts a cluster `c` was split into (by necks and edges, in all its rounds), with the pixels
 * around the cuts between them given out again (reownCuts; opening radius NECK_RADII[0] body sizes,
 * as the first neck split). Done once on the split's outcome, not inside its rounds: a few pixels
 * more or less would sway the later rounds' decisions, which stay as they were. Only the parts whose
 * pixels changed are rebuilt; null when nothing changed or a rebuilt part would come apart (its
 * largest component below REOWN_CONNECTED of its pixels).
 */
function reownParts(c: Candidate, parts: Candidate[], ra: number, body: number, shade: Mask, W: number, H: number): Candidate[] | null {
  const labels = partLabels(c, parts);
  const re = reownCuts(c, labels, parts.length, Math.max(2, NECK_RADII[0] * body), body, shade);
  if (!re) return null;
  const changed = new Uint8Array(parts.length + 1);
  for (let i = 0; i < re.length; i++) if (re[i] !== labels[i]) changed[re[i]] = changed[labels[i]] = 1;
  if (!changed.some((v) => v)) return null;
  const out: Candidate[] = [];
  for (let k = 0; k < parts.length; k++) {
    const q = parts[k];
    if (!changed[k + 1]) { out.push(q); continue; }
    const lp = labelsPart(c, re, [k + 1]);
    if (!lp) return null;
    const lc = labelComponents(lp.mask, 8);
    const main = lc.stats.reduce((a, b) => (b.area > a.area ? b : a));
    if (main.area < REOWN_CONNECTED * maskArea(lp.mask)) return null;
    const b = main.bbox;
    const pc = makeCandidate(componentMask(lc.labels, lp.bbox.width, main.label, b), { x: lp.bbox.x + b.x, y: lp.bbox.y + b.y, width: b.width, height: b.height }, W, H, main.area, SHAPE_MAX_PIECES * ra);
    out.push({ ...pc, ...(q.merged !== undefined ? { merged: q.merged } : {}) });
  }
  return out;
}

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
  for (let y = 0; y < h; y++) {
    const Y = y + y0;
    const r0 = Math.min(H - 1, Math.max(0, Y - 1)) * W, r1 = Math.min(H - 1, Math.max(0, Y)) * W, r2 = Math.min(H - 1, Math.max(0, Y + 1)) * W;
    for (let x = 0; x < w; x++) {
      const X = x + x0;
      const cl = Math.min(W - 1, Math.max(0, X - 1)), cm = Math.min(W - 1, Math.max(0, X)), cr = Math.min(W - 1, Math.max(0, X + 1));
      const a0 = (r0 + cl) * 4, a1 = (r0 + cm) * 4, a2 = (r0 + cr) * 4;
      const b0 = (r1 + cl) * 4, b2 = (r1 + cr) * 4;
      const c0 = (r2 + cl) * 4, c1 = (r2 + cm) * 4, c2 = (r2 + cr) * 4;
      let m2 = 0;
      for (let c = 0; c < 3; c++) {
        const gx = data[a2 + c] + 2 * data[b2 + c] + data[c2 + c] - data[a0 + c] - 2 * data[b0 + c] - data[c0 + c];
        const gy = data[c0 + c] + 2 * data[c1 + c] + data[c2 + c] - data[a0 + c] - 2 * data[a1 + c] - data[a2 + c];
        m2 += gx * gx + gy * gy;
      }
      const m = Math.sqrt(m2);
      mag[y * w + x] = m;
      if (m > max) max = m;
    }
  }
  const out = new Uint8Array(w * h);
  const k = 255 / max;
  for (let i = 0; i < out.length; i++) {
    const v = (mag[i] * k + 0.5) | 0;
    out[i] = v > 255 ? 255 : v;
  }
  return out;
}

/**
 * Marker-controlled watershed inside `mask` on the (quantised) gradient: every pixel goes to the
 * marker whose flood reaches it over the lowest edges, so boundaries settle on the strongest edges
 * between markers. `labels` holds marker ids (> 0) and is filled in place. With `compact` (levels
 * per pixel of distance from the pixel's marker centre, `centres` per label id), the cost of a pixel
 * also grows with its distance from the marker flooding it (compact watershed): a marker cannot take
 * over a neighbour's half through a channel of weak edges. Exported for tests.
 */
export function watershed(mask: Mask, grad: Uint8Array, labels: Int32Array, compact = 0, centres: Point[] = []): void {
  const { width: w, height: h } = mask;
  const md = mask.data;
  // Bucket queue: one growable stack per gradient level.
  const LEVELS = 256;
  const stacks: Int32Array[] = Array.from({ length: LEVELS }, () => new Int32Array(64));
  const size = new Int32Array(LEVELS);
  const push = (level: number, i: number) => {
    let st = stacks[level];
    if (size[level] === st.length) {
      const grown = new Int32Array(st.length * 2);
      grown.set(st);
      stacks[level] = st = grown;
    }
    st[size[level]++] = i;
  };
  const cost = (j: number, l: number) => {
    if (compact <= 0) return grad[j];
    const c = centres[l], x = j % w, y = (j - x) / w;
    return Math.min(LEVELS - 1, grad[j] + Math.round(compact * Math.hypot(x - c.x, y - c.y)));
  };
  for (let i = 0; i < labels.length; i++) if (labels[i] > 0) push(Math.min(LEVELS - 1, grad[i]), i);
  for (let level = 0; level < LEVELS; level++) {
    while (size[level] > 0) {
      const i = stacks[level][--size[level]];
      const x = i % w, y = (i - x) / w, l = labels[i];
      if (x > 0 && md[i - 1] && labels[i - 1] === 0) { labels[i - 1] = l; push(Math.max(level, cost(i - 1, l)), i - 1); }
      if (x < w - 1 && md[i + 1] && labels[i + 1] === 0) { labels[i + 1] = l; push(Math.max(level, cost(i + 1, l)), i + 1); }
      if (y > 0 && md[i - w] && labels[i - w] === 0) { labels[i - w] = l; push(Math.max(level, cost(i - w, l)), i - w); }
      if (y < h - 1 && md[i + w] && labels[i + w] === 0) { labels[i + w] = l; push(Math.max(level, cost(i + w, l)), i + w); }
    }
  }
}

/**
 * Split a cluster of touching or slightly overlapping loose pieces along the edges between them.
 * Markers come from the foreground before closing (pieces 1–3 px apart are separate there) or,
 * failing that, from k-means of the interior (k = area / piece area). A watershed on the colour
 * gradient puts the cuts on the gaps or on the outlines of the upper pieces. Neighbouring parts stay
 * apart only with evidence for the cut between them (a dark crease along it, separate blobs before
 * closing, convincing piece outlines on both sides, or two whole pieces turned against each other)
 * and when they are not neighbours on one assembled grid (same angle, one body apart); everything
 * else is joined again. Parts below a
 * third of a piece go to the neighbour they share most outline with. Null when one region remains.
 * `measured`: the piece area `ra` was measured on single pieces (see the compact floods below).
 */
function splitAtEdges(c: Candidate, ra: number, body: number, preClose: Mask, img: RGBAImage, score: GrayImage, high: number, W: number, H: number, measured = false): Candidate[] | null {
  const k = Math.round(c.area / ra);
  if (k < 2 || k > MAX_EDGE_SPLIT) return null;
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
  let comps = labelComponents(open(fillHoles(sub), 1), 4);
  let big = comps.stats.filter((st) => st.area >= 0.3 * ra);
  let viaGap = false, viaValley = false;
  if (big.length < 2) {
    // Markers 1b: the strongly coloured cores of the pieces, apart where a band of weaker colour
    // (a cast shadow, colour bled into the table) fills the gap between them.
    const vals: number[] = [];
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) if (c.mask.data[y * w + x]) vals.push(score.data[(y + by) * W + x + bx]);
    }
    const level = Math.max(VALLEY_CORE * high, VALLEY_SHARE * median(vals));
    const core = createMask(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        core.data[i] = c.mask.data[i] && score.data[(y + by) * W + x + bx] >= level ? 1 : 0;
      }
    }
    const cc = labelComponents(open(fillHoles(core), 2), 4);
    const cores = cc.stats.filter((st) => st.area >= 0.3 * ra);
    if (cores.length >= 2) {
      comps = cc;
      big = cores;
      viaValley = true;
    }
  }
  // Marker labels 1..n and the blob each came from (0: k-means markers).
  const blobOf: number[] = [0];
  // (A part of several pieces is split in turn by the caller.)
  if (big.length >= 2 && big.length <= MAX_EDGE_SPLIT) {
    viaGap = !viaValley;
    big.forEach((st, b) => {
      blobOf.push(b + 1);
      for (let i = 0; i < labels.length; i++) if (comps.labels[i] === st.label) labels[i] = b + 1;
    });
  } else {
    if (!kMeansMarkers(c.mask, k, body, labels, 1)) return null;
    for (let m = 0; m < k; m++) blobOf.push(0);
  }
  const nLabels = blobOf.length - 1;
  const grad = colourGradient(img, c.bbox);
  if (measured && blobOf.every((b) => b === 0)) {
    // k-means markers stand for whole pieces. A flood over weak edges can take half a piece over to
    // its neighbour (its print as dark as the neighbour's): the floods are then also run compact
    // (the cost grows with the distance from the marker), and the cut whose parts are closer to
    // whole pieces is taken (clearly closer: the edges are the better evidence otherwise). Only with
    // the piece size measured on single pieces (`measured`): otherwise "whole pieces" means little.
    const centres: Point[] = [{ x: 0, y: 0 }];
    const sx = new Float64Array(nLabels + 1), sy = new Float64Array(nLabels + 1), sn = new Float64Array(nLabels + 1);
    for (let i = 0; i < labels.length; i++) if (labels[i] > 0) { sx[labels[i]] += i % w; sy[labels[i]] += Math.floor(i / w); sn[labels[i]]++; }
    for (let l = 1; l <= nLabels; l++) centres.push({ x: sn[l] ? sx[l] / sn[l] : 0, y: sn[l] ? sy[l] / sn[l] : 0 });
    const compact = labels.slice();
    watershed(c.mask, grad, labels);
    watershed(c.mask, grad, compact, COMPACT_LEVELS / body, centres);
    const misfit = (ls: Int32Array) => {
      const a = new Float64Array(nLabels + 1);
      for (let i = 0; i < ls.length; i++) if (ls[i] > 0) a[ls[i]]++;
      let e = 0;
      for (let l = 1; l <= nLabels; l++) e += Math.abs(a[l] / ra - Math.max(1, Math.round(a[l] / ra)));
      return e;
    };
    if (misfit(compact) < misfit(labels) - COMPACT_GAIN) labels.set(compact);
  } else watershed(c.mask, grad, labels);
  const n = nLabels;
  // Shared boundary per pair of labels, with the crease strength along it.
  // (The crease widens with the magnification: wider valleys on large pieces.)
  const th = blackTopHat(img, c.bbox, Math.max(3, Math.round(CREASE_WIDTH * body)));
  const pairStats = () => {
    const shared = new Map<number, number[]>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = labels[y * w + x];
        if (l <= 0) continue;
        for (const [xx, yy] of [[x + 1, y], [x, y + 1]]) {
          if (xx >= w || yy >= h) continue;
          const m = labels[yy * w + xx];
          if (m <= 0 || m === l) continue;
          const key = Math.min(l, m) * 64 + Math.max(l, m);
          let best = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xq = x + dx, yq = y + dy;
            if (xq >= 0 && yq >= 0 && xq < w && yq < h) best = Math.max(best, th[yq * w + xq]);
          }
          const list = shared.get(key);
          if (list) list.push(best);
          else shared.set(key, [best]);
        }
      }
    }
    return shared;
  };
  const area = new Float64Array(n + 1);
  for (let i = 0; i < labels.length; i++) if (labels[i] > 0) area[labels[i]]++;
  // Parts below a third of a piece go to the neighbour they share most boundary with.
  for (;;) {
    let small = -1;
    for (let l = 1; l <= n; l++) if (area[l] > 0 && area[l] < 0.3 * ra && (small < 0 || area[l] < area[small])) small = l;
    if (small < 0) break;
    let to = -1, most = 0;
    for (const [key, v] of pairStats()) {
      const a = Math.floor(key / 64), b = key % 64;
      const other = a === small ? b : b === small ? a : -1;
      if (other > 0 && v.length > most) { most = v.length; to = other; }
    }
    if (to < 0) break;
    for (let i = 0; i < labels.length; i++) if (labels[i] === small) labels[i] = to;
    area[to] += area[small];
    area[small] = 0;
  }
  const live = [...Array(n + 1).keys()].filter((l) => l > 0 && area[l] > 0);
  if (live.length < 2) return null;
  const partOf = (l: number): Candidate | null => {
    const pm = createMask(w, h);
    for (let i = 0; i < labels.length; i++) if (labels[i] === l) pm.data[i] = 1;
    const lc = labelComponents(pm, 4);
    if (lc.stats.length === 0) return null;
    const main = lc.stats.reduce((a, b2) => (b2.area > a.area ? b2 : a));
    const b = main.bbox;
    // Holes are filled, but not over another part: a piece lying inside a ring of the cluster stays
    // that piece, not part of the ring as well.
    const pm2 = fillHoles(componentMask(lc.labels, w, main.label, b));
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        const o = labels[(y + b.y) * w + x + b.x];
        if (o > 0 && o !== l) pm2.data[y * b.width + x] = 0;
      }
    }
    return makeCandidate(pm2, { x: b.x + bx, y: b.y + by, width: b.width, height: b.height }, W, H, undefined, SHAPE_MAX_PIECES * ra);
  };
  const parts = new Map<number, Candidate>();
  for (const l of live) {
    const pc = partOf(l);
    if (pc) parts.set(l, pc);
  }
  // Join neighbours without evidence for the cut, and neighbours on one assembled grid.
  const root = new Int32Array(n + 1);
  for (let l = 0; l <= n; l++) root[l] = l;
  const find = (l: number): number => (root[l] === l ? l : (root[l] = find(root[l])));
  const stats = pairStats();
  // An assembled patch: the parts' outer edges run along the cluster's grid. Only a cluster of
  // pieces at their own angles takes dark creases for cuts (assembled pieces show a thin dark cut
  // line as well). Parts that reach the outline along a short stretch only do not vote: in an
  // assembled strip with pieces on top, such a part's tab flank swung the vote.
  const outer = live.map((l) => { const pc = parts.get(l); return pc ? outerAngle(pc, c, OUTER_MIN_SUPPORT * body) : null; }).filter((a): a is number => a !== null);
  const aligned = outer.filter((a) => quarterDiff(a, c.orientation) <= OUTER_GRID_DEG).length;
  const mixed = c.secondPeak >= LOOSE_SECOND_PEAK && outer.length >= 2 && aligned < 0.75 * outer.length;
  // Median colour score along each part's stretch of the cluster outline (3 px in).
  const edgeScore = new Float64Array(n + 1);
  {
    const inner = erode(c.mask, 3).data;
    const vals: number[][] = Array.from({ length: n + 1 }, () => []);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, l = labels[i];
        if (l <= 0 || !inner[i]) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inner[i - 1] || !inner[i + 1] || !inner[i - w] || !inner[i + w];
        if (edge) vals[l].push(score.data[(y + by) * W + x + bx]);
      }
    }
    for (const l of live) edgeScore[l] = vals[l].length ? median(vals[l]) : Infinity;
  }
  // Seam evidence along the cuts between cores apart (cutSupport).
  const seams = viaValley ? cutSupport(c, labels, preClose, img, body) : null;
  for (const [key, v] of stats) {
    const a = Math.floor(key / 64), b = key % 64;
    const pa = parts.get(a), pb = parts.get(b);
    if (!pa || !pb) continue;
    const ca = pa.shape?.confidence ?? 0, cb = pb.shape?.confidence ?? 0;
    const crease = median(v);
    // Parts from separate blobs: apart before closing, or apart in their cores where they are pieces
    // at their own angles or a seam runs all along the cut between them (a loose piece touching an
    // assembled group at nearly its angle).
    const sepBlob = blobOf[a] !== blobOf[b];
    const seam = seams?.get(a * PAIR_KEY + b);
    // (Only between whole pieces of a small cluster, at angles of their own however slight: inside
    // an assembled group, print apart from its neighbours' gives cores apart too, cut along the
    // group's seams into parts that are no whole number of pieces.)
    const whole = (n: number) => n >= SEAM_APART_PART && Math.abs(n - Math.round(n)) <= SEAM_APART_WHOLE;
    const turnedApart = () => {
      const ta = outerAngle(pa, c, OUTER_MIN_SUPPORT * body), tb = outerAngle(pb, c, OUTER_MIN_SUPPORT * body);
      return ta !== null && tb !== null && quarterDiff(ta, tb) >= SEAM_APART_TURN;
    };
    const seamed = !!seam && seam.n >= Math.max(3, Math.round(SEAM_TOLERANCE * body)) && seam.seam >= SEAM_APART * seam.n &&
      c.area <= EDGE_RECUT_MAX_PIECES * ra && whole(area[a] / ra) && whole(area[b] / ra) && turnedApart();
    const apart = sepBlob && (viaGap || (viaValley && (mixed || c.secondPeak > TOUCHING_SECOND_PEAK || seamed)));
    // Two whole pieces end to end, a crease along the cut, whose outer edges run in two directions
    // apart: loose pieces turned against each other (outerTurn). An assembled pair cut through a
    // piece shows parts at angles apart too, but along edges of one grid shared by both.
    const turn = crease >= CREASE_MIN && Math.abs(area[a] / ra - 1) <= SEAM_APART_WHOLE && Math.abs(area[b] / ra - 1) <= SEAM_APART_WHOLE ? outerTurn(pa, pb, c, OUTER_MIN_SUPPORT * body) : null;
    const turned = !!turn && turn.deg >= LOOSE_TURN_DEG && turn.cross <= LOOSE_TURN_CROSS;
    const evidence = turned || (crease >= CREASE_MIN && mixed) || apart || (Math.max(ca, cb) >= 0.7 && (Math.min(ca, cb) >= UNCERTAIN_CONFIDENCE || c.secondPeak > TOUCHING_SECOND_PEAK));
    // A part with a faint outline wrapped around its neighbour is that piece's glare halo or shadow.
    const wrap = v.length / Math.max(1, Math.min(polygonPerimeter(pa.contour), polygonPerimeter(pb.contour)));
    const halo = wrap >= HALO_WRAP && Math.min(edgeScore[a], edgeScore[b]) < high;
    // Two neighbours both well below a piece that make one together: one piece given two markers.
    const halves = !(viaGap && sepBlob) && area[a] < HALF_PART * ra && area[b] < HALF_PART * ra && area[a] + area[b] <= 1.35 * ra;
    // (Pieces turned apart are on no common grid, however close their angles look to onOneGrid.)
    if (!evidence || halves || halo || (!turned && onOneGrid(pa, pb, c, body))) root[find(a)] = find(b);
  }
  const groups = new Map<number, number[]>();
  for (const l of live) {
    const r = find(l);
    groups.set(r, [...(groups.get(r) ?? []), l]);
  }
  if (groups.size < 2) return null;
  const out: Candidate[] = [];
  // Parts below half a piece are kept only when a gap sets them apart (a whole blob of their own).
  let tooSmall = false;
  for (const members of groups.values()) {
    const blob = blobOf[members[0]];
    const ownBlob = viaGap && blob > 0 && live.every((l) => (blobOf[l] === blob) === members.includes(l));
    let pc: Candidate | null;
    if (members.length === 1) pc = parts.get(members[0]) ?? null;
    else {
      const r = members[0];
      for (const l of members) for (let i = 0; i < labels.length; i++) if (labels[i] === l) labels[i] = r;
      pc = partOf(r);
    }
    if (!pc) continue;
    if (pc.area < 0.5 * ra && !ownBlob) tooSmall = true;
    out.push(pc);
  }
  if (out.length < 2 || tooSmall) return null;
  return out;
}

/**
 * Markers for `k` pieces in `region` (a mask in the cluster's frame): k-means of its interior pixel
 * positions (farthest-point start at the deepest point), a disc of 0.15 body sizes around each
 * centre, labelled `first`, `first + 1`, …. False when the region has too few interior points.
 */
function kMeansMarkers(region: Mask, k: number, body: number, labels: Int32Array, first: number): boolean {
  const { width: w, height: h } = region;
  const dt = distanceTransform(region).data;
  const pts: number[] = [];
  const stride = Math.max(1, Math.round(Math.sqrt(maskArea(region) / 40000)));
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) if (dt[y * w + x] >= 0.12 * body) pts.push(y * w + x);
  if (pts.length < 10 * k) return false;
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
  for (const i of pts) {
    const x = i % w, y = (i - x) / w;
    for (let m = 0; m < k; m++) if ((x - cx[m]) ** 2 + (y - cy[m]) ** 2 <= r2) { labels[i] = first + m; break; }
  }
  return true;
}

/**
 * Two parts of a cluster that are neighbours on one assembled grid: the straight parts of their
 * outlines on the cluster's outer edge run along one grid (modulo 90°) and their centroids lie one
 * body apart along an axis of it. The outer edges are real piece outlines, unlike the cuts between
 * the parts, so they tell the angle even of parts that are not whole pieces. Loose pieces touching
 * each other lie at their own angles and offsets.
 */
function onOneGrid(a: Candidate, b: Candidate, cluster: Candidate, body: number): boolean {
  const aa = outerAngle(a, cluster) ?? a.orientation, ab = outerAngle(b, cluster) ?? b.orientation;
  if (quarterDiff(aa, ab) > OUTER_GRID_DEG) return false;
  const ca = maskCentroid(a), cb = maskCentroid(b);
  const t = (-aa * Math.PI) / 180;
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  const u = Math.abs(dx * Math.cos(t) - dy * Math.sin(t)) / body, v = Math.abs(dx * Math.sin(t) + dy * Math.cos(t)) / body;
  return Math.abs(Math.max(u, v) - 1) < GRID_TOLERANCE && Math.min(u, v) < GRID_TOLERANCE;
}

/**
 * Dominant direction (degrees modulo 90) of the straight stretches of a part's outline that lie on
 * the outer edge of its cluster; null when too little of it does, or when less than `minSupport` px
 * of straight edge run in that direction (a part reaching the outline only along a curved tab or a
 * few pixels of a side has no telling direction). Exported for tests.
 */
export function outerAngle(part: { contour: Point[]; area: number }, cluster: { mask: Mask; bbox: Rect }, minSupport = 0): number | null {
  const hist = outerEdges(part, cluster);
  return hist && peakDirection(hist, minSupport);
}

/** Peak direction of an outer-edge histogram (outerEdges); null below `minSupport` px of straight edge within 4° of it. */
function peakDirection(hist: Float64Array, minSupport: number): number | null {
  let best = 0, bestV = -1;
  for (let i = 0; i < 90; i++) {
    let v = 0;
    for (let j = -3; j <= 3; j++) v += hist[(i + j + 90) % 90] * Math.exp(-(j * j) / 4.5);
    if (v > bestV) { bestV = v; best = i; }
  }
  return around(hist, best + 0.5, 4) < minSupport ? null : best + 0.5;
}

/**
 * Turn between two parts of a cluster along the cluster's outer edge: the difference (degrees
 * modulo 90) of their outer-edge directions (outerAngle, each with `minSupport` px of straight
 * edge), and the straight outer edge running along the other part's direction as a share of that
 * running along the part's own (both within LOOSE_TURN_WINDOW degrees, summed over the two parts):
 * low when each part's edges keep to their own direction, as those of loose pieces turned against
 * each other do. Null when either part has no outer direction. Exported for tests.
 */
export function outerTurn(a: { contour: Point[]; area: number }, b: { contour: Point[]; area: number }, cluster: { mask: Mask; bbox: Rect }, minSupport = 0): { deg: number; cross: number } | null {
  const ea = outerEdges(a, cluster), eb = outerEdges(b, cluster);
  const ta = ea && peakDirection(ea, minSupport), tb = eb && peakDirection(eb, minSupport);
  if (!ea || !eb || ta === null || tb === null) return null;
  const own = around(ea, ta, LOOSE_TURN_WINDOW) + around(eb, tb, LOOSE_TURN_WINDOW);
  const cross = around(ea, tb, LOOSE_TURN_WINDOW) + around(eb, ta, LOOSE_TURN_WINDOW);
  return { deg: quarterDiff(ta, tb), cross: own > 0 ? cross / own : Infinity };
}

/**
 * Straight edge (px) of an outer-edge histogram (outerEdges) whose direction lies within
 * `tol` degrees (modulo 90) of `deg`.
 */
function around(hist: Float64Array, deg: number, tol: number): number {
  let s = 0;
  for (let i = 0; i < 90; i++) if (quarterDiff(i + 0.5, deg) <= tol) s += hist[i];
  return s;
}

/**
 * Histogram (1° bins modulo 90, px of straight edge) of the directions of a part's outline where it
 * lies on the outer edge of its cluster, each sample weighted by how straight the outline runs
 * there; null when too little of the outline lies on the outer edge (see outerAngle).
 */
function outerEdges(part: { contour: Point[]; area: number }, cluster: { mask: Mask; bbox: Rect }): Float64Array | null {
  const { mask: cm, bbox: cb } = cluster;
  const outside = (x: number, y: number) => {
    const lx = Math.round(x) - cb.x, ly = Math.round(y) - cb.y;
    return lx < 0 || ly < 0 || lx >= cm.width || ly >= cm.height || !cm.data[ly * cm.width + lx];
  };
  const onEdge = (p: Point) => outside(p.x + 1.5, p.y) || outside(p.x - 1.5, p.y) || outside(p.x, p.y + 1.5) || outside(p.x, p.y - 1.5);
  const perim = polygonPerimeter(part.contour);
  if (!(perim > 0)) return null;
  const N = Math.max(32, Math.min(2048, Math.round(perim / 1.5)));
  const pts = smoothContour(resampleContour(part.contour, N), 1.5);
  const h = Math.max(2, Math.round(3 / (perim / N)));
  const step = perim / N;
  const hist = new Float64Array(90);
  let used = 0;
  for (let i = 0; i < N; i++) {
    const a = pts[(i - h + N) % N], b = pts[(i + h) % N];
    if (!onEdge(a) || !onEdge(pts[i]) || !onEdge(b)) continue;
    const a2 = pts[(i - 2 * h + N) % N], b2 = pts[(i + 2 * h) % N];
    const d1 = Math.atan2(pts[i].y - a2.y, pts[i].x - a2.x), d2 = Math.atan2(b2.y - pts[i].y, b2.x - pts[i].x);
    let dd = Math.abs(d2 - d1);
    if (dd > Math.PI) dd = 2 * Math.PI - dd;
    const w = Math.exp(-(((dd * 180) / Math.PI / 12) ** 2));
    let deg = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 90;
    if (deg < 0) deg += 90;
    hist[Math.min(89, Math.floor(deg))] += w * step;
    used++;
  }
  return used * step < 0.5 * Math.sqrt(part.area) ? null : hist;
}

/** Centroid of a candidate's mask in photo coordinates. */
function maskCentroid(c: Candidate): Point {
  let sx = 0, sy = 0, n = 0;
  const { width: w, height: h } = c.mask;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (c.mask.data[y * w + x]) { sx += x; sy += y; n++; }
  return n > 0 ? { x: c.bbox.x + sx / n, y: c.bbox.y + sy / n } : { x: c.bbox.x, y: c.bbox.y };
}

/**
 * Peel soft illumination effects off a region: glare halos and cast shadows change the table's
 * brightness smoothly, while a piece ends at a crisp cut edge. Region pixels reachable from outside
 * through smooth pixels (local high-pass energy of the luminance at table level) are given back to
 * the table, unless they are mostly in a colour the table cannot take under any lighting (a piece
 * printed in one smooth colour). Kept only when it leaves piece-sized parts with clearly better
 * outlines. A region that goes (nearly) all the way has no crisp edge anywhere: an empty list
 * (the caller drops it when its colour is weak as well: a stain or a shading on the table).
 */
function peelSoft(c: Candidate, img: RGBAImage, fit: BackgroundFit, ra: number, W: number, H: number): Candidate[] | null {
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
  const gone = createMask(w, h);
  for (let i = 0; i < w * h; i++) if (m.data[i] && flooded[i]) gone.data[i] = 1;
  // Glare and shadow keep the table's colour (only its brightness changes): what would be peeled
  // off in a colour of its own is a piece printed in one smooth colour, and stays.
  const gc = labelComponents(gone, 8);
  const coloured = new Float64Array(gc.stats.length + 1);
  const cache = new Map<number, ReturnType<typeof tableChromasAt>>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = gc.labels[y * w + x];
      if (!l) continue;
      const key = (y >> 3) * 4096 + (x >> 3);
      let colours = cache.get(key);
      if (!colours) cache.set(key, (colours = tableChromasAt(fit, Math.min(W - 1, x0 + (x & ~7) + 4), Math.min(H - 1, y0 + (y & ~7) + 4))));
      const o = ((y + y0) * W + x + x0) * 4;
      const lab = rgbToLab(img.data[o], img.data[o + 1], img.data[o + 2]);
      if (tableChromaDistance(colours, lab[1], lab[2]) > PEEL_CHROMA) coloured[l]++;
    }
  }
  const keep = new Set(gc.stats.filter((st) => coloured[st.label] >= PEEL_COLOURED_SHARE * st.area).map((st) => st.label));
  const rest = createMask(w, h);
  let removed = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m.data[i]) continue;
    if (gone.data[i] && !keep.has(gc.labels[i])) removed++;
    else rest.data[i] = 1;
  }
  if (removed < 0.08 * c.area) return null;
  if (removed >= SMOOTH_THROUGH * c.area) {
    // Nearly all of it smooth: a piece still shows a crisp cut edge along its outline.
    const inner = erode(m, 2), outer = dilate(m, 2);
    let rim = 0, crisp = 0;
    for (let i = 0; i < w * h; i++) {
      if (!outer.data[i] || inner.data[i]) continue;
      rim++;
      if (energy[i] > t) crisp++;
    }
    if (crisp < SMOOTH_CRISP * rim) return [];
  }
  const cleaned = fillHoles(open(rest, 1));
  const { labels, stats } = labelComponents(cleaned, 8);
  const parts = stats
    .filter((st) => st.area >= 0.5 * ra)
    .map((st) => makeCandidate(componentMask(labels, w, st.label, st.bbox), { x: st.bbox.x + x0, y: st.bbox.y + y0, width: st.bbox.width, height: st.bbox.height }, W, H, st.area, SHAPE_MAX_PIECES * ra));
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

/**
 * Blockiness from which a photo counts as a JPEG with subsampled colour (outlines snapped to
 * luminance edges, colour averaged): ≈ 1 without any, ≥ 1.2 for every decoder of a 4:2:0 JPEG
 * (a browser's smooth "fancy" chroma upsampling measures ≈ 1.2–2, jpeg-js's replication ≈ 2–5).
 */
const JPEG_BLOCKINESS = 1.1;
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

/** Lightness above the table (its sigmas) from which a pixel in the table's hue may be glare. */
const GLARE_MIN_L = 2.5;
/** Share of glare pixels (see glareShare) from which glare is peeled off a region that may hold a piece. */
const GLARE_PEEL_SHARE = 0.25;

/**
 * Glare test for photo pixels: lighter than the table there (GLARE_MIN_L sigmas) and in the table's
 * hue or paler (table colours cached per 8×8 block).
 */
function glareTest(img: RGBAImage, fit: BackgroundFit, W: number): (X: number, Y: number) => boolean {
  const cache = new Map<number, { L: number; colours: ReturnType<typeof tableChromasAt> }>();
  return (X, Y) => {
    const key = (Y >> 3) * 8192 + (X >> 3);
    let t = cache.get(key);
    if (!t) cache.set(key, (t = { L: backgroundAt(fit, X, Y)[0], colours: tableChromasAt(fit, X, Y) }));
    const o = (Y * W + X) * 4;
    const lab = rgbToLab(img.data[o], img.data[o + 1], img.data[o + 2]);
    return lab[0] - t.L > GLARE_MIN_L * fit.sigma[0] && tableChromaDistance(t.colours, lab[1], lab[2]) <= PEEL_CHROMA;
  };
}

/** Share of a region's pixels that look like glare (see glareTest); every second pixel and row. */
function glareShare(c: Candidate, img: RGBAImage, fit: BackgroundFit, W: number): number {
  const { width: w, height: h } = c.mask;
  const isGlare = glareTest(img, fit, W);
  let n = 0, glare = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (!c.mask.data[y * w + x]) continue;
      n++;
      if (isGlare(x + c.bbox.x, y + c.bbox.y)) glare++;
    }
  }
  return n > 0 ? glare / n : 0;
}

/**
 * Peel glare off a region that holds a piece next to a glare patch: the glare pixels go back to the
 * table, specks left between them are opened away, and what remains in piece-sized parts is kept
 * when one of them shows a piece outline. Null when there is too little glare or no outline appears.
 */
function peelGlare(c: Candidate, img: RGBAImage, fit: BackgroundFit, ra: number, W: number, H: number): Candidate[] | null {
  const { width: w, height: h } = c.mask;
  const isGlare = glareTest(img, fit, W);
  const rest = cloneMask(c.mask);
  let removed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!c.mask.data[y * w + x] || !isGlare(x + c.bbox.x, y + c.bbox.y)) continue;
      rest.data[y * w + x] = 0;
      removed++;
    }
  }
  if (removed < 0.2 * c.area) return null;
  const cleaned = fillHoles(open(rest, 2));
  const { labels, stats } = labelComponents(cleaned, 8);
  const parts = stats
    .filter((st) => st.area >= 0.5 * ra)
    .map((st) => makeCandidate(componentMask(labels, w, st.label, st.bbox), { x: st.bbox.x + c.bbox.x, y: st.bbox.y + c.bbox.y, width: st.bbox.width, height: st.bbox.height }, W, H, st.area, SHAPE_MAX_PIECES * ra));
  if (!parts.some((p) => (p.shape?.confidence ?? 0) >= REFERENCE_CONFIDENCE)) return null;
  return parts;
}

/** Width (body sizes) of the outer band searched for a soft cast shadow around a dark piece. */
const SHADOW_BAND = 0.1;
/** Narrowest such band (px): only close-ups (pieces ≥ 120 px) show halos the outline snapping misses. */
const SHADOW_BAND_MIN = 12;
/** Deepest shadow colour, as a multiple of the table's chroma (soft shadow on warm wood deepens it). */
const SHADOW_CHROMA_SCALE = 2.5;

/**
 * Peel a soft cast shadow off a dark piece: in an outer band of SHADOW_BAND body sizes, pixels darker
 * than the table (or at its brightness) but less than halfway to the piece's own brightness (measured
 * just inside the band, locally along the outline), in a table hue, and reached from outside through
 * such pixels, are given back to the table. The piece ends at the half-way point of its own edge; a
 * shadow is a smooth ramp on the table side of it. Null when nothing (or too much) would change.
 */
function peelShadowHalo(c: Candidate, img: RGBAImage, fit: BackgroundFit, noise: number, body: number, W: number, H: number): Candidate | null {
  const K = Math.round(SHADOW_BAND * body);
  if (K < SHADOW_BAND_MIN) return null;
  const pad = 9;
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
  const near = dilate(m, 2), far = dilate(m, 8);
  const ring: number[] = [];
  for (let i = 0; i < w * h; i++) if (far.data[i] && !near.data[i]) ring.push(Y[i]);
  if (ring.length < 30) return null;
  const tY = median(ring);
  const sY = Math.max(noise, 1.4826 * median(ring.map((v) => Math.abs(v - tY))), 1);
  // The piece's own brightness K–2K px in, averaged locally along the outline.
  const band = erode(m, K), deep = erode(m, 2 * K);
  const P = createGray(w, h), In = createGray(w, h);
  for (let i = 0; i < w * h; i++) {
    if (!band.data[i] || deep.data[i]) continue;
    P.data[i] = Y[i];
    In.data[i] = 1;
  }
  const sumP = boxBlurGray(P, 2 * K).data, cnt = boxBlurGray(In, 2 * K).data;
  // Shadow pixels of the outer band.
  const shade = new Uint8Array(w * h);
  const cache = new Map<number, ReturnType<typeof tableChromasAt>>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m.data[i] || band.data[i] || cnt[i] < 0.02) continue;
      const pY = sumP[i] / cnt[i];
      if (tY - pY < SNAP_MIN_STEP * sY) continue;
      if (Y[i] > tY + SNAP_MIN_DEV * sY || Y[i] < 0.5 * (tY + pY)) continue;
      const key = (y >> 3) * 4096 + (x >> 3);
      let colours = cache.get(key);
      if (!colours) cache.set(key, (colours = tableChromasAt(fit, Math.min(W - 1, x0 + (x & ~7) + 4), Math.min(H - 1, y0 + (y & ~7) + 4))));
      const o = ((y + y0) * W + x + x0) * 4;
      const lab = rgbToLab(img.data[o], img.data[o + 1], img.data[o + 2]);
      if (tableChromaDistance(colours, lab[1], lab[2], SHADOW_CHROMA_SCALE) <= PEEL_CHROMA) shade[i] = 1;
    }
  }
  // Reached from outside through shadow pixels (4-connected).
  const gone = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (shade[i] && (!m.data[i - 1] || !m.data[i + 1] || !m.data[i - w] || !m.data[i + w])) { gone[i] = 1; queue[tail++] = i; }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    for (const j of [i - 1, i + 1, i - w, i + w]) {
      if (j < 0 || j >= w * h || gone[j] || !shade[j]) continue;
      gone[j] = 1;
      queue[tail++] = j;
    }
  }
  const keep = cloneMask(m);
  let removed = 0;
  for (let i = 0; i < w * h; i++) if (gone[i]) { keep.data[i] = 0; removed++; }
  if (removed < 0.02 * c.area) return null;
  const cleaned = fillHoles(open(keep, 1));
  const { labels, stats } = labelComponents(cleaned, 8);
  if (stats.length === 0) return null;
  const main = stats.reduce((a, b) => (b.area > a.area ? b : a));
  if (main.area < 0.6 * c.area) return null;
  const peeled = makeCandidate(componentMask(labels, w, main.label, main.bbox), { x: main.bbox.x + x0, y: main.bbox.y + y0, width: main.bbox.width, height: main.bbox.height }, W, H, main.area);
  // A piece outline must not get worse (a shadow halo only rounds it off).
  if ((peeled.shape?.confidence ?? 0) < (c.shape?.confidence ?? 0) - 0.05) return null;
  return { ...peeled, group: c.group, merged: c.merged };
}

/** Share of a region the largest part must keep when its cast shadow is trimmed. */
const CAST_KEEP = 0.7;

/**
 * A single piece's outline without the deep cast shadow along it (castShadow.ts): the largest part
 * left, unless that lost much of the region (then the "shadow" was dark print). Its shape confidence
 * is no guide here: at the sizes these shadows show (pieces of 40–100 px), a shadow filling the
 * blanks along one side squares the outline off as convincingly as the piece's own sides.
 */
function trimCastShadow(c: Candidate, img: RGBAImage, fit: BackgroundFit, band: number, ra: number, W: number, H: number): Candidate | null {
  const pad = 2;
  const x0 = Math.max(0, c.bbox.x - pad), y0 = Math.max(0, c.bbox.y - pad);
  const x1 = Math.min(W, c.bbox.x + c.bbox.width + pad), y1 = Math.min(H, c.bbox.y + c.bbox.height + pad);
  const w = x1 - x0, h = y1 - y0;
  const m = createMask(w, h);
  for (let y = 0; y < c.bbox.height; y++) m.data.set(c.mask.data.subarray(y * c.bbox.width, (y + 1) * c.bbox.width), (y + c.bbox.y - y0) * w + c.bbox.x - x0);
  const cast = castShadow(m, x0, y0, img, fit, band);
  if (!cast || cast.count < 0.02 * ra) return null;
  for (let i = 0; i < w * h; i++) if (cast.shadow[i]) m.data[i] = 0;
  const { labels, stats } = labelComponents(open(m, 1), 8);
  if (stats.length === 0) return null;
  const main = stats.reduce((a, b) => (b.area > a.area ? b : a));
  if (main.area < CAST_KEEP * c.area || main.area < 0.5 * ra) return null;
  const trimmed = makeCandidate(componentMask(labels, w, main.label, main.bbox), { x: main.bbox.x + x0, y: main.bbox.y + y0, width: main.bbox.width, height: main.bbox.height }, W, H, main.area);
  return { ...trimmed, group: c.group, merged: c.merged };
}

/**
 * Wood-grain table model (SegmentOptions.grain) when the option is not given: off. On the HABA oak
 * photo it gives cleaner outlines and finds every piece, but leaves two touching pieces merged and
 * one cut by a sunlit table patch; matching keeps such regions ambiguous (capForSize), so its
 * confident placements stay right, but one piece fewer is placed right at all, and segmentation
 * on grained wood takes about twice as long. Two Flickr wood photos gain clearly.
 */
const GRAIN_DEFAULT = false;

/**
 * Trimming of deep cast shadows off single pieces (SegmentOptions.castShadow) when the option is not
 * given: off. On the brown-board photo of 2026-10-24 (2026-10-24-assembled-board-gaps) it gives two
 * more outlines right (3 of 13 judged marks instead of 1) and changes no other feedback file, but on
 * synthetic dark-wood scenes it moves outlines that matching relied on (wave-dark-wood-pieces kind
 * accuracy 1 → 0.95, starry-wood-tiles-real top-1 0.69 → 0.63; without the deep-shadow share
 * also Puzzle-Map segTop1 0.267 → 0.258 and placed confident precision 0.999 → 0.991).
 */
const CAST_SHADOW_DEFAULT = false;

/** Graph-cut refinement (SegmentOptions.graphCut) when the option is not given. */
const GRAPH_CUT_DEFAULT = false;
/** Depth (body sizes, 3–48 px) from which region pixels stay piece in the graph cut. */
const GC_INNER = 0.15;
/** Distance (body sizes, 2–24 px) outside a region beyond which pixels stay table. */
const GC_OUTER = 0.08;
/** Width (body sizes, at least 4 px) of the window beyond that which only feeds the table model. */
const GC_RING = 0.1;
/** Regions refined: from GC_MIN_PIECES to GC_MAX_PIECES piece areas (clusters gain little and are slow)… */
const GC_MIN_PIECES = 0.3;
const GC_MAX_PIECES = 3;
/** …whose outline is in doubt: shape confidence below GC_DOUBT_CONFIDENCE, or above GC_DOUBT_AREA piece areas. */
const GC_DOUBT_CONFIDENCE = 0.7;
const GC_DOUBT_AREA = 1.3;
/** Share of a region the refinement must keep (it trims halos, it does not replace the region)… */
const GC_MIN_KEPT = 0.5;
/** …and must remove at least (halos are 8–25 % of a region; less is noise at knob tips and corners). */
const GC_MIN_CHANGE = 0.03;
/**
 * Mean data margin (nats per pixel: −log p(piece) + log p(table) under colour models of the
 * region's interior and of the table around it) from which a part the cut removed goes to the
 * table; parts below GC_KEEP_MIN_AREA piece areas go regardless (outline smoothing).
 */
const GC_MARGIN = 1;
const GC_KEEP_MIN_AREA = 0.004;
/** Opening radius (px, or body sizes when larger) below which removed strips stay with the piece. */
const GC_THIN_PX = 2;
const GC_THIN = 0.02;
/**
 * Body size (px) per step of the reduced scale of the first cut (larger pieces are cut coarsely
 * first), up to GC_MAX_SCALE (coarser cuts miss the thin halo bands of close-ups).
 */
const GC_BODY_PX = 50;
const GC_MAX_SCALE = 3;

/**
 * Refine a region's outline by graph cut (refine.ts): the band from GC_INNER body sizes inside the
 * outline to GC_OUTER outside is relabelled (other regions stay table), and the region gives up
 * only what looks like a halo (glare, soft shadow, table colour bled into by a JPEG): parts the cut
 * removed that are wider than a thin strip and that colour models of the region's interior and of
 * the table around it clearly take for table. Thin strips all along the outline are the blend of
 * piece and table at a clean edge; parts those models do not clearly give to the table are print
 * resembling the table, cut off because the cut follows strong print edges (a dark corner on a
 * dark table). Nothing is added: the cut only shrinks the region. Parts of at least GC_MIN_PIECES
 * piece areas become candidates (several when the cut separates pieces). Null when nothing usable
 * remains or the change is too small to be a halo.
 */
function graphCutCandidate(c: Candidate, all: Candidate[], img: RGBAImage, body: number, ra: number, minArea: number, W: number, H: number): Candidate[] | null {
  const inner = Math.max(3, Math.min(48, Math.round(GC_INNER * body)));
  const outer = Math.max(2, Math.min(24, Math.round(GC_OUTER * body)));
  const ring = Math.max(4, Math.round(GC_RING * body));
  const reach = outer + ring + 2;
  const others = all.filter((o) => o !== c && rectGap(o.bbox, c.bbox) <= reach);
  const r = refineByGraphCut(img, c.mask, c.bbox, others, { inner, outer, ring, scale: Math.max(1, Math.min(GC_MAX_SCALE, Math.round(body / GC_BODY_PX))) });
  if (!r) return null;
  const { x: x0, y: y0, width: w, height: h } = r.rect;
  const refined = fillHoles(r.mask);
  // The region in the window; what the cut removed from it.
  const region = createMask(w, h), removed = createMask(w, h);
  let any = 0;
  for (let y = 0; y < c.bbox.height; y++) {
    for (let x = 0; x < c.bbox.width; x++) {
      if (!c.mask.data[y * c.bbox.width + x]) continue;
      const i = (y + c.bbox.y - y0) * w + x + c.bbox.x - x0;
      region.data[i] = 1;
      if (!refined.data[i]) { removed.data[i] = 1; any++; }
    }
  }
  for (let i = 0; i < w * h; i++) refined.data[i] &= region.data[i];
  if (any > 0) {
    // Only bands wider than a thin strip (anti-aliasing, blur, JPEG colour at a clean edge) go…
    const thin = Math.max(GC_THIN_PX, GC_THIN * body);
    const thick = open(removed, thin, 'disk');
    for (let i = 0; i < w * h; i++) if (removed.data[i] && !thick.data[i]) refined.data[i] = 1;
    // …and only where colour models of the region's interior and of the table around it (not the
    // cut's own models, which drift towards what it cut off) clearly say table on average.
    const rc = labelComponents(thick, 8);
    const margin = new Float64Array(rc.stats.length + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = rc.labels[y * w + x];
        if (!l) continue;
        const o = ((y + y0) * W + x + x0) * 4;
        margin[l] += gmmNegLogLikBest(r.piece, img.data[o], img.data[o + 1], img.data[o + 2]) - gmmNegLogLikBest(r.table, img.data[o], img.data[o + 1], img.data[o + 2]);
      }
    }
    const keep = new Set(rc.stats.filter((st) => st.area >= GC_KEEP_MIN_AREA * ra && margin[st.label] < GC_MARGIN * st.area).map((st) => st.label));
    if (keep.size > 0) for (let i = 0; i < w * h; i++) if (keep.has(rc.labels[i])) refined.data[i] = 1;
    // Notches left where only parts of a band went are closed again (within the region).
    const closed = close(refined, thin, 'disk');
    for (let i = 0; i < w * h; i++) refined.data[i] = closed.data[i] & region.data[i];
  }
  const { labels, stats } = labelComponents(refined, 8);
  const parts = stats.filter((st) => st.area >= Math.max(minArea, GC_MIN_PIECES * ra));
  const kept = parts.reduce((sum, st) => sum + st.area, 0);
  // (Changes of a few pixels at knob tips and corners are noise, not a halo.)
  if (kept < GC_MIN_KEPT * c.area || (parts.length === 1 && kept > (1 - GC_MIN_CHANGE) * c.area)) return null;
  return parts.map((st) => makeCandidate(componentMask(labels, w, st.label, st.bbox), { x: st.bbox.x + x0, y: st.bbox.y + y0, width: st.bbox.width, height: st.bbox.height }, W, H, st.area, SHAPE_MAX_PIECES * ra));
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
  return r > 0.6 && r < 1.6 && bodyAspect(c.shape) <= SINGLE_MAX_ASPECT;
}

/** Weight (in single pieces) of the unit area of all objects against the clean single outlines. */
const UNIT_WEIGHT = 2;

/**
 * The area of one piece that best explains a set of object areas (loose pieces, pairs, clusters of
 * touching pieces) as whole multiples of it: objects close to one unit count fully, multiples less
 * (several counts fit them), and objects well below a unit count against it. Robust where few
 * objects are clean single pieces (dense layouts). 0 without objects.
 */
function unitArea(areas: number[], weights: number[]): number {
  if (areas.length === 0) return 0;
  const lo = Math.min(...areas) / 1.6, hi = Math.max(...areas) * 1.1;
  let best = 0, bestScore = -Infinity;
  for (let A = lo; A <= hi; A *= 1.02) {
    let score = 0;
    for (let i = 0; i < areas.length; i++) {
      const x = areas[i] / A;
      if (x < 0.7) {
        score -= 0.5 * weights[i];
        continue;
      }
      const k = Math.max(1, Math.round(x));
      const e = (x - k) / (0.18 * Math.sqrt(k));
      score += (weights[i] * Math.exp(-0.5 * e * e)) / k;
    }
    if (score > bestScore) {
      bestScore = score;
      best = A;
    }
  }
  return best;
}

/** Largest body aspect ratio of a single piece (two pieces side by side make 2). */
const SINGLE_MAX_ASPECT = 1.35;

/** Aspect ratio (≥ 1) of a shape's body quadrilateral: mean of opposite sides, longer / shorter. */
function bodyAspect(s: PieceShape): number {
  const d = (i: number) => Math.hypot(s.corners[(i + 1) % 4].x - s.corners[i].x, s.corners[(i + 1) % 4].y - s.corners[i].y);
  const a = d(0) + d(2), b = d(1) + d(3);
  return Math.max(a, b) / Math.max(1e-6, Math.min(a, b));
}

/** Largest cluster (piece areas) whose neck split may be replaced by a cut along the edges. */
const EDGE_RECUT_MAX_PIECES = 4;

/** Largest chroma distance (sigmas, see tableChromaDistance) of a pixel that may be peeled off as glare or shadow. */
const PEEL_CHROMA = 4;
/** Share of such coloured pixels from which a soft area is a piece rather than glare or shadow. */
const PEEL_COLOURED_SHARE = 0.5;
/** Largest region (piece areas) whose soft halo or shadow is peeled off. */
const PEEL_MAX_PIECES = 8;
/** Largest part (piece areas) of a split that is split again at wider necks. */
const RESPLIT_MAX_PIECES = 20;
/**
 * Area (piece areas) by which a part must be smaller than the cluster it was split from to be split
 * again: every round has to shrink the parts (a split keeps no part below half a piece), or a part
 * the split cannot shrink recurses without end.
 */
const SPLIT_PROGRESS = 0.5;
/** Largest part (piece areas) that wider necks peel off a patch of many pieces: loose pieces, pairs. */
const PEEL_LOOSE_PIECES = 4;
/**
 * Smallest hole (piece areas) in a cluster that is table enclosed by its pieces rather than print
 * inside one piece (print like the table rarely covers half a piece).
 */
const TABLE_HOLE = 0.5;
/** Largest candidate (piece areas) whose outline is analysed as a single piece. */
const SHAPE_MAX_PIECES = 3;
/** Largest hole that is filled, in piece areas (see objectUnitArea). */
const HOLE_MAX_PIECES = 1.5;

/**
 * Area of one piece estimated from the components of at least `minArea` px that do not touch the
 * photo border (loose pieces, pairs, clusters; not networks of tile gaps reaching the border), as
 * the unit their areas are multiples of; Infinity without any.
 */
function objectUnitArea(m: Mask, minArea: number): number {
  const { width: w, height: h } = m;
  const { count, y: ry, x0: rx0, x1: rx1, root } = labelRuns(m, 1, 8);
  const area = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const r = root[i];
    if (area[r] < 0) continue;
    if (ry[i] === 0 || ry[i] === h - 1 || rx0[i] === 0 || rx1[i] === w - 1) area[r] = -1;
    else area[r] += rx1[i] - rx0[i] + 1;
  }
  const areas: number[] = [];
  for (let i = 0; i < count; i++) if (root[i] === i && area[i] >= minArea) areas.push(area[i]);
  return areas.length > 0 ? unitArea(areas, areas.map(() => 1)) : Infinity;
}

/**
 * Smallest reference single as a share of the photo area (a piece covers ≥ 0.2 % even with 200
 * pieces in view; specks of shadow or grain that happen to have a tidy outline are far smaller).
 */
const MIN_REFERENCE_SHARE = 5e-4;

/** Shape confidence of clean single pieces (assembled patches rarely exceed ≈ 0.8). */
const STRONG_SINGLE = 0.85;

/**
 * The regions that define the single-piece size. Assembled patches sometimes get a plausible
 * "piece" outline (four corners at the patch corners), so: prefer very clean shapes, and when the
 * sizes are clearly multi-modal take the smallest well-supported size cluster (patches are multiples
 * of a piece, never smaller).
 */
function referenceSingles(cands: Candidate[], minArea: number): Candidate[] {
  // Crumbs and specks that happen to have a tidy outline are no reference (see MIN_REFERENCE_SHARE).
  const plausible = cands.filter((c) => c.area >= minArea && isPlausibleSingle(c));
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
 * Seam pieces (area / seam pitch², see {@link estimatePatchPitch}) at or above which a lone region
 * is a large assembled block. Single pieces stay below ≈ 20 (their comb locks onto the knob necks,
 * a third of a piece apart) in the real feedback photos; blocks of 30+ pieces reach their count.
 */
const LARGE_BLOCK_PIECES = 30;

/** True when the region's seams show a large assembled block (see {@link LARGE_BLOCK_PIECES}). */
function isLargeBlock(photo: RGBAImage, c: Candidate): boolean {
  const est = estimatePatchPitch(cropRGBA(photo, c.bbox), c.mask, c.orientation);
  return !!est && c.area >= LARGE_BLOCK_PIECES * est.pitch * est.pitch;
}

/**
 * Find every piece / patch in a scan photo. Regions get ids 1..n in reading order, a kind
 * ('piece' | 'patch' | 'unknown'), outline, shape (single pieces), orientation and issues; the
 * result also carries the foreground mask, background model and the photo quality report.
 */
export function segmentPieces(input: RGBAImage, opts: SegmentOptions = {}): Segmentation {
  const W = input.width, H = input.height;
  // The same JPEG decoded by jpeg-js (colour replicated over 2×2 pixels) or by a browser (colour
  // interpolated) is analysed as the browser decodes it: no result depends on the decoder.
  let t0 = performance.now();
  const photo = interpolateReplicatedChroma(input);
  const patchRatio = opts.patchAreaRatio ?? 1.8;
  const fragRatio = opts.fragmentAreaRatio ?? 0.35;
  // JPEG photos at their original pixel grid: colour bleeds into the table around every piece, in
  // blocks of up to 16×16 px (outlines are snapped to brightness edges below; specks of one or two
  // such blocks are noise).
  const blockiness = chromaBlockiness(photo);
  const blocky = blockiness >= JPEG_BLOCKINESS;
  const minArea = opts.minArea ?? Math.max(blocky ? JPEG_MIN_AREA : 48, Math.round(5e-5 * W * H));

  const timings = opts.timings;
  const lap = (name: string) => {
    const t = performance.now();
    if (timings) timings[name] = (timings[name] ?? 0) + (t - t0);
    t0 = t;
  };
  // Noisy photos (dim light): score a box-filtered copy, so that white noise does not drown the
  // small colour difference of dark pieces on a dark table (clean photos keep full sharpness).
  const noise = estimateNoise(photo);
  const smoothing = noise < NOISE_SMOOTH_1 ? 0 : noise < NOISE_SMOOTH_2 ? 1 : 2;
  // A phone JPEG stores colour at half resolution: its pixel-level colour noise (and how a decoder
  // upsamples the colour) carries no information, so the colour is averaged over 3×3 pixels while
  // the brightness stays sharp. Replays decoded differently, or re-encoded, then score alike.
  const scored = smoothing > 0 ? boxBlurRGB(photo, smoothing) : blocky ? smoothChroma(photo, 1) : photo;
  let fit: BackgroundFit = fitBackground(scored);
  lap('background');
  const diag = opts.diagnostics;

  // Luminance texture (light neutral tables): the photo's part computed once, on first use.
  const lumaOn = opts.luminanceTexture ?? true;
  let lumaCache: LumaTexture | null | undefined;
  const luma = () => (lumaCache === undefined ? (lumaCache = lumaTexture(scored)) : lumaCache);
  /** Score → threshold → texture → morphology → candidates → reference size → strands removed. */
  const pass = (model: BackgroundFit, grain?: GrainTable) => {
    const score = foregroundScore(scored, model, grain);
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
    // On a light, neutral, plain table pale grey print differs from the table in brightness only
    // (the shadow-tolerant score takes it for shade): luminance texture too, kept from bridging
    // pieces lying close (lumaTexture.ts).
    else if (lumaOn && lumaTextureApplies(model)) addTexture(lumaTextureForeground(luma(), fg, model));
    lap('texture');
    // Pieces lying 1–3 px apart are still separate here (closing bridges them): kept for splitting.
    const preClose = cloneMask(fg);
    fg = close(fg, 2);
    // Holes in pieces (print like the table) are filled; table enclosed by a grid of tile gaps, by an
    // assembled frame or by a ring of touching pieces is not (larger than a piece).
    fg = fillHoles(fg, HOLE_MAX_PIECES * objectUnitArea(fg, Math.max(minArea, MIN_REFERENCE_SHARE * W * H)));
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
      const minRef = MIN_REFERENCE_SHARE * W * H;
      const others = cands.filter((c) => !c.touchesBorder);
      // Unit area from every object (loose pieces, pairs, clusters of touching pieces); the clean
      // single-piece outlines that agree with it refine it.
      const objects = others.filter((c) => c.area >= minRef);
      const unit = unitArea(objects.map((c) => c.area), objects.map((c) => (isPlausibleSingle(c) ? 1 + 2 * c.shape!.confidence : 1)));
      const singles = referenceSingles(cands, minRef).filter((c) => unit <= 0 || (c.area >= 0.65 * unit && c.area <= 1.55 * unit));
      let refArea: number, refBody: number;
      if (singles.length > 0) {
        const ms = median(singles.map((c) => c.area));
        refArea = unit > 0 ? Math.exp((singles.length * Math.log(ms) + UNIT_WEIGHT * Math.log(unit)) / (singles.length + UNIT_WEIGHT)) : ms;
        refBody = median(singles.map((c) => c.shape!.bodySize)) * Math.sqrt(refArea / ms);
      } else {
        refArea = unit > 0 ? unit : others.length > 0 ? median(others.map((c) => c.area)) : 0;
        refBody = Math.sqrt(refArea);
      }
      return { singles, refArea, refBody, noReference: singles.length === 0 && others.length < 3 };
    };
    let ref = references();
    // Plank gaps, tile seams, cracks, cables: thin long structures must neither join a piece nor
    // become a region of their own.
    if (ref.refBody > 0) {
      const out: Candidate[] = [];
      let changed = false;
      for (const c of cands) {
        // Weak pixels (between the thresholds) far from any strong one: shading bands, the edge of
        // a second surface, shadows that only hysteresis tied to a piece.
        const anchored = dropFarWeak(c, score, th.high, texOnly, Math.max(2, WEAK_REACH * ref.refBody), Math.max(minArea, ANCHOR_MIN * ref.refArea), ref.refArea, minArea, W, H, ref.singles.length > 0, scored);
        if (anchored) changed = true;
        for (const a of anchored ?? [c]) {
          const parts = removeThin(a, ref.refBody, ref.refArea, minArea, W, H);
          if (parts) changed = true;
          out.push(...(parts ?? [a]));
        }
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
  // Grained wood: the table colour along the grain through each pixel, around the pieces found so
  // far (grain.ts), and segment again (this pass takes the local table model's place below).
  let grainUsed = false;
  if (p.ref.refBody > 0 && (opts.grain ?? GRAIN_DEFAULT)) {
    const exclude = createMask(W, H);
    for (const c of p.cands) {
      if (c.area < 0.25 * p.ref.refArea) continue;
      const { x: bx, y: by, width: bw, height: bh } = c.bbox;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) if (c.mask.data[y * bw + x]) exclude.data[(y + by) * W + x + bx] = 1;
      }
    }
    const coherence = grainCoherence(scored, exclude, p.ref.refBody);
    if (coherence >= GRAIN_MIN_COHERENCE) {
      // Shadow zones and light at the scale of a few pieces (the local table model) stay the smooth
      // model's part: the grain is the residual from both.
      const local = fit.palette.length === 0 ? fitLocalTable(scored, fit, exclude, Math.max(2 * p.ref.refBody, Math.min(W, H) / 10)) : null;
      const model: BackgroundFit = local ? { ...fit, local } : fit;
      const grain = fitGrainTable(scored, exclude, p.ref.refBody, fit.sigma, (x, y) => backgroundAt(model, x, y), 0);
      if (diag && grain) diag.grain = { coherence: grain.coherence, sigma: grain.sigma, coverage: grain.coverage };
      if (grain) {
        fit = model;
        p = pass(fit, grain);
        grainUsed = true;
      }
    }
    lap('grain');
  }
  // Shadow zones and local lighting the smooth surface cannot follow: learn them from the table
  // around the pieces found so far (coarse grid, cells of at least two pieces) and segment again.
  if (!grainUsed && p.ref.refBody > 0 && fit.palette.length === 0) {
    // Excluded (on a 4× coarser grid): anything piece-shaped and every blob with a fair share of
    // strong pixels (pieces, and patches of weak pieces whose print is speckled with them). Smooth
    // weak blobs, which may be the shadow zone itself, stay in the estimate (a cell spans several
    // pieces, so the median is robust).
    const f = 4, cw = Math.ceil(W / f), ch = Math.ceil(H / f);
    const whole = createMask(cw, ch);
    const sd = p.score.data, high = p.th.high;
    for (const c of p.cands) {
      if (c.area < 0.25 * p.ref.refArea) continue;
      const { x: bx, y: by, width: bw, height: bh } = c.bbox;
      let strong = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) if (c.mask.data[y * bw + x] && sd[(y + by) * W + x + bx] >= high) strong++;
      }
      const pieceLike = c.area >= 0.5 * p.ref.refArea && c.shape !== null && c.shape.confidence >= MIN_SHAPE_CONFIDENCE;
      if (!pieceLike && strong < LOCAL_STRONG_SHARE * c.area) continue;
      for (let y = 0; y < bh; y++) {
        const crow = (((y + by) / f) | 0) * cw;
        for (let x = 0; x < bw; x++) if (c.mask.data[y * bw + x]) whole.data[crow + (((x + bx) / f) | 0)] = 1;
      }
    }
    const exclude = dilate(whole, Math.max(1, Math.round((0.25 * p.ref.refBody) / f)));
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
      // (Not clusters of many pieces: peeling them is slow and changes little.)
      const doubtful = !c.touchesBorder && c.area >= 0.6 * ra && c.area <= PEEL_MAX_PIECES * ra && (c.area > 1.3 * ra || !c.shape || c.shape.confidence < 0.7);
      if (!doubtful) {
        out.push(c);
        continue;
      }
      // (Glare is only looked for where a fair share of the region looks like it.)
      const glare = () => (glareShare(c, scored, fit, W) >= GLARE_PEEL_SHARE ? peelGlare(c, scored, fit, ra, W, H) : null);
      const peeled = peelSoft(c, scored, fit, ra, W, H);
      // Smooth all through and weakly coloured: a stain or shading on the table, no piece.
      if (peeled?.length === 0 && medianScore(score, c) < th.high) continue;
      out.push(...((peeled?.length ? peeled : null) ?? glare() ?? [c]));
    }
    cands = out;
  }

  // The table in shade (narrow gaps between pieces lying close), over the foreground: once per photo,
  // when a split first needs it.
  let shadeMap: Mask | undefined;
  const shade = opts.shadeGaps === false ? null : (): Mask => {
    if (shadeMap) return shadeMap;
    const t = performance.now();
    shadeMap = tableShade(scored, fit, fg, SHADE_RHO_MIN, SHADE_RHO_MAX, SHADE_TOL);
    // (Part of the split's time; reported on its own with the re-ownership.)
    if (timings) timings.shade = (timings.shade ?? 0) + performance.now() - t;
    return shadeMap;
  };
  // Split touching pieces at narrow necks, wider necks for what is still too large.
  let group = 0;
  if (refArea > 0 && opts.splitTouching !== false) {
    // A part is split again only when the split made it clearly smaller than its cluster.
    const shrunk = (p: Candidate, c: Candidate) => p.area <= c.area - SPLIT_PROGRESS * refAreaAt(c);
    const splitTouching = (c: Candidate, from: number): Candidate[] | null => {
      const ra = refAreaAt(c), bodyAt = refBody * Math.sqrt(ra / refArea);
      // A clean four-corner outline clearly larger than a piece is two pieces side by side.
      const confidentSingle = c.shape !== null && c.shape.confidence >= 0.7 && c.shape.bodySize <= 1.2 * bodyAt;
      if (c.area <= 1.4 * ra || confidentSingle) return null;
      for (let k = from; k < NECK_RADII.length; k++) {
        // Every part at least half a piece: the opening only cuts contacts clearly narrower than a
        // piece body (pieces of an assembled patch touch along whole sides).
        const necks = splitAtNecks(c, Math.max(2, NECK_RADII[k] * bodyAt), 0.3 * ra, 0.5 * ra);
        if (!necks) continue;
        // (Cuts through a piece's waist are undone: no seam runs there.)
        const parts = seamCuts(c, necks, preClose, scored, bodyAt, Math.max(2, NECK_RADII[k] * bodyAt));
        if (!parts) continue;
        const out: Candidate[] = [];
        for (const p of parts) {
          const pc = makeCandidate(p.mask, p.bbox, W, H, undefined, SHAPE_MAX_PIECES * ra);
          // Parts of many pieces (an assembled frame) are not cut further, only loose pieces lying
          // against them are peeled off.
          out.push(...((!shrunk(pc, c) ? null : pc.area <= RESPLIT_MAX_PIECES * ra ? splitTouching(pc, k) : peelLoose(pc, k + 1)) ?? [pc]));
        }
        // A cut through a contact zone may spoil every outline; where the edges between a few
        // pieces give as many parts with a convincing outline, those are taken.
        const convincing = (ps: Candidate[]) => ps.some((p) => (p.shape?.confidence ?? 0) >= REFERENCE_CONFIDENCE);
        if (c.area <= EDGE_RECUT_MAX_PIECES * ra && !convincing(out)) {
          const edges = splitAtEdges(c, ra, bodyAt, preClose, scored, score, th.high, W, H, singles.length > 0);
          if (edges && edges.length === out.length && convincing(edges)) return edges;
        }
        return out;
      }
      // A patch of many pieces without any neck: only loose pieces lying against it come off (the
      // edges are not cut for so many pieces).
      if (c.area > RESPLIT_MAX_PIECES * ra) return peelLoose(c, from);
      // Pieces touching along a whole side or slightly overlapping: cut along the edges between them.
      const cut = splitAtEdges(c, ra, bodyAt, preClose, scored, score, th.high, W, H, singles.length > 0);
      // Parts still clearly larger than a piece (a blob of pieces lying close together, a part whose
      // overlapping pieces the area under-counted) are split in turn.
      return cut?.flatMap((p) => (p.area > 1.4 * ra && shrunk(p, c) ? splitTouching(p, 0) : null) ?? [p]) ?? null;
    };
    // A patch of many pieces with loose pieces lying against it: wider necks cut only parts of a few
    // pieces off it (an assembled patch's own pieces join it along whole sides). Table the patch and
    // the loose pieces enclose is opened for these cuts (filled, it ties them together beyond any
    // neck); between loose pieces only, the edge split separates them better than such cuts.
    // (`opened`: the patch's table holes are open already, it was peeled before.)
    const peelLoose = (c: Candidate, from: number, opened = false): Candidate[] | null => {
      const ra = refAreaAt(c), bodyAt = refBody * Math.sqrt(ra / refArea);
      const holed = opened ? null : openTableHoles(c, preClose, TABLE_HOLE * ra, W);
      const necks = holed ? { ...c, mask: holed } : c;
      for (let k = from; k < NECK_RADII.length; k++) {
        const parts = splitAtNecks(necks, Math.max(2, NECK_RADII[k] * bodyAt), 0.3 * ra, 0.5 * ra)?.map((p) => (holed ? { ...p, mask: refill(p.mask, p.bbox, c, holed) } : p));
        if (!parts) continue;
        const main = parts.reduce((a, b) => (maskArea(b.mask) > maskArea(a.mask) ? b : a));
        const loose = parts.filter((p) => p !== main);
        if (loose.some((p) => maskArea(p.mask) > PEEL_LOOSE_PIECES * ra)) continue;
        const rest = makeCandidate(main.mask, main.bbox, W, H, undefined, SHAPE_MAX_PIECES * ra);
        const out = peelLoose(rest, k + 1, true) ?? [rest];
        for (const p of loose) {
          const pc = makeCandidate(p.mask, p.bbox, W, H, undefined, SHAPE_MAX_PIECES * ra);
          out.push(...((shrunk(pc, c) ? splitTouching(pc, k) : null) ?? [pc]));
        }
        return out;
      }
      return null;
    };
    const out: Candidate[] = [];
    for (const c of cands) {
      const split = splitTouching(c, 0);
      // (Halves only by a piece size measured on single pieces: without one, "half a piece" means little.)
      let parts = split && singles.length > 0 ? rejoinHalves(split, c, refAreaAt(c), W, H) : split;
      // The split's decisions stay; the pixels around its cuts are given out again with the shaded
      // table carved out (a knob pressed against a neighbour goes back to its own piece).
      const bodyAt = refBody * Math.sqrt(refAreaAt(c) / refArea);
      if (parts && parts.length > 1 && shade && bodyAt >= REOWN_MIN_BODY) {
        const map = shade(), t = performance.now();
        parts = reownParts(c, parts, refAreaAt(c), bodyAt, map, W, H) ?? parts;
        if (timings) timings.shade = (timings.shade ?? 0) + performance.now() - t;
      }
      if (parts && parts.length > 1) {
        group++;
        for (const p of parts) out.push({ ...p, group });
      } else out.push(c);
    }
    cands = out;
  }
  if (refArea > 0) cands = mergeFragments(cands, refAreaAt, refBody, W, H);
  lap('split');
  // (The crease maps of the split are no longer needed.)
  topHatTiles.delete(scored);
  if (diag) diag.blockiness = blockiness;
  // Deep cast shadows taken in by single pieces (castShadow.ts), where the outline gets clearly better.
  const trimmed = (c: Candidate): Candidate | null => {
    if (!(opts.castShadow ?? CAST_SHADOW_DEFAULT) || refArea <= 0 || fit.color[0] < DARK_TABLE_L) return null;
    const ra = refAreaAt(c), band = CAST_BAND * refBody * Math.sqrt(ra / refArea);
    return c.area >= 0.5 * ra && c.area <= 1.4 * ra && band >= CAST_BAND_MIN ? trimCastShadow(c, scored, fit, band, ra, W, H) : null;
  };
  // Soft cast shadows around dark pieces in close-ups (else deep ones of any piece), then (JPEGs)
  // colour bled into the table.
  cands = cands.map((c) => {
    if (c.touchesBorder) return c;
    const bodyAt = refBody * Math.sqrt(refAreaAt(c) / Math.max(1, refArea));
    const peeled = (refArea > 0 ? peelShadowHalo(c, scored, fit, noise, bodyAt, W, H) : null) ?? trimmed(c) ?? c;
    return blocky ? snapOutline(peeled, scored, score, th.high, noise, bodyAt, W, H) ?? peeled : peeled;
  });
  lap('snap');
  // Outlines in doubt (no convincing piece shape, or larger than a piece) refined by graph cut:
  // halos trimmed; pieces the cut separates (each at least half a piece) become touching pieces.
  // (Not on a dark table: no visible cast shadows there, and dark print at an outline looks like it.)
  if (refArea > 0 && (opts.graphCut ?? GRAPH_CUT_DEFAULT) && fit.color[0] >= DARK_TABLE_L) {
    const out: Candidate[] = [];
    for (const c of cands) {
      const ra = refAreaAt(c);
      const doubtful = !c.shape || c.shape.confidence < GC_DOUBT_CONFIDENCE || c.area > GC_DOUBT_AREA * ra;
      const parts = doubtful && !c.touchesBorder && c.area >= GC_MIN_PIECES * ra && c.area <= GC_MAX_PIECES * ra ? graphCutCandidate(c, cands, scored, refBody * Math.sqrt(ra / refArea), ra, minArea, W, H) : null;
      if (!parts || (parts.length > 1 && parts.some((q) => q.area < 0.5 * ra))) out.push(c);
      else if (parts.length === 1) out.push({ ...parts[0], group: c.group, merged: c.merged });
      else {
        group++;
        for (const q of parts) out.push({ ...q, group });
      }
    }
    cands = out;
    lap('graphcut');
  }

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
    // lone pieces ≥ 0.9). A large block can still fit four corners moderately well: its seams,
    // one piece apart, tell it from a single piece.
    else if (noReference && (weakShape || (!confidentSingle && isLargeBlock(photo, c)))) kind = 'patch';
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
    // An assembled patch keeps the table it encloses open (the cells of missing pieces): matching
    // then neither compares that table with the picture nor reports those cells as covered.
    const mask = kind === 'patch' && ra > 0 ? openTableHoles(c, preClose, TABLE_HOLE * ra, W) ?? c.mask : c.mask;
    const table = kind === 'patch' && ra > 0 ? tableInside(photo, fit, mask, c.bbox, score, th.high, texOnly, TABLE_SPECK * ra) : undefined;
    return { region, mask, image: cropRGBA(photo, c.bbox), borderTable: 0, ...(table ? { table } : {}) };
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
