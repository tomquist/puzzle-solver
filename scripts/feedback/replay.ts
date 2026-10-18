/**
 * Replay a feedback file with the current pipeline and judge every user correction:
 * - 'missed' point: is it now inside a detected piece / patch? If not, why (score, mask, specks)?
 * - 'not_a_piece': is the region still detected as a piece / patch?
 * - 'merged': is the region now split into several regions?
 * - 'bad_outline': how does the current outline compare (IoU, shape confidence)?
 * - 'wrong_place': is the user's correct cell now the top-1 placement?
 * - confirmed placements: still top-1?
 * - box photo: corner error of the current detectBox against the user's quad.
 * Shared by `npm run feedback:inspect` and bench/feedback.eval.ts.
 */
import type { Point, Quad } from '../../src/cv/geometry';
import type { Rect, RGBAImage } from '../../src/cv/image';
import type { FeedbackBundle, FeedbackMark } from '../../src/feedback/format';
import type { BoxDetection, CellRef, DetectedRegion, RegionMatch, ScanResult } from '../../src/model/types';
import { analyzeScan } from '../../src/pipeline/analyzeScan';
import { detectBox } from '../../src/pipeline/box';
import { buildReferenceIndex } from '../../src/pipeline/match';
import { segmentPieces, type BackgroundModel, type SegmentDiagnostics } from '../../src/pipeline/pieces';
import { basename } from 'node:path';
import { decodeFeedbackImage, readFeedbackFile } from './io';
import { readReview, type FeedbackReview, type MarkReview, type ReviewObject } from './review';
import { cellJaccard, cellKey, centroidOf, containsPoint, correspondent, distanceToRect, formatCells, overlaps, rasterizeRegions, regionAtTap, type RasterRegion } from './regions';

/** Outcome of one user mark under the current pipeline. */
export interface MarkJudgement {
  /** 1-based position in the file's mark list (shown as M1, M2, … everywhere). */
  index: number;
  mark: FeedbackMark;
  /** Photo position of the mark (point, or the marked region's centre). */
  at: Point;
  /** What the app reported originally (from the file). */
  original: string;
  /** What the current pipeline finds. */
  now: string;
  /** true = the problem is gone, false = still there, null = cannot be judged automatically. */
  fixed: boolean | null;
  /** Short verdict, e.g. FIXED, STILL MISSED, CHANGED. */
  verdict: string;
  /** Diagnosis when not fixed (why the current pipeline still fails). */
  why?: string;
  /** Current regions involved (to highlight them). */
  currentIds: number[];
  /** Verdict of the visual review of this mark (see review.ts), when the file has one. */
  review?: MarkReview;
}

export interface PlacementJudgement {
  regionId: number;
  cells: CellRef[];
  at: Point;
  /** Union bounding box of the item's regions (photo coordinates). */
  bbox: Rect;
  originalCells: CellRef[];
  currentCells: CellRef[];
  currentIds: number[];
  originalOk: boolean;
  ok: boolean;
}

export interface BoxJudgement {
  userQuad: Quad;
  detection: BoxDetection;
  /** Largest corner distance in px and as a fraction of the user quad's diagonal. */
  errorPx: number;
  error: number;
  ms: number;
}

/** A result scored against the review's answer key (counts; unsure objects excluded). */
export interface ObjectScore {
  /** Objects in the key. */
  objects: number;
  /** Objects inside a piece / patch region. */
  found: number;
  /** Objects alone in their region (found and not merged with another object). */
  clean: number;
  /** Piece / patch regions, and those holding at least one object (the rest are false). */
  regions: number;
  real: number;
}

