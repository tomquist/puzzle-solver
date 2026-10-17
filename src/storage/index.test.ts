import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepository, getRepository, requestPersistentStorage, setRepository } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  setRepository(undefined);
});

describe('getRepository', () => {
  it('uses IndexedDB when it can be opened and returns a shared instance', async () => {
    const [a, b] = await Promise.all([getRepository(), getRepository()]);
    expect(a.persistent).toBe(true);
    expect(b.repo).toBe(a.repo);
    expect(await a.repo.listPuzzles()).toEqual([]);
  });

  it('falls back to memory when IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { repo, persistent } = await getRepository();
    expect(persistent).toBe(false);
    expect(await repo.getProgress('x')).toEqual({ puzzleId: 'x', placed: {}, updatedAt: 0 });
  });

  it('falls back to memory when opening IndexedDB fails', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new DOMException('denied', 'InvalidStateError');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await getRepository()).persistent).toBe(false);
  });

  it('can be overridden for tests', async () => {
    const repo = createMemoryRepository();
    setRepository({ repo, persistent: false });
    expect((await getRepository()).repo).toBe(repo);
  });
});

describe('requestPersistentStorage', () => {
  it('is false when the API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestPersistentStorage()).toBe(false);
  });

  it('asks the browser when not yet persisted', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not throw when the browser rejects', async () => {
    vi.stubGlobal('navigator', { storage: { persist: async () => Promise.reject(new Error('nope')) } });
    expect(await requestPersistentStorage()).toBe(false);
  });
});
