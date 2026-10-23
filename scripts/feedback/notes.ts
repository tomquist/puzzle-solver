/**
 * Judging the marks noted while placing (FeedbackNote → FeedbackMark, see src/ui/lib/scanNotes.ts)
 * under the current pipeline – kept apart from replay.ts, which calls these:
 * - 'wrong_fit' (two items said to join don't fit): does the current result still link them?
 *   FIXED when not, STILL SUGGESTED when it does.
 * - 'wrong_place' with rejected spots ("Not here", no known right cell): does the current result
 *   still put the item in one of them? MOVED AWAY when not, STILL SUGGESTED when it does.
 */
import type { Point } from '../../src/cv/geometry';
import type { FeedbackMark, RejectedSpot } from '../../src/feedback/format';
import type { CellRef, GridSpec, ScanResult } from '../../src/model/types';
import { buildScanItems } from '../../src/ui/lib/items';
import type { MarkJudgement } from './replay';
import { cellKey, centroidOf, correspondent, formatCells, type RasterRegion } from './regions';

type WrongFitMark = Extract<FeedbackMark, { kind: 'wrong_fit' }>;

export interface NoteContext {
  original: ScanResult;
  current: ScanResult;
  /** True when the current result was matched (the file has a reference picture). */
  matched: boolean;
  grid: GridSpec;
  origById: Map<number, RasterRegion>;
  curR: RasterRegion[];
}

/** Regions of an item label in a result: an assembled group's members (labelled by its smallest id), or the region. */
export function labelMembers(label: number, result: ScanResult): number[] {
  const g = (result.groups ?? []).find((x) => x.kind === 'assembled' && x.regionIds.includes(label) && Math.min(...x.regionIds) === label);
  return g ? g.regionIds : [label];
}

/** Keys of the items holding these regions, and whether two sets of items are linked. */
function linkState(result: ScanResult, grid: GridSpec, a: number[], b: number[]): { shown: boolean; linked: boolean; same: boolean } {
  const { items, links } = buildScanItems(result, grid);
  const keysOf = (ids: number[]) => new Set(items.filter((i) => i.regionIds.some((id) => ids.includes(id))).map((i) => i.key));
  const ka = keysOf(a);
  const kb = keysOf(b);
  const same = [...ka].some((k) => kb.has(k));
  const linked = links.some((l) => (ka.has(l.a) && kb.has(l.b)) || (ka.has(l.b) && kb.has(l.a)));
  return { shown: ka.size > 0 && kb.size > 0, linked, same };
}

const sideText = (m: WrongFitMark) => (m.sideA ? ` (#${m.a}'s ${m.sideA} side)` : '');

/** Judge a 'wrong_fit' mark: is the connection still suggested? */
export function judgeWrongFit(index: number, mark: WrongFitMark, ctx: NoteContext): MarkJudgement {
  const membersA = labelMembers(mark.a, ctx.original);
  const membersB = labelMembers(mark.b, ctx.original);
  const origA = membersA.map((id) => ctx.origById.get(id)).filter((r): r is RasterRegion => !!r);
  const origB = membersB.map((id) => ctx.origById.get(id)).filter((r): r is RasterRegion => !!r);
  const centres = [...origA, ...origB].map(centroidOf);
  const at: Point = centres.length
    ? { x: centres.reduce((s, c) => s + c.x, 0) / centres.length, y: centres.reduce((s, c) => s + c.y, 0) / centres.length }
    : { x: 0, y: 0 };
  const before = linkState(ctx.original, ctx.grid, membersA, membersB);
  const original = `#${mark.a} + #${mark.b}${sideText(mark)} ${before.linked ? 'joined' : 'not joined (?)'}`;
  if (origA.length === 0 || origB.length === 0) {
    return { index, mark, at, original: `#${mark.a} + #${mark.b} missing`, now: '-', fixed: null, verdict: 'INVALID', currentIds: [] };
  }
  const corr = (rs: RasterRegion[]) => [...new Set(rs.map((r) => correspondent(r, ctx.curR)?.id).filter((id): id is number => id !== undefined))];
  const curA = corr(origA);
  const curB = corr(origB);
  const currentIds = [...curA, ...curB];
  if (!ctx.matched) return { index, mark, at, original, now: 'not matched (no reference)', fixed: null, verdict: 'UNJUDGED', currentIds };
  if (curA.length === 0 || curB.length === 0) return { index, mark, at, original, now: 'no corresponding region', fixed: null, verdict: 'GONE', currentIds };
  const now = linkState(ctx.current, ctx.grid, curA, curB);
  if (now.same) return { index, mark, at, original, now: `#${curA.join(',#')} and #${curB.join(',#')} in one item`, fixed: null, verdict: 'ONE ITEM', currentIds };
  const text = `#${curA.join(',#')} + #${curB.join(',#')} ${now.linked ? 'still joined' : now.shown ? 'not joined' : 'not both shown'}`;
  return { index, mark, at, original, now: text, fixed: !now.linked, verdict: now.linked ? 'STILL SUGGESTED' : 'FIXED', currentIds };
}

/** The rejected spots in words: "r3c5, r4c5 (turn 90)". */
export function rejectedText(spots: RejectedSpot[]): string {
  return spots.map((s) => `r${s.row}c${s.col}${s.rotationDeg !== undefined ? ` (turn ${Math.round(s.rotationDeg)})` : ''}`).join(', ');
}

/** Verdict of a 'wrong_place' mark with rejected spots and no right cell, from the current cells. */
export function judgeRejectedSpots(spots: RejectedSpot[], currentCells: CellRef[]): { fixed: boolean; verdict: string; now: string } {
  const at = new Set(currentCells.map(cellKey));
  const still = spots.filter((s) => at.has(cellKey(s)));
  return still.length > 0
    ? { fixed: false, verdict: 'STILL SUGGESTED', now: `placed ${formatCells(currentCells)}, still at rejected ${rejectedText(still)}` }
    : { fixed: true, verdict: 'MOVED AWAY', now: `placed ${formatCells(currentCells)}` };
}