/** Score piece / patch regions (centred inside `area`, when given) against an answer key of object points. */
export function scoreObjects(objects: ReviewObject[], regions: RasterRegion[], area?: Rect): ObjectScore {
  const inArea = (r: RasterRegion) => {
    if (!area) return true;
    const cx = r.rect.x + r.rect.width / 2, cy = r.rect.y + r.rect.height / 2;
    return cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height;
  };
  const shown = regions.filter((r) => r.region.kind !== 'unknown' && inArea(r));
  const hits = objects.map((o) => shown.find((r) => containsPoint(r, o)));
  const perRegion = new Map<RasterRegion, number>();
  for (const h of hits) if (h) perRegion.set(h, (perRegion.get(h) ?? 0) + 1);
  const counted = objects.map((o, i) => ({ o, h: hits[i] })).filter(({ o }) => !o.unsure);
  return {
    objects: counted.length,
    found: counted.filter(({ h }) => h).length,
    clean: counted.filter(({ h }) => h && perRegion.get(h) === 1).length,
    regions: shown.length,
    real: shown.filter((r) => perRegion.has(r)).length,
  };
}

export interface FeedbackReplay {
  name: string;
  bundle: FeedbackBundle;
  photo: RGBAImage | null;
  /** Scale from stored result coordinates to photo pixels (1 unless the file is inconsistent). */
  resultScale: number;
  original: ScanResult | null;
  current: ScanResult | null;
  /** True when matching ran (the file has a reference picture). */
  matched: boolean;
  diagnostics: SegmentDiagnostics | null;
  background: BackgroundModel | null;
  marks: MarkJudgement[];
  /** True when the marks were reviewed: then only marks reviewed 'ok' count in the metrics. */
  reviewed?: boolean;
  /** Stored and current result scored against the review's answer key, when it has one. */
  objects?: { original: ObjectScore; current: ObjectScore };
  placements: PlacementJudgement[];
  boxPhoto: RGBAImage | null;
  box: BoxJudgement | null;
  /** Pipeline timings of the replay (ms). */
  timings: Record<string, number>;
  /** Problems with the file itself (missing parts, size mismatches). */
  notes: string[];
}

const now = () => performance.now();
/** How far (in piece body sizes) a 'missed' tap may land outside a region and still mean it. */
const TAP_TOLERANCE = 0.12;

function regionCenter(r: DetectedRegion): Point {
  return { x: r.bbox.x + r.bbox.width / 2, y: r.bbox.y + r.bbox.height / 2 };
}

function describeRegion(r: DetectedRegion, m: RegionMatch | undefined): string {
  const st = m ? m.status : 'unmatched';
  const top = m?.candidates[0];
  const conf = r.shape ? ` shape ${r.shape.confidence.toFixed(2)}` : '';
  return `#${r.id} ${r.kind}${conf} ${st}${top ? ` r${top.row}c${top.col}` : ''}`;
}

/** Cells a set of regions is placed at (patches: covered cells; pieces: top-1 cell). */
function placedCells(ids: number[], result: ScanResult): CellRef[] {
  const out = new Map<string, CellRef>();
  const byId = new Map(result.matches.map((m) => [m.regionId, m]));
  // An assembled group containing all of them places them as one unit.
  const group = (result.groups ?? []).find((g) => g.kind === 'assembled' && ids.every((id) => g.regionIds.includes(id)));
  if (group && ids.length > 1) return group.cells;
  for (const id of ids) {
    const m = byId.get(id);
    const top = m?.candidates[0];
    if (!m || !top || m.status === 'unmatched') continue;
    const cells = m.coveredCells && m.coveredCells.length > 0 ? m.coveredCells : [{ row: top.row, col: top.col }];
    for (const c of cells) out.set(cellKey(c), c);
  }
  return [...out.values()];
}

/** Regions of the stored result that a placement / wrong_place mark refers to (an item label may name an assembled group). */
function itemMembers(regionId: number, result: ScanResult, cells?: CellRef[]): number[] {
  const g = (result.groups ?? []).find((x) => x.kind === 'assembled' && x.regionIds.includes(regionId) && Math.min(...x.regionIds) === regionId);
  if (g && g.regionIds.length > 1 && (!cells || cells.length > 1)) return g.regionIds;
  return [regionId];
}

