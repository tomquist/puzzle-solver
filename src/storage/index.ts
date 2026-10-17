/** Public API of the storage package. */
import { createIndexedDbRepository } from './indexedDbRepository';
import { createMemoryRepository } from './memoryRepository';
import type { PuzzleRepository } from './types';

export { newId, type PuzzleRepository } from './types';
export { createIndexedDbRepository, DB_VERSION } from './indexedDbRepository';
export { createMemoryRepository } from './memoryRepository';
export { PuzzleNotFoundError } from './common';
export {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportFileName,
  PuzzleImportError,
  type PuzzleExportFile,
} from './exportFormat';

/** The app-wide repository and whether its data survives a page reload. */
export interface RepositoryHandle {
  repo: PuzzleRepository;
  /** false when IndexedDB is unavailable and data only lives in memory. */
  persistent: boolean;
}

let handle: Promise<RepositoryHandle> | undefined;

async function openDefaultRepository(): Promise<RepositoryHandle> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const repo = createIndexedDbRepository();
      await repo.listPuzzles(); // probe: opens (and if needed upgrades) the database
      return { repo, persistent: true };
    } catch (err) {
      console.warn('IndexedDB is unavailable; puzzles will only be kept until the page is closed.', err);
    }
  }
  return { repo: createMemoryRepository(), persistent: false };
}

/**
 * The app-wide repository, created on first call: IndexedDB when it can be opened, otherwise an
 * in-memory fallback (`persistent: false`). Concurrent callers share the same instance.
 */
export function getRepository(): Promise<RepositoryHandle> {
  handle ??= openDefaultRepository();
  return handle;
}

/** Replaces the instance returned by {@link getRepository}; `undefined` resets it. For tests. */
export function setRepository(value: RepositoryHandle | undefined): void {
  handle = value && Promise.resolve(value);
}

/**
 * Asks the browser not to evict this origin's storage under pressure
 * (`navigator.storage.persist()`). Resolves `false` when unsupported or denied; never throws.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
