import { describe, expect, it } from 'vitest';
import type { ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';
import { buildFeedbackBundle, byteLength, placementsForScan } from './build';
import { decodeFeedbackImageBytes, parseFeedback, serializeFeedback } from './format';

const puzzle: PuzzleRecord = {
  id: 'p1',
  name: 'Secret family photo',
  createdAt: 1,
  updatedAt: 1,
  pieceCount: 500,
  grid: { rows: 20, cols: 25 },
  cut: 'grid',
  physicalSize: { width: 49, height: 36, unit: 'cm' },
  reference: { blobId: 'r', width: 1000, height: 800 },
  thumbnailBlobId: 't',
  sources: [],
};

const scan: ScanRecord = {
  id: 's1',
  puzzleId: 'p1',
  createdAt: 2,
  photoBlobId: 'b',
  width: 4,
  height: 3,
  result: { width: 4, height: 3, regions: [], matches: [], fits: [], quality: { score: 1, issues: [], metrics: {} }, timings: {} },
};

const progress: ProgressRecord = {
  puzzleId: 'p1',
  updatedAt: 3,
  placed: {
    '5,7': { at: 1, scanId: 's1', regionId: 4 },
    '5,6': { at: 1, scanId: 's1', regionId: 4 },
    '2,2': { at: 1, scanId: 's1', regionId: 1 },
    '9,9': { at: 1, scanId: 'other', regionId: 1 },
    '8,8': { at: 1, scanId: 's1' },
    '7,7': { at: 1 },
  },
};

const app = { version: 'abc', userAgent: 'UA', viewport: { width: 390, height: 844, dpr: 3 }, language: 'en' };
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i));

describe('placementsForScan', () => {
  it('groups this scan’s placed cells by region, sorted', () => {
    expect(placementsForScan(progress, 's1')).toEqual([
      { regionId: 1, cells: [{ row: 2, col: 2 }] },
      { regionId: 4, cells: [{ row: 5, col: 6 }, { row: 5, col: 7 }] },
    ]);
    expect(placementsForScan(progress, 'nope')).toEqual([]);
    expect(placementsForScan(undefined, 's1')).toEqual([]);
  });
});

describe('buildFeedbackBundle', () => {
  it('packs scan, reference, box, marks and comment', () => {
    const b = buildFeedbackBundle({
      createdAt: 42,
      app,
      puzzle,
      reference: { bytes: bytes(10), type: 'image/jpeg', width: 1000, height: 800 },
      box: { bytes: bytes(5), type: 'image/jpeg', width: 400, height: 300, quad: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }] },
      scan: { record: scan, photo: { bytes: bytes(7), type: 'image/jpeg', width: 4, height: 3 } },
      progress,
      marks: [{ kind: 'missed', x: 1, y: 2 }, { kind: 'not_a_piece', regionId: 9 }],
      comment: '  two pieces missed  ',
    });
    expect(b.createdAt).toBe(42);
    expect(b.app).toEqual(app);
    expect(b.puzzle).toEqual({ pieceCount: 500, grid: { rows: 20, cols: 25 }, cut: 'grid', physicalSize: { width: 49, height: 36, unit: 'cm' } });
    expect(JSON.stringify(b)).not.toContain('Secret family photo');
    expect([...decodeFeedbackImageBytes(b.reference!)]).toEqual([...bytes(10)]);
    expect(b.box!.quad).toEqual([{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }]);
    expect(b.scan!.photo).toMatchObject({ width: 4, height: 3, type: 'image/jpeg' });
    expect(b.scan!.placements).toHaveLength(2);
    // The result's own build and time (the app may have updated since the scan).
    expect(b.scan!.analysedAt).toBe(2);
    expect(b.scan!.appVersion).toBeUndefined();
    const stamped = buildFeedbackBundle({ createdAt: 42, app, puzzle, scan: { record: { ...scan, appVersion: 'old123' }, photo: { bytes: bytes(7), type: 'image/jpeg', width: 4, height: 3 } }, marks: [] });
    expect(stamped.scan!.appVersion).toBe('old123');
    expect(b.marks).toEqual([{ kind: 'missed', x: 1, y: 2 }, { kind: 'not_a_piece', regionId: 9 }]);
    expect(b.comment).toBe('two pieces missed');
    // Valid feedback file.
    const text = serializeFeedback(b);
    expect(parseFeedback(text).scan!.result.width).toBe(4);
    expect(byteLength(text)).toBe(text.length);
  });

  it('leaves out optional parts (box-only feedback from Settings)', () => {
    const b = buildFeedbackBundle({ createdAt: 1, app, puzzle: { ...puzzle, physicalSize: undefined }, box: { bytes: bytes(3), type: 'image/jpeg', width: 2, height: 2, quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, marks: [], comment: '   ' });
    expect(b.scan).toBeUndefined();
    expect(b.reference).toBeUndefined();
    expect(b.comment).toBeUndefined();
    expect('physicalSize' in b.puzzle).toBe(false);
    expect(b.box).toBeDefined();
    expect(() => parseFeedback(serializeFeedback(b))).not.toThrow();
  });

  it('copies marks instead of sharing them', () => {
    const marks = [{ kind: 'merged' as const, regionId: 2 }];
    const b = buildFeedbackBundle({ createdAt: 1, app, puzzle, marks });
    marks[0].regionId = 99;
    expect(b.marks).toEqual([{ kind: 'merged', regionId: 2 }]);
  });
});