/** Single piece: the top-1 cell is right; several cells: Jaccard ≥ 0.5. */
const cellsOk = (found: CellRef[], truth: CellRef[]): boolean =>
  truth.length === 1 ? found.length >= 1 && cellKey(found[0]) === cellKey(truth[0]) : cellJaccard(found, truth) >= 0.5;

export interface ReplayOptions {
  /** Skip the box re-detection. */
  skipBox?: boolean;
  /** Visual review of the marks; without one every mark counts. */
  review?: FeedbackReview;
  /** The scan photo already decoded (e.g. by Chromium, see chromium.ts); default jpeg-js. */
  scanPhoto?: RGBAImage;
}

/** Re-run the current pipeline on a feedback file and judge every mark, placement and the box. */
export function replayFeedback(bundle: FeedbackBundle, name: string, opts: ReplayOptions = {}): FeedbackReplay {
  const notes: string[] = [];
  const timings: Record<string, number> = {};
  const out: FeedbackReplay = {
    name, bundle, photo: null, resultScale: 1, original: null, current: null, matched: false, diagnostics: null, background: null,
    marks: [], placements: [], boxPhoto: null, box: null, timings, notes,
  };

  if (bundle.box && !opts.skipBox) {
    const photo = decodeFeedbackImage(bundle.box.photo);
    out.boxPhoto = photo;
    const t = now();
    const detection = detectBox(photo);
    const ms = now() - t;
    timings.box = ms;
    const q = bundle.box.quad;
    const diag = Math.max(Math.hypot(q[2].x - q[0].x, q[2].y - q[0].y), Math.hypot(q[3].x - q[1].x, q[3].y - q[1].y));
    let worst = 0;
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(detection.quad[i].x - q[i].x, detection.quad[i].y - q[i].y));
    out.box = { userQuad: q, detection, errorPx: worst, error: diag > 0 ? worst / diag : 0, ms };
  }

  if (!bundle.scan) {
    if (bundle.marks.length > 0) notes.push('marks present but the file has no scan');
    return out;
  }
  const photo = opts.scanPhoto ?? decodeFeedbackImage(bundle.scan.photo);
  out.photo = photo;
  const original = bundle.scan.result;
  out.original = original;
  if (original.width && original.width !== photo.width) {
    out.resultScale = photo.width / original.width;
    notes.push(`stored result is ${original.width}x${original.height} but the photo is ${photo.width}x${photo.height}; coordinates scaled by ${out.resultScale.toFixed(3)}`);
  }
  const s = out.resultScale;

  // Current pipeline: full analysis when the reference is there, segmentation only otherwise. The
  // segmentation internals come from a separate (deterministic, identical) segmentPieces run.
  const diagnostics: SegmentDiagnostics = {};
  let t = now();
  const segTimings: Record<string, number> = {};
  const seg = segmentPieces(photo, { timings: segTimings, diagnostics });
  timings.segment = now() - t;
  out.diagnostics = diagnostics;
  out.background = seg.background;
  if (bundle.reference) {
    const ref = decodeFeedbackImage(bundle.reference);
    t = now();
    const index = buildReferenceIndex(ref, bundle.puzzle.grid, bundle.puzzle.cut);
    timings.index = now() - t;
    t = now();
    out.current = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height) }).result;
    timings.analyze = now() - t;
    out.matched = true;
  } else {
    notes.push('no reference picture in the file: segmentation only (placements cannot be judged)');
    out.current = {
      width: photo.width, height: photo.height,
      regions: seg.regions.map((r) => r.region),
      matches: seg.regions.map((r) => ({ regionId: r.region.id, candidates: [], status: 'unmatched' as const })),
      fits: [], groups: [], quality: seg.quality, timings: segTimings,
    };
  }
  const current = out.current;
  const origR = rasterizeRegions(original.regions, s);
  const curR = rasterizeRegions(current.regions);
  const origById = new Map(origR.map((r) => [r.id, r]));
  const curMatch = new Map(current.matches.map((m) => [m.regionId, m]));
  const origMatch = new Map(original.matches.map((m) => [m.regionId, m]));
  const isPiece = (r: RasterRegion) => r.region.kind !== 'unknown';
  const regionDiag = new Map((diagnostics.regions ?? []).map((d) => [d.id, d]));
  const diagText = (id: number): string => {
    const d = regionDiag.get(id);
    if (!d) return '';
    const parts = [`contrast ${d.contrast.toFixed(1)}`, `area ${d.areaRatio.toFixed(2)}x`];
    if (d.textureFraction > 0.02) parts.push(`texture ${(100 * d.textureFraction).toFixed(0)}%`);
    if (d.merged > 1) parts.push(`reassembled from ${d.merged}`);
    if (d.split) parts.push('split from touching');
    return parts.join(', ');
  };

  // Old regions the user marked as not a whole piece (wrong outline, no piece): a current region that
  // takes them in has not merged two pieces.
  const notWhole = new Set(bundle.marks.flatMap((m) => (m.kind === 'bad_outline' || m.kind === 'not_a_piece' ? [m.regionId] : [])));
  bundle.marks.forEach((given, k) => {
    const index = k + 1;
    // A reviewed kind correction (the user picked the wrong kind for a real problem).
    const fix = opts.review?.marks[String(index)]?.kind;
    const mark: FeedbackMark = fix && given.kind !== 'missed' && fix !== given.kind ? { kind: fix, regionId: given.regionId } : given;
    if (mark.kind === 'missed') {
      const at = { x: mark.x * s, y: mark.y * s };
      // Taps land a few px off: a region within TAP_TOLERANCE body sizes counts as tapped.
      const tol = Math.max(4, TAP_TOLERANCE * (diagnostics.refBody || 60));
      const tapText = (t: { d: number } | null) => (t && t.d > 0 ? ` (tap ${Math.round(t.d)} px outside)` : '');
      const origTap = regionAtTap(origR, at, tol);
      const origHit = origTap?.r;
      const original = origHit ? `inside ${describeRegion(origHit.region, origMatch.get(origHit.id))}${tapText(origTap)}` : 'not detected';
      const tap = regionAtTap(curR, at, tol);
      const hit = tap?.r;
      if (hit && isPiece(hit)) {
        // Inside a region, but is it a region of its own? Not when it also swallowed a piece the
        // app had found separately (old regions the user marked as fragments or as no piece don't
        // count), or another piece the user marked as missed.
        const swallowed = overlaps(hit, origR).filter((o) => o.ofB > 0.5 && !containsPoint(o.r, at) && isPiece(o.r) && !notWhole.has(o.r.id));
        const otherTaps = bundle.marks.filter((m, j) => j !== k && m.kind === 'missed' && containsPoint(hit, { x: m.x * s, y: m.y * s })).length;
        const nowText = describeRegion(hit.region, curMatch.get(hit.id)) + tapText(tap);
        const ratio = regionDiag.get(hit.id)?.areaRatio ?? 1;
        if (swallowed.length > 0 || otherTaps > 0) {
          const withText = [...swallowed.map((o) => `old #${o.r.id}`), ...(otherTaps ? [`${otherTaps} more missed piece${otherTaps > 1 ? 's' : ''}`] : [])].join(', ');
          out.marks.push({ index, mark, at, original, now: `${nowText}, merged with ${withText}`, fixed: false, verdict: 'MERGED', why: diagText(hit.id), currentIds: [hit.id] });
        } else if (hit.region.kind !== 'piece' || ratio > 1.6) {
          // A piece the user had to mark is not found when it only sits inside a larger region.
          out.marks.push({ index, mark, at, original, now: `inside ${nowText}`, fixed: false, verdict: 'IN LARGER REGION', why: diagText(hit.id), currentIds: [hit.id] });
        } else {
          out.marks.push({ index, mark, at, original, now: nowText, fixed: true, verdict: 'FOUND', currentIds: [hit.id] });
        }
        return;
      }
      const why = missedReason(at, diagnostics, curR, hit);
      out.marks.push({ index, mark, at, original, now: hit ? `only fragment #${hit.id}` : 'not detected', fixed: false, verdict: 'STILL MISSED', why, currentIds: hit ? [hit.id] : [] });
      return;
    }
    const orig = origById.get(mark.regionId);
    if (!orig) {
      notes.push(`M${index}: region #${mark.regionId} is not in the stored result`);
      out.marks.push({ index, mark, at: { x: 0, y: 0 }, original: `#${mark.regionId} missing`, now: '-', fixed: null, verdict: 'INVALID', currentIds: [] });
      return;
    }
    const at = centroidOf(orig);
    const origText = describeRegion(orig.region, origMatch.get(orig.id));
    const ov = overlaps(orig, curR);
    if (mark.kind === 'not_a_piece') {
      // Still detected when a piece / patch region covers most of it (or it covers most of one).
      const still = ov.filter((o) => isPiece(o.r) && (o.iou >= 0.3 || o.ofA >= 0.5 || o.ofB >= 0.5));
      if (still.length === 0) {
        const frag = ov.find((o) => !isPiece(o.r) && o.ofA >= 0.3);
        out.marks.push({ index, mark, at, original: origText, now: frag ? `fragment #${frag.r.id} (not offered)` : 'gone', fixed: true, verdict: 'REMOVED', currentIds: frag ? [frag.r.id] : [] });
      } else {
        const r = still[0].r;
        out.marks.push({ index, mark, at, original: origText, now: describeRegion(r.region, curMatch.get(r.id)), fixed: false, verdict: 'STILL DETECTED', why: diagText(r.id), currentIds: still.map((o) => o.r.id) });
      }
      return;
    }
    if (mark.kind === 'merged') {
      const parts = ov.filter((o) => isPiece(o.r) && o.ofB >= 0.6);
      const covered = parts.reduce((a, o) => a + o.inter, 0) / Math.max(1, orig.area);
      const split = parts.length >= 2 && covered >= 0.5;
      const nowText = parts.length === 0 ? 'not detected' : parts.length === 1 ? `still one: ${describeRegion(parts[0].r.region, curMatch.get(parts[0].r.id))}` : `${parts.length} regions #${parts.map((o) => o.r.id).join(',#')}`;
      out.marks.push({ index, mark, at, original: origText, now: nowText, fixed: split, verdict: split ? 'SPLIT' : 'STILL MERGED', why: split || parts.length === 0 ? undefined : diagText(parts[0].r.id), currentIds: parts.map((o) => o.r.id) });
      return;
    }
    if (mark.kind === 'bad_outline') {
      const c = correspondent(orig, curR, 0.3);
      if (!c) {
        out.marks.push({ index, mark, at, original: origText, now: 'no corresponding region', fixed: null, verdict: 'GONE', currentIds: [] });
        return;
      }
      const v = ov.find((o) => o.r === c)!.iou;
      const oc = orig.region.shape?.confidence ?? 0, nc = c.region.shape?.confidence ?? 0;
      const changed = v < 0.9 || Math.abs(nc - oc) > 0.1 || !!orig.region.shape !== !!c.region.shape;
      out.marks.push({
        index, mark, at, original: origText, now: `${describeRegion(c.region, curMatch.get(c.id))}, IoU with old ${v.toFixed(2)}`,
        fixed: null, verdict: changed ? 'CHANGED' : 'UNCHANGED', why: diagText(c.id), currentIds: [c.id],
      });
      return;
    }
    // wrong_place
    const members = itemMembers(mark.regionId, original, undefined);
    const curIds = members.map((id) => origById.get(id)).filter((r): r is RasterRegion => !!r).map((r) => correspondent(r, curR)?.id).filter((id): id is number => id !== undefined);
    const origCells = placedCells(members, original);
    const curCells = curIds.length > 0 && out.matched ? placedCells(curIds, current) : [];
    const nowText = !out.matched ? 'not matched (no reference)' : curIds.length === 0 ? 'no corresponding region' : `placed ${formatCells(curCells)}`;
    let fixed: boolean | null = null, verdict = 'UNJUDGED';
    if (out.matched && curIds.length > 0) {
      if (mark.correct) {
        fixed = curCells.some((c) => cellKey(c) === cellKey(mark.correct!));
        verdict = fixed ? 'FIXED' : 'STILL WRONG';
      } else {
        const same = cellJaccard(curCells, origCells) >= 0.5;
        verdict = same ? 'SAME PLACE' : 'MOVED';
      }
    }
    out.marks.push({
      index, mark, at, original: `${origText} placed ${formatCells(origCells)}${mark.correct ? `, correct r${mark.correct.row}c${mark.correct.col}` : ''}`,
      now: nowText, fixed, verdict, currentIds: curIds,
    });
  });

  for (const p of bundle.scan.placements) {
    const members = itemMembers(p.regionId, original, p.cells);
    const origMembers = members.map((id) => origById.get(id)).filter((r): r is RasterRegion => !!r);
    if (origMembers.length === 0) {
      notes.push(`placement of #${p.regionId}: region not in the stored result`);
      continue;
    }
    const curIds = [...new Set(origMembers.map((r) => correspondent(r, curR)?.id).filter((id): id is number => id !== undefined))];
    const originalCells = placedCells(members, original);
    const currentCells = out.matched ? placedCells(curIds, current) : [];
    const c0 = centroidOf(origMembers[0]);
    const x0 = Math.min(...origMembers.map((r) => r.rect.x)), y0 = Math.min(...origMembers.map((r) => r.rect.y));
    const x1 = Math.max(...origMembers.map((r) => r.rect.x + r.rect.width)), y1 = Math.max(...origMembers.map((r) => r.rect.y + r.rect.height));
    out.placements.push({
      regionId: p.regionId, cells: p.cells, at: c0, bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, originalCells, currentCells, currentIds: curIds,
      originalOk: cellsOk(originalCells, p.cells), ok: out.matched && curIds.length > 0 && cellsOk(currentCells, p.cells),
    });
  }
  if (opts.review) for (const j of out.marks) j.review = opts.review.marks[String(j.index)];
  const key = opts.review?.objects;
  if (key?.length) out.objects = { original: scoreObjects(key, origR, opts.review!.area), current: scoreObjects(key, curR, opts.review!.area) };
  out.reviewed = !!opts.review;
  return out;
}

