/**
 * Synthetic feedback files with known answers, for testing the feedback tooling before real files
 * arrive: a rendered scene is analysed with the current pipeline and the stored result is then
 * spoiled the way users report it (a piece dropped → 'missed', a fake region on the table →
 * 'not_a_piece', two pieces fused → 'merged', a wrong top-1 cell → 'wrong_place'), plus confirmed
 * placements from the ground truth and a box photo with its true picture quad.
 */
import type { Point } from '../../src/cv/geometry';
import type { RGBAImage } from '../../src/cv/image';
import { FEEDBACK_FORMAT, FEEDBACK_VERSION, type FeedbackBundle, type FeedbackMark } from '../../src/feedback/format';
import type { CellRef, DetectedRegion, RegionMatch, ScanResult } from '../../src/model/types';
import { analyzeScan } from '../../src/pipeline/analyzeScan';
import { buildReferenceIndex } from '../../src/pipeline/match';
import { loadTestAsset } from '../../src/testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderBoxPhoto, renderPiecesPhoto, Rng, type PieceTruth, type RenderOptions } from '../../src/testing/synth';
import { encodeImageForFeedback } from './io';
import { rasterizeRegions, iou } from './regions';

export interface SyntheticFeedback {
  bundle: FeedbackBundle;
  photo: RGBAImage;
  truth: PieceTruth[];
  /** A table point far from every piece (a 'missed' mark there cannot be fixed). */
  emptyPoint: Point;
}

export interface SyntheticFeedbackOptions {
  seed?: number;
  painting?: 'starry-night' | 'great-wave';
  singles?: number;
  render?: RenderOptions;
  /** Include the reference picture (default true; without it only segmentation can be replayed). */
  reference?: boolean;
  /** Include a box photo with the true picture quad (default true). */
  box?: boolean;
}

function hull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  // Clockwise on screen (y down) = counter-clockwise in math orientation reversed.
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].reverse();
}

function boxOf(pts: Point[]): { x: number; y: number; width: number; height: number } {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x + 1, height: Math.ceil(Math.max(...ys)) - y + 1 };
}

