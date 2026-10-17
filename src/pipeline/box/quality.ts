/**
 * Quality checks for the box photo (picture region found by detectBox) and for the rectified
 * reference image. Measurements come from the shared metrics in `pipeline/quality/metrics`; this
 * module only decides thresholds, messages and hints.
 */
import { rgbaToGray, saturationValue } from '../../cv/color';
import { applyMat3, type Quad } from '../../cv/geometry';
import { cropRGBA, createMask, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { componentMask, labelComponents } from '../../cv/components';
import { traceOuterContour } from '../../cv/contour';
import { distanceTransform } from '../../cv/distance';
import { open } from '../../cv/morphology';
import { convexHull, polygonArea } from '../../cv/polygon';
import { fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import type { GridSpec, QualityIssue, QualityReport } from '../../model/types';
import { blurMetric, exposureStats, glareMask } from '../quality/metrics';
import { toPhoto, toWork, type WorkImage } from './field';
import { quadAngles, quadSides, suggestRectifiedSize, unitSquareToQuad } from './geometry';

/** Thresholds (exported for tests and tuning). */
export const BOX_QUALITY = {
  /** Below this detection confidence the user is asked to place the corners. */
  minConfidence: 0.45,
  /** blurMetric (0 sharp .. 1 blurry) above which the picture is reported blurry. */
  blurWarn: 0.55,
  /** Fraction of the picture covered by glare blobs. */
  glareWarn: 0.004,
  darkMean: 0.16,
  darkP95: 0.38,
  /** Fraction of the picture with blown-out luminance (≥ 250). */
  brightBlown: 0.2,
  brightMean: 0.88,
  /** Min opposite-side ratio / max corner-angle deviation before 'perspective' fires. */
  perspectiveRatio: 0.7,
  perspectiveAngle: 24,
  /** Rectified long side (px) below which the picture is too small (warning / info). */
  lowResWarn: 500,
  lowResInfo: 800,
  /** Reference pixels per grid cell (warning / info). */
  refCellWarn: 32,
  refCellInfo: 48,
};

/** 0..1 report score from the issues' severities. */
function reportScore(issues: QualityIssue[]): number {
  let s = 1;
  for (const i of issues) s -= i.severity === 'error' ? 0.5 : i.severity === 'warning' ? 0.25 : 0.05;
  return Math.max(0, Math.min(1, s));
}

interface GlareResult {
  fraction: number;
  area?: Rect;
}

/**
 * Specular glare inside `mask`: bright, colourless blobs (shared `glareMask`) that are compact
 * (solidity) and surrounded by a bright, desaturated halo – a reflection washes out the picture
 * gradually, whereas white paint ends at a sharp edge next to normally coloured content. Blobs are
 * taken from a near-white and from a saturated (clipped) mask; the latter separates a reflection's
 * clipped core from bright white paper around it.
 */
function measureGlare(img: RGBAImage, mask: Mask): GlareResult {
  const loose = glareMask(img, { minValue: 0.965, maxSaturation: 0.1 });
  let inside = 0;
  for (let i = 0; i < loose.data.length; i++) {
    loose.data[i] = loose.data[i] && mask.data[i] ? 1 : 0;
    inside += mask.data[i];
  }
  if (inside === 0) return { fraction: 0 };
  // The strict (clipped) mask is a subset of the loose one: only re-test flagged pixels.
  const strict = createMask(img.width, img.height);
  for (let i = 0, p = 0; i < loose.data.length; i++, p += 4) {
    if (!loose.data[i]) continue;
    const [sat, val] = saturationValue(img.data[p], img.data[p + 1], img.data[p + 2]);
    if (val >= 0.985 && sat <= 0.06) strict.data[i] = 1;
  }
  const a = glareBlobs(img, mask, loose, inside);
  const b = glareBlobs(img, mask, strict, inside);
  return a.fraction >= b.fraction ? a : b;
}

/** Fraction of the masked area covered by glare-like blobs of candidate mask `g` (see measureGlare). */
function glareBlobs(img: RGBAImage, mask: Mask, g: Mask, inside: number): GlareResult {
  const { width: W, height: H } = img;
  const cleaned = open(g, 1);
  const { stats, labels } = labelComponents(cleaned, 8);
  const minBlob = Math.max(12, 0.0015 * inside);
  const blobs = stats.filter((s) => s.area >= minBlob).sort((a, b) => b.area - a.area).slice(0, 12);
  let total = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of blobs) {
    const hull = convexHull(traceOuterContour(componentMask(labels, W, s.label, s.bbox, 1)));
    const solidity = s.area / Math.max(1, polygonArea(hull));
    if (solidity < 0.85) continue;
    // Halo: inner ring (0.2–0.7 R from the blob) vs outer ring (1.3–2 R).
    const R = Math.sqrt(s.area / Math.PI);
    const pad = Math.ceil(2.1 * R) + 1;
    const wx0 = Math.max(0, s.bbox.x - pad), wy0 = Math.max(0, s.bbox.y - pad);
    const ww = Math.min(W, s.bbox.x + s.bbox.width + pad) - wx0, wh = Math.min(H, s.bbox.y + s.bbox.height + pad) - wy0;
    const outside = createMask(ww, wh);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) outside.data[y * ww + x] = labels[(y + wy0) * W + x + wx0] === s.label ? 0 : 1;
    const dist = distanceTransform(outside).data;
    let lIn = 0, sIn = 0, nIn = 0, lOut = 0, sOut = 0, nOut = 0;
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const gi = (y + wy0) * W + x + wx0;
        if (!mask.data[gi]) continue;
        const d = dist[y * ww + x];
        const inner = d >= 0.2 * R && d <= 0.7 * R, outer = d >= 1.3 * R && d <= 2 * R;
        if (!inner && !outer) continue;
        const p = gi * 4, r = img.data[p], gg = img.data[p + 1], b = img.data[p + 2];
        const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
        const sat = saturationValue(r, gg, b)[0];
        if (inner) { lIn += lum; sIn += sat; nIn++; } else { lOut += lum; sOut += sat; nOut++; }
      }
    }
    if (nIn < 8 || nOut < 8) continue;
    const halo = lIn / nIn - lOut / nOut;
    if (halo < 15 || sIn / nIn > sOut / nOut - 0.02) continue;
    total += s.area;
    x0 = Math.min(x0, s.bbox.x);
    y0 = Math.min(y0, s.bbox.y);
    x1 = Math.max(x1, s.bbox.x + s.bbox.width);
    y1 = Math.max(y1, s.bbox.y + s.bbox.height);
  }
  if (total === 0) return { fraction: 0 };
  return { fraction: total / inside, area: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/** Fraction of masked pixels whose luminance is blown out (≥ 250). */
function blownFraction(img: RGBAImage, mask: Mask): number {
  let n = 0, blown = 0;
  const d = img.data;
  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    if (!mask.data[i]) continue;
    n++;
    if (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] >= 250) blown++;
  }
  return n ? blown / n : 0;
}

