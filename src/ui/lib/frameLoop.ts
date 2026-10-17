/**
 * Live-camera quality loop: every `intervalMs` grab a small frame and assess it – but never start a
 * new assessment while one is still running (on a slow phone the worker may need longer than the
 * interval; queued requests would pile up and the feedback would lag ever further behind).
 */
export interface FrameLoopOptions<F, Q> {
  grab: () => F | null;
  assess: (frame: F) => Promise<Q>;
  onResult: (quality: Q) => void;
  intervalMs?: number;
}

export interface FrameLoop {
  stop(): void;
  /** Frames skipped because an assessment was still in flight (for diagnostics/tests). */
  readonly skipped: number;
}

export function startFrameLoop<F, Q>({ grab, assess, onResult, intervalMs = 400 }: FrameLoopOptions<F, Q>): FrameLoop {
  let inFlight = false;
  let stopped = false;
  let skipped = 0;
  const id = setInterval(() => {
    if (stopped) return;
    if (inFlight) {
      skipped++;
      return;
    }
    const frame = grab();
    if (!frame) return;
    inFlight = true;
    assess(frame)
      .then((q) => {
        if (!stopped) onResult(q);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
    get skipped() {
      return skipped;
    },
  };
}
