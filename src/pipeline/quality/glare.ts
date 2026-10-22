/**
 * Specular glare: the image of a lamp, a window or the phone's torch on a glossy surface. Shared by
 * the box photo / reference checks (pipeline/box/quality.ts) and the live camera frame check
 * (pipeline/pieces/quality.ts assessFrame). Measures only; thresholds are up to the caller.
 */
import { saturationValue } from '../../cv/color';
import { componentMask, labelComponents } from '../../cv/components';
import { traceOuterContour } from '../../cv/contour';
import { distanceTransform } from '../../cv/distance';
import { createMask, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { open } from '../../cv/morphology';
import { convexHull, polygonArea } from '../../cv/polygon';
import { glareMask } from './metrics';

export interface GlareResult {
  /** Fraction of the masked area covered by glare blobs. */
  fraction: number;
  /** Bounding box of the glare blobs. */
  area?: Rect;
}

export interface GlareOptions {
  /** Smallest blob counted, as a fraction of the masked area (default 0.0015). */
  minBlobFraction?: number;
  /** Smallest blob counted in pixels (default 12). */
  minBlobPx?: number;
  /**
   * Distance (px) from the blob below which the halo is not measured (default 0). In small images
   * (live frames) resampling smears even a sharp white edge over a pixel or so – that ramp is no
   * halo; a reflection's halo reaches further.
   */
  ringFromPx?: number;
  /**
   * Pixels the outer ring (what the halo is compared with) may use; default `mask`. Live frames
   * leave out the table: a grey table around a small piece looks like a desaturated halo, a
   * coloured one makes pale print next to it look like one.
   */
  outerRingMask?: Mask;
  /** Pixels the inner ring (the halo) may use; default `mask`. */
  innerRingMask?: Mask;
  /** Share of the outer ring that must lie in `outerRingMask` (default 0): a blob mostly on the table is no glare on a piece. */
  minOuterShare?: number;
}

/**
 * Specular glare inside `mask`: bright, colourless blobs (shared `glareMask`) that are compact
 * (solidity) and surrounded by a bright, desaturated halo – a reflection washes out the picture
 * gradually, whereas white paint ends at a sharp edge next to normally coloured content. Blobs are
 * taken from a near-white and from a saturated (clipped) mask; the latter separates a reflection's
 * clipped core from bright white paper around it.
 */
export function measureGlare(img: RGBAImage, mask: Mask, opts: GlareOptions = {}): GlareResult {
  const loose = glareMask(img, { minValue: 0.965, maxSaturation: 0.1 });
  let inside = 0;
  let candidates = 0;
  for (let i = 0; i < loose.data.length; i++) {
    loose.data[i] = loose.data[i] && mask.data[i] ? 1 : 0;
    inside += mask.data[i];
    candidates += loose.data[i];
  }
  if (inside === 0) return { fraction: 0 };
  const minBlob = Math.max(opts.minBlobPx ?? 12, (opts.minBlobFraction ?? 0.0015) * inside);
  // Nothing bright enough to make a single blob (the common case for live frames): done.
  if (candidates < minBlob) return { fraction: 0 };
  // The strict (clipped) mask is a subset of the loose one: only re-test flagged pixels.
  const strict = createMask(img.width, img.height);
  for (let i = 0, p = 0; i < loose.data.length; i++, p += 4) {
    if (!loose.data[i]) continue;
    const [sat, val] = saturationValue(img.data[p], img.data[p + 1], img.data[p + 2]);
    if (val >= 0.985 && sat <= 0.06) strict.data[i] = 1;
  }
  const ring = { ringFromPx: opts.ringFromPx ?? 0, innerMask: opts.innerRingMask ?? mask, outerMask: opts.outerRingMask ?? mask, minOuterShare: opts.minOuterShare ?? 0 };
  const a = glareBlobs(img, loose, inside, minBlob, ring);
  const b = glareBlobs(img, strict, inside, minBlob, ring);
  return a.fraction >= b.fraction ? a : b;
}

/** Fraction of the masked area covered by glare-like blobs of candidate mask `g` (see measureGlare). */
function glareBlobs(img: RGBAImage, g: Mask, inside: number, minBlob: number, ring: { ringFromPx: number; innerMask: Mask; outerMask: Mask; minOuterShare: number }): GlareResult {
  const { ringFromPx, innerMask, outerMask, minOuterShare } = ring;
  const { width: W, height: H } = img;
  const cleaned = open(g, 1);
  const { stats, labels } = labelComponents(cleaned, 8);
  const blobs = stats.filter((s) => s.area >= minBlob).sort((a, b) => b.area - a.area).slice(0, 12);
  let total = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of blobs) {
    const hull = convexHull(traceOuterContour(componentMask(labels, W, s.label, s.bbox, 1)));
    const solidity = s.area / Math.max(1, polygonArea(hull));
    if (solidity < 0.85) continue;
    // Halo: inner ring (0.2–0.7 R from the blob, at least `ringFromPx` away) vs outer ring (1.3–2 R).
    const R = Math.sqrt(s.area / Math.PI);
    const innerFrom = Math.max(0.2 * R, ringFromPx);
    const innerTo = ringFromPx > 0 ? Math.max(0.7 * R, innerFrom + 1.5) : 0.7 * R;
    const pad = Math.ceil(2.1 * R) + 1;
    const wx0 = Math.max(0, s.bbox.x - pad), wy0 = Math.max(0, s.bbox.y - pad);
    const ww = Math.min(W, s.bbox.x + s.bbox.width + pad) - wx0, wh = Math.min(H, s.bbox.y + s.bbox.height + pad) - wy0;
    const outside = createMask(ww, wh);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) outside.data[y * ww + x] = labels[(y + wy0) * W + x + wx0] === s.label ? 0 : 1;
    const dist = distanceTransform(outside).data;
    let lIn = 0, sIn = 0, nIn = 0, lOut = 0, sOut = 0, nOut = 0, nRing = 0;
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const gi = (y + wy0) * W + x + wx0;
        const d = dist[y * ww + x];
        const inRing = d >= 1.3 * R && d <= 2 * R;
        if (inRing) nRing++;
        const inner = d >= innerFrom && d <= innerTo && innerMask.data[gi] === 1;
        const outer = inRing && outerMask.data[gi] === 1;
        if (!inner && !outer) continue;
        const p = gi * 4, r = img.data[p], gg = img.data[p + 1], b = img.data[p + 2];
        const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
        const sat = saturationValue(r, gg, b)[0];
        if (inner) { lIn += lum; sIn += sat; nIn++; } else { lOut += lum; sOut += sat; nOut++; }
      }
    }
    if (nIn < 8 || nOut < 8 || nOut < minOuterShare * nRing) continue;
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
