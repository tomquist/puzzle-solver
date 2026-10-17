/**
 * Rotation helpers for Placement.rotationDeg (ARCHITECTURE §3): the clockwise rotation in degrees
 * that turns a piece *as it lies in the photo* into its upright orientation in the finished puzzle.
 */
import type { Point } from '../../cv/geometry';

/** Normalise to [0, 360). */
export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d === 0 ? 0 : d;
}

/** Normalise to (-180, 180]; positive = clockwise. */
export function signedDeg(deg: number): number {
  const d = normalizeDeg(deg);
  return d > 180 ? d - 360 : d;
}

/**
 * Unit vector, in photo coordinates (y down), of the piece's "up" direction as it lies in the
 * photo: `rotate(-rotationDeg) · (0, -1)`.
 */
export function upVector(rotationDeg: number): Point {
  const r = (rotationDeg * Math.PI) / 180;
  const x = -Math.sin(r);
  const y = -Math.cos(r);
  // Avoid -0 for clean output.
  return { x: Math.abs(x) < 1e-12 ? 0 : x, y: Math.abs(y) < 1e-12 ? 0 : y };
}

export type QuarterTurn = 0 | 90 | 180 | 270;

/** Nearest quarter turn (clockwise) of a rotation. */
export function nearestQuarterTurn(rotationDeg: number): QuarterTurn {
  return ((Math.round(normalizeDeg(rotationDeg) / 90) % 4) * 90) as QuarterTurn;
}

export interface TurnInstruction {
  quarter: QuarterTurn;
  /** Short instruction for the nearest quarter turn, e.g. "Turn ↻ 90°", "Keep as it is". */
  short: string;
  /** Exact rotation, e.g. "exactly 84° clockwise" ("" when < 1°). */
  exact: string;
  /** Signed exact rotation in (-180, 180] (positive = clockwise). */
  degrees: number;
}

/** Human instruction for turning a piece from photo orientation to upright. */
export function turnInstruction(rotationDeg: number): TurnInstruction {
  const degrees = signedDeg(rotationDeg);
  const quarter = nearestQuarterTurn(rotationDeg);
  const short =
    quarter === 0 ? 'Keep as it is'
    : quarter === 90 ? 'Turn ↻ 90°'
    : quarter === 180 ? 'Turn ↻ 180°'
    : 'Turn ↺ 90°';
  const abs = Math.round(Math.abs(degrees));
  let exact = '';
  if (abs >= 1) {
    exact = abs === 180 ? 'exactly 180°' : `exactly ${abs}° ${degrees > 0 ? 'clockwise' : 'counter-clockwise'}`;
  }
  return { quarter, short, exact, degrees };
}

/** Compact label for the nearest quarter turn: "↻90°", "↺90°", "180°", "" (upright). */
export function turnBadge(rotationDeg: number): string {
  const q = nearestQuarterTurn(rotationDeg);
  return q === 0 ? '' : q === 90 ? '↻90°' : q === 180 ? '180°' : '↺90°';
}
