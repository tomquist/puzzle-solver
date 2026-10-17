/**
 * Photo quality of a scan (whole photo + per region) and of live camera frames.
 *
 * Measurements come from `pipeline/quality/metrics.ts` (blur, exposure, glare) plus outline-based
 * measures computed here: edge width across the piece outlines (overall and per direction, to tell
 * defocus from motion blur), background separability / outline contrast, the lighting ratio of the
 * background model and the spatial trend of piece sizes (perspective).
 */
import { rgbaToGray, rgbToLab } from '../../cv/color';
import { labelComponents } from '../../cv/components';
import { findOuterContours } from '../../cv/contour';
import { convexHull, polygonArea, polygonPerimeter } from '../../cv/polygon';
import { createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { erode, open } from '../../cv/morphology';
import { sampleRGBA } from '../../cv/warp';
import type { FrameQuality, QualityCode, QualityIssue, QualityReport, Severity } from '../../model/types';
import { blurMetric, exposureStats, glareMask } from '../quality/metrics';
import { backgroundAt } from './background';
import type { Segmentation, SegmentedRegion } from './types';
import { median, quantile } from './util';

/** Thresholds of the scan quality checks (exported for tests and tuning). */
export const QUALITY_THRESHOLDS = {
  /** Median outline edge width (10–90 %, px) above which the photo is blurry (sharp ≈ 1–2, Gaussian σ 1.5 ≈ 3–3.8, σ 2.5 ≈ 4.3–5.3). */
  blurEdgeWidth: 4.0,
  /** Content blur metric (0 sharp .. 1 blurry) on the pieces above which the photo is blurry. */
  blurMetric: 0.72,
  /** Widest per-direction edge width (px) that, with anisotropy, indicates motion blur (sharp photos ≤ 2.2). */
  motionEdgeWidth: 3.0,
  /** Ratio of the widest to the narrowest direction-binned edge width that indicates motion blur. */
  motionAnisotropy: 1.6,
  /** Mean piece luminance (0..1) below which the photo is too dark. */
  darkMean: 0.15,
  /** 95th percentile of piece luminance below which the photo is too dark. */
  darkP95: 0.33,
  /** Fraction of piece pixels of coloured print with a clipped channel above which the photo is too bright. */
  brightColoured: 0.05,
  /** Fraction of piece pixels blown out to white above which the photo is too bright regardless of the print. */
  brightBlownMassive: 0.15,
  /** Clipped (any channel ≥ 254) / blown (all ≥ 253) piece fractions reported as info (white print reaching the clip level). */
  brightClipped: 0.25,
  brightBlown: 0.04,
  /** Fraction of the whole photo blown out to white. */
  brightPhotoBlown: 0.3,
  /** Fraction of a piece covered by compact convex blown-out blobs (specular glare) that raises a region issue. */
  regionGlare: 0.03,
  /** Otsu separability of the (log) foreground score below which contrast is low. */
  lowSeparability: 0.7,
  /** Median outline foreground score (background sigmas) below which contrast is low. */
  lowOutlineContrast: 7.5,
  /** Share of the photo's inside showing further table colours above which the table counts as patterned. */
  patternedTable: 0.05,
  /** Share of the border band the table model explains, below which the table is too busy to model. */
  unexplainedTable: 0.7,
  /**
   * 95th / 5th percentile of the table luminance (linear light) above which lighting is uneven.
   * synth `illumination` 0.2 / 0.25 (±26–30 % sRGB at the corners, segmentation unaffected) measure
   * 1.9–2.9; 0.35 measures 3.1–4.7 and 0.5 measures 4.8–10.6.
   */
  unevenLighting: 3.5,
  /** Median body size (px) below which pieces are too small; below the second value it is an error. */
  lowResolution: 50,
  lowResolutionError: 28,
  /** Predicted body-size ratio across the pieces (planar fit) and fit quality that indicate perspective. */
  perspectiveRatio: 1.25,
  perspectiveR2: 0.6,
};

const T = QUALITY_THRESHOLDS;
/** A clipped pixel with another channel below this is coloured print (hue and texture lost). */
const COLOURED_BELOW = 190;
/** Minimum solidity (area / convex hull) of a blown blob to count as specular glare. */
const GLARE_SOLIDITY = 0.88;
/** Minimum size of a single glare blob as a fraction of the piece. */
const GLARE_MIN_BLOB = 0.02;

function issue(code: QualityCode, severity: Severity, message: string, hint?: string, regionIds?: number[]): QualityIssue {
  const out: QualityIssue = { code, severity, message };
  if (hint) out.hint = hint;
  if (regionIds && regionIds.length) out.regionIds = regionIds;
  return out;
}

/** Mask eroded by `r` px (square), treating everything outside the mask's frame as unset. */
function insetMask(m: Mask, r: number): Mask {
  const W = m.width + 2 * r, H = m.height + 2 * r;
  const padded = createMask(W, H);
  for (let y = 0; y < m.height; y++) padded.data.set(m.data.subarray(y * m.width, (y + 1) * m.width), (y + r) * W + r);
  const e = erode(padded, r);
  const out = createMask(m.width, m.height);
  for (let y = 0; y < m.height; y++) out.data.set(e.data.subarray((y + r) * W + r, (y + r) * W + r + m.width), y * m.width);
  return out;
}

/** The interior pixels of the given regions packed into a 1-row image. */
function packInterior(regions: SegmentedRegion[], inner: Map<number, Mask>): RGBAImage {
  let n = 0;
  for (const r of regions) {
    const m = inner.get(r.region.id);
    if (m) for (let i = 0; i < m.data.length; i++) n += m.data[i];
  }
  const out = createRGBA(Math.max(1, n), 1);
  let k = 0;
  for (const r of regions) {
    const m = inner.get(r.region.id);
    if (!m) continue;
    const d = r.image.data;
    for (let i = 0; i < m.data.length; i++) {
      if (!m.data[i]) continue;
      out.data[k] = d[i * 4];
      out.data[k + 1] = d[i * 4 + 1];
      out.data[k + 2] = d[i * 4 + 2];
      out.data[k + 3] = 255;
      k += 4;
    }
  }
  return out;
}

/** Fractions of pixels with any channel ≥ 254 (clipped) and with all channels ≥ 253 (blown white). */
function clipping(img: RGBAImage, step = 1): { clipped: number; blown: number } {
  const d = img.data;
  let n = 0, clipped = 0, blown = 0;
  for (let p = 0; p < d.length; p += 4 * step) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    n++;
    if (r >= 254 || g >= 254 || b >= 254) clipped++;
    if (r >= 253 && g >= 253 && b >= 253) blown++;
  }
  return n > 0 ? { clipped: clipped / n, blown: blown / n } : { clipped: 0, blown: 0 };
}