/** Median blur metric over up to `n` tiles inside the quad (unit-square positions). */
function measureBlur(img: RGBAImage, quad: Quad, tile: number, downscale: number): number {
  const H = unitSquareToQuad(quad);
  if (!H) return 0;
  const vals: number[] = [];
  for (const [u, v] of [[0.3, 0.35], [0.7, 0.35], [0.5, 0.65]]) {
    const c = applyMat3(H, { x: u, y: v });
    const rect = { x: Math.round(c.x - tile / 2), y: Math.round(c.y - tile / 2), width: tile, height: tile };
    let crop = cropRGBA(img, rect);
    if (crop.width < 32 || crop.height < 32) continue;
    if (downscale < 0.8) crop = resizeRGBA(crop, Math.max(16, Math.round(crop.width * downscale)), Math.max(16, Math.round(crop.height * downscale)));
    vals.push(blurMetric(rgbaToGray(crop)));
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

function exposureIssues(mean: number, p95: number, blown: number, what: string): QualityIssue[] {
  const out: QualityIssue[] = [];
  if (mean < BOX_QUALITY.darkMean || p95 < BOX_QUALITY.darkP95) {
    out.push({ code: 'too_dark', severity: 'warning', message: `The ${what} is too dark.`, hint: 'Use more light or move closer to a window; avoid shadows on the box.' });
  } else if (blown > BOX_QUALITY.brightBlown || mean > BOX_QUALITY.brightMean) {
    out.push({ code: 'too_bright', severity: 'warning', message: `The ${what} is overexposed.`, hint: 'Avoid direct light on the box or tap a bright area to lower the exposure.' });
  }
  return out;
}

/**
 * Quality report of a box photo given the detected picture quad (photo coordinates). `cutOff`
 * marks a quad with sides on the photo border (the picture continues beyond the photo).
 */
export function assessBoxPhoto(photo: RGBAImage, work: WorkImage, quad: Quad, confidence: number, cutOff = false): QualityReport {
  const issues: QualityIssue[] = [];
  const metrics: Record<string, number> = { confidence };
  const wq = quad.map((p) => toWork(work, p));
  const mask = createMask(work.rgba.width, work.rgba.height);
  fillPolygon(mask, wq, 1);
  const ex = exposureStats(work.rgba, mask);
  metrics.brightness = ex.mean;
  metrics.clippedHigh = ex.clippedHigh;
  metrics.clippedLow = ex.clippedLow;
  metrics.p05 = ex.p05;
  metrics.p95 = ex.p95;
  const blown = blownFraction(work.rgba, mask);
  metrics.blown = blown;
  const size = suggestRectifiedSize(quad, undefined, Infinity);
  const longSide = Math.max(size.width, size.height);
  metrics.pictureWidth = size.width;
  metrics.pictureHeight = size.height;
  // Blur at (at most) the resolution the reference will have.
  const down = Math.min(1, 3000 / longSide);
  const blur = measureBlur(photo, quad, Math.round(Math.min(256, Math.max(96, 0.2 * longSide)) / Math.max(down, 0.1)), down);
  metrics.blur = blur;
  const glare = measureGlare(work.rgba, mask);
  metrics.glareFraction = glare.fraction;
  const sides = quadSides(quad);
  const ratio = Math.min(Math.min(sides[0], sides[2]) / Math.max(sides[0], sides[2]), Math.min(sides[1], sides[3]) / Math.max(sides[1], sides[3]));
  const angleDev = Math.max(...quadAngles(quad).map((a) => Math.abs(a - 90)));
  metrics.perspectiveRatio = ratio;
  metrics.maxAngleDeviation = angleDev;

  if (confidence < BOX_QUALITY.minConfidence) {
    issues.push({
      code: 'box_not_found',
      severity: 'warning',
      message: 'The edges of the puzzle picture could not be found reliably.',
      hint: 'Drag the four corners onto the picture corners, or retake the photo with the whole box on a plain, contrasting surface.',
    });
  }
  if (blur > BOX_QUALITY.blurWarn) {
    issues.push({ code: 'blurry', severity: 'warning', message: 'The photo of the picture is blurry.', hint: 'Hold the phone steady, tap the picture to focus and use more light.' });
  }
  if (glare.fraction > BOX_QUALITY.glareWarn) {
    const a = glare.area;
    const area = a ? photoRect(work, a) : undefined;
    issues.push({
      code: 'glare',
      severity: glare.fraction > 0.05 ? 'error' : 'warning',
      message: 'Reflections (glare) hide part of the picture.',
      hint: 'Tilt the box slightly or move away from overhead lights so the reflection disappears.',
      area,
    });
  }
  issues.push(...exposureIssues(ex.mean, ex.p95, blown, 'picture'));
  if (cutOff) {
    issues.push({
      code: 'cut_off',
      severity: 'warning',
      message: 'The picture is cut off by the edge of the photo.',
      hint: 'Step back or zoom out so the whole picture fits in the photo; missing parts cannot be matched.',
    });
  } else if (ratio < BOX_QUALITY.perspectiveRatio || angleDev > BOX_QUALITY.perspectiveAngle) {
    issues.push({ code: 'perspective', severity: 'warning', message: 'The box is photographed at a steep angle.', hint: 'Shoot from straight above so the box looks rectangular.' });
  }
  if (longSide < BOX_QUALITY.lowResWarn) {
    issues.push({ code: 'low_resolution', severity: 'warning', message: `The picture is only about ${Math.round(longSide)} px across in the photo.`, hint: 'Move closer so the box fills the photo, or use the full camera resolution.' });
  } else if (longSide < BOX_QUALITY.lowResInfo) {
    issues.push({ code: 'low_resolution', severity: 'info', message: `The picture is about ${Math.round(longSide)} px across in the photo.`, hint: 'A closer or higher-resolution photo gives a sharper reference.' });
  }
  return { score: reportScore(issues), issues, metrics };
}

function photoRect(work: WorkImage, r: Rect): Rect {
  const a = toPhoto(work, { x: r.x - 0.5, y: r.y - 0.5 });
  const b = toPhoto(work, { x: r.x + r.width - 0.5, y: r.y + r.height - 0.5 });
  return { x: Math.round(a.x + 0.5), y: Math.round(a.y + 0.5), width: Math.round(b.x - a.x), height: Math.round(b.y - a.y) };
}

/**
 * Quality of the rectified reference image for a grid: pixels per grid cell
 * ('reference_low_resolution' warning below ~32 px, info below ~48 px, with a hint to add
 * close-ups), blur, glare on the picture and exposure.
 */
export function assessReference(reference: RGBAImage, grid: GridSpec): QualityReport {
  const issues: QualityIssue[] = [];
  const { width: W, height: H } = reference;
  const pxPerCell = Math.min(W / Math.max(1, grid.cols), H / Math.max(1, grid.rows));
  const metrics: Record<string, number> = { pxPerCell, width: W, height: H };
  if (pxPerCell < BOX_QUALITY.refCellWarn) {
    issues.push({
      code: 'reference_low_resolution',
      severity: 'warning',
      message: `Only about ${Math.round(pxPerCell)} px per piece in the reference picture.`,
      hint: 'Add close-up photos of parts of the box to sharpen the reference, or retake the box photo closer.',
    });
  } else if (pxPerCell < BOX_QUALITY.refCellInfo) {
    issues.push({
      code: 'reference_low_resolution',
      severity: 'info',
      message: `About ${Math.round(pxPerCell)} px per piece in the reference picture.`,
      hint: 'Close-up photos of the box would improve matching of small details.',
    });
  }
  const full: Quad = [{ x: -0.5, y: -0.5 }, { x: W - 0.5, y: -0.5 }, { x: W - 0.5, y: H - 0.5 }, { x: -0.5, y: H - 0.5 }];
  const blur = measureBlur(reference, full, Math.round(Math.min(384, Math.max(64, 0.25 * Math.max(W, H)))), 1);
  metrics.blur = blur;
  if (blur > BOX_QUALITY.blurWarn) {
    issues.push({ code: 'blurry', severity: 'warning', message: 'The reference picture is blurry.', hint: 'Retake the box photo with the phone held steady and the picture in focus.' });
  }
  // Exposure and glare on a ≤ 800 px copy.
  const f = Math.min(1, 800 / Math.max(W, H));
  const small = f < 1 ? resizeRGBA(reference, Math.max(1, Math.round(W * f)), Math.max(1, Math.round(H * f))) : reference;
  const all = createMask(small.width, small.height);
  all.data.fill(1);
  const ex = exposureStats(small, all);
  metrics.brightness = ex.mean;
  metrics.clippedHigh = ex.clippedHigh;
  const blown = blownFraction(small, all);
  metrics.blown = blown;
  const glare = measureGlare(small, all);
  metrics.glareFraction = glare.fraction;
  if (glare.fraction > BOX_QUALITY.glareWarn) {
    const a = glare.area;
    issues.push({
      code: 'glare',
      severity: 'warning',
      message: 'Reflections (glare) hide part of the reference picture.',
      hint: 'Retake the box photo without reflections (tilt the box, avoid overhead light), or cover the area with a close-up.',
      area: a ? { x: Math.round(a.x / f), y: Math.round(a.y / f), width: Math.round(a.width / f), height: Math.round(a.height / f) } : undefined,
    });
  }
  issues.push(...exposureIssues(ex.mean, ex.p95, blown, 'reference picture'));
  return { score: reportScore(issues), issues, metrics };
}
