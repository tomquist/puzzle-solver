/**
 * Placement truth for a feedback file: where every piece of the photo really belongs. A sidecar next
 * to the file, `<name>.truth.json`, holds it; bench/private.eval.ts replays the file and scores the
 * result against it. Truth files live with private feedback files (test-corpus/private/, which is
 * git-ignored: those files carry the puzzle's commercial picture and must never be committed).
 *
 *   {
 *     "format": "puzzle-solver-truth", "version": 1,
 *     "feedback": "fb18.json", "created": "2026-10-20",
 *     "method": "how the truth was established",
 *     "pieces": [{ "x": 812, "y": 455, "row": 18, "col": 21, "rotationDeg": 146, "unsure": false, "note": "…" }],
 *     "blocks": [{ "x": 1100, "y": 1000, "cells": [{ "row": 10, "col": 21 }, …], "rotationDeg": 207 }]
 *   }
 *
 * - Coordinates are photo pixels of `scan.photo` (the image as analysed): a point well inside the
 *   piece or assembled block.
 * - `row`/`col`: the piece's cell in the puzzle grid (0-based, as `Placement.row/col`).
 * - `rotationDeg`: the app's convention (`Placement.rotationDeg`): the clockwise turn, in degrees
 *   [0, 360), that takes the piece from how it lies in the photo to upright.
 * - `blocks`: assembled groups placed as one (their cells and common rotation).
 * - `unsure`: identity or placement not certain; such items count in neither direction.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Point } from '../../src/cv/geometry';
import type { CellRef, RegionMatch, ScanResult, UncertainReason } from '../../src/model/types';
import { cellJaccard, cellKey, containsPoint, rasterizeRegions, type RasterRegion } from './regions';

export const TRUTH_FORMAT = 'puzzle-solver-truth';

export interface PieceTruth {
  x: number;
  y: number;
  row: number;
  col: number;
  rotationDeg: number;
  unsure?: boolean;
  note?: string;
}

export interface BlockTruth {
  x: number;
  y: number;
  cells: CellRef[];
  rotationDeg: number;
  unsure?: boolean;
  note?: string;
}

export interface PlacementTruth {
  format: typeof TRUTH_FORMAT;
  version: number;
  /** File name of the feedback file this truth belongs to. */
  feedback: string;
  /** Date the truth was established (YYYY-MM-DD). */
  created?: string;
  method?: string;
  pieces?: PieceTruth[];
  blocks?: BlockTruth[];
}

export const isTruthFile = (path: string): boolean => /\.truth\.json$/i.test(path);

export function truthPath(feedbackPath: string): string {
  return feedbackPath.replace(/\.json$/i, '') + '.truth.json';
}

/** Validate parsed truth (throws on anything malformed). */
export function parseTruth(data: unknown, where = 'truth'): PlacementTruth {
  const t = data as PlacementTruth;
  if (!t || t.format !== TRUTH_FORMAT || t.version !== 1) throw new Error(`${where}: not a ${TRUTH_FORMAT} v1 file`);
  const finite = (...v: unknown[]) => v.every((x) => typeof x === 'number' && Number.isFinite(x));
  for (const p of t.pieces ?? []) {
    if (!finite(p.x, p.y, p.row, p.col, p.rotationDeg) || p.row < 0 || p.col < 0) throw new Error(`${where}: bad piece ${JSON.stringify(p)}`);
  }
  for (const b of t.blocks ?? []) {
    if (!finite(b.x, b.y, b.rotationDeg) || !Array.isArray(b.cells) || b.cells.length === 0 || !b.cells.every((c) => finite(c.row, c.col))) {
      throw new Error(`${where}: bad block at ${b.x},${b.y}`);
    }
  }
  return t;
}

/** The truth next to a feedback file, if there is one. */
export function readTruth(feedbackPath: string): PlacementTruth | undefined {
  const path = truthPath(feedbackPath);
  return existsSync(path) ? parseTruth(JSON.parse(readFileSync(path, 'utf8')), path) : undefined;
}

