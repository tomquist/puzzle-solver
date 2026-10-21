/**
 * The background cell-size measurements: their steps wait while a scan is analysed (a new scan's
 * result goes first), the evidence lands in its scan in place of the placeholder, a re-analysed
 * scan keeps only its newest measurement, and a measurement lost with a reload is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID_EVIDENCE_VERSION, type GridEvidence, type ScanRecord } from '../../model/types';
import { createMemoryRepository } from '../../storage/memoryRepository';
import type { GridFollowUpStep, PipelineApi } from '../../worker/api';
import { analysingScan, dropStaleMeasurements, queueGridMeasurement, setMeasurementTarget } from './gridMeasurements';

const evidence = (n: number, pending = false): GridEvidence => ({
  version: GRID_EVIDENCE_VERSION,
  grid: { rows: 4, cols: 5 },
  refWidth: 500,
  refHeight: 400,
  sources: pending ? [] : [{ kind: 'pieces', regionIds: [n], x: [50, 150], y: [50, 150] }],
  ...(pending ? { pending: true } : {}),
});

const scan = (id: string): ScanRecord => ({
  id,
  puzzleId: 'p',
  createdAt: 1,
  photoBlobId: `b-${id}`,
  width: 10,
  height: 10,
  result: { width: 10, height: 10, regions: [], matches: [], fits: [], groups: [{ id: 1, kind: 'neighbors', regionIds: [1, 2], cells: [], bounds: { row0: 0, col0: 0, row1: 0, col1: 0 }, x: 0, y: 0, confidence: 0.5 }], quality: { score: 1, issues: [], metrics: {} }, timings: {}, gridEvidence: evidence(0, true) },
});

/** A pipeline whose measurements take `steps` steps each and end with evidence `n` (the token's number). */
function fakePipeline(steps: number) {
  const calls: string[] = [];
  const left = new Map<string, number>();
  const pipeline = {
    async gridFollowUpStep(token: string): Promise<GridFollowUpStep> {
      calls.push(token);
      const n = (left.get(token) ?? steps) - 1;
      left.set(token, n);
      return n > 0 ? { done: false } : { done: true, evidence: evidence(Number(token.slice(1))) };
    },
  } as unknown as PipelineApi;
  return { pipeline, calls };
}

/** Let the queue run (fake timers: it waits for the page before its first step). */
const settle = () => vi.advanceTimersByTimeAsync(10_000);

describe('grid measurements', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wait for a scan being analysed, then fill the placeholder (keeping the rest of the scan)', async () => {
    const repo = createMemoryRepository();
    await repo.saveScan(scan('s1'));
    const { pipeline, calls } = fakePipeline(3);
    const changed: string[] = [];
    setMeasurementTarget({ repo, pipeline, changed: (id) => changed.push(id) });
    let release!: () => void;
    const analysing = analysingScan(() => new Promise<void>((resolve) => (release = resolve)));
    queueGridMeasurement('t7', 's1', 'p');
    await settle();
    expect(calls).toEqual([]);
    release();
    await analysing;
    await settle();
    expect(calls).toEqual(['t7', 't7', 't7']);
    const saved = await repo.getScan('s1');
    expect(saved?.result.gridEvidence).toEqual(evidence(7));
    expect(saved?.result.groups).toHaveLength(1);
    expect(changed).toEqual(['p']);
  });

  it('keeps only the newest measurement of a re-analysed scan; drops what a reload lost', async () => {
    const repo = createMemoryRepository();
    await repo.saveScan(scan('s1'));
    await repo.saveScan(scan('s2'));
    const { pipeline, calls } = fakePipeline(2);
    setMeasurementTarget({ repo, pipeline, changed: () => {} });
    let release!: () => void;
    const analysing = analysingScan(() => new Promise<void>((resolve) => (release = resolve)));
    queueGridMeasurement('t1', 's1', 'p');
    queueGridMeasurement('t2', 's1', 'p');
    // s2's measurement was lost (not queued): dropped, its scan counts by positions.
    release();
    await analysing;
    await settle();
    expect(calls.filter((t) => t === 't1')).toEqual([]);
    expect((await repo.getScan('s1'))?.result.gridEvidence).toEqual(evidence(2));
    expect(await dropStaleMeasurements(repo, 'p')).toBe(true);
    const s2 = await repo.getScan('s2');
    expect(s2?.result.gridEvidence).toBeUndefined();
    expect(s2?.result.groups).toHaveLength(1);
    expect(await dropStaleMeasurements(repo, 'p')).toBe(false);
  });
});
