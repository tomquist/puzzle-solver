/**
 * Live-camera quality loop: every `intervalMs` grab a small frame and assess it – but never start a
 * new assessment while one is still running (on a slow phone the worker may need longer than the
 * interval; queued requests would pile up and the feedback would lag ever further behind) – and
 * what the meter says about a frame (meterState).
 */
import type { FrameQuality } from '../../model/types';

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

/** What the live quality meter shows for a frame assessment. */
export interface MeterState {
  tone: 'checking' | 'ok' | 'bad';
  text: string;
  /** Glare in the frame. */
  glare: boolean;
  /** Glare while the torch is on: offer to turn it off. */
  torchOff: boolean;
}

/**
 * The live meter's line for an assessment: "Looks good", the problem's message, and for glare
 * with the torch on the obvious fix ("Glare – turn the torch off").
 */
export function meterState(q: FrameQuality | undefined, torchOn: boolean): MeterState {
  if (!q) return { tone: 'checking', text: 'Checking…', glare: false, torchOff: false };
  if (q.ok) return { tone: 'ok', text: 'Looks good', glare: false, torchOff: false };
  const glare = q.problem === 'glare';
  if (glare && torchOn) return { tone: 'bad', text: 'Glare – turn the torch off', glare, torchOff: true };
  return { tone: 'bad', text: q.message ?? 'Adjust', glare, torchOff: false };
}
