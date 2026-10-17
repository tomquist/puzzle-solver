/** Helpers shared by the IndexedDB and in-memory repositories (identical semantics). */
import type { Id, ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';

/**
 * A binary payload as persisted. Stored as an ArrayBuffer rather than a `Blob` because Blobs in
 * IndexedDB are unreliable in some Safari versions and unsupported by fake-indexeddb.
 */
export interface StoredBlob {
  id: Id;
  /** MIME type of the original Blob ('' when unknown). */
  type: string;
  data: ArrayBuffer;
  size: number;
  createdAt: number;
}

/** Progress record returned for puzzles that have none saved yet. */
export function emptyProgress(puzzleId: Id): ProgressRecord {
  return { puzzleId, placed: {}, updatedAt: 0 };
}

/** Most recently updated first, then by name. */
export function comparePuzzles(a: PuzzleRecord, b: PuzzleRecord): number {
  return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Newest first (ties broken by id so the order is deterministic). */
export function compareScans(a: ScanRecord, b: ScanRecord): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Ids of all blobs owned by a puzzle record itself (reference, thumbnail, source photos). */
export function puzzleBlobIds(puzzle: PuzzleRecord): Id[] {
  return [puzzle.reference?.blobId, puzzle.thumbnailBlobId, ...(puzzle.sources ?? []).map((s) => s.blobId)].filter(
    (id): id is Id => typeof id === 'string' && id.length > 0,
  );
}

/** Unique ids of every blob owned by a puzzle and its scans. */
export function ownedBlobIds(puzzle: PuzzleRecord | undefined, scans: readonly ScanRecord[]): Id[] {
  const ids = new Set<Id>(puzzle ? puzzleBlobIds(puzzle) : []);
  for (const scan of scans) if (scan.photoBlobId) ids.add(scan.photoBlobId);
  return [...ids];
}

export async function toStoredBlob(id: Id, blob: Blob, createdAt = Date.now()): Promise<StoredBlob> {
  const data = await blob.arrayBuffer();
  return { id, type: blob.type, data, size: data.byteLength, createdAt };
}

export function fromStoredBlob(stored: StoredBlob): Blob {
  return new Blob([stored.data], { type: stored.type });
}

/** `navigator.storage.estimate()` when available, `{}` otherwise. Never throws. */
export async function estimateStorage(): Promise<{ usage?: number; quota?: number }> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || typeof storage.estimate !== 'function') return {};
    const { usage, quota } = await storage.estimate();
    return { usage, quota };
  } catch {
    return {};
  }
}

export class PuzzleNotFoundError extends Error {
  constructor(id: Id) {
    super(`Puzzle not found: ${id}`);
    this.name = 'PuzzleNotFoundError';
  }
}
