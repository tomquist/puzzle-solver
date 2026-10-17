/**
 * Accuracy benchmark helpers (Node only). Scenarios render synthetic photos with exact ground truth,
 * run the real pipeline and score the result. See docs/TESTING.md.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Point, Quad } from '../src/cv/geometry';
import { createMask, createRGBA, type Mask, type Rect, type RGBAImage } from '../src/cv/image';
import { drawPolygon, fillPolygon } from '../src/cv/raster';
import type { CellRef, DetectedRegion, PuzzleSide, RegionMatch, ScanResult } from '../src/model/types';
import { pieceKindOf, Rng, type JigsawCut, type PieceTruth } from '../src/testing/synth';
import { REPO_ROOT } from '../src/testing/nodeImageIO';

// ---------------------------------------------------------------------------------------------
// Scenario item selection
// ---------------------------------------------------------------------------------------------

export interface ItemSpec {
  /** Number of random single pieces. */
  singles: number;
  /** Patch sizes as [rows, cols]. */
  patches?: [number, number][];
  /** Only border pieces as singles. */
  bordersOnly?: boolean;
}

/** Pick non-overlapping items (singles and rectangular patches, anchor = top-left piece first). */
export function pickItems(cut: JigsawCut, spec: ItemSpec, seed: number): (number | number[])[] {
  const rng = new Rng(seed * 31 + 5);
  const used = new Set<number>();
  const items: (number | number[])[] = [];
  for (const [h, w] of spec.patches ?? []) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const r = rng.int(cut.rows - h + 1), c = rng.int(cut.cols - w + 1);
      const idx: number[] = [];
      for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) idx.push((r + dr) * cut.cols + c + dc);
      if (idx.some((i) => used.has(i))) continue;
      // Keep a one-cell gap so single pieces never fit the patch by accident in the truth.
      idx.forEach((i) => used.add(i));
      items.push(idx);
      break;
    }
  }
  const pool = cut.pieces
    .filter((p) => !used.has(p.index))
    .filter((p) => !spec.bordersOnly || p.row === 0 || p.col === 0 || p.row === cut.rows - 1 || p.col === cut.cols - 1)
    .map((p) => p.index);
  for (const i of rng.shuffle(pool).slice(0, spec.singles)) items.push(i);
  return rng.shuffle(items);
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

function polygonBounds(pts: Point[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1) - Math.floor(x0) + 1, height: Math.ceil(y1) - Math.floor(y0) + 1 };
}

interface PolyMask {
  rect: Rect;
  mask: Mask;
  area: number;
}

function rasterize(poly: Point[]): PolyMask {
  const rect = polygonBounds(poly);
  const mask = createMask(rect.width, rect.height);
  fillPolygon(mask, poly.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y })));
  let area = 0;
  for (let i = 0; i < mask.data.length; i++) area += mask.data[i];
  return { rect, mask, area };
}

function iou(a: PolyMask, b: PolyMask): number {
  const x0 = Math.max(a.rect.x, b.rect.x), y0 = Math.max(a.rect.y, b.rect.y);
  const x1 = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width);
  const y1 = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  let inter = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (a.mask.data[(y - a.rect.y) * a.rect.width + (x - a.rect.x)] && b.mask.data[(y - b.rect.y) * b.rect.width + (x - b.rect.x)]) inter++;
    }
  }
  return inter / (a.area + b.area - inter);
}

/**
 * Let Vitest's worker RPC breathe between long CPU-bound scenes (otherwise it reports
 * "Timeout calling onTaskUpdate").
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export function angleError(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

// ---------------------------------------------------------------------------------------------
// Scan evaluation
// ---------------------------------------------------------------------------------------------

export interface ScanMetrics {
  items: number;
  regions: number;
  /** Truth items found as a region with IoU ≥ 0.8. */
  segRecall: number;
  /** Regions that correspond to a truth item. */
  segPrecision: number;
  /** Single pieces: corners detected (region has a shape). */
  shapeRate: number;
  /** Single pieces with a shape: corner/edge/interior classified correctly. */
  kindAccuracy: number;
  /** Matched items placed in the right cell (patches: covered cells Jaccard ≥ 0.5). */
  top1: number;
  /** Single pieces: right cell among the best three candidates. */
  top3: number;
  /** Correct placements with rotation error ≤ 10°. */
  rotationOk: number;
  /** Fraction of 'confident' regions that are placed correctly. */
  confidentPrecision: number;
  /** Fraction of truth items reported as 'confident'. */
  confidentRate: number;
  fitPrecision: number;
  fitRecall: number;
  /** Number of warning/error quality issues (should be 0 on clean scenarios). */
  warnings: number;
  ms: number;
}

const SIDE_DELTA: Record<PuzzleSide, [number, number]> = { top: [-1, 0], right: [0, 1], bottom: [1, 0], left: [0, -1] };

