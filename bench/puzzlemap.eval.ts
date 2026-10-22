/**
 * Placement on other puzzles: real piece photos from the Puzzle-Map dataset (Hugging Face
 * pablo-moreira/puzzle-map, CC BY 4.0; fetched by `npm run corpus:fetch-puzzlemap` into the
 * git-ignored test-corpus/puzzle-map/, skipped when it is missing). Each labelled piece is matched
 * against its puzzle's reference picture and scored against its labelled cell and turn.
 *
 * The photos are webcam / phone shots, mostly of a single piece held between the fingers in front
 * of a desk, some of pieces lying on a table; the labels give a box per piece (knobs included), its
 * side kinds (flat / knob / hole, as seen in the photo), the small tilt in the photo, and the cell
 * and quarter turn in the puzzle. Two ways to hand a piece to the matcher, both scored:
 *   annotated  the piece as the matcher would get it from a good outline: an idealised outline and
 *              piece shape (body corners, side kinds) built from the labels (body centre and size
 *              from the box and the side kinds, turned by the labelled tilt). Measures matching
 *              alone, as if segmentation were right.
 *   segmented  our segmentation on the photo around the box (25 % margin); the region over the body
 *              centre goes to the matcher as in a scan. Misses count as wrong placements. Most
 *              photos show fingers and a desk around the piece, which segmentation is not made for.
 *
 * Truth: `puzzle.angle` is the counter-clockwise turn of the piece in the photo (the side kinds of
 * 642 / 643 labels agree with the border cells under that reading), so the clockwise turn back to
 * upright (Placement.rotationDeg) is angle − tilt.
 * Metrics per reference picture: items, cells (chance of a random top-1 is 1 / cells), top1, top3,
 * rotationOk (top-1 correct with the turn within 10°), confidentRate / confidentPrecision
 * ('confident' placements and the share of them that are right), segFound / segTop1 / segTop3, segErrors
 * (photos where segmentPieces threw; counted as not found).
 * Gated by bench/baseline.json (suite 'puzzlemap') when the data is there; PUZZLEMAP_LIMIT=<n>
 * runs the first n photos only (no gate, no baseline update); DEBUG_IMAGES=1 writes the first
 * annotated outlines per puzzle to .debug/bench/puzzlemap/.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMask, cropRGBA, type RGBAImage } from '../src/cv/image';
import type { GridSpec, PieceShape, RegionMatch, SideKind } from '../src/model/types';
import { buildReferenceIndex, matchRegions, type MatchInput, type ReferenceIndex } from '../src/pipeline/match';
import { segmentPieces, type Segmentation } from '../src/pipeline/pieces';
import { DEBUG_IMAGES, loadImageFile, REPO_ROOT, savePng, SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';
import { angleError, compareToBaseline, report, saveBaselineSuite, UPDATE_BASELINE, yieldToEventLoop, type CalibrationPair, type MetricRecord } from './lib';
import { saveCalibrationPairs } from './calibration';

const DIR = resolve(REPO_ROOT, 'test-corpus/puzzle-map');
const PIECES = resolve(DIR, 'pieces/annotations.json');
const PUZZLES = resolve(DIR, 'puzzles/annotations.json');
const LIMIT = Number(process.env.PUZZLEMAP_LIMIT) || Infinity;
const COLUMNS = ['items', 'cells', 'top1', 'top3', 'rotationOk', 'confidentRate', 'confidentPrecision', 'segFound', 'segTop1', 'segTop3', 'segErrors', 'ms'];

type SideLabel = 'INNER' | 'OUTER' | 'SMOOTH';
interface PieceLabel {
  /** xmin, ymin, xmax, ymax in photo px, knobs included. */
  bbox: [number, number, number, number];
  valid?: boolean;
  /** Tilt in the photo (degrees, clockwise on screen). */
  rotation?: number;
  sides: { top: SideLabel; right: SideLabel; bottom: SideLabel; left: SideLabel };
  /** 1-based row / column; angle: counter-clockwise quarter turn of the piece in the photo. */
  puzzle?: { name: string; row: number; column: number; angle: number };
}

/** Knob length relative to the body side (typical cut: 0.2–0.25). */
const KNOB = 0.22;