/** Smallest difference between two angles in degrees. */
function angleError(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

/** A rotation within this many degrees of the truth counts as right. */
export const ROTATION_TOLERANCE = 10;

/** Outcome of one truth item. */
export interface TruthJudgement {
  kind: 'piece' | 'block';
  index: number;
  at: Point;
  unsure: boolean;
  truth: string;
  /** Region holding the point (piece / patch kind only). */
  regionId?: number;
  /** Other truth items in the same region (pieces merged into one region). */
  merged: boolean;
  status?: RegionMatch['status'];
  top1: boolean;
  top3: boolean;
  rotationOk: boolean;
  confident: boolean;
  /** Confidence of the best placement (0 when not placed). */
  confidence: number;
  /** Why the placement is unsure (`RegionMatch.uncertainReason`). */
  reason?: UncertainReason;
  /** Blocks: cell Jaccard of the placement with the truth. */
  jaccard?: number;
  placed: string;
}

export interface TruthScore {
  items: TruthJudgement[];
  /** Rates over the sure items (see {@link truthMetrics}). */
  metrics: Record<string, number>;
}

const fmtCells = (cells: CellRef[]) => (cells.length === 1 ? `r${cells[0].row}c${cells[0].col}` : `${cells.length} cells`);

/**
 * Score a scan result against the truth. Pieces: the region under the point (found), whether it
 * also holds other truth items (merged), and its placement: top-1 / top-3 cell (a patch region:
 * its covered cells hold the piece's cell), rotation within {@link ROTATION_TOLERANCE}° (of top-1
 * placements), confident. 'unmatched' regions count as not placed. Blocks: placed when the covered
 * cells overlap the truth cells with Jaccard ≥ 0.5.
 */
export function scoreTruth(result: ScanResult, truth: PlacementTruth): TruthScore {
  const regions = rasterizeRegions(result.regions).filter((r) => r.region.kind !== 'unknown');
  const matches = new Map(result.matches.map((m) => [m.regionId, m]));
  const at = (p: Point): RasterRegion | undefined => regions.find((r) => containsPoint(r, p));
  const points = [...(truth.pieces ?? []), ...(truth.blocks ?? [])];
  const holders = points.map((p) => at(p)?.id);
  const count = new Map<number, number>();
  for (const id of holders) if (id !== undefined) count.set(id, (count.get(id) ?? 0) + 1);
  const items: TruthJudgement[] = [];
  const placedCells = (m: RegionMatch | undefined): CellRef[] => {
    const c = m?.candidates[0];
    if (!m || !c || m.status === 'unmatched') return [];
    return m.coveredCells && m.coveredCells.length > 0 ? m.coveredCells : [{ row: c.row, col: c.col }];
  };
  (truth.pieces ?? []).forEach((p, i) => {
    const id = holders[i];
    const m = id === undefined ? undefined : matches.get(id);
    const region = id === undefined ? undefined : regions.find((r) => r.id === id)!.region;
    const placed = placedCells(m);
    const key = cellKey(p);
    const best = m && m.status !== 'unmatched' ? m.candidates[0] : undefined;
    const isPatch = region?.kind === 'patch' && (m?.coveredCells?.length ?? 0) > 0;
    const top1 = isPatch ? placed.some((c) => cellKey(c) === key) : !!best && cellKey(best) === key;
    const top3 = top1 || (!isPatch && !!m && m.status !== 'unmatched' && m.candidates.slice(0, 3).some((c) => cellKey(c) === key));
    items.push({
      kind: 'piece', index: i, at: { x: p.x, y: p.y }, unsure: !!p.unsure, truth: `r${p.row}c${p.col} ${Math.round(p.rotationDeg)}°`,
      regionId: id, merged: id !== undefined && (count.get(id) ?? 0) > 1, status: m?.status,
      top1, top3, rotationOk: top1 && !!best && angleError(best.rotationDeg, p.rotationDeg) <= ROTATION_TOLERANCE,
      confident: m?.status === 'confident', confidence: best?.confidence ?? 0, reason: m?.uncertainReason, placed: best ? `${fmtCells(placed)} ${Math.round(best.rotationDeg)}°` : 'not placed',
    });
  });
  const nPieces = truth.pieces?.length ?? 0;
  (truth.blocks ?? []).forEach((b, i) => {
    const id = holders[nPieces + i];
    const m = id === undefined ? undefined : matches.get(id);
    const placed = placedCells(m);
    const best = m && m.status !== 'unmatched' ? m.candidates[0] : undefined;
    const jaccard = placed.length > 0 ? cellJaccard(placed, b.cells) : 0;
    const top1 = jaccard >= 0.5;
    items.push({
      kind: 'block', index: i, at: { x: b.x, y: b.y }, unsure: !!b.unsure, truth: `${b.cells.length} cells ${Math.round(b.rotationDeg)}°`,
      regionId: id, merged: id !== undefined && (count.get(id) ?? 0) > 1, status: m?.status,
      top1, top3: top1, rotationOk: top1 && !!best && angleError(best.rotationDeg, b.rotationDeg) <= ROTATION_TOLERANCE,
      confident: m?.status === 'confident', confidence: best?.confidence ?? 0, jaccard, placed: best ? `${fmtCells(placed)} ${Math.round(best.rotationDeg)}°` : 'not placed',
    });
  });
  return { items, metrics: truthMetrics(items) };
}

/**
 * Rates over the sure items. Pieces: found (inside a piece / patch region), merged (sharing it with
 * another truth item), top1, top3, rotationOk (share of the top-1 placements), confidentShare
 * (confident placements of all pieces), confidentPrecision (top-1 right among the confident),
 * confidentTurnPrecision (top-1 right and turned within {@link ROTATION_TOLERANCE}° among the
 * confident). Blocks: blockFound, blockTop1 (Jaccard ≥ 0.5), blockJaccard (mean), blockRotationOk. Counts:
 * pieces, blocks, unsure.
 */
export function truthMetrics(items: TruthJudgement[]): Record<string, number> {
  const out: Record<string, number> = {};
  const sure = items.filter((j) => !j.unsure);
  const rate = (xs: TruthJudgement[], f: (j: TruthJudgement) => boolean) => (xs.length === 0 ? NaN : xs.filter(f).length / xs.length);
  const pieces = sure.filter((j) => j.kind === 'piece');
  const blocks = sure.filter((j) => j.kind === 'block');
  out.pieces = pieces.length;
  out.unsure = items.length - sure.length;
  if (pieces.length > 0) {
    out.found = rate(pieces, (j) => j.regionId !== undefined);
    out.merged = rate(pieces, (j) => j.merged);
    out.top1 = rate(pieces, (j) => j.top1);
    out.top3 = rate(pieces, (j) => j.top3);
    const right = pieces.filter((j) => j.top1);
    out.rotationOk = right.length === 0 ? 0 : rate(right, (j) => j.rotationOk);
    out.confidentShare = rate(pieces, (j) => j.confident);
    const conf = pieces.filter((j) => j.confident);
    if (conf.length > 0) {
      out.confidentPrecision = rate(conf, (j) => j.top1);
      out.confidentTurnPrecision = rate(conf, (j) => j.top1 && j.rotationOk);
    }
  }
  out.blocks = blocks.length;
  if (blocks.length > 0) {
    out.blockFound = rate(blocks, (j) => j.regionId !== undefined);
    out.blockTop1 = rate(blocks, (j) => j.top1);
    out.blockJaccard = blocks.reduce((a, j) => a + (j.jaccard ?? 0), 0) / blocks.length;
    out.blockRotationOk = rate(blocks, (j) => j.rotationOk);
  }
  return out;
}

/** The sure single pieces that were placed (not 'unmatched'), as calibration pairs (bench/calibration.ts). */
export function truthCalibrationPairs(items: readonly TruthJudgement[]): { confidence: number; status: RegionMatch['status']; cell: boolean; turn: boolean; top3: boolean; reason?: UncertainReason }[] {
  return items
    .filter((j) => j.kind === 'piece' && !j.unsure && j.status !== undefined && j.status !== 'unmatched' && j.placed !== 'not placed')
    .map((j) => ({ confidence: j.confidence, status: j.status!, cell: j.top1, turn: j.rotationOk, top3: j.top3, reason: j.reason }));
}