/** Associate regions with ground-truth items and compute all scan metrics. */
export function evaluateScan(result: ScanResult, truth: PieceTruth[], cut: JigsawCut, ms: number): { metrics: ScanMetrics; regionToTruth: Map<number, number> } {
  const truthMasks = truth.map((t) => rasterize(t.outline));
  const regionMasks = new Map<number, PolyMask>(result.regions.map((r) => [r.id, rasterize(r.contour)]));
  const regionToTruth = new Map<number, number>();
  const truthToRegion = new Map<number, number>();
  for (const r of result.regions) {
    let best = -1, bestIoU = 0;
    const rm = regionMasks.get(r.id)!;
    truth.forEach((_, i) => {
      const v = iou(rm, truthMasks[i]);
      if (v > bestIoU) { bestIoU = v; best = i; }
    });
    if (best >= 0 && bestIoU >= 0.8 && !truthToRegion.has(best)) {
      regionToTruth.set(r.id, best);
      truthToRegion.set(best, r.id);
    }
  }
  const matchById = new Map<number, RegionMatch>(result.matches.map((m) => [m.regionId, m]));
  const regionById = new Map<number, DetectedRegion>(result.regions.map((r) => [r.id, r]));
  const cellsOf = (t: PieceTruth): CellRef[] => t.pieces.map((i) => ({ row: cut.pieces[i].row, col: cut.pieces[i].col }));
  const key = (c: CellRef) => `${c.row},${c.col}`;

  let singles = 0, shapes = 0, kindsOk = 0, top1 = 0, top3 = 0, rotOk = 0, confident = 0, confidentOk = 0, matchedItems = 0;
  const correct = new Set<number>();
  truth.forEach((t, i) => {
    const rid = truthToRegion.get(i);
    const isPatch = t.pieces.length > 1;
    if (!isPatch) singles++;
    if (rid === undefined) return;
    matchedItems++;
    const region = regionById.get(rid)!;
    const match = matchById.get(rid);
    if (!isPatch && region.shape) {
      shapes++;
      if (region.shape.kind === pieceKindOf(cut.pieces[t.pieces[0]].sides)) kindsOk++;
    }
    const best = match?.candidates[0];
    let ok = false;
    if (best) {
      if (isPatch) {
        const truthCells = new Set(cellsOf(t).map(key));
        const covered = new Set((match?.coveredCells ?? []).map(key));
        let inter = 0;
        covered.forEach((k) => { if (truthCells.has(k)) inter++; });
        ok = inter / (truthCells.size + covered.size - inter) >= 0.5;
      } else {
        ok = best.row === t.row && best.col === t.col;
        if (match!.candidates.slice(0, 3).some((c) => c.row === t.row && c.col === t.col)) top3++;
      }
    }
    if (ok) {
      top1++;
      correct.add(rid);
      if (angleError(best!.rotationDeg, t.rotationDeg) <= 10) rotOk++;
    }
    if (match?.status === 'confident') {
      confident++;
      if (ok) confidentOk++;
    }
  });
  // Confident regions without any truth item count against precision.
  for (const m of result.matches) if (m.status === 'confident' && !regionToTruth.has(m.regionId)) confident++;

  // Fits: truth adjacency between items.
  const adjacent = (a: PieceTruth, b: PieceTruth) => {
    const cb = new Set(cellsOf(b).map(key));
    return cellsOf(a).some((c) => Object.values(SIDE_DELTA).some(([dr, dc]) => cb.has(key({ row: c.row + dr, col: c.col + dc }))));
  };
  const truthPairs = new Set<string>();
  for (let i = 0; i < truth.length; i++) for (let j = i + 1; j < truth.length; j++) if (adjacent(truth[i], truth[j])) truthPairs.add(`${i}-${j}`);
  let hintsScored = 0, hintsOk = 0;
  const foundPairs = new Set<string>();
  for (const h of result.fits) {
    const ta = regionToTruth.get(h.a), tb = regionToTruth.get(h.b);
    if (ta === undefined || tb === undefined) continue;
    hintsScored++;
    const pair = ta < tb ? `${ta}-${tb}` : `${tb}-${ta}`;
    let ok = truthPairs.has(pair);
    const A = truth[ta], B = truth[tb];
    if (ok && A.pieces.length === 1 && B.pieces.length === 1) {
      const [dr, dc] = SIDE_DELTA[h.sideA];
      ok = A.row + dr === B.row && A.col + dc === B.col;
    }
    if (ok) {
      hintsOk++;
      foundPairs.add(pair);
    }
  }
  const warnings = result.quality.issues.filter((i) => i.severity !== 'info').length;
  const rate = (a: number, b: number) => (b === 0 ? 1 : a / b);
  return {
    regionToTruth,
    metrics: {
      items: truth.length,
      regions: result.regions.length,
      segRecall: rate(matchedItems, truth.length),
      segPrecision: rate(regionToTruth.size, result.regions.length),
      shapeRate: rate(shapes, singles),
      kindAccuracy: rate(kindsOk, shapes),
      top1: rate(top1, truth.length),
      top3: rate(top3, singles),
      rotationOk: rate(rotOk, top1),
      confidentPrecision: rate(confidentOk, confident),
      confidentRate: rate(confident, truth.length),
      fitPrecision: rate(hintsOk, hintsScored),
      fitRecall: rate(foundPairs.size, truthPairs.size),
      warnings,
      ms,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Box evaluation
// ---------------------------------------------------------------------------------------------

/** Max corner distance between two quads as a fraction of the true quad's diagonal. */
export function quadError(found: Quad, truth: Quad): number {
  const diag = Math.hypot(truth[2].x - truth[0].x, truth[2].y - truth[0].y);
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(found[i].x - truth[i].x, found[i].y - truth[i].y));
  return worst / diag;
}

// ---------------------------------------------------------------------------------------------
// Baseline gating and reporting
// ---------------------------------------------------------------------------------------------

/** Metrics where lower is better; everything else is higher-is-better. Timing is report-only. */
const LOWER_IS_BETTER = new Set(['warnings', 'meanError', 'maxError', 'falseWarnings']);
const REPORT_ONLY = new Set(['ms', 'items', 'regions', 'scenes', 'confidentRate']);

export type MetricRecord = Record<string, number>;

export interface Baseline {
  /** Allowed absolute drop for rate metrics before the gate fails. */
  tolerance: number;
  suites: Record<string, Record<string, MetricRecord>>;
}

const BASELINE_PATH = resolve(REPO_ROOT, 'bench/baseline.json');
export const UPDATE_BASELINE = !!process.env.UPDATE_BASELINE;

export function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return { tolerance: 0.03, suites: {} };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
}

export function saveBaselineSuite(suite: string, results: Record<string, MetricRecord>): void {
  const baseline = loadBaseline();
  const rounded: Record<string, MetricRecord> = {};
  for (const [name, rec] of Object.entries(results)) {
    rounded[name] = {};
    for (const [k, v] of Object.entries(rec)) if (!REPORT_ONLY.has(k)) rounded[name][k] = Math.round(v * 1000) / 1000;
  }
  baseline.suites[suite] = rounded;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
}

/** Returns human-readable regressions of `actual` against the baseline (empty = pass). */
export function compareToBaseline(suite: string, scenario: string, actual: MetricRecord): string[] {
  const baseline = loadBaseline();
  const expected = baseline.suites[suite]?.[scenario];
  if (!expected) return [];
  const problems: string[] = [];
  for (const [k, exp] of Object.entries(expected)) {
    const v = actual[k];
    if (v === undefined || REPORT_ONLY.has(k)) continue;
    if (LOWER_IS_BETTER.has(k)) {
      const allowed = k === 'warnings' || k === 'falseWarnings' ? exp : exp + baseline.tolerance;
      if (v > allowed + 1e-9) problems.push(`${scenario}.${k}: ${fmt(v)} > baseline ${fmt(exp)}`);
    } else if (v < exp - baseline.tolerance - 1e-9) {
      problems.push(`${scenario}.${k}: ${fmt(v)} < baseline ${fmt(exp)} - ${baseline.tolerance}`);
    }
  }
  return problems;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** Average a list of metric records (per-scene results → scenario result). */
export function average(records: MetricRecord[]): MetricRecord {
  const out: MetricRecord = {};
  if (records.length === 0) return out;
  for (const k of Object.keys(records[0])) out[k] = records.reduce((s, r) => s + (r[k] ?? 0), 0) / records.length;
  return out;
}

/** Print a markdown table and write the JSON report to .debug/bench/<suite>.json. */
export function report(suite: string, results: Record<string, MetricRecord>, columns: string[]): string {
  const lines = [`| ${suite} | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---:').join('|')}|`];
  for (const [name, rec] of Object.entries(results)) {
    lines.push(`| ${name} | ${columns.map((c) => (rec[c] === undefined ? '' : c === 'ms' ? Math.round(rec[c]).toString() : fmt(rec[c]))).join(' | ')} |`);
  }
  const table = lines.join('\n');
  const out = resolve(REPO_ROOT, `.debug/bench/${suite}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2));
  writeFileSync(resolve(REPO_ROOT, `.debug/bench/${suite}.md`), table + '\n');
  return table;
}

// ---------------------------------------------------------------------------------------------
// Debug overlay
// ---------------------------------------------------------------------------------------------

/** Photo with truth outlines (white) and region outlines (green = correct, red = wrong, yellow = unmatched). */
export function overlay(photo: RGBAImage, result: ScanResult, truth: PieceTruth[], cut: JigsawCut, regionToTruth: Map<number, number>): RGBAImage {
  const out = createRGBA(photo.width, photo.height);
  out.data.set(photo.data);
  for (const t of truth) drawPolygon(out, t.outline, [255, 255, 255, 255], 1);
  const matchById = new Map(result.matches.map((m) => [m.regionId, m]));
  for (const r of result.regions) {
    const ti = regionToTruth.get(r.id);
    const best = matchById.get(r.id)?.candidates[0];
    let color: [number, number, number, number] = [255, 220, 0, 255];
    if (ti !== undefined && best) {
      const t = truth[ti];
      const ok = t.pieces.length > 1 || (best.row === cut.pieces[t.pieces[0]].row && best.col === cut.pieces[t.pieces[0]].col);
      color = ok ? [40, 220, 80, 255] : [240, 40, 40, 255];
    }
    drawPolygon(out, r.contour, color, 3);
  }
  return out;
}