/** Why a point the user marked as a missed piece is still not inside a detected region. */
function missedReason(at: Point, d: SegmentDiagnostics, regions: RasterRegion[], fragment: RasterRegion | undefined): string {
  const parts: string[] = [];
  const score = d.score;
  if (fragment) parts.push(`only a fragment (area ${fragment.area} px, < 35% of a piece)`);
  if (score) {
    const r = Math.max(6, Math.round(0.2 * (d.refBody || 60)));
    const vals: number[] = [];
    let colour = 0, texture = 0, removed = 0, n = 0;
    for (let y = Math.max(0, Math.round(at.y) - r); y <= Math.min(score.height - 1, Math.round(at.y) + r); y++) {
      for (let x = Math.max(0, Math.round(at.x) - r); x <= Math.min(score.width - 1, Math.round(at.x) + r); x++) {
        if ((x - at.x) ** 2 + (y - at.y) ** 2 > r * r) continue;
        const i = y * score.width + x;
        vals.push(score.data[i]);
        n++;
        colour += d.colour?.data[i] ?? 0;
        texture += d.texture?.data[i] ?? 0;
        removed += d.removed?.data[i] ?? 0;
      }
    }
    vals.sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)] ?? 0;
    const p90 = vals[Math.floor(vals.length * 0.9)] ?? 0;
    parts.push(`score median ${med.toFixed(1)} / p90 ${p90.toFixed(1)} vs low ${(d.low ?? 0).toFixed(1)} high ${(d.high ?? 0).toFixed(1)}`);
    if (n > 0) parts.push(`colour mask ${Math.round((100 * colour) / n)}%, texture ${Math.round((100 * texture) / n)}%`);
    if (removed > 0) parts.push(`speck removed (< ${d.minArea} px)`);
    if (!fragment && colour === 0 && texture === 0) parts.push(p90 < (d.low ?? 0) ? 'looks like the table' : 'below the high threshold everywhere');
  }
  const near = regions
    .map((r) => ({ r, d: distanceToRect(r.rect, at) }))
    .filter((x) => x.r !== fragment)
    .sort((a, b) => a.d - b.d)[0];
  if (near && near.d < 3 * (d.refBody || 60)) parts.push(`nearest #${near.r.id} at ${Math.round(near.d)} px`);
  return parts.join('; ');
}

