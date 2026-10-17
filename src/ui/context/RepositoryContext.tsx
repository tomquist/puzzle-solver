import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createMemoryRepository, getRepository, requestPersistentStorage } from '../../storage';
import type { PuzzleRepository } from '../../storage/types';
import { Spinner } from '../components/Feedback';

export interface RepositoryState {
  repo: PuzzleRepository;
  /** false when the data only lives in memory (IndexedDB unavailable). */
  persistent: boolean;
  /** Whether the browser granted persistent storage (undefined = not asked / unknown). */
  persisted: boolean | undefined;
  /** Ask the browser to keep our data under storage pressure. */
  requestPersist(): Promise<boolean>;
}

const RepositoryContext = createContext<RepositoryState | null>(null);

export function RepositoryProvider({ children }: { children: ReactNode }) {
  const [handle, setHandle] = useState<{ repo: PuzzleRepository; persistent: boolean }>();
  const [persisted, setPersisted] = useState<boolean>();

  useEffect(() => {
    let alive = true;
    getRepository()
      .catch(() => ({ repo: createMemoryRepository(), persistent: false }))
      .then((h) => {
        if (alive) setHandle(h);
      });
    navigator.storage?.persisted?.().then(
      (p) => alive && setPersisted(p),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const requestPersist = useCallback(async () => {
    const ok = await requestPersistentStorage();
    setPersisted(ok);
    return ok;
  }, []);

  const value = useMemo<RepositoryState | null>(
    () => (handle ? { repo: handle.repo, persistent: handle.persistent, persisted, requestPersist } : null),
    [handle, persisted, requestPersist],
  );

  if (!value) {
    return (
      <div className="splash">
        <Spinner label="Opening your puzzles…" />
      </div>
    );
  }
  return <RepositoryContext value={value}>{children}</RepositoryContext>;
}

export function useRepository(): RepositoryState {
  const r = use(RepositoryContext);
  if (!r) throw new Error('useRepository must be used inside <RepositoryProvider>');
  return r;
}

/** Shortcut for the repository itself. */
export function useRepo(): PuzzleRepository {
  return useRepository().repo;
}