const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** Body centre and side length of a labelled piece, from its box and side kinds. */
function bodyOf(p: PieceLabel): { cx: number; cy: number; size: number } {
  const [x0, y0, x1, y1] = p.bbox;
  const knob = (s: SideLabel) => (s === 'OUTER' ? 1 : 0);
  const t = ((p.rotation ?? 0) * Math.PI) / 180;
  const spread = Math.abs(Math.cos(t)) + Math.abs(Math.sin(t));
  const bw = (x1 - x0) / (1 + KNOB * (knob(p.sides.left) + knob(p.sides.right)));
  const bh = (y1 - y0) / (1 + KNOB * (knob(p.sides.top) + knob(p.sides.bottom)));
  const size = (bw + bh) / 2 / spread;
  const cx = (x0 + x1) / 2 + (KNOB * size * (knob(p.sides.left) - knob(p.sides.right))) / 2;
  const cy = (y0 + y1) / 2 + (KNOB * size * (knob(p.sides.top) - knob(p.sides.bottom))) / 2;
  return { cx, cy, size };
}

const SIDE_KIND: Record<SideLabel, SideKind> = { OUTER: 'tab', INNER: 'blank', SMOOTH: 'flat' };

/**
 * The 'annotated' input: an idealised outline from the labels (the body square turned by the tilt,
 * slightly shrunk, a round knob on every knob side, a round hole cut on every hole side) with its
 * corners and side kinds as the piece shape, as segmentation would deliver a well-outlined piece.
 */
function annotatedInput(photo: RGBAImage, p: PieceLabel): MatchInput {
  const { cx, cy, size: b } = bodyOf(p);
  const t = ((p.rotation ?? 0) * Math.PI) / 180;
  // Local axes of the piece on screen: u = its right, v = its bottom.
  const u = { x: Math.cos(t), y: Math.sin(t) }, v = { x: -Math.sin(t), y: Math.cos(t) };
  const at = (lx: number, ly: number) => ({ x: cx + lx * u.x + ly * v.x, y: cy + lx * u.y + ly * v.y });
  const labels = [p.sides.top, p.sides.right, p.sides.bottom, p.sides.left];
  const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const reach = 0.8 * b;
  const x = Math.max(0, Math.floor(cx - reach)), y = Math.max(0, Math.floor(cy - reach));
  const rect = { x, y, width: Math.min(photo.width, Math.ceil(cx + reach)) - x, height: Math.min(photo.height, Math.ceil(cy + reach)) - y };
  const mask = createMask(rect.width, rect.height);
  const half = 0.47 * b, knobR = 0.13 * b;
  for (let j = 0; j < rect.height; j++) {
    for (let i = 0; i < rect.width; i++) {
      const dx = i + rect.x + 0.5 - cx, dy = j + rect.y + 0.5 - cy;
      const lx = dx * u.x + dy * u.y, ly = dx * v.x + dy * v.y;
      let inside = Math.abs(lx) <= half && Math.abs(ly) <= half;
      labels.forEach((s, k) => {
        const [nx, ny] = normals[k];
        if (s === 'OUTER' && Math.hypot(lx - 0.6 * b * nx, ly - 0.6 * b * ny) <= knobR) inside = true;
        if (s === 'INNER' && Math.hypot(lx - 0.38 * b * nx, ly - 0.38 * b * ny) <= knobR) inside = false;
      });
      if (inside) mask.data[j * rect.width + i] = 1;
    }
  }
  const h = b / 2;
  const side = (s: SideLabel) => ({ kind: SIDE_KIND[s], length: b, profile: [] });
  const sides: PieceShape['sides'] = [side(labels[0]), side(labels[1]), side(labels[2]), side(labels[3])];
  const flats = labels.filter((s) => s === 'SMOOTH').length;
  // Outline orientation in (-45, 45], clockwise on screen like PieceShape.angleDeg.
  let o = p.rotation ?? 0;
  while (o > 45) o -= 90;
  while (o <= -45) o += 90;
  const shape: PieceShape = {
    corners: [at(-h, -h), at(h, -h), at(h, h), at(-h, h)], sides, angleDeg: o, bodySize: b, center: { x: cx, y: cy },
    kind: flats >= 2 ? 'corner' : flats === 1 ? 'edge' : 'interior', confidence: 1,
  };
  return { regionId: 1, kind: 'piece', image: cropRGBA(photo, rect), mask, origin: { x: rect.x, y: rect.y }, shape, orientationDeg: o, expectedBodySize: b };
}

