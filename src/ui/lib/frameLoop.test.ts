import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meterState, startFrameLoop } from './frameLoop';

describe('meterState', () => {
  const base = { sharpness: 0.9, brightness: 0.5, clipped: 0.01 };
  it('says what the frame needs, and to turn the torch off when it causes glare', () => {
    expect(meterState(undefined, false)).toMatchObject({ tone: 'checking', text: 'Checking…' });
    expect(meterState({ ...base, ok: true }, true)).toMatchObject({ tone: 'ok', text: 'Looks good', glare: false, torchOff: false });
    const glare = { ...base, ok: false, problem: 'glare' as const, message: 'Glare – move the light or tilt the lamp', glare: 0.01 };
    expect(meterState(glare, false)).toEqual({ tone: 'bad', text: glare.message, glare: true, torchOff: false });
    expect(meterState(glare, true)).toEqual({ tone: 'bad', text: 'Glare – turn the torch off', glare: true, torchOff: true });
    // Other problems with the torch on: their own message.
    expect(meterState({ ...base, ok: false, problem: 'blurry', message: 'Blurry' }, true)).toMatchObject({ text: 'Blurry', torchOff: false });
  });
});

describe('startFrameLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never has more than one assessment in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const results: number[] = [];
    const loop = startFrameLoop({
      grab: () => ({}),
      assess: () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A slow worker: 1 s per frame, interval 400 ms.
        return new Promise<number>((resolve) => setTimeout(() => {
          inFlight--;
          resolve(calls);
        }, 1000));
      },
      onResult: (q) => results.push(q),
      intervalMs: 400,
    });
    await vi.advanceTimersByTimeAsync(5000);
    loop.stop();
    expect(maxInFlight).toBe(1);
    expect(calls).toBeLessThanOrEqual(5);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(loop.skipped).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('skips when no frame is available and stops delivering after stop()', async () => {
    let ready = false;
    const onResult = vi.fn();
    const loop = startFrameLoop({ grab: () => (ready ? 1 : null), assess: async (f: number) => f, onResult, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect(onResult).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(onResult).toHaveBeenCalledTimes(1);
    loop.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