/** Build a feedback bundle from a synthetic scene (see the module comment). */
export function makeSyntheticFeedback(opts: SyntheticFeedbackOptions = {}): SyntheticFeedback {
  const seed = opts.seed ?? 21;
  const src = loadTestAsset(opts.painting ?? 'starry-night');
  const grid = { rows: 16, cols: 20 };
  const cut = generateJigsaw(grid.rows, grid.cols, src.width, src.height, seed);
  const rng = new Rng(seed * 17 + 1);
  const singles = rng.shuffle(cut.pieces.map((p) => p.index)).slice(0, opts.singles ?? 10);
  const render: RenderOptions = { background: [38, 40, 46], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1, margin: 40, ...opts.render, seed: seed + 50 };
  const { photo, truth } = renderPiecesPhoto(src, cut, singles, render);
  const reference = perturbReference(src, { seed });
  const index = buildReferenceIndex(reference, grid, 'grid');
  const result: ScanResult = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height) }).result;

  // Truth item of every region (IoU ≥ 0.8).
  const regs = rasterizeRegions(result.regions);
  const truthRegs = rasterizeRegions(truth.map((t, i) => ({ id: i, kind: 'piece', bbox: t.bbox, contour: t.outline, area: 0, touchesBorder: false, orientationDeg: 0, issues: [] })));
  const truthOf = new Map<number, number>();
  for (const r of regs) {
    const best = truthRegs.map((t) => ({ t, v: iou(r, t) })).sort((a, b) => b.v - a.v)[0];
    if (best && best.v >= 0.8) truthOf.set(r.id, best.t.id);
  }
  const cellOf = (id: number): CellRef => {
    const t = truth[truthOf.get(id)!];
    return { row: t.row, col: t.col };
  };
  const usable = result.regions.filter((r) => truthOf.has(r.id) && r.kind === 'piece').map((r) => r.id);
  if (usable.length < 7) throw new Error(`synthetic feedback: only ${usable.length} usable regions`);
  const marks: FeedbackMark[] = [];
  let regions: DetectedRegion[] = result.regions.map((r) => ({ ...r }));
  let matches: RegionMatch[] = result.matches.map((m) => ({ ...m, candidates: m.candidates.map((c) => ({ ...c })) }));
  const dropRegion = (id: number) => {
    regions = regions.filter((r) => r.id !== id);
    matches = matches.filter((m) => m.regionId !== id);
  };
  let nextId = Math.max(...result.regions.map((r) => r.id)) + 1;

  // 1) Missed: the app "did not find" one piece.
  const missedId = usable[0];
  const missedTruth = truth[truthOf.get(missedId)!];
  dropRegion(missedId);
  marks.push({ kind: 'missed', x: Math.round(missedTruth.center.x), y: Math.round(missedTruth.center.y) });

  // 2) Merged: two pieces reported as one region (their convex hull).
  const centre = (id: number) => {
    const b = result.regions.find((r) => r.id === id)!.bbox;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const a = usable[1];
  const others = usable.slice(2).sort((p, q) => Math.hypot(centre(p).x - centre(a).x, centre(p).y - centre(a).y) - Math.hypot(centre(q).x - centre(a).x, centre(q).y - centre(a).y));
  const b = others[0];
  const ra = result.regions.find((r) => r.id === a)!, rb = result.regions.find((r) => r.id === b)!;
  const fused = hull([...ra.contour, ...rb.contour]);
  dropRegion(a);
  dropRegion(b);
  const mergedId = nextId++;
  regions.push({ id: mergedId, kind: 'patch', bbox: boxOf(fused), contour: fused, area: ra.area + rb.area, touchesBorder: false, orientationDeg: ra.orientationDeg, issues: [] });
  matches.push({ regionId: mergedId, candidates: [], status: 'unmatched' });
  marks.push({ kind: 'merged', regionId: mergedId });

  // 3) Not a piece: a fake region on empty table, as far as possible from every piece.
  const body = Math.sqrt(truth.reduce((s, t) => s + t.bbox.width * t.bbox.height, 0) / truth.length) * 0.75;
  let best: Point = { x: photo.width / 2, y: photo.height / 2 }, bestD = -1;
  for (let y = body; y < photo.height - body; y += body / 4) {
    for (let x = body; x < photo.width - body; x += body / 4) {
      const d = Math.min(...truth.map((t) => Math.max(t.bbox.x - x, x - (t.bbox.x + t.bbox.width), t.bbox.y - y, y - (t.bbox.y + t.bbox.height))));
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  }
  const h = body * 0.4;
  const fake: Point[] = [{ x: best.x - h, y: best.y - h }, { x: best.x + h, y: best.y - h }, { x: best.x + h, y: best.y + h }, { x: best.x - h, y: best.y + h }];
  const fakeId = nextId++;
  regions.push({ id: fakeId, kind: 'piece', bbox: boxOf(fake), contour: fake, area: Math.round(4 * h * h), touchesBorder: false, orientationDeg: 0, issues: [] });
  matches.push({ regionId: fakeId, candidates: [], status: 'unmatched' });
  marks.push({ kind: 'not_a_piece', regionId: fakeId });

  // 4) Wrong place: spoil the stored top-1 cell of a piece; the user knows the right one.
  const wrongId = usable[3] === b ? usable[4] : usable[3];
  const wm = matches.find((m) => m.regionId === wrongId)!;
  const right = cellOf(wrongId);
  const wrong = { row: (right.row + 5) % grid.rows, col: (right.col + 7) % grid.cols };
  wm.candidates = [{ row: wrong.row, col: wrong.col, x: 0, y: 0, rotationDeg: 0, score: 0.5, confidence: 0.8 }, ...wm.candidates];
  wm.status = 'confident';
  marks.push({ kind: 'wrong_place', regionId: wrongId, correct: right });

  // 5) A bad outline (not judged automatically).
  const badId = usable.find((id) => ![missedId, a, b, wrongId].includes(id))!;
  marks.push({ kind: 'bad_outline', regionId: badId });

  // Confirmed placements: three correctly placed pieces.
  const placements = usable
    .filter((id) => ![missedId, a, b, wrongId].includes(id))
    .slice(0, 3)
    .map((id) => ({ regionId: id, cells: [cellOf(id)] }));

  const stored: ScanResult = { ...result, regions: regions.sort((p, q) => p.id - q.id), matches, groups: [], fits: [] };
  const bundle: FeedbackBundle = {
    format: FEEDBACK_FORMAT,
    version: FEEDBACK_VERSION,
    createdAt: Date.UTC(2026, 9, 17, 12, 0),
    app: { version: 'synthetic', userAgent: 'node', viewport: { width: 390, height: 844, dpr: 3 } },
    puzzle: { pieceCount: grid.rows * grid.cols, grid, cut: 'grid' },
    scan: { photo: encodeImageForFeedback(photo, 'image/jpeg', 92), result: stored, placements },
    marks,
    comment: 'synthetic feedback (scripts/feedback/synthetic.ts)',
  };
  if (opts.reference !== false) bundle.reference = encodeImageForFeedback(reference, 'image/jpeg', 92);
  if (opts.box !== false) {
    const box = renderBoxPhoto(perturbReference(src, { seed: seed + 1 }), { seed, width: 1200, height: 900 });
    bundle.box = { photo: encodeImageForFeedback(box.photo, 'image/jpeg', 90), quad: box.pictureQuad };
  }
  // A table point far from all pieces (and from the fake region).
  let empty: Point = { x: 0, y: 0 }, emptyD = -1;
  for (let y = body; y < photo.height - body; y += body / 4) {
    for (let x = body; x < photo.width - body; x += body / 4) {
      const d = Math.min(Math.hypot(x - best.x, y - best.y), ...truth.map((t) => Math.max(t.bbox.x - x, x - (t.bbox.x + t.bbox.width), t.bbox.y - y, y - (t.bbox.y + t.bbox.height))));
      if (d > emptyD) { emptyD = d; empty = { x: Math.round(x), y: Math.round(y) }; }
    }
  }
  return { bundle, photo, truth, emptyPoint: empty };
}
