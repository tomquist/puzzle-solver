/**
 * Screen Wake Lock controller: keeps the screen on while active, re-acquires the lock when the
 * page becomes visible again (the browser releases it whenever the page is hidden), releases it on
 * stop, and silently does nothing where the API is missing or the request is refused.
 */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockEnv {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
  document: {
    visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
}

export interface WakeLockController {
  start(): void;
  stop(): void;
  /** True while a wake lock is held. */
  readonly held: boolean;
}

export function createWakeLock(env: WakeLockEnv): WakeLockController {
  let active = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = false;

  const acquire = async () => {
    if (!active || sentinel || pending || !env.wakeLock || env.document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const s = await env.wakeLock.request('screen');
      if (!active) {
        await s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null;
      });
    } catch {
      // Not allowed (battery saver, no user activation, iframe policy …) – ignore.
    } finally {
      pending = false;
    }
  };

  const onVisibility = () => {
    if (env.document.visibilityState === 'visible') void acquire();
  };

  return {
    start() {
      if (active) return;
      active = true;
      env.document.addEventListener('visibilitychange', onVisibility);
      void acquire();
    },
    stop() {
      if (!active) return;
      active = false;
      env.document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinel;
      sentinel = null;
      void s?.release().catch(() => undefined);
    },
    get held() {
      return sentinel !== null;
    },
  };
}
