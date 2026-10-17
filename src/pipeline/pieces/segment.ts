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
import { solveLinear, type Point } from '../../cv/geometry';
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
 * Only regions clearly larger than one piece are split, so narrow-waisted single pieces are safe.
 */
const NECK_RADIUS = 0.2;
/**
 * Relative height of a second outline-orientation peak above which a patch looks like loose pieces
 * at different rotations (assembled patches share one grid: measured ≤ 0.31 vs. up to 0.95).
 */
const TOUCHING_SECOND_PEAK = 0.42;

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
  const fit = fitBackground(photo);
  lap('background');
  const score = foregroundScore(photo, fit);
  lap('score');
  const th = chooseThreshold(score);
  let fg = hysteresis(score, th.high, th.low);
  lap('threshold');
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
  const noReference = singles.length === 0 && others.length < 3;
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
