/**
 * Photo quality of a scan (whole photo + per region) and of live camera frames.
 *
 * Measurements come from `pipeline/quality/metrics.ts` (blur, exposure, glare) plus outline-based
 * measures computed here: edge width across the piece outlines (overall and per direction, to tell
 * defocus from motion blur), background separability / outline contrast, lighting range of the
 * background model and the spatial trend of piece sizes (perspective).
 */
import { rgbaToGray, rgbToLab } from '../../cv/color';
import { createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { erode } from '../../cv/morphology';
import { sampleRGBA } from '../../cv/warp';
import type { FrameQuality, QualityCode, QualityIssue, QualityReport, Severity } from '../../model/types';
import { blurMetric, exposureStats, glareMask } from '../quality/metrics';
import { backgroundAt } from './background';
import type { Segmentation, SegmentedRegion } from './types';
import { median, quantile } from './util';

/** Thresholds of the scan quality checks (exported for tests and tuning). */
export const QUALITY_THRESHOLDS = {
  /** Median outline edge width (10–90 %, px) above which the photo is blurry. */
  blurEdgeWidth: 3.6,
  /** Ratio of the widest to the narrowest direction-binned edge width that indicates motion blur. */
  motionAnisotropy: 1.7,
  /** Mean piece luminance (0..1) below which the photo is too dark. */
  darkMean: 0.16,
  /** Fraction of piece pixels with blown highlights above which the photo is too bright. */
  brightClipped: 0.06,
  /** Mean piece luminance above which the photo is too bright. */
  brightMean: 0.86,
  /** Fraction of a piece covered by glare that raises a region issue. */
  regionGlare: 0.015,
  /** Otsu separability of the (log) foreground score below which contrast is low. */
  lowSeparability: 0.72,
  /** Median outline foreground score (background sigmas) below which contrast is low. */
  lowOutlineContrast: 9,
  /** Lightness range (L*) of the background model above which lighting is uneven. */
  unevenLighting: 22,
  /** Median body size (px) below which pieces are too small; below the second value it is an error. */
  lowResolution: 50,
  lowResolutionError: 28,
  /** Predicted body-size ratio across the photo (from a planar fit) that indicates perspective. */
  perspectiveRatio: 1.18,
};

const T = QUALITY_THRESHOLDS;
/** Minimum HSV value of glare pixels (specular highlights are (nearly) clipped). */
const GLARE_VALUE = 0.975;

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

/** The interior pixels (inset 2 px) of the given regions packed into a 1-row image. */
function packInterior(regions: SegmentedRegion[], inner: Map<number, Mask>): RGBAImage {
  let n = 0;
  for (const r of regions) {
    const m = inner.get(r.region.id)!;
    for (let i = 0; i < m.data.length; i++) n += m.data[i];
  }
  const out = createRGBA(Math.max(1, n), 1);
  let k = 0;
  for (const r of regions) {
    const m = inner.get(r.region.id)!;
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

export interface EdgeWidthStats {
  /** Median 10–90 % edge width across the outlines (px). */
  median: number;
  /** Max / min of the per-direction median widths (1 = isotropic). */
  anisotropy: number;
  /** Direction (deg, outline normal, [0, 180)) of the widest edges. */
  widestDirection: number;
  samples: number;
}

/**
 * Edge width across region outlines: at points along each outline the colour difference to the
 * background model (ΔE) is sampled along the outward normal; width = rise / steepest slope
 * (≈ 2.5 σ for a Gaussian-blurred step, ≈ 1 px for a sharp anti-aliased edge).
 */
export function outlineEdgeWidths(photo: RGBAImage, seg: Segmentation): EdgeWidthStats {
  const R = 7, STEP = 0.5;
  const ns = Math.round((2 * R) / STEP) + 1;
  const prof = new Float32Array(ns);
  const px = [0, 0, 0, 0];
  const widths: number[] = [];
  const dirs: number[] = [];
  for (const sr of seg.regions) {
    const r = sr.region;
    if (r.kind === 'unknown' || r.contour.length < 8) continue;
    const c = r.contour;
    // Walk the polygon at a fixed arc spacing.
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
        // Only straight-ish stretches: segment long enough around the sample.
        if (len < 4) continue;
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
        const outer = Array.from(prof.subarray(0, Math.floor(ns / 4)));
        const inner = Array.from(prof.subarray(Math.floor(ns / 2)));
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
  if (widths.length < 8) return { median: 0, anisotropy: 1, widestDirection: 0, samples: widths.length };
  const BINS = 6;
  const bins: number[][] = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < widths.length; i++) bins[Math.min(BINS - 1, Math.floor(dirs[i] / (180 / BINS)))].push(widths[i]);
  let lo = Infinity, hi = -Infinity, widest = 0;
  bins.forEach((b, i) => {
    if (b.length < 4) return;
    const m = median(b);
    if (m < lo) lo = m;
    if (m > hi) { hi = m; widest = (i + 0.5) * (180 / BINS); }
  });
  return { median: median(widths), anisotropy: lo > 0 && Number.isFinite(hi) ? hi / lo : 1, widestDirection: widest, samples: widths.length };
}

/**
 * Per-region photo issues (glare on the piece). Appends to `region.issues`; called by
 * `segmentPieces`. Returns the glare fraction per region id.
 */
export function assessRegions(seg: Segmentation): Map<number, number> {
  const out = new Map<number, number>();
  for (const sr of seg.regions) {
    const r = sr.region;
    if (r.kind === 'unknown') continue;
    const inner = insetMask(sr.mask, 2);
    const packed = packInterior([sr], new Map([[r.id, inner]]));
    const n = packed.width;
    const g = glareMask(packed, { minValue: GLARE_VALUE, maxSaturation: 0.1 });
    let hit = 0;
    for (let i = 0; i < n; i++) hit += g.data[i];
    const frac = n > 0 ? hit / n : 0;
    out.set(r.id, frac);
    if (frac > T.regionGlare && hit >= 12) {
      r.issues.push({ code: 'glare', severity: 'warning', message: 'Glare on this piece.', hint: 'Avoid direct light or reflections on the pieces.', regionIds: [r.id], area: r.bbox });
    }
  }
  return out;
}

/** Least-squares plane s = a + b·u + c·v; returns predicted ratio across the photo and R². */
function perspectiveTrend(items: { x: number; y: number; s: number }[], w: number, h: number): { ratio: number; r2: number } {
  const n = items.length;
  if (n < 6) return { ratio: 1, r2: 0 };
  // Normal equations for [1, u, v].
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  let mean = 0;
  for (const it of items) mean += it.s;
  mean /= n;
  for (const it of items) {
    const f = [1, it.x / w - 0.5, it.y / h - 0.5];
    for (let i = 0; i < 3; i++) {
      b[i] += f[i] * it.s;
      for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j];
    }
  }
  // Solve 3×3 by Cramer's rule.
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return { ratio: 1, r2: 0 };
  const coef = [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
  let ssTot = 0, ssRes = 0;
  for (const it of items) {
    const p = coef[0] + coef[1] * (it.x / w - 0.5) + coef[2] * (it.y / h - 0.5);
    ssRes += (it.s - p) ** 2;
    ssTot += (it.s - mean) ** 2;
  }
  // Predicted sizes at the extreme positions actually covered by pieces.
  let lo = Infinity, hi = -Infinity;
  for (const it of items) {
    const p = coef[0] + coef[1] * (it.x / w - 0.5) + coef[2] * (it.y / h - 0.5);
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  return { ratio: lo > 0 ? hi / lo : 1, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

/**
 * Whole-scan quality: blur / motion blur, exposure, glare, contrast with the background, lighting,
 * resolution, perspective, plus the per-region issues (cut off, touching, fragments, uncertain
 * shapes, glare) aggregated into one issue per code.
 */
export function assessPhoto(photo: RGBAImage, seg: Segmentation): QualityReport {
  const { width: w, height: h } = photo;
  const issues: QualityIssue[] = [];

  const metrics: Record<string, number> = {};
  const useful = seg.regions.filter((r) => r.region.kind !== 'unknown');
  metrics.regions = seg.regions.length;
  metrics.pieces = seg.regions.filter((r) => r.region.kind === 'piece').length;
  metrics.patches = seg.regions.filter((r) => r.region.kind === 'patch').length;

  if (useful.length === 0) {
    const ex = exposureStats(photo);
    metrics.brightness = ex.mean;
    issues.push(issue('no_pieces', 'error', 'No pieces found.', 'Spread the pieces on a plain background that contrasts with them.'));
    if (ex.mean < T.darkMean) issues.push(issue('too_dark', 'warning', 'The photo is too dark.', 'Add light or move to a brighter spot.'));
    if (ex.clippedHigh > 0.25) issues.push(issue('too_bright', 'warning', 'The photo is overexposed.', 'Reduce direct light or tap a piece to set exposure.'));
    return { score: scoreOf(issues), issues, metrics };
  }

  // Exposure on the pieces (interiors, inset 2 px).
  const inner = new Map<number, Mask>();
  for (const r of useful) inner.set(r.region.id, insetMask(r.mask, 2));
  const ex = exposureStats(packInterior(useful, inner));
  metrics.brightness = ex.mean;
  metrics.clippedHigh = ex.clippedHigh;
  metrics.clippedLow = ex.clippedLow;
  if (ex.mean < T.darkMean || ex.p95 < 0.3) {
    issues.push(issue('too_dark', ex.mean < 0.08 ? 'error' : 'warning', 'The photo is too dark.', 'Add light or move to a brighter spot.'));
  } else if (ex.clippedHigh > T.brightClipped || ex.mean > T.brightMean) {
    issues.push(issue('too_bright', ex.clippedHigh > 0.25 ? 'error' : 'warning', 'The photo is overexposed.', 'Reduce direct light or tap a piece to set exposure.'));
  }

  // Sharpness: content blur on the pieces and edge width across the outlines.
  const body = seg.medianBodySize ?? Math.sqrt(median(useful.map((r) => r.region.area)));
  metrics.medianBodySize = body;
  const blurRegions = useful.filter((r) => !r.region.touchesBorder).sort((a, b) => b.region.area - a.region.area).slice(0, 12);
  metrics.blur = median(blurRegions.map((r) => blurMetric(rgbaToGray(r.image), inner.get(r.region.id), Math.max(3, Math.round(body / 25)))));
  const ew = outlineEdgeWidths(photo, seg);
  metrics.edgeWidth = ew.median;
  metrics.edgeAnisotropy = ew.anisotropy;
  if (ew.samples >= 8) {
    if (ew.anisotropy > T.motionAnisotropy && ew.median > 0.75 * T.blurEdgeWidth) {
      issues.push(issue('motion_blur', 'warning', 'The photo is blurred by motion.', 'Hold the phone still (rest your elbows) or add light.'));
    } else if (ew.median > T.blurEdgeWidth) {
      issues.push(issue('blurry', ew.median > 2 * T.blurEdgeWidth ? 'error' : 'warning', 'The photo is out of focus.', 'Tap the pieces to focus and hold still.'));
    }
  }

  // Contrast with the background.
  const bgm = seg.background;
  metrics.separability = bgm.separability;
  metrics.outlineContrast = bgm.outlineContrast;
  if (bgm.separability < T.lowSeparability || bgm.outlineContrast < T.lowOutlineContrast) {
    issues.push(issue('low_contrast', 'warning', 'Pieces are hard to tell from the background.', 'Use a plain background that contrasts with the pieces.'));
  }

  // Lighting gradient across the background.
  metrics.lightingRange = bgm.lightnessRange;
  if (bgm.lightnessRange > T.unevenLighting) {
    issues.push(issue('uneven_lighting', 'warning', 'The lighting is uneven.', 'Light the table evenly and avoid casting shadows.'));
  }

  // Resolution.
  if (seg.medianBodySize !== undefined || useful.length > 0) {
    if (body < T.lowResolution) {
      issues.push(issue('low_resolution', body < T.lowResolutionError ? 'error' : 'warning', 'The pieces are small in the photo.', 'Move closer so the pieces fill more of the photo.'));
    }
  }

  // Perspective: systematic size trend across the photo.
  const sized = seg.regions.filter((r) => r.region.shape && r.region.shape.confidence >= 0.5);
  const trend = perspectiveTrend(sized.map((r) => ({ x: r.region.shape!.center.x, y: r.region.shape!.center.y, s: r.region.shape!.bodySize })), w, h);
  metrics.perspectiveRatio = trend.ratio;
  metrics.perspectiveR2 = trend.r2;
  if (trend.ratio > T.perspectiveRatio && trend.r2 > 0.5) {
    issues.push(issue('perspective', 'warning', 'The photo is taken at an angle.', 'Hold the phone parallel to the table, directly above the pieces.'));
  }

  // Aggregate region issues.
  issues.push(...aggregateRegionIssues(seg.regions));
  return { score: scoreOf(issues), issues, metrics };
}

const AGGREGATE_TEXT: Partial<Record<QualityCode, [string, string, string]>> = {
  cut_off: ['A piece is cut off by the photo edge.', 'pieces are cut off by the photo edge.', 'Keep all pieces fully inside the frame.'],
  touching_pieces: ['Some pieces touch each other.', 'regions contain touching pieces.', 'Leave a small gap between loose pieces.'],
  fragment: ['A small fragment was ignored.', 'small fragments were ignored.', 'Remove crumbs and dust from the table.'],
  shape_uncertain: ['A piece outline is unclear.', 'piece outlines are unclear.', 'Use a plain background and spread the pieces out.'],
  glare: ['Glare on a piece.', 'pieces have glare.', 'Avoid direct light or reflections on the pieces.'],
  blurry: ['A piece is out of focus.', 'pieces are out of focus.', 'Tap the pieces to focus.'],
};

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
 * Fast live-camera feedback on a small (~320 px) frame: sharpness, brightness, clipping and a
 * short message when the frame is not good enough. Runs in a few milliseconds.
 */
export function assessFrame(frame: RGBAImage): FrameQuality {
  const gray = rgbaToGray(frame);
  const radius = Math.max(2, Math.round(Math.max(frame.width, frame.height) / 120));
  const bm = blurMetric(gray, undefined, radius);
  const sharpness = Math.max(0, Math.min(1, (0.8 - bm) / 0.45));
  const ex = exposureStats(frame);
  const clipped = ex.clippedLow + ex.clippedHigh;
  let message: string | undefined;
  if (ex.mean < 0.12 || ex.p95 < 0.25) message = 'Too dark – add light';
  else if (ex.clippedHigh > 0.12 || ex.mean > 0.88) message = 'Too bright – avoid direct light';
  else if (sharpness < 0.4) message = 'Blurry – hold still and tap to focus';
  return { sharpness, brightness: ex.mean, clipped, ok: message === undefined, ...(message ? { message } : {}) };
}
