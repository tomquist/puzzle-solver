import { describe, expect, it } from 'vitest';
import { Rng } from '../../testing/synth';
import { profileMismatch } from './fits';
import { dtwDistance, profileMismatchDtw, stripMismatch } from './sideCompare';

/** A knob-like profile: flat, a plateau of height h from position p0 to p1 (exclusive), flat. */
function knob(n: number, p0: number, p1: number, h: number): number[] {
  return Array.from({ length: n }, (_, k) => (k >= p0 && k < p1 ? h : 0));
}

const rms = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, k) => s + (v - b[k]) ** 2, 0) / a.length);

describe('dtwDistance', () => {
  it('is 0 for identical sequences and Infinity for empty ones', () => {
    const a = [0, 0.1, 0.3, 0.2, 0];
    expect(dtwDistance(a, a, { band: 2 })).toBe(0);
    expect(dtwDistance([], a, { band: 2 })).toBe(Infinity);
  });

  it('equals the RMS difference without warping (band 0)', () => {
    const a = [0, 1, 2, 3], b = [0, 2, 2, 5];
    expect(dtwDistance(a, b, { band: 0 })).toBeCloseTo(Math.sqrt((0 + 1 + 0 + 4) / 4), 12);
  });

  it('solves a known small case: a one-sample shift costs nothing once the band allows it', () => {
    // Path (0,0) (1,0) (2,1) (2,2) matches equal values throughout.
    expect(dtwDistance([0, 0, 1], [0, 1, 1], { band: 1 })).toBe(0);
    expect(dtwDistance([0, 0, 1], [0, 1, 1], { band: 0 })).toBeCloseTo(Math.sqrt(1 / 3), 12);
  });

  it('absorbs shifts up to the band width, not beyond', () => {
    const a = knob(32, 10, 20, 0.25);
    const shifted2 = knob(32, 12, 22, 0.25);
    expect(dtwDistance(a, shifted2, { band: 0 })).toBeGreaterThan(0.08);
    expect(dtwDistance(a, shifted2, { band: 1 })).toBeGreaterThan(0.03);
    expect(dtwDistance(a, shifted2, { band: 2 })).toBe(0);
    expect(dtwDistance(a, shifted2, { band: 3 })).toBe(0);
  });

  it('never exceeds the RMS difference and shrinks as the band widens', () => {
    const rng = new Rng(4);
    for (let t = 0; t < 20; t++) {
      const a = Array.from({ length: 24 }, () => rng.uniform(-1, 1));
      const b = Array.from({ length: 24 }, () => rng.uniform(-1, 1));
      const d0 = dtwDistance(a, b, { band: 0 }), d1 = dtwDistance(a, b, { band: 1 }), d3 = dtwDistance(a, b, { band: 3 });
      expect(d0).toBeCloseTo(rms(a, b), 12);
      expect(d1).toBeLessThanOrEqual(d0 + 1e-12);
      expect(d3).toBeLessThanOrEqual(d1 + 1e-12);
    }
  });

  it('handles sequences of different lengths and interleaved, weighted channels', () => {
    // A stretched copy: every sample twice.
    const a = [0, 1, 2, 3], b = [0, 0, 1, 1, 2, 2, 3, 3];
    expect(dtwDistance(a, b, { band: 1 })).toBe(0);
    // Two channels; the second one weighted 4×.
    const p = [0, 0, 1, 1], q = [0, 1, 1, 1];
    expect(dtwDistance(p, q, { band: 0, dim: 2, weights: [1, 4] })).toBeCloseTo(Math.sqrt((4 * 1) / 2), 12);
  });
});

describe('profileMismatchDtw', () => {
  const tab = knob(32, 11, 20, 0.25);
  const blank = tab.map((v) => -v).reverse(); // the mating side as its piece reports it

  it('is 0 for the complementary profile and at most the point-wise RMS', () => {
    expect(profileMismatchDtw(tab, blank, 2)).toBe(0);
    expect(profileMismatchDtw(tab, tab, 2)).toBeGreaterThan(0.1);
    const rng = new Rng(9);
    const noisy = blank.map((v) => v + rng.uniform(-0.02, 0.02));
    expect(profileMismatchDtw(tab, noisy, 1)).toBeLessThanOrEqual(profileMismatch(tab, noisy) + 1e-12);
  });

  it('tolerates the neck of the knob falling one sample off (point-wise RMS does not)', () => {
    const off = knob(32, 12, 20, 0.25).map((v) => -v).reverse();
    expect(profileMismatch(tab, off)).toBeGreaterThan(0.04);
    expect(profileMismatchDtw(tab, off, 1)).toBeLessThan(0.005);
  });

  it('removes a tilted baseline only when asked to', () => {
    // A corner off across the side tilts the whole profile.
    const tilted = blank.map((v, k) => v + (0.04 * k) / 31);
    expect(profileMismatchDtw(tab, tilted, 2)).toBeGreaterThan(0.015);
    expect(profileMismatchDtw(tab, tilted, 2, true)).toBeLessThan(1e-9);
  });
});

describe('stripMismatch', () => {
  // A strip running from red to blue (Lab triples).
  const strip = (n: number, f = (k: number) => k / (n - 1)) => {
    const out = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const t = f(k);
      out.set([50 + 10 * t, 60 - 80 * t, 40 - 90 * t], k * 3);
    }
    return out;
  };
  const reversed = (s: Float32Array) => {
    const n = s.length / 3, out = new Float32Array(s.length);
    for (let k = 0; k < n; k++) out.set(s.subarray((n - 1 - k) * 3, (n - k) * 3), k * 3);
    return out;
  };

  it('is 0 for the partner strip (same colours, opposite direction) and large for other colours', () => {
    const a = strip(32);
    expect(stripMismatch(a, reversed(a))).toBeCloseTo(0, 4);
    expect(stripMismatch(a, a)).toBeGreaterThan(20);
  });

  it('compensates a small lighting gain between the two strips', () => {
    const a = strip(32);
    const darker = reversed(a).map((v) => v * 0.92);
    expect(stripMismatch(a, darker, { maxGain: 1 })).toBeGreaterThan(2);
    expect(stripMismatch(a, darker)).toBeLessThan(0.5);
  });

  it('absorbs a slightly shifted strip with its DTW band', () => {
    const a = strip(32);
    const b = reversed(strip(32, (k) => Math.min(1, Math.max(0, (k - 1) / 31))));
    expect(stripMismatch(a, b, { band: 2 })).toBeLessThan(stripMismatch(a, b, { band: 0 }));
  });
});
