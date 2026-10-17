import { describe, expect, it } from 'vitest';
import { createWakeLock, type WakeLockEnv, type WakeLockSentinelLike } from './wakeLock';

function fakeEnv(opts: { supported?: boolean; refuse?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const sentinels: { released: boolean; onRelease: (() => void)[] }[] = [];
  let requests = 0;
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_: 'visibilitychange', l: () => void) => listeners.add(l),
    removeEventListener: (_: 'visibilitychange', l: () => void) => listeners.delete(l),
  };
  const env: WakeLockEnv = {
    document: doc,
    wakeLock:
      opts.supported === false
        ? undefined
        : {
            request: async () => {
              requests++;
              if (opts.refuse) throw new DOMException('denied', 'NotAllowedError');
              const s = { released: false, onRelease: [] as (() => void)[] };
              sentinels.push(s);
              const sentinel: WakeLockSentinelLike = {
                release: async () => {
                  s.released = true;
                  s.onRelease.forEach((f) => f());
                },
                addEventListener: (_t, l) => s.onRelease.push(l),
              };
              return sentinel;
            },
          },
  };
  const setVisible = (v: boolean) => {
    doc.visibilityState = v ? 'visible' : 'hidden';
    listeners.forEach((l) => l());
  };
  // The browser releases the lock when the page is hidden.
  const systemRelease = () => sentinels.filter((s) => !s.released).forEach((s) => ((s.released = true), s.onRelease.forEach((f) => f())));
  return { env, sentinels, setVisible, systemRelease, listeners, requests: () => requests };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('wake lock', () => {
  it('acquires on start and releases on stop', async () => {
    const f = fakeEnv();
    const wl = createWakeLock(f.env);
    wl.start();
    await flush();
    expect(wl.held).toBe(true);
    wl.stop();
    await flush();
    expect(wl.held).toBe(false);
    expect(f.sentinels[0].released).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  it('re-acquires when the page becomes visible again', async () => {
    const f = fakeEnv();
    const wl = createWakeLock(f.env);
    wl.start();
    await flush();
    f.setVisible(false);
    f.systemRelease();
    expect(wl.held).toBe(false);
    f.setVisible(true);
    await flush();
    expect(wl.held).toBe(true);
    expect(f.requests()).toBe(2);
    wl.stop();
  });

  it('is a silent no-op when unsupported or refused', async () => {
    for (const opts of [{ supported: false }, { refuse: true }]) {
      const wl = createWakeLock(fakeEnv(opts).env);
      expect(() => wl.start()).not.toThrow();
      await flush();
      expect(wl.held).toBe(false);
      wl.stop();
    }
  });

  it('releases a lock that arrives after stop()', async () => {
    const f = fakeEnv();
    const wl = createWakeLock(f.env);
    wl.start();
    wl.stop(); // before the request resolved
    await flush();
    expect(wl.held).toBe(false);
    expect(f.sentinels[0].released).toBe(true);
  });
});
