import type { Id, ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';
import {
  comparePuzzles,
  compareScans,
  emptyProgress,
  fromStoredBlob,
  ownedBlobIds,
  PuzzleNotFoundError,
  type StoredBlob,
  toStoredBlob,
} from './common';
import { decodePuzzleExport, encodePuzzleExport } from './exportFormat';
import { newId, type PuzzleRepository } from './types';

/**
 * In-memory {@link PuzzleRepository} with the same semantics as the IndexedDB one (records are
 * structured-cloned on the way in and out, blobs are copied). Used by tests and as a fallback when
 * IndexedDB is unavailable; data is lost on reload. `estimateUsage` reports the bytes of stored
 * blobs.
 */
export function createMemoryRepository(): PuzzleRepository {
  const puzzles = new Map<Id, PuzzleRecord>();
  const blobs = new Map<Id, StoredBlob>();
  const scans = new Map<Id, ScanRecord>();
  const progress = new Map<Id, ProgressRecord>();

  const scansOf = (puzzleId: Id): ScanRecord[] => [...scans.values()].filter((s) => s.puzzleId === puzzleId);

  const repo: PuzzleRepository = {
    async listPuzzles() {
      return [...puzzles.values()].map((p) => structuredClone(p)).sort(comparePuzzles);
    },
    async getPuzzle(id) {
      const p = puzzles.get(id);
      return p && structuredClone(p);
    },
    async savePuzzle(puzzle) {
      puzzles.set(puzzle.id, structuredClone(puzzle));
    },
    async deletePuzzle(id) {
      const owned = scansOf(id);
      for (const blobId of ownedBlobIds(puzzles.get(id), owned)) blobs.delete(blobId);
      for (const scan of owned) scans.delete(scan.id);
      progress.delete(id);
      puzzles.delete(id);
    },

    async putBlob(blob) {
      const stored = await toStoredBlob(newId(), blob);
      blobs.set(stored.id, stored);
      return stored.id;
    },
    async getBlob(id) {
      const stored = blobs.get(id);
      return stored && fromStoredBlob(stored);
    },
    async deleteBlob(id) {
      blobs.delete(id);
    },

    async listScans(puzzleId) {
      return scansOf(puzzleId)
        .map((s) => structuredClone(s))
        .sort(compareScans);
    },
    async getScan(id) {
      const s = scans.get(id);
      return s && structuredClone(s);
    },
    async saveScan(scan) {
      scans.set(scan.id, structuredClone(scan));
    },
    async updateScan(id, change) {
      const cur = scans.get(id);
      const next = cur && change(structuredClone(cur));
      if (next) scans.set(id, structuredClone(next));
      return next && structuredClone(next);
    },
    async deleteScan(id) {
      const scan = scans.get(id);
      if (scan) blobs.delete(scan.photoBlobId);
      scans.delete(id);
    },

    async getProgress(puzzleId) {
      const p = progress.get(puzzleId);
      return p ? structuredClone(p) : emptyProgress(puzzleId);
    },
    async saveProgress(record) {
      progress.set(record.puzzleId, structuredClone(record));
    },

    async exportPuzzle(id) {
      const puzzle = puzzles.get(id);
      if (!puzzle) throw new PuzzleNotFoundError(id);
      const owned = scansOf(id).sort(compareScans);
      const ownedBlobs = ownedBlobIds(puzzle, owned)
        .map((blobId) => blobs.get(blobId))
        .filter((b): b is StoredBlob => b !== undefined);
      return encodePuzzleExport({
        puzzle,
        progress: progress.get(id) ?? emptyProgress(id),
        scans: owned,
        blobs: ownedBlobs,
      });
    },
    async importPuzzle(file) {
      const names = [...puzzles.values()].map((p) => p.name);
      const bundle = await decodePuzzleExport(file, names);
      for (const b of bundle.blobs) blobs.set(b.id, b);
      for (const s of bundle.scans) scans.set(s.id, s);
      progress.set(bundle.puzzle.id, bundle.progress);
      puzzles.set(bundle.puzzle.id, bundle.puzzle);
      return structuredClone(bundle.puzzle);
    },

    async estimateUsage() {
      let usage = 0;
      for (const b of blobs.values()) usage += b.size;
      return { usage };
    },
  };
  return repo;
}
