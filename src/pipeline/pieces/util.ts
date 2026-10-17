/** Small numeric helpers shared inside the pieces package. */
import type { Point } from '../../cv/geometry';

/** Median of a list (0 for an empty list). Does not modify the input. */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values).sort();
  return n % 2 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/** q-quantile (0..1, linear interpolation) of a list (0 for an empty list). */
export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values).sort();
  const pos = Math.max(0, Math.min(n - 1, q * (n - 1)));
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < n ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

/** Translate points by (dx, dy). */
export function offsetPoints(pts: readonly Point[], dx: number, dy: number): Point[] {
  return pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}
