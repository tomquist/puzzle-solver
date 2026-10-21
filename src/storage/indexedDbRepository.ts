import { type DBSchema, type IDBPDatabase, type IDBPTransaction, openDB, type StoreNames } from 'idb';
import type { Id, ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';
import {
  comparePuzzles,
  compareScans,
  emptyProgress,
  estimateStorage,
  fromStoredBlob,
  ownedBlobIds,
  PuzzleNotFoundError,
  type StoredBlob,
  toStoredBlob,
} from './common';
import { decodePuzzleExport, encodePuzzleExport } from './exportFormat';
import { newId, type PuzzleRepository } from './types';

/** IndexedDB schema (current version). */
export interface PuzzleDbSchema extends DBSchema {
  puzzles: { key: Id; value: PuzzleRecord };
  blobs: { key: Id; value: StoredBlob };
  scans: { key: Id; value: ScanRecord; indexes: { byPuzzle: Id } };
  progress: { key: Id; value: ProgressRecord };
}

type Migration = (
  db: IDBPDatabase<PuzzleDbSchema>,
  tx: IDBPTransaction<PuzzleDbSchema, StoreNames<PuzzleDbSchema>[], 'versionchange'>,
) => void;

/**
 * Schema migrations; `MIGRATIONS[v]` upgrades version v to v + 1. To change the schema, append a
 * function (never edit existing ones) — the database version follows automatically.
 */
const MIGRATIONS: readonly Migration[] = [
  // 0 → 1: initial schema.
  (db) => {
    db.createObjectStore('puzzles', { keyPath: 'id' });
    db.createObjectStore('blobs', { keyPath: 'id' });
    db.createObjectStore('scans', { keyPath: 'id' }).createIndex('byPuzzle', 'puzzleId');
    db.createObjectStore('progress', { keyPath: 'puzzleId' });
  },
];

/** Current IndexedDB schema version. */
export const DB_VERSION = MIGRATIONS.length;

const ALL_STORES = ['puzzles', 'blobs', 'scans', 'progress'] as const;

async function openPuzzleDb(name: string, onClosed: () => void): Promise<IDBPDatabase<PuzzleDbSchema>> {
  const db: IDBPDatabase<PuzzleDbSchema> = await openDB<PuzzleDbSchema>(name, DB_VERSION, {
    upgrade(database, oldVersion, newVersion, tx) {
      for (let v = oldVersion; v < (newVersion ?? DB_VERSION); v++) MIGRATIONS[v](database, tx);
    },
    // Another tab wants to upgrade the schema: get out of its way; the next call reopens.
    blocking() {
      db.close();
      onClosed();
    },
    terminated() {
      onClosed();
    },
  });
  return db;
}

/**
 * IndexedDB-backed {@link PuzzleRepository} (via `idb`). The database is opened lazily on first
 * use; a failed open is retried on the next call. Multi-store operations (cascading deletes,
 * import) run in a single transaction.
 */
export function createIndexedDbRepository(dbName = 'puzzle-solver'): PuzzleRepository {
  let dbPromise: Promise<IDBPDatabase<PuzzleDbSchema>> | undefined;

  const getDb = (): Promise<IDBPDatabase<PuzzleDbSchema>> => {
    if (!dbPromise) {
      const p = openPuzzleDb(dbName, () => {
        if (dbPromise === p) dbPromise = undefined;
      });
      p.catch(() => {
        if (dbPromise === p) dbPromise = undefined;
      });
      dbPromise = p;
    }
    return dbPromise;
  };

  return {
    async listPuzzles() {
      return (await (await getDb()).getAll('puzzles')).sort(comparePuzzles);
    },
    async getPuzzle(id) {
      return (await getDb()).get('puzzles', id);
    },
    async savePuzzle(puzzle) {
      await (await getDb()).put('puzzles', puzzle);
    },
    async deletePuzzle(id) {
      const tx = (await getDb()).transaction(ALL_STORES, 'readwrite');
      const [puzzle, scans] = await Promise.all([
        tx.objectStore('puzzles').get(id),
        tx.objectStore('scans').index('byPuzzle').getAll(id),
      ]);
      const blobs = tx.objectStore('blobs');
      await Promise.all([
        ...ownedBlobIds(puzzle, scans).map((blobId) => blobs.delete(blobId)),
        ...scans.map((s) => tx.objectStore('scans').delete(s.id)),
        tx.objectStore('progress').delete(id),
        tx.objectStore('puzzles').delete(id),
        tx.done,
      ]);
    },

    async putBlob(blob) {
      // Read the bytes before touching the database: a transaction must not span other awaits.
      const stored = await toStoredBlob(newId(), blob);
      await (await getDb()).put('blobs', stored);
      return stored.id;
    },
    async getBlob(id) {
      const stored = await (await getDb()).get('blobs', id);
      return stored && fromStoredBlob(stored);
    },
    async deleteBlob(id) {
      await (await getDb()).delete('blobs', id);
    },

    async listScans(puzzleId) {
      return (await (await getDb()).getAllFromIndex('scans', 'byPuzzle', puzzleId)).sort(compareScans);
    },
    async getScan(id) {
      return (await getDb()).get('scans', id);
    },
    async saveScan(scan) {
      await (await getDb()).put('scans', scan);
    },
    async updateScan(id, change) {
      const tx = (await getDb()).transaction('scans', 'readwrite');
      const cur = await tx.store.get(id);
      const next = cur && change(cur);
      if (next) await tx.store.put(next);
      await tx.done;
      return next;
    },
    async deleteScan(id) {
      const tx = (await getDb()).transaction(['scans', 'blobs'], 'readwrite');
      const scan = await tx.objectStore('scans').get(id);
      await Promise.all([
        scan ? tx.objectStore('blobs').delete(scan.photoBlobId) : undefined,
        tx.objectStore('scans').delete(id),
        tx.done,
      ]);
    },

    async getProgress(puzzleId) {
      return (await (await getDb()).get('progress', puzzleId)) ?? emptyProgress(puzzleId);
    },
    async saveProgress(record) {
      await (await getDb()).put('progress', record);
    },

    async exportPuzzle(id) {
      const tx = (await getDb()).transaction(ALL_STORES, 'readonly');
      const [puzzle, scans, progress] = await Promise.all([
        tx.objectStore('puzzles').get(id),
        tx.objectStore('scans').index('byPuzzle').getAll(id),
        tx.objectStore('progress').get(id),
      ]);
      if (!puzzle) throw new PuzzleNotFoundError(id);
      const blobs = await Promise.all(ownedBlobIds(puzzle, scans).map((blobId) => tx.objectStore('blobs').get(blobId)));
      await tx.done;
      return encodePuzzleExport({
        puzzle,
        progress: progress ?? emptyProgress(id),
        scans: scans.sort(compareScans),
        blobs: blobs.filter((b): b is StoredBlob => b !== undefined),
      });
    },
    async importPuzzle(file) {
      const names = (await (await getDb()).getAll('puzzles')).map((p) => p.name);
      const bundle = await decodePuzzleExport(file, names);
      const tx = (await getDb()).transaction(ALL_STORES, 'readwrite');
      await Promise.all([
        ...bundle.blobs.map((b) => tx.objectStore('blobs').put(b)),
        ...bundle.scans.map((s) => tx.objectStore('scans').put(s)),
        tx.objectStore('progress').put(bundle.progress),
        tx.objectStore('puzzles').put(bundle.puzzle),
        tx.done,
      ]);
      return bundle.puzzle;
    },

    estimateUsage: estimateStorage,
  };
}
