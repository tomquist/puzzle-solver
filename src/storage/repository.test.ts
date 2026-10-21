import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { cellKey, GRID_EVIDENCE_VERSION, type Id, type PuzzleRecord, type ScanRecord, type ScanResult } from '../model/types';
import {
  createIndexedDbRepository,
  createMemoryRepository,
  EXPORT_FORMAT,
  exportFileName,
  newId,
  PuzzleImportError,
  PuzzleNotFoundError,
  type PuzzleRepository,
} from './index';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function pseudoRandomBytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function makeBlob(n: number, seed: number, type = 'image/jpeg'): Blob {
  return new Blob([pseudoRandomBytes(n, seed)], { type });
}

async function bytesOf(blob: Blob | undefined): Promise<Uint8Array> {
  expect(blob).toBeDefined();
  return new Uint8Array(await blob!.arrayBuffer());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const emptyResult: ScanResult = {
  width: 100,
  height: 80,
  regions: [],
  matches: [],
  fits: [],
  quality: { score: 1, issues: [], metrics: {} },
  timings: {},
};

async function addPuzzle(
  repo: PuzzleRepository,
  opts: { name?: string; updatedAt?: number; referenceBytes?: number } = {},
): Promise<PuzzleRecord> {
  const reference = await repo.putBlob(makeBlob(opts.referenceBytes ?? 2000, 1));
  const thumb = await repo.putBlob(makeBlob(300, 2));
  const overview = await repo.putBlob(makeBlob(1500, 3));
  const closeup = await repo.putBlob(makeBlob(900, 4, 'image/png'));
  const puzzle: PuzzleRecord = {
    id: newId(),
    name: opts.name ?? 'Night Sky',
    createdAt: 1000,
    updatedAt: opts.updatedAt ?? 2000,
    pieceCount: 1000,
    physicalSize: { width: 70, height: 50, unit: 'cm' },
    grid: { rows: 27, cols: 38 },
    cut: 'grid',
    reference: { blobId: reference, width: 3800, height: 2700 },
    thumbnailBlobId: thumb,
    sources: [
      {
        blobId: overview,
        width: 4000,
        height: 3000,
        role: 'overview',
        quad: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
          { x: 7, y: 8 },
        ],
      },
      { blobId: closeup, width: 2000, height: 1500, role: 'closeup', toReference: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    ],
  };
  await repo.savePuzzle(puzzle);
  return puzzle;
}

async function addScan(repo: PuzzleRepository, puzzleId: Id, createdAt: number, label?: string): Promise<ScanRecord> {
  const photoBlobId = await repo.putBlob(makeBlob(700, createdAt));
  const scan: ScanRecord = { id: newId(), puzzleId, createdAt, photoBlobId, width: 100, height: 80, result: emptyResult, label };
  await repo.saveScan(scan);
  return scan;
}

// ---------------------------------------------------------------------------------------------
// Shared suite
// ---------------------------------------------------------------------------------------------

const implementations: [string, () => PuzzleRepository][] = [
  ['memory', () => createMemoryRepository()],
  ['indexeddb', () => createIndexedDbRepository(`test-${newId()}`)],
];

describe.each(implementations)('%s repository', (_name, create) => {
  it('saves, lists (most recently updated first), updates and gets puzzles', async () => {
    const repo = create();
    expect(await repo.listPuzzles()).toEqual([]);
    expect(await repo.getPuzzle('missing')).toBeUndefined();

    const a = await addPuzzle(repo, { name: 'A', updatedAt: 10 });
    const b = await addPuzzle(repo, { name: 'B', updatedAt: 20 });
    expect((await repo.listPuzzles()).map((p) => p.name)).toEqual(['B', 'A']);
    expect(await repo.getPuzzle(a.id)).toEqual(a);

    await repo.savePuzzle({ ...a, name: 'A2', updatedAt: 30 });
    expect((await repo.listPuzzles()).map((p) => p.name)).toEqual(['A2', 'B']);
    expect((await repo.getPuzzle(a.id))?.name).toBe('A2');

    // Returned records are copies.
    const got = await repo.getPuzzle(b.id);
    got!.name = 'changed';
    expect((await repo.getPuzzle(b.id))?.name).toBe('B');
  });

  it('stores blobs with type and exact bytes', async () => {
    const repo = create();
    const source = makeBlob(12345, 7, 'image/png');
    const id = await repo.putBlob(source);
    const back = await repo.getBlob(id);
    expect(back?.type).toBe('image/png');
    expect(back?.size).toBe(12345);
    expect(sameBytes(await bytesOf(back), new Uint8Array(await source.arrayBuffer()))).toBe(true);

    const empty = await repo.putBlob(new Blob([]));
    expect((await repo.getBlob(empty))?.size).toBe(0);
    expect(empty).not.toBe(id);

    await repo.deleteBlob(id);
    expect(await repo.getBlob(id)).toBeUndefined();
    expect(await repo.getBlob('missing')).toBeUndefined();
    await repo.deleteBlob('missing'); // no-op
  });

  it('lists scans of one puzzle newest first and deletes a scan with its photo', async () => {
    const repo = create();
    const p1 = await addPuzzle(repo);
    const p2 = await addPuzzle(repo);
    const s1 = await addScan(repo, p1.id, 100, 'first');
    const s3 = await addScan(repo, p1.id, 300, 'third');
    const s2 = await addScan(repo, p1.id, 200, 'second');
    const other = await addScan(repo, p2.id, 250);

    expect((await repo.listScans(p1.id)).map((s) => s.label)).toEqual(['third', 'second', 'first']);
    expect((await repo.listScans(p2.id)).map((s) => s.id)).toEqual([other.id]);
    expect(await repo.listScans('missing')).toEqual([]);
    expect(await repo.getScan(s2.id)).toEqual(s2);
    expect(await repo.getScan('missing')).toBeUndefined();

    await repo.saveScan({ ...s1, label: 'renamed' });
    expect((await repo.getScan(s1.id))?.label).toBe('renamed');

    // A change in one step, on the record as stored; undefined leaves it.
    const changed = await Promise.all([
      repo.updateScan(s1.id, (s) => ({ ...s, label: `${s.label}+a` })),
      repo.updateScan(s1.id, (s) => ({ ...s, label: `${s.label}+b` })),
    ]);
    expect(changed[1]?.label).toBe('renamed+a+b');
    expect((await repo.getScan(s1.id))?.label).toBe('renamed+a+b');
    expect(await repo.updateScan(s1.id, () => undefined)).toBeUndefined();
    expect((await repo.getScan(s1.id))?.label).toBe('renamed+a+b');
    expect(await repo.updateScan('missing', (s) => s)).toBeUndefined();

    await repo.deleteScan(s3.id);
    expect(await repo.getScan(s3.id)).toBeUndefined();
    expect(await repo.getBlob(s3.photoBlobId)).toBeUndefined();
    expect(await repo.getBlob(s2.photoBlobId)).toBeDefined();
    expect((await repo.listScans(p1.id)).map((s) => s.id)).toEqual([s2.id, s1.id]);
    await repo.deleteScan('missing'); // no-op
  });

  it('returns empty progress by default and stores progress', async () => {
    const repo = create();
    expect(await repo.getProgress('p')).toEqual({ puzzleId: 'p', placed: {}, updatedAt: 0 });
    const progress = { puzzleId: 'p', placed: { [cellKey({ row: 1, col: 2 })]: { at: 5, regionId: 3 } }, updatedAt: 5 };
    await repo.saveProgress(progress);
    expect(await repo.getProgress('p')).toEqual(progress);
    expect(await repo.getProgress('q')).toEqual({ puzzleId: 'q', placed: {}, updatedAt: 0 });
  });

  it('deletePuzzle cascades to blobs, scans and progress but leaves other puzzles alone', async () => {
    const repo = create();
    const doomed = await addPuzzle(repo);
    const kept = await addPuzzle(repo);
    const scans = [await addScan(repo, doomed.id, 1), await addScan(repo, doomed.id, 2)];
    const keptScan = await addScan(repo, kept.id, 3);
    await repo.saveProgress({ puzzleId: doomed.id, placed: { '0,0': { at: 1, scanId: scans[0].id } }, updatedAt: 1 });
    await repo.saveProgress({ puzzleId: kept.id, placed: { '0,1': { at: 1 } }, updatedAt: 1 });

    await repo.deletePuzzle(doomed.id);

    expect(await repo.getPuzzle(doomed.id)).toBeUndefined();
    const doomedBlobs = [
      doomed.reference.blobId,
      doomed.thumbnailBlobId,
      ...doomed.sources.map((s) => s.blobId),
      ...scans.map((s) => s.photoBlobId),
    ];
    for (const id of doomedBlobs) expect(await repo.getBlob(id)).toBeUndefined();
    for (const s of scans) expect(await repo.getScan(s.id)).toBeUndefined();
    expect(await repo.listScans(doomed.id)).toEqual([]);
    expect((await repo.getProgress(doomed.id)).updatedAt).toBe(0);

    expect(await repo.getPuzzle(kept.id)).toEqual(kept);
    expect(await repo.getBlob(kept.reference.blobId)).toBeDefined();
    expect(await repo.getBlob(keptScan.photoBlobId)).toBeDefined();
    expect((await repo.getProgress(kept.id)).placed).toEqual({ '0,1': { at: 1 } });
    await repo.deletePuzzle('missing'); // no-op
  });

  it('exports and re-imports a puzzle with fresh ids and byte-identical blobs', async () => {
    const repo = create();
    const original = await addPuzzle(repo, { name: 'Big', referenceBytes: 3 * 1024 * 1024 + 7 });
    const scanA = await addScan(repo, original.id, 100, 'a');
    const scanB = await addScan(repo, original.id, 200, 'b');
    const progress = {
      puzzleId: original.id,
      placed: {
        '0,0': { at: 1, scanId: scanA.id, regionId: 2 },
        '0,1': { at: 2, scanId: scanB.id },
        '5,5': { at: 3 },
        '6,6': { at: 4, scanId: 'deleted-scan' },
      },
      updatedAt: 4,
    };
    await repo.saveProgress(progress);

    const file = await repo.exportPuzzle(original.id);
    expect(file.type).toBe('application/json');
    const json = JSON.parse(await file.text()) as Record<string, unknown>;
    expect(json.format).toBe(EXPORT_FORMAT);
    expect(json.version).toBe(1);
    expect(typeof json.exportedAt).toBe('number');
    expect(Object.keys(json.blobs as object)).toHaveLength(6);

    // Import into the same repository: everything gets new ids, the name is disambiguated.
    const imported = await repo.importPuzzle(file);
    expect(imported.id).not.toBe(original.id);
    expect(imported.name).toBe('Big (imported)');
    expect(await repo.getPuzzle(imported.id)).toEqual(imported);
    expect(imported.grid).toEqual(original.grid);
    expect(imported.sources.map((s) => s.quad ?? s.toReference)).toEqual(
      original.sources.map((s) => s.quad ?? s.toReference),
    );

    const pairs: [Id, Id][] = [
      [original.reference.blobId, imported.reference.blobId],
      [original.thumbnailBlobId, imported.thumbnailBlobId],
      ...original.sources.map((s, i): [Id, Id] => [s.blobId, imported.sources[i].blobId]),
    ];
    const newScans = await repo.listScans(imported.id);
    expect(newScans.map((s) => s.label)).toEqual(['b', 'a']);
    const oldScans = [scanB, scanA];
    newScans.forEach((s, i) => {
      expect(s.id).not.toBe(oldScans[i].id);
      expect(s.puzzleId).toBe(imported.id);
      expect(s.result).toEqual(oldScans[i].result);
      pairs.push([oldScans[i].photoBlobId, s.photoBlobId]);
    });
    for (const [oldId, newBlobId] of pairs) {
      expect(newBlobId).not.toBe(oldId);
      const [a, b] = [await repo.getBlob(oldId), await repo.getBlob(newBlobId)];
      expect(b?.type).toBe(a?.type);
      expect(sameBytes(await bytesOf(a), await bytesOf(b))).toBe(true);
    }
    expect((await repo.getBlob(imported.reference.blobId))?.size).toBe(3 * 1024 * 1024 + 7);

    const newProgress = await repo.getProgress(imported.id);
    const newScanA = newScans.find((s) => s.label === 'a')!;
    const newScanB = newScans.find((s) => s.label === 'b')!;
    expect(newProgress).toEqual({
      puzzleId: imported.id,
      placed: {
        '0,0': { at: 1, scanId: newScanA.id, regionId: 2 },
        '0,1': { at: 2, scanId: newScanB.id },
        '5,5': { at: 3 },
        '6,6': { at: 4 },
      },
      updatedAt: 4,
    });

    // The original is untouched; a second import gets another name.
    expect(await repo.getPuzzle(original.id)).toEqual(original);
    expect(await repo.getProgress(original.id)).toEqual(progress);
    expect((await repo.importPuzzle(file)).name).toBe('Big (imported 2)');

    // Deleting the copy does not affect the original's blobs.
    await repo.deletePuzzle(imported.id);
    expect(await repo.getBlob(original.reference.blobId)).toBeDefined();

    // A fresh repository keeps the plain name.
    const other = create();
    const copy = await other.importPuzzle(file);
    expect(copy.name).toBe('Big');
    expect(await other.listScans(copy.id)).toHaveLength(2);
    expect(sameBytes(await bytesOf(await other.getBlob(copy.reference.blobId)), await bytesOf(await repo.getBlob(original.reference.blobId)))).toBe(true);
  });

  it('keeps the grid state with the puzzle and carries its per-scan evidence over on import', async () => {
    const repo = create();
    const original = await addPuzzle(repo, { name: 'Grid' });
    const scanA = await addScan(repo, original.id, 100, 'a');
    const evidence = {
      version: GRID_EVIDENCE_VERSION,
      grid: { rows: 27, cols: 38 },
      refWidth: 3800,
      refHeight: 2700,
      sources: [{ kind: 'patch' as const, regionIds: [1], w: { log: 4.6, se: 0.01, n: 5 }, x: [10.5], y: [20.5] }],
    };
    const withState: PuzzleRecord = {
      ...original,
      pieceCountKind: 'about',
      gridState: {
        status: 'unconfirmed',
        scans: { [scanA.id]: evidence, 'deleted-scan': evidence },
        declined: [{ rows: 27, cols: 39 }],
        left: [],
        suggestion: { grid: { rows: 28, cols: 38 }, odds: 40, sources: 3, scans: 2, at: 5 },
      },
    };
    await repo.savePuzzle(withState);
    expect(await repo.getPuzzle(original.id)).toEqual(withState);

    const imported = await repo.importPuzzle(await repo.exportPuzzle(original.id));
    const [newScan] = await repo.listScans(imported.id);
    expect(imported.pieceCountKind).toBe('about');
    expect(imported.gridState?.status).toBe('unconfirmed');
    expect(imported.gridState?.declined).toEqual([{ rows: 27, cols: 39 }]);
    expect(imported.gridState?.suggestion?.grid).toEqual({ rows: 28, cols: 38 });
    // Keyed by the new scan id; evidence of a scan that is not in the file is dropped.
    expect(imported.gridState?.scans).toEqual({ [newScan.id]: evidence });
  });

  it('exports a puzzle without scans or progress', async () => {
    const repo = create();
    const p = await addPuzzle(repo);
    const copy = await create().importPuzzle(await repo.exportPuzzle(p.id));
    expect(copy.name).toBe(p.name);
    await expect(repo.exportPuzzle('missing')).rejects.toBeInstanceOf(PuzzleNotFoundError);
  });

  it('rejects invalid import files without writing anything', async () => {
    const repo = create();
    const p = await addPuzzle(repo);
    const valid = JSON.parse(await (await repo.exportPuzzle(p.id)).text()) as Record<string, unknown>;
    const json = (v: unknown) => new Blob([JSON.stringify(v)], { type: 'application/json' });
    const firstBlobId = Object.keys(valid.blobs as object)[0];

    const bad: [string, Blob][] = [
      ['not json', new Blob(['hello'])],
      ['array', json([1, 2])],
      ['wrong format', json({ ...valid, format: 'something-else' })],
      ['newer version', json({ ...valid, version: 99 })],
      ['missing puzzle', json({ ...valid, puzzle: undefined })],
      ['puzzle without reference', json({ ...valid, puzzle: { ...(valid.puzzle as object), reference: null } })],
      ['bad scans', json({ ...valid, scans: [{ id: 'x' }] })],
      ['missing blobs', json({ ...valid, blobs: undefined })],
      ['corrupted base64', json({ ...valid, blobs: { ...(valid.blobs as object), [firstBlobId]: { type: 'image/jpeg', base64: '%%%' } } })],
    ];
    for (const [label, file] of bad) {
      await expect(repo.importPuzzle(file), label).rejects.toBeInstanceOf(PuzzleImportError);
    }
    expect(await repo.listPuzzles()).toHaveLength(1);
  });

  it('estimates usage without throwing', async () => {
    const usage = await create().estimateUsage();
    expect(typeof usage).toBe('object');
  });
});

// ---------------------------------------------------------------------------------------------
// Implementation-specific
// ---------------------------------------------------------------------------------------------

describe('indexeddb repository', () => {
  it('persists across repository instances (page reloads)', async () => {
    const name = `test-${newId()}`;
    const first = createIndexedDbRepository(name);
    const p = await addPuzzle(first);
    const scan = await addScan(first, p.id, 5);
    const second = createIndexedDbRepository(name);
    expect(await second.getPuzzle(p.id)).toEqual(p);
    expect(await second.getScan(scan.id)).toEqual(scan);
    expect((await second.getBlob(p.reference.blobId))?.size).toBe(2000);
  });

  it('moves puzzles between implementations via export/import', async () => {
    const memory = createMemoryRepository();
    const p = await addPuzzle(memory);
    await addScan(memory, p.id, 1);
    const idb = createIndexedDbRepository(`test-${newId()}`);
    const copy = await idb.importPuzzle(await memory.exportPuzzle(p.id));
    expect(await idb.listScans(copy.id)).toHaveLength(1);
  });
});

describe('memory repository', () => {
  it('reports blob bytes as usage', async () => {
    const repo = createMemoryRepository();
    await repo.putBlob(makeBlob(1000, 1));
    await repo.putBlob(makeBlob(24, 2));
    expect(await repo.estimateUsage()).toEqual({ usage: 1024 });
  });
});

describe('exportFileName', () => {
  it('produces a safe file name', () => {
    expect(exportFileName('Night Sky')).toBe('Night Sky.puzzle.json');
    expect(exportFileName('a/b:c?')).toBe('a b c.puzzle.json');
    expect(exportFileName('  ')).toBe('puzzle.puzzle.json');
  });
});
