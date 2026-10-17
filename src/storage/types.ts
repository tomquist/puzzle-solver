import type { Id, ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';

/**
 * Persistence for puzzles, their images, scans and solving progress. The production
 * implementation is IndexedDB-backed (`createIndexedDbRepository`); `createMemoryRepository` is
 * used by tests and as a fallback when IndexedDB is unavailable (e.g. some private modes).
 */
export interface PuzzleRepository {
  /** All puzzles, most recently updated first. */
  listPuzzles(): Promise<PuzzleRecord[]>;
  getPuzzle(id: Id): Promise<PuzzleRecord | undefined>;
  /** Insert or update. */
  savePuzzle(puzzle: PuzzleRecord): Promise<void>;
  /** Deletes the puzzle and everything it owns (blobs, scans, progress). */
  deletePuzzle(id: Id): Promise<void>;

  /** Store a binary blob (image). Returns its new id. */
  putBlob(blob: Blob): Promise<Id>;
  getBlob(id: Id): Promise<Blob | undefined>;
  deleteBlob(id: Id): Promise<void>;

  /** Scans of a puzzle, newest first. */
  listScans(puzzleId: Id): Promise<ScanRecord[]>;
  getScan(id: Id): Promise<ScanRecord | undefined>;
  saveScan(scan: ScanRecord): Promise<void>;
  /** Deletes the scan and its photo blob. */
  deleteScan(id: Id): Promise<void>;

  /** Returns an empty progress record when none was saved yet. */
  getProgress(puzzleId: Id): Promise<ProgressRecord>;
  saveProgress(progress: ProgressRecord): Promise<void>;

  /**
   * Serialize a puzzle (record, blobs, scans, progress) into a single downloadable file
   * (`application/json`; see `exportFileName`). Rejects with `PuzzleNotFoundError` for unknown ids.
   */
  exportPuzzle(id: Id): Promise<Blob>;
  /**
   * Import a file produced by exportPuzzle. Always creates new ids (puzzle, scans, blobs); appends
   * " (imported)" to the name when it is already taken. Rejects with `PuzzleImportError` (with a
   * user-presentable message) for invalid files, without writing anything.
   */
  importPuzzle(file: Blob): Promise<PuzzleRecord>;

  /** Approximate bytes used, if the platform can tell. */
  estimateUsage(): Promise<{ usage?: number; quota?: number }>;
}

export function newId(): Id {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