/** The 'segmented' input: our segmentation around the box, the region over the body centre (an Error when segmentation throws). */
function segmentedInput(photo: RGBAImage, p: PieceLabel): MatchInput | Error | null {
  const [x0, y0, x1, y1] = p.bbox;
  const mx = 0.25 * (x1 - x0), my = 0.25 * (y1 - y0);
  const X0 = Math.max(0, Math.floor(x0 - mx)), Y0 = Math.max(0, Math.floor(y0 - my));
  const rect = { x: X0, y: Y0, width: Math.min(photo.width, Math.ceil(x1 + mx)) - X0, height: Math.min(photo.height, Math.ceil(y1 + my)) - Y0 };
  let seg: Segmentation;
  try {
    seg = segmentPieces(cropRGBA(photo, rect), SEGMENT_OPTIONS);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  const { cx, cy } = bodyOf(p);
  const px = Math.round(cx - rect.x), py = Math.round(cy - rect.y);
  const hit = seg.regions.find(({ region: r, mask }) => {
    const i = px - r.bbox.x, j = py - r.bbox.y;
    return r.kind !== 'unknown' && i >= 0 && j >= 0 && i < mask.width && j < mask.height && mask.data[j * mask.width + i] === 1;
  });
  if (!hit) return null;
  const r = hit.region;
  return {
    regionId: 1, kind: r.kind, image: hit.image, mask: hit.mask, origin: { x: r.bbox.x, y: r.bbox.y }, shape: r.shape,
    orientationDeg: r.orientationDeg, expectedBodySize: seg.medianBodySize, outline: { borderTable: hit.borderTable, issues: r.issues.map((i) => i.code) },
  };
}

/** The input's crop with the mask tinted and the shape corners marked (DEBUG_IMAGES). */
function maskOverlay(input: MatchInput): RGBAImage {
  const out = { width: input.image.width, height: input.image.height, data: new Uint8ClampedArray(input.image.data) };
  for (let i = 0; i < input.mask.data.length; i++) {
    if (input.mask.data[i]) continue;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = out.data[i * 4 + c] * 0.35;
  }
  for (const q of input.shape?.corners ?? []) {
    const x = Math.round(q.x - input.origin.x), y = Math.round(q.y - input.origin.y);
    for (let d = -3; d <= 3; d++) {
      for (const [px, py] of [[x + d, y], [x, y + d]]) {
        if (px >= 0 && py >= 0 && px < out.width && py < out.height) out.data.set([255, 0, 255, 255], (py * out.width + px) * 4);
      }
    }
  }
  return out;
}

interface Tally {
  items: number; cells: number; top1: number; top3: number; rotOk: number; confident: number; confidentOk: number;
  segFound: number; segTop1: number; segTop3: number; segErrors: number; ms: number;
}

const newTally = (cells: number): Tally => ({ items: 0, cells, top1: 0, top3: 0, rotOk: 0, confident: 0, confidentOk: 0, segFound: 0, segTop1: 0, segTop3: 0, segErrors: 0, ms: 0 });

function record(t: Tally): MetricRecord {
  const rate = (a: number, b: number) => (b > 0 ? a / b : 0);
  return {
    items: t.items, cells: t.cells, top1: rate(t.top1, t.items), top3: rate(t.top3, t.items), rotationOk: rate(t.rotOk, t.items),
    confidentRate: rate(t.confident, t.items), confidentPrecision: t.confident > 0 ? t.confidentOk / t.confident : 1,
    segFound: rate(t.segFound, t.items), segTop1: rate(t.segTop1, t.items), segTop3: rate(t.segTop3, t.items), segErrors: t.segErrors, ms: t.ms,
  };
}

describe('puzzle-map placement', () => {
  if (!existsSync(PIECES) || !existsSync(PUZZLES)) {
    it.skip('no Puzzle-Map data (npm run corpus:fetch-puzzlemap)', () => {});
    return;
  }
  const labels = JSON.parse(readFileSync(PIECES, 'utf8')) as Record<string, { pieces: PieceLabel[] }>;
  const grids = JSON.parse(readFileSync(PUZZLES, 'utf8')) as Record<string, { rows: number; columns: number }>;
  const photos = Object.keys(labels).filter((f) => labels[f].pieces.some((p) => p.puzzle)).sort().slice(0, LIMIT);
  const byPuzzle = new Map<string, { photo: string; piece: PieceLabel }[]>();
  for (const photo of photos) {
    for (const piece of labels[photo].pieces) {
      if (!piece.puzzle) continue;
      const list = byPuzzle.get(piece.puzzle.name) ?? [];
      list.push({ photo, piece });
      byPuzzle.set(piece.puzzle.name, list);
    }
  }
  const results: Record<string, MetricRecord> = {};
  const all = newTally(0);
  const pairs: CalibrationPair[] = [];

  for (const [name, items] of [...byPuzzle].sort(([a], [b]) => a.localeCompare(b))) {
    it(name, async () => {
      const g = grids[name];
      const grid: GridSpec = { rows: g.rows, cols: g.columns };
      const index: ReferenceIndex = buildReferenceIndex(loadImageFile(resolve(DIR, 'puzzles', name)), grid, 'grid');
      const t = newTally(grid.rows * grid.cols);
      const decoded = new Map<string, RGBAImage>();
      for (const { photo, piece } of items) {
        await yieldToEventLoop();
        if (!decoded.has(photo)) decoded.clear(), decoded.set(photo, loadImageFile(resolve(DIR, 'pieces', photo)));
        const img = decoded.get(photo)!;
        const { row, column, angle } = piece.puzzle!;
        const truthRot = norm360(angle - (piece.rotation ?? 0));
        const judge = (m: RegionMatch | undefined) => {
          const keys = (m?.candidates ?? []).map((c) => `${c.row},${c.col}`);
          const cell = `${row - 1},${column - 1}`;
          return { top1: keys[0] === cell, top3: keys.slice(0, 3).includes(cell), m };
        };
        const start = performance.now();
        const input = annotatedInput(img, piece);
        const a = judge(matchRegions(index, [input])[0]);
        if (DEBUG_IMAGES && t.items < 6) savePng(`.debug/bench/puzzlemap/${name}-${t.items + 1}.png`, maskOverlay(input));
        t.items++;
        if (a.top1) t.top1++;
        if (a.top3) t.top3++;
        if (a.top1 && angleError(a.m!.candidates[0].rotationDeg, truthRot) <= 10) t.rotOk++;
        if (a.m?.status === 'confident') {
          t.confident++;
          if (a.top1) t.confidentOk++;
        }
        const best = a.m?.candidates[0];
        if (a.m && best && a.m.status !== 'unmatched') {
          pairs.push({ confidence: best.confidence, status: a.m.status, cell: a.top1, turn: a.top1 && angleError(best.rotationDeg, truthRot) <= 10, top3: a.top3, reason: a.m.uncertainReason });
        }
        const segInput = segmentedInput(img, piece);
        if (segInput instanceof Error) {
          t.segErrors++;
          console.warn(`${photo}: segmentation failed: ${segInput.message}`);
        } else if (segInput) {
          t.segFound++;
          const s = judge(matchRegions(index, [segInput])[0]);
          if (s.top1) t.segTop1++;
          if (s.top3) t.segTop3++;
        }
        t.ms += performance.now() - start;
      }
      for (const k of Object.keys(t) as (keyof Tally)[]) all[k] += t[k];
      results[name] = record(t);
      if (UPDATE_BASELINE || LIMIT < Infinity) return;
      const problems = compareToBaseline('puzzlemap', name, results[name]);
      expect(problems, problems.join('\n')).toEqual([]);
    }, 2_400_000);
  }

  afterAll(() => {
    if (Object.keys(results).length === 0) return;
    const overall = record(all);
    delete overall.cells;
    results.overall = overall;
    console.log('\n' + report('puzzlemap', results, COLUMNS) + '\n');
    if (LIMIT === Infinity) saveCalibrationPairs('puzzlemap', pairs);
    if (UPDATE_BASELINE && LIMIT === Infinity) saveBaselineSuite('puzzlemap', results);
  });
});
