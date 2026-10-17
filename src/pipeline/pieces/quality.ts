/**
 * Photo quality of a scan (whole photo + per region) and of live camera frames.
 *
 * Measurements come from `pipeline/quality/metrics.ts` (blur, exposure, glare) plus outline-based
 * measures computed here: edge width across the piece outlines (overall and per direction, to tell
 * defocus from motion blur), background separability / outline contrast, the lighting ratio of the
 * background model and the spatial trend of piece sizes (perspective).
 */
import { rgbaToGray, rgbToLab } from '../../cv/color';
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
  /** Fraction of piece pixels with a clipped channel (≥ 254) above which the photo is too bright (white-heavy prints reach ≈ 0.2). */
  brightClipped: 0.25,
  /** Fraction of piece pixels blown out to white (all channels ≥ 253). */
  brightBlown: 0.04,
  /** Fraction of the whole photo blown out to white. */
  brightPhotoBlown: 0.3,
  /** Fraction of a piece covered by a compact glare blob that raises a region issue. */
  regionGlare: 0.012,
  /** Otsu separability of the (log) foreground score below which contrast is low. */
  lowSeparability: 0.7,
  /** Median outline foreground score (background sigmas) below which contrast is low. */
  lowOutlineContrast: 7.5,
  /** Ratio of the brightest to the darkest modelled background luminance that is uneven lighting (±10 % sRGB gain ≈ 1.8). */
  unevenLighting: 2.6,
  /** Median body size (px) below which pieces are too small; below the second value it is an error. */
  lowResolution: 50,
  lowResolutionError: 28,
  /** Predicted body-size ratio across the pieces (planar fit) and fit quality that indicate perspective. */
  perspectiveRatio: 1.25,
  perspectiveR2: 0.6,
};

const T = QUALITY_THRESHOLDS;

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

/**
 * Fraction of a region's interior covered by compact glare blobs: blown-out white pixels (specular
 * highlights clip all channels) surviving a 3×3 opening, so isolated bright pixels and merely
 * bright (cream, yellow) print do not count.
 */
function regionGlare(sr: SegmentedRegion, inner: Mask): number {
  const d = sr.image.data;
  let n = 0, bright = 0;
  for (let i = 0; i < inner.data.length; i++) {
    if (!inner.data[i]) continue;
    n++;
    if (d[i * 4] >= 245 && d[i * 4 + 1] >= 245 && d[i * 4 + 2] >= 245) bright++;
  }
  if (n === 0 || bright < Math.max(12, 0.5 * T.regionGlare * n)) return 0;
  const g = glareMask(sr.image, { minValue: 0.98, maxSaturation: 0.025 });
  for (let i = 0; i < g.data.length; i++) g.data[i] &= inner.data[i];
  // Opening scaled to the piece size: thin white print structures vanish, glare spots survive.
  const blobs = open(g, Math.max(1, Math.round(0.05 * Math.sqrt(n))));
  let hit = 0;
  for (let i = 0; i < blobs.data.length; i++) hit += blobs.data[i];
  return hit / n;
}

/** Per-region photo issues (glare on the piece); appends to `region.issues`. Called by `segmentPieces`. */
export function assessRegions(seg: Segmentation): void {
  for (const sr of seg.regions) {
    const r = sr.region;
    if (r.kind === 'unknown') continue;
    const frac = regionGlare(sr, insetMask(sr.mask, 2));
    if (frac > T.regionGlare) {
      r.issues.push({ code: 'glare', severity: 'warning', message: 'Glare or blown-out highlight on this piece.', hint: 'Avoid direct light or reflections on the pieces.', regionIds: [r.id], area: r.bbox });
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
  metrics.brightness = ex.mean;
  metrics.p95 = ex.p95;
  metrics.clipped = clip.clipped;
  metrics.blown = clip.blown;
  if (ex.mean < T.darkMean || ex.p95 < T.darkP95) {
    issues.push(issue('too_dark', ex.mean < 0.07 ? 'error' : 'warning', 'The photo is too dark.', HINT.dark));
  } else if (clip.clipped > T.brightClipped || clip.blown > T.brightBlown || photoClip.blown > T.brightPhotoBlown) {
    issues.push(issue('too_bright', clip.clipped > 0.5 ? 'error' : 'warning', 'The photo is overexposed.', HINT.bright));
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
  if (bgm.separability < T.lowSeparability || bgm.outlineContrast < T.lowOutlineContrast) {
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

  issues.push(...aggregateRegionIssues(seg.regions));
  return { score: scoreOf(issues), issues, metrics };
}

const AGGREGATE_TEXT: Partial<Record<QualityCode, [string, string, string]>> = {
  cut_off: ['A piece is cut off by the photo edge.', 'pieces are cut off by the photo edge.', 'Keep all pieces fully inside the frame.'],
  touching_pieces: ['Some pieces touch each other.', 'regions contain touching pieces.', 'Leave a small gap between loose pieces.'],
  fragment: ['A small fragment was ignored.', 'small fragments were ignored.', 'Remove crumbs and dust from the table.'],
  shape_uncertain: ['A piece outline is unclear.', 'piece outlines are unclear.', 'Use a plain background and spread the pieces out.'],
  glare: ['Glare or blown-out highlights on a piece.', 'pieces have glare or blown-out highlights.', 'Avoid direct light or reflections on the pieces.'],
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