export interface EdgeWidthStats {
  /** Median 10–90 % edge width across the outlines (px). */
  median: number;
  /** Largest per-direction median width (px). */
  widest: number;
  /** Max / min of the per-direction median widths (1 = isotropic). */
  anisotropy: number;
  /** Direction (deg, outline normal, [0, 180)) of the widest edges. */
  widestDirection: number;
  samples: number;
}

/**
 * Edge width across region outlines: at points along each outline the colour difference to the
 * background model (ΔE) is sampled along the normal; width = 0.8 · rise / steepest slope
 * (≈ 2.5 σ for a Gaussian-blurred step, ≈ 1 px for a sharp anti-aliased edge). Widths are also
 * binned by outline direction: directional (motion) blur widens only some directions.
 */
export function outlineEdgeWidths(photo: RGBAImage, seg: Segmentation): EdgeWidthStats {
  const R = 12, STEP = 0.75;
  const ns = Math.round((2 * R) / STEP) + 1;
  const prof = new Float32Array(ns);
  const px = [0, 0, 0, 0];
  const widths: number[] = [];
  const dirs: number[] = [];
  const outerN = Math.floor(ns / 4), innerStart = Math.floor(ns / 2);
  const outer = new Float32Array(outerN), inner = new Float32Array(ns - innerStart);
  for (const sr of seg.regions) {
    const r = sr.region;
    if (r.kind === 'unknown' || r.contour.length < 8) continue;
    const c = r.contour;
    let perim = 0;
    for (let i = 0; i < c.length; i++) perim += Math.hypot(c[(i + 1) % c.length].x - c[i].x, c[(i + 1) % c.length].y - c[i].y);
    const spacing = Math.max(6, perim / 48);
    let acc = spacing / 2;
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const tx = (b.x - a.x) / len, ty = (b.y - a.y) / len;
      const nx = ty, ny = -tx; // outward normal of a clockwise outline
      while (acc < len) {
        const ox = a.x + tx * acc, oy = a.y + ty * acc;
        acc += spacing;
        if (len < 4) continue; // only straight-ish stretches
        const bg = backgroundAt(seg.background, ox, oy);
        let ok = true;
        for (let k = 0; k < ns; k++) {
          const s = R - k * STEP; // from outside (+R) to inside (−R)
          if (!sampleRGBA(photo, ox + nx * s, oy + ny * s, px)) { ok = false; break; }
          const lab = rgbToLab(px[0], px[1], px[2]);
          prof[k] = Math.hypot(lab[0] - bg[0], lab[1] - bg[1], lab[2] - bg[2]);
        }
        if (!ok) continue;
        // Outside level: median of the outer quarter; inside level: 75th percentile of the inner half.
        outer.set(prof.subarray(0, outerN));
        inner.set(prof.subarray(innerStart));
        const lo = median(outer), hi = quantile(inner, 0.75);
        const rise = hi - lo;
        if (rise < 8) continue;
        let slope = 0;
        for (let k = 1; k < ns; k++) {
          const d = (prof[k] - prof[k - 1]) / STEP;
          if (d > slope) slope = d;
        }
        if (slope <= 0) continue;
        widths.push(Math.min(2 * R, (0.8 * rise) / slope));
        let ang = (Math.atan2(ny, nx) * 180) / Math.PI;
        if (ang < 0) ang += 180;
        if (ang >= 180) ang -= 180;
        dirs.push(ang);
      }
      acc -= len;
    }
  }
  if (widths.length < 8) return { median: 0, widest: 0, anisotropy: 1, widestDirection: 0, samples: widths.length };
  const BINS = 6;
  const bins: number[][] = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < widths.length; i++) bins[Math.min(BINS - 1, Math.floor(dirs[i] / (180 / BINS)))].push(widths[i]);
  let lo = Infinity, hi = -Infinity, widestDirection = 0;
  bins.forEach((b, i) => {
    if (b.length < 4) return;
    const m = median(b);
    if (m < lo) lo = m;
    if (m > hi) { hi = m; widestDirection = (i + 0.5) * (180 / BINS); }
  });
  const ok = lo > 0 && Number.isFinite(hi);
  return { median: median(widths), widest: ok ? hi : median(widths), anisotropy: ok ? hi / lo : 1, widestDirection, samples: widths.length };
}