export type FeedbackMetrics = Record<string, number>;

/**
 * Per-file metrics (rates 0..1; keys without any applicable mark are left out so they are neither
 * gated nor averaged): missedFound, falseRemoved, mergedSplit, wrongFixed, placementsTop1, boxError.
 * With a review only marks reviewed 'ok' count; mergedExact is the share of merged marks with a
 * reviewed part count that now come out as exactly that many regions. With an answer key:
 * objectRecall (objects found), objectClean (found alone in their region) and objectPrecision
 * (regions holding an object).
 */
export function feedbackMetrics(r: FeedbackReplay): FeedbackMetrics {
  const m: FeedbackMetrics = {};
  const counts = (j: MarkJudgement) => !r.reviewed || j.review?.verdict === 'ok';
  const rate = (key: string, kind: FeedbackMark['kind'], filter: (j: MarkJudgement) => boolean = () => true) => {
    const js = r.marks.filter((j) => j.mark.kind === kind && j.fixed !== null && counts(j) && filter(j));
    if (js.length > 0) m[key] = js.filter((j) => j.fixed).length / js.length;
  };
  rate('missedFound', 'missed');
  rate('falseRemoved', 'not_a_piece');
  rate('mergedSplit', 'merged');
  const exact = r.marks.filter((j) => j.mark.kind === 'merged' && counts(j) && j.review?.parts);
  if (exact.length > 0) m.mergedExact = exact.filter((j) => j.currentIds.length === j.review!.parts).length / exact.length;
  rate('wrongFixed', 'wrong_place');
  if (r.objects && r.objects.current.objects > 0) {
    const o = r.objects.current;
    m.objectRecall = o.found / o.objects;
    m.objectClean = o.clean / o.objects;
    m.objectPrecision = o.regions > 0 ? o.real / o.regions : 1;
  }
  if (r.placements.length > 0 && r.matched) m.placementsTop1 = r.placements.filter((p) => p.ok).length / r.placements.length;
  if (r.box) m.boxError = r.box.error;
  m.items = r.marks.length + r.placements.length;
  if (r.current) m.regions = r.current.regions.length;
  m.ms = (r.timings.analyze ?? 0) + (r.matched ? 0 : r.timings.segment ?? 0) + (r.timings.box ?? 0);
  return m;
}

export { regionCenter };

/** Replay one feedback file from disk and compute its metrics (bench/feedback.eval.ts, tests). */
export function evaluateFeedbackFile(path: string, opts: ReplayOptions = {}): { replay: FeedbackReplay; metrics: FeedbackMetrics } {
  const name = basename(path).replace(/\.json$/i, '');
  const replay = replayFeedback(readFeedbackFile(path), name, { ...opts, review: opts.review ?? readReview(path) });
  return { replay, metrics: feedbackMetrics(replay) };
}
