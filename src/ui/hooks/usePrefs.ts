/** App preferences shared by all components (one store, persisted to localStorage). */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { loadPrefs, savePrefs, type AppPrefs, type StorageLike } from '../lib/prefs';
import { createWakeLock } from '../lib/wakeLock';

function storage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

let current: AppPrefs | undefined;
const listeners = new Set<() => void>();

function get(): AppPrefs {
  current ??= loadPrefs(storage());
  return current;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePrefs(): [AppPrefs, (update: (p: AppPrefs) => AppPrefs) => void] {
  const prefs = useSyncExternalStore(subscribe, get, get);
  const update = useCallback((fn: (p: AppPrefs) => AppPrefs) => {
    current = fn(get());
    savePrefs(storage(), current);
    listeners.forEach((l) => l());
  }, []);
  return [prefs, update];
}

/** Keep the screen on while `active` (Screen Wake Lock API; no-op where unsupported). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || typeof document === 'undefined') return;
    const nav = navigator as Navigator & { wakeLock?: Parameters<typeof createWakeLock>[0]['wakeLock'] };
    const wl = createWakeLock({ wakeLock: nav.wakeLock, document });
    wl.start();
    return () => wl.stop();
  }, [active]);
}