/** Clipping of one region's interior and how much of it destroys detail. */
export interface ClipAnalysis {
  /** Interior pixels. */
  pixels: number;
  /** Pixels with a clipped channel (≥ 254). */
  clipped: number;
  /** Clipped pixels of coloured print (another channel < 190): hue and texture are lost. */
  colouredClipped: number;
  /** Near-white pixels blown out in all channels (≥ 253). */
  blown: number;
  /** Pixels of compact, convex blown-out blobs (specular glare). */
  glare: number;
}

/**
 * Clipping analysis of a region (interior `inner`). Clipping of coloured print loses hue and
 * texture. Near-white blown areas are ambiguous (white paper or sky that crossed the clip level
 * loses nothing); only sizeable (≥ 2 % of the piece), compact, convex blown blobs — the image of a
 * lamp or window on a glossy surface — count as glare, while blown white print follows the print's
 * irregular shapes or forms many small dots.
 */
export function clipAnalysis(sr: SegmentedRegion, inner: Mask): ClipAnalysis {
  const { width: w, height: h, data: d } = sr.image;
  const out: ClipAnalysis = { pixels: 0, clipped: 0, colouredClipped: 0, blown: 0, glare: 0 };
  for (let i = 0; i < w * h; i++) {
    if (!inner.data[i]) continue;
    out.pixels++;
    const p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2];
    if (r < 254 && g < 254 && b < 254) continue;
    out.clipped++;
    if (Math.min(r, g, b) < COLOURED_BELOW) out.colouredClipped++;
    else if (r >= 253 && g >= 253 && b >= 253) out.blown++;
  }
  if (out.blown < 12) return out;
  // Glare: sizeable, compact (mostly survives an opening scaled to the piece) and convex blown
  // components; solidity is judged on the whole component, not on pieces an opening may cut off.
  const gm = glareMask(sr.image, { minValue: 0.98, maxSaturation: 0.025 });
  for (let i = 0; i < gm.data.length; i++) gm.data[i] &= inner.data[i];
  const opened = open(gm, Math.max(1, Math.round(0.05 * Math.sqrt(out.pixels))));
  const { labels } = labelComponents(gm, 8);
  for (const { contour, stats } of findOuterContours(gm, Math.max(12, GLARE_MIN_BLOB * out.pixels))) {
    let core = 0;
    for (let y = stats.bbox.y; y < stats.bbox.y + stats.bbox.height; y++) {
      for (let x = stats.bbox.x; x < stats.bbox.x + stats.bbox.width; x++) {
        const k = y * w + x;
        if (labels[k] === stats.label && opened.data[k]) core++;
      }
    }
    const hull = convexHull(contour);
    // Traced pixel-centre outlines lose ≈ half a pixel all around: compare with the hull grown by that.
    const solidity = Math.min(1, stats.area / (polygonArea(hull) + 0.5 * polygonPerimeter(hull) + 1));
    if (solidity >= GLARE_SOLIDITY && core >= 0.5 * stats.area) out.glare += stats.area;
  }
  return out;
}

