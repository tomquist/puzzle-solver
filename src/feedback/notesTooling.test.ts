/**
 * The developer tooling's verdicts on noted marks (scripts/feedback/notes.ts): is a connection the
 * user said doesn't fit still suggested, is a piece still put in a spot the user rejected?
 */
import { describe, expect, it } from 'vitest';
import { judgeRejectedSpots, judgeWrongFit, labelMembers, type NoteContext } from '../../scripts/feedback/notes';
import { formatSummary } from '../../scripts/feedback/inspect';
import { rasterizeRegions } from '../../scripts/feedback/regions';
import { feedbackMetrics, replayFeedback } from '../../scripts/feedback/replay';
import { makeSyntheticFeedback } from '../../scripts/feedback/synthetic';
import type { DetectedRegion, Placement, RegionGroup, RegionMatch, ScanResult } from '../model/types';
import { parseFeedback, serializeFeedback } from './format';

function square(id: number, x: number, y: number, size = 40): DetectedRegion {
  return {
    id,
    kind: 'piece',
    bbox: { x, y, width: size, height: size },
    contour: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }],
    area: size * size,
    touchesBorder: false,
    orientationDeg: 0,
    issues: [],
  };
}
const place = (row: number, col: number): Placement => ({ row, col, x: col * 10 + 5, y: row * 10 + 5, rotationDeg: 0, score: 0.5, confidence: 0.9 });
const match = (regionId: number, ...candidates: Placement[]): RegionMatch => ({ regionId, status: 'confident', candidates });
const group = (id: number, kind: RegionGroup['kind'], regionIds: number[], cells: { row: number; col: number }[] = []): RegionGroup => ({
  id,
  kind,
  regionIds,
  cells,
  bounds: { row0: 0, col0: 0, row1: 0, col1: 0 },
  x: 0,
  y: 0,
  confidence: 0.9,
});
const grid = { rows: 10, cols: 10 };
const scan = (matches: RegionMatch[], groups: RegionGroup[]): ScanResult => ({
  width: 400,
  height: 300,
  regions: [square(1, 10, 10), square(2, 100, 10), square(3, 200, 10)],
  matches,
  fits: [],
  groups,
  quality: { score: 1, issues: [], metrics: {} },
  timings: {},
});

/** The app said 1 and 2 join (r1c1 | r1c2). */
const original = scan([match(1, place(1, 1)), match(2, place(1, 2)), match(3, place(5, 5))], [group(1, 'neighbors', [1, 2])]);
const ctx = (current: ScanResult, matched = true): NoteContext => ({
  original,
  current,
  matched,
  grid,
  origById: new Map(rasterizeRegions(original.regions).map((r) => [r.id, r])),
  curR: rasterizeRegions(current.regions),
});

describe('noted marks in the feedback tooling', () => {
  const mark = { kind: 'wrong_fit' as const, a: 1, b: 2, sideA: 'right' as const, sideB: 'left' as const };

  it('says STILL SUGGESTED while the pipeline still joins the pair', () => {
    const j = judgeWrongFit(1, mark, ctx(original));
    expect(j).toMatchObject({ fixed: false, verdict: 'STILL SUGGESTED', currentIds: [1, 2] });
    expect(j.original).toBe("#1 + #2 (#1's right side) joined");
  });

  it('says FIXED once the pair is no longer joined', () => {
    const current = scan([match(1, place(1, 1)), match(2, place(7, 7)), match(3, place(5, 5))], []);
    expect(judgeWrongFit(1, mark, ctx(current))).toMatchObject({ fixed: true, verdict: 'FIXED' });
  });

  it('cannot judge without matching, or when a piece is gone', () => {
    expect(judgeWrongFit(1, mark, ctx(original, false))).toMatchObject({ fixed: null, verdict: 'UNJUDGED' });
    const gone = { ...original, regions: [square(1, 10, 10), square(3, 200, 10)] };
    expect(judgeWrongFit(1, mark, ctx(gone))).toMatchObject({ fixed: null, verdict: 'GONE' });
    expect(judgeWrongFit(1, { ...mark, b: 42 }, ctx(original))).toMatchObject({ fixed: null, verdict: 'INVALID' });
  });

  it('finds the members of an assembled group by its label', () => {
    const withGroup = { ...original, groups: [group(1, 'assembled', [3, 2], [{ row: 1, col: 2 }])] };
    expect(labelMembers(2, withGroup)).toEqual([3, 2]);
    expect(labelMembers(3, withGroup)).toEqual([3]);
  });

  it('replays a file with noted marks end to end (judged, counted, summarised)', () => {
    const { bundle } = makeSyntheticFeedback({ seed: 21, box: false });
    const [a, b] = bundle.scan!.result.regions.filter((r) => r.kind === 'piece').map((r) => r.id);
    const top = bundle.scan!.result.matches.find((m) => m.regionId === b)!.candidates[0];
    bundle.marks.push({ kind: 'wrong_fit', a, b }, { kind: 'wrong_place', regionId: b, rejected: [{ row: top.row, col: top.col }] });
    const replay = replayFeedback(parseFeedback(serializeFeedback(bundle)), 'noted');
    const fit = replay.marks.find((j) => j.mark.kind === 'wrong_fit')!;
    expect(['FIXED', 'STILL SUGGESTED', 'ONE ITEM', 'GONE']).toContain(fit.verdict);
    const spot = replay.marks.at(-1)!;
    expect(['MOVED AWAY', 'STILL SUGGESTED', 'UNJUDGED']).toContain(spot.verdict);
    const metrics = feedbackMetrics(replay);
    if (fit.fixed !== null) expect(metrics.fitFixed).toBe(fit.fixed ? 1 : 0);
    expect(formatSummary(replay)).toMatch(new RegExp(`wrong_fit\\s+#${a}\\+#${b}`));
  }, 120_000);

  it('says whether a piece is still put in a spot the user rejected', () => {
    const spots = [{ row: 1, col: 2, rotationDeg: 90 }, { row: 6, col: 6 }];
    expect(judgeRejectedSpots(spots, [{ row: 6, col: 6 }])).toMatchObject({ fixed: false, verdict: 'STILL SUGGESTED' });
    expect(judgeRejectedSpots(spots, [{ row: 3, col: 3 }])).toMatchObject({ fixed: true, verdict: 'MOVED AWAY' });
  });
});
