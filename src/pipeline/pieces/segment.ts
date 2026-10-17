/**
 * Segmentation of a scan photo (loose pieces / assembled patches on a table) into regions.
 *
 * Pipeline: Lab conversion → background model (border band, quadratic lighting surface,
 * iterative refinement) → foreground score → Otsu threshold on the log score with hysteresis →
 * open / close / fill holes / drop specks → connected components → outline tracing and shape
 * analysis → classification (piece / patch / fragment), splitting of touching pieces at narrow
 * necks → reading-order ids → quality assessment.
 */
import { componentMask, labelComponents, labelRuns, removeSmallComponents } from '../../cv/components';
import { traceOuterContour } from '../../cv/contour';
import type { Point } from '../../cv/geometry';
import { createGray, createMask, cropMask, cropRGBA, maskArea, maskBounds, type GrayImage, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { close, fillHoles, open } from '../../cv/morphology';
import { simplifyPolygon, smoothContour } from '../../cv/polygon';
import { otsuThreshold, threshold } from '../../cv/threshold';
import type { DetectedRegion, PieceShape, QualityIssue, RegionKind } from '../../model/types';
import { fitBackground, foregroundScore } from './background';
import { assessPhoto, assessRegions } from './quality';
import { analyzePieceShape, bodyOrientation, orientationHistogram } from './shape';
import type { BackgroundModel, SegmentOptions, Segmentation, SegmentedRegion } from './types';
import { median, offsetPoints } from './util';

/** Minimum shape confidence for a region to serve as a single-piece size reference. */
const REFERENCE_CONFIDENCE = 0.45;
/** Shapes below this confidence are not attached to regions. */
const MIN_SHAPE_CONFIDENCE = 0.3;
/** Shapes below this confidence raise 'shape_uncertain'. */
const UNCERTAIN_CONFIDENCE = 0.5;
/**
 * Opening radius (fraction of the body size) that separates touching pieces: contacts narrower
 * than ~0.4 body sizes break, while pieces of an assembled patch share whole sides and stay joined.
 */
const NECK_RADIUS = 0.2;

/** A region candidate: local mask (tight bbox) plus derived geometry. */
interface Candidate {
  mask: Mask;
  bbox: Rect;
  area: number;
  touchesBorder: boolean;
  /** Raw traced outline in photo coordinates (clockwise). */
  contour: Point[];
  shape: PieceShape | null;
  orientation: number;
  /** Candidates split from the same touching cluster share a group number. */
  group?: number;
}

function makeCandidate(mask: Mask, bbox: Rect, photoW: number, photoH: number, area?: number): Candidate {
  const contour = offsetPoints(traceOuterContour(mask), bbox.x, bbox.y);
  const touchesBorder = bbox.x <= 0 || bbox.y <= 0 || bbox.x + bbox.width >= photoW || bbox.y + bbox.height >= photoH;
  const shape = touchesBorder ? null : analyzePieceShape(contour);
  return { mask, bbox, area: area ?? maskArea(mask), touchesBorder, contour, shape, orientation: orientationHistogram(contour).angle };
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

/**
 * Find every piece / patch in a scan photo. Regions get ids 1..n in reading order, a kind
 * ('piece' | 'patch' | 'unknown'), outline, shape (single pieces), orientation and issues; the
 * result also carries the foreground mask, background model and the photo quality report.
 */
export function segmentPieces(photo: RGBAImage, opts: SegmentOptions = {}): Segmentation {
  const W = photo.width, H = photo.height;
  const patchRatio = opts.patchAreaRatio ?? 1.8;
  const fragRatio = opts.fragmentAreaRatio ?? 0.35;
  const minArea = opts.minArea ?? Math.max(48, Math.round(2e-4 * W * H));

  const timings = opts.timings;
  let t0 = performance.now();
  const lap = (name: string) => {
    const t = performance.now();
    if (timings) timings[name] = (timings[name] ?? 0) + (t - t0);
    t0 = t;
  };
  const fit = fitBackground(photo);
  lap('background');
  const score = foregroundScore(photo, fit);
  lap('score');
  const th = chooseThreshold(score);
  let fg = hysteresis(score, th.high, th.low);
  lap('threshold');
  fg = open(fg, 1);
  fg = close(fg, 2);
  fg = fillHoles(fg);
  fg = removeSmallComponents(fg, minArea);
  lap('morphology');
  const { labels, stats } = labelComponents(fg, 8);
  lap('components');

  let cands: Candidate[] = stats.map((s) => makeCandidate(componentMask(labels, W, s.label, s.bbox), s.bbox, W, H, s.area));
  lap('shapes');

  // Single-piece reference size.
  const singles = cands.filter(isPlausibleSingle);
  const others = cands.filter((c) => !c.touchesBorder);
  const refArea = singles.length > 0 ? median(singles.map((c) => c.area)) : others.length > 0 ? median(others.map((c) => c.area)) : 0;
  const refBody = singles.length > 0 ? median(singles.map((c) => c.shape!.bodySize)) : Math.sqrt(refArea);

  // Split touching pieces at narrow necks.
  let group = 0;
  if (refArea > 0 && opts.splitTouching !== false) {
    const out: Candidate[] = [];
    for (const c of cands) {
      const confidentSingle = c.shape !== null && c.shape.confidence >= 0.7;
      if (c.area > 1.4 * refArea && !confidentSingle) {
        const parts = splitAtNecks(c, Math.max(2, NECK_RADIUS * refBody), 0.3 * refArea);
        if (parts && parts.every((p) => maskArea(p.mask) >= fragRatio * refArea)) {
          group++;
          for (const p of parts) out.push({ ...makeCandidate(p.mask, p.bbox, W, H), group });
          continue;
        }
      }
      out.push(c);
    }
    cands = out;
  }
  lap('split');

  // Classify and build regions.
  const ordered = readingOrder(cands);
  const regions: SegmentedRegion[] = ordered.map((c, i) => {
    const ratio = refArea > 0 ? c.area / refArea : 1;
    const confidentSingle = c.shape !== null && c.shape.confidence >= 0.7 && ratio <= 3;
    let kind: RegionKind = 'piece';
    if (ratio < fragRatio) kind = 'unknown';
    else if (ratio > patchRatio && !confidentSingle) kind = 'patch';
    const shape = kind === 'piece' && c.shape && c.shape.confidence >= MIN_SHAPE_CONFIDENCE ? c.shape : undefined;
    const orientationDeg = shape ? bodyOrientation(shape) : c.orientation;
    const contour = simplifyPolygon(smoothContour(c.contour, 0.7), 0.5);
    const region: DetectedRegion = {
      id: i + 1,
      kind,
      bbox: c.bbox,
      contour,
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
  ordered.forEach((c, i) => {
    const r = regions[i].region;
    const issues: QualityIssue[] = r.issues;
    if (c.touchesBorder) {
      issues.push({ code: 'cut_off', severity: 'warning', message: 'Piece is cut off by the photo edge.', hint: 'Keep all pieces fully inside the frame.', regionIds: [r.id], area: r.bbox });
    }
    if (r.kind === 'unknown' && refArea > 0 && c.area < fragRatio * refArea) {
      issues.push({ code: 'fragment', severity: 'info', message: 'Small fragment, not a whole piece.', hint: 'Remove crumbs and dust from the table.', regionIds: [r.id], area: r.bbox });
    }
    if (c.group !== undefined) {
      issues.push({ code: 'touching_pieces', severity: 'warning', message: 'Touching pieces were separated automatically.', hint: 'Leave a small gap between pieces.', regionIds: groups.get(c.group), area: r.bbox });
    }
    if (r.kind === 'piece' && !c.touchesBorder && (!c.shape || c.shape.confidence < UNCERTAIN_CONFIDENCE)) {
      issues.push({ code: 'shape_uncertain', severity: 'info', message: 'Piece outline is unclear.', hint: 'Use a plain background and spread the pieces out.', regionIds: [r.id], area: r.bbox });
    }
  });

  const bodies = regions.filter((r) => r.region.shape).map((r) => r.region.shape!.bodySize);
  const background: BackgroundModel = {
    ...fit,
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