/** Per-region photo issues (glare on the piece); appends to `region.issues`. Called by `segmentPieces`. */
export function assessRegions(seg: Segmentation): void {
  for (const sr of seg.regions) {
    const r = sr.region;
    if (r.kind === 'unknown') continue;
    const a = clipAnalysis(sr, insetMask(sr.mask, 2));
    if (a.pixels > 0 && a.glare > T.regionGlare * a.pixels && a.glare >= 12) {
      r.issues.push({ code: 'glare', severity: 'warning', message: 'Glare on this piece.', hint: 'Avoid direct light or reflections on the pieces.', regionIds: [r.id], area: r.bbox });
    }
  }
}

/** Least-squares plane s = a + b·u + c·v over the items; predicted size ratio across them and R². */
function perspectiveTrend(items: { x: number; y: number; s: number }[], w: number, h: number): { ratio: number; r2: number } {
  const n = items.length;
  if (n < 6) return { ratio: 1, r2: 0 };
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  let mean = 0;
  for (const it of items) mean += it.s;
  mean /= n;
  const feat = (it: { x: number; y: number }) => [1, it.x / w - 0.5, it.y / h - 0.5];
  for (const it of items) {
    const f = feat(it);
    for (let i = 0; i < 3; i++) {
      b[i] += f[i] * it.s;
      for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j];
    }
  }
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return { ratio: 1, r2: 0 };
  const coef = [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
  let ssTot = 0, ssRes = 0, lo = Infinity, hi = -Infinity;
  for (const it of items) {
    const f = feat(it);
    const p = coef[0] + coef[1] * f[1] + coef[2] * f[2];
    ssRes += (it.s - p) ** 2;
    ssTot += (it.s - mean) ** 2;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  return { ratio: lo > 0 ? hi / lo : 1, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

const HINT = {
  dark: 'Add light or move to a brighter spot.',
  bright: 'Avoid direct light on the table; tap a piece to set the exposure.',
  blur: 'Tap the pieces to focus and hold the phone still.',
  motion: 'Hold the phone still (rest your elbows) or add light.',
  contrast: 'Use a plain background that contrasts with the pieces.',
  pattern: 'Lay the pieces on a plain, single-coloured surface (a sheet of paper, a plain cloth).',
  lighting: 'Light the table evenly and avoid casting shadows.',
  resolution: 'Move closer so the pieces fill more of the photo.',
  perspective: 'Hold the phone parallel to the table, directly above the pieces.',
  none: 'Spread the pieces on a plain background that contrasts with them.',
};

/**
 * Whole-scan quality: blur / motion blur, exposure, contrast with the background, lighting,
 * resolution and perspective, plus the per-region issues (cut off, touching, fragments, uncertain
 * shapes, glare) aggregated into one issue per code. Does not modify `seg`.
 */
export function assessPhoto(photo: RGBAImage, seg: Segmentation): QualityReport {
  const { width: w, height: h } = photo;
  const issues: QualityIssue[] = [];
  const metrics: Record<string, number> = {};
  const useful = seg.regions.filter((r) => r.region.kind !== 'unknown');
  metrics.regions = seg.regions.length;
  metrics.pieces = seg.regions.filter((r) => r.region.kind === 'piece').length;
  metrics.patches = seg.regions.filter((r) => r.region.kind === 'patch').length;
  const photoClip = clipping(photo, 7);
  metrics.photoBlown = photoClip.blown;

  if (useful.length === 0) {
    const ex = exposureStats(photo);
    metrics.brightness = ex.mean;
    issues.push(issue('no_pieces', 'error', 'No pieces found.', HINT.none));
    if (ex.mean < T.darkMean || ex.p95 < T.darkP95) issues.push(issue('too_dark', 'warning', 'The photo is too dark.', HINT.dark));
    else if (photoClip.blown > T.brightPhotoBlown) issues.push(issue('too_bright', 'warning', 'The photo is overexposed.', HINT.bright));
    issues.push(...aggregateRegionIssues(seg.regions));
    return { score: scoreOf(issues), issues, metrics };
  }

  // Exposure on the piece interiors (inset 2 px).
  const inner = new Map<number, Mask>();
  for (const r of useful) inner.set(r.region.id, insetMask(r.mask, 2));
  const packed = packInterior(useful, inner);
  const ex = exposureStats(packed);
  const clip = clipping(packed);
  let pixels = 0, coloured = 0;
  for (const r of useful) {
    const a = clipAnalysis(r, inner.get(r.region.id)!);
    pixels += a.pixels;
    coloured += a.colouredClipped;
  }
  const colouredFrac = pixels > 0 ? coloured / pixels : 0;
  metrics.brightness = ex.mean;
  metrics.p95 = ex.p95;
  metrics.clipped = clip.clipped;
  metrics.blown = clip.blown;
  metrics.colouredClipped = colouredFrac;
  if (ex.mean < T.darkMean || ex.p95 < T.darkP95) {
    issues.push(issue('too_dark', ex.mean < 0.07 ? 'error' : 'warning', 'The photo is too dark.', HINT.dark));
  } else if (colouredFrac > T.brightColoured || clip.blown > T.brightBlownMassive || photoClip.blown > T.brightPhotoBlown) {
    // Coloured print clipped, or large areas blown out: detail is lost.
    const severe = colouredFrac > 0.25 || clip.blown > 0.4;
    issues.push(issue('too_bright', severe ? 'error' : 'warning', 'The photo is overexposed.', HINT.bright));
  } else if (clip.clipped > T.brightClipped || clip.blown > T.brightBlown) {
    // Only white / cream print (paper, sky) reaches the clip level: little detail is lost.
    issues.push(issue('too_bright', 'info', 'White areas of the print are clipped.', HINT.bright));
  }

  // Sharpness: edge width across the outlines (+ content blur on the pieces).
  const body = seg.medianBodySize ?? Math.sqrt(median(useful.map((r) => r.region.area)));
  metrics.medianBodySize = body;
  const blurRegions = useful.filter((r) => !r.region.touchesBorder).sort((a, b) => b.region.area - a.region.area).slice(0, 12);
  metrics.blur = median(blurRegions.map((r) => blurMetric(rgbaToGray(r.image), inner.get(r.region.id), Math.max(3, Math.round(body / 25)))));
  const ew = outlineEdgeWidths(photo, seg);
  metrics.edgeWidth = ew.median;
  metrics.edgeWidthWidest = ew.widest;
  metrics.edgeAnisotropy = ew.anisotropy;
  if (ew.samples >= 8) {
    if (ew.anisotropy > T.motionAnisotropy && ew.widest > T.motionEdgeWidth) {
      issues.push(issue('motion_blur', 'warning', 'The photo is blurred by movement.', HINT.motion));
    } else if (ew.median > T.blurEdgeWidth || (metrics.blur > T.blurMetric && ew.median > 0.75 * T.blurEdgeWidth)) {
      issues.push(issue('blurry', ew.median > 2 * T.blurEdgeWidth ? 'error' : 'warning', 'The photo is out of focus.', HINT.blur));
    }
  }

  // Contrast with the background.
  const bgm = seg.background;
  metrics.separability = bgm.separability;
  metrics.outlineContrast = bgm.outlineContrast;
  // Global: weak outlines overall (separability alone is too content-dependent). Region-level
  // low_contrast issues (unreliable, low-contrast regions) are merged into the same issue below.
  // A patterned table (its further colours spread over the inside of the photo) hides pieces in
  // those colours; the floor beyond a table edge does not matter.
  const pattern = bgm.palette.reduce((a, p) => a + p.interior, 0);
  metrics.tablePattern = pattern;
  metrics.tableFit = bgm.bandFit;
  if (pattern > T.patternedTable || bgm.bandFit < T.unexplainedTable) {
    issues.push(issue('low_contrast', 'warning', 'The table is patterned; pieces in its colours may be missed.', HINT.pattern));
  } else if (bgm.outlineContrast < T.lowOutlineContrast || (bgm.separability < T.lowSeparability && bgm.outlineContrast < 10)) {
    issues.push(issue('low_contrast', 'warning', 'The pieces are hard to tell from the background.', HINT.contrast));
  }

  // Lighting gradient across the background.
  const lr = bgm.lightingRatio;
  metrics.lightingRatio = lr;
  if (lr > T.unevenLighting) issues.push(issue('uneven_lighting', 'warning', 'The lighting is uneven.', HINT.lighting));

  // Resolution.
  if (body < T.lowResolution) {
    issues.push(issue('low_resolution', body < T.lowResolutionError ? 'error' : 'warning', 'The pieces are small in the photo.', HINT.resolution));
  }

  // Perspective: systematic size trend across the photo.
  const sized = seg.regions.filter((r) => r.region.shape && r.region.shape.confidence >= 0.5);
  const trend = perspectiveTrend(sized.map((r) => ({ x: r.region.shape!.center.x, y: r.region.shape!.center.y, s: r.region.shape!.bodySize })), w, h);
  metrics.perspectiveRatio = trend.ratio;
  metrics.perspectiveR2 = trend.r2;
  if (trend.ratio > T.perspectiveRatio && trend.r2 > T.perspectiveR2) {
    issues.push(issue('perspective', 'warning', 'The photo is taken at an angle.', HINT.perspective));
  }

  const all = mergeIssues(issues, aggregateRegionIssues(seg.regions));
  return { score: scoreOf(all), issues: all, metrics };
}

/** Append region issues; a region issue whose code is already present adds its region ids there. */
function mergeIssues(global: QualityIssue[], regional: QualityIssue[]): QualityIssue[] {
  const out = [...global];
  for (const r of regional) {
    const g = out.find((i) => i.code === r.code);
    if (!g) { out.push(r); continue; }
    g.regionIds = [...new Set([...(g.regionIds ?? []), ...(r.regionIds ?? [])])].sort((a, b) => a - b);
  }
  return out;
}

const AGGREGATE_TEXT: Partial<Record<QualityCode, [string, string, string]>> = {
  cut_off: ['A piece is cut off by the photo edge.', 'pieces are cut off by the photo edge.', 'Keep all pieces fully inside the frame.'],
  touching_pieces: ['Some pieces touch each other.', 'regions contain touching pieces.', 'Leave a small gap between loose pieces.'],
  fragment: ['A small fragment was ignored.', 'small fragments were ignored.', 'Remove crumbs and dust from the table.'],
  shape_uncertain: ['A piece outline is unclear.', 'piece outlines are unclear.', 'Use a plain background and spread the pieces out.'],
  glare: ['Glare on a piece.', 'pieces have glare.', 'Avoid direct light or reflections on the pieces.'],
  low_contrast: ['A piece is hard to tell from the background; its outline may be wrong.', 'pieces are hard to tell from the background; their outlines may be wrong.', 'Use a plain background that contrasts with the pieces.'],
};

/**
 * Withdraw region-level issues of the given codes for `regionIds` (e.g. 'low_contrast' for regions
 * that were placed confidently, so their outline evidently was good enough) and update the photo
 * report accordingly. Photo-wide issues of those codes are kept.
 */
export function resolveRegionIssues(seg: Segmentation, regionIds: ReadonlySet<number>, codes: readonly QualityCode[]): void {
  let changed = false;
  for (const sr of seg.regions) {
    const r = sr.region;
    const keep = r.issues.filter((i) => !(codes.includes(i.code) && regionIds.has(r.id)));
    if (keep.length !== r.issues.length) {
      r.issues = keep;
      changed = true;
    }
  }
  if (!changed) return;
  const regional = aggregateRegionIssues(seg.regions);
  const issues: QualityIssue[] = [];
  for (const is of seg.quality.issues) {
    if (!codes.includes(is.code) || !is.regionIds) {
      issues.push(is);
      continue;
    }
    const text = AGGREGATE_TEXT[is.code];
    const regionalOnly = !!text && (is.message === text[0] || is.message.endsWith(text[1]));
    const agg = regional.find((r) => r.code === is.code);
    if (regionalOnly) {
      if (agg) issues.push(agg);
    } else {
      issues.push({ ...is, regionIds: is.regionIds.filter((id) => !regionIds.has(id)) });
    }
  }
  seg.quality.issues = issues;
  seg.quality.score = scoreOf(issues);
}

function aggregateRegionIssues(regions: SegmentedRegion[]): QualityIssue[] {
  const by = new Map<QualityCode, { ids: Set<number>; severity: Severity }>();
  const rank: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
  for (const sr of regions) {
    for (const is of sr.region.issues) {
      const e = by.get(is.code) ?? { ids: new Set<number>(), severity: is.severity };
      for (const id of is.regionIds ?? [sr.region.id]) e.ids.add(id);
      if (rank[is.severity] > rank[e.severity]) e.severity = is.severity;
      by.set(is.code, e);
    }
  }
  const out: QualityIssue[] = [];
  for (const [code, e] of by) {
    const ids = [...e.ids].sort((a, b) => a - b);
    const text = AGGREGATE_TEXT[code];
    const msg = text ? (ids.length === 1 ? text[0] : `${ids.length} ${text[1]}`) : code;
    out.push(issue(code, e.severity, msg, text?.[2], ids));
  }
  return out;
}

function scoreOf(issues: QualityIssue[]): number {
  let s = 1;
  for (const i of issues) s *= i.severity === 'error' ? 0.4 : i.severity === 'warning' ? 0.8 : 0.96;
  return Math.max(0, Math.min(1, s));
}

/**
 * Fast live-camera feedback on a small (~320 px) frame: sharpness (content-normalised blur metric),
 * brightness, clipping and a short message when the frame is not good enough. ≈ 5 ms for 320×240.
 */
export function assessFrame(frame: RGBAImage): FrameQuality {
  const gray = rgbaToGray(frame);
  const radius = Math.max(2, Math.round(Math.max(frame.width, frame.height) / 120));
  const bm = blurMetric(gray, undefined, radius);
  // Sharp frames measure ≈ 0.25–0.35, Gaussian blur σ = 1 px ≈ 0.5–0.6, σ = 1.5 px ≈ 0.62–0.72.
  const sharpness = Math.max(0, Math.min(1, (0.8 - bm) / 0.45));
  const ex = exposureStats(frame);
  const high = clipping(frame).clipped;
  const clipped = Math.min(1, ex.clippedLow + high);
  let message: string | undefined;
  if (ex.mean < 0.12 || ex.p95 < 0.25) message = 'Too dark – add light';
  else if (high > 0.1 || ex.mean > 0.9) message = 'Too bright – avoid direct light';
  else if (sharpness < 0.45) message = 'Blurry – hold still and tap to focus';
  return { sharpness, brightness: ex.mean, clipped, ok: message === undefined, ...(message ? { message } : {}) };
}
