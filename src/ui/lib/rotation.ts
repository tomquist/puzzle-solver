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

/**
 * How far to turn, in plain words – by the size of the short-way turn |signedDeg|:
 *
 * | band       | turn        | words                                    |
 * |------------|-------------|------------------------------------------|
 * | upright    | < 10°       | Already the right way up                 |
 * | little     | 10° – 35°   | Turn it a little to the right/left       |
 * | eighth     | 35° – 60°   | Turn it half a quarter to the right/left |
 * | quarter    | 60° – 120°  | Turn it a quarter to the right/left      |
 * | nearlyHalf | 120° – 155° | Turn it nearly halfway round to the …    |
 * | half       | ≥ 155°      | Turn it upside down                      |
 *
 * "Right" is clockwise: the top edge moves to the right. The animation and the arc arrow show
 * the exact amount; the exact angle is the small print.
 */
export type TurnBand = 'upright' | 'little' | 'eighth' | 'quarter' | 'nearlyHalf' | 'half';

export function turnBand(rotationDeg: number): TurnBand {
  const a = Math.abs(signedDeg(rotationDeg));
  return a < 10 ? 'upright' : a < 35 ? 'little' : a < 60 ? 'eighth' : a < 120 ? 'quarter' : a < 155 ? 'nearlyHalf' : 'half';
}

export interface TurnInstruction {
  quarter: QuarterTurn;
  band: TurnBand;
  /** 'right' = clockwise, 'left' = counter-clockwise; undefined when upright or upside down. */
  direction?: 'right' | 'left';
  /** The instruction in plain words, e.g. "Turn it a quarter to the right". */
  text: string;
  /** Exact rotation for the small print, e.g. "84° clockwise" ("" when < 1°). */
  exact: string;
  /** Signed exact rotation in (-180, 180] (positive = clockwise) – the short way. */
  degrees: number;
}

const BAND_WORDS: Record<Exclude<TurnBand, 'upright' | 'half'>, string> = {
  little: 'a little',
  eighth: 'half a quarter',
  quarter: 'a quarter',
  nearlyHalf: 'nearly halfway round',
};

/** Plain-words instruction for turning a piece from photo orientation to upright (the short way). */
export function turnInstruction(rotationDeg: number): TurnInstruction {
  const degrees = signedDeg(rotationDeg);
  const quarter = nearestQuarterTurn(rotationDeg);
  const band = turnBand(rotationDeg);
  const abs = Math.round(Math.abs(degrees));
  const direction = band === 'upright' || band === 'half' ? undefined : degrees > 0 ? 'right' : 'left';
  const text = band === 'upright' ? 'Already the right way up' : band === 'half' ? 'Turn it upside down' : `Turn it ${BAND_WORDS[band]} to the ${direction}`;
  const exact = abs < 1 ? '' : abs === 180 ? '180°' : `${abs}° ${degrees > 0 ? 'clockwise' : 'counter-clockwise'}`;
  return { quarter, band, direction, text, exact, degrees };
}

/** The turn as a participle for sentences: "turned a quarter to the left", "turned upside down", "the same way round". */
export function turnedWords(rotationDeg: number): string {
  const t = turnInstruction(rotationDeg);
  if (t.band === 'upright') return 'the same way round';
  if (t.band === 'half') return 'turned upside down';
  return `turned ${BAND_WORDS[t.band]} to the ${t.direction}`;
}

/** Compact words for lists: "slight turn right", "¼ turn right", "upside down", '' when upright. */
export function turnBadge(rotationDeg: number): string {
  const t = turnInstruction(rotationDeg);
  switch (t.band) {
    case 'upright':
      return '';
    case 'little':
      return `slight turn ${t.direction}`;
    case 'eighth':
      return `⅛ turn ${t.direction}`;
    case 'quarter':
      return `¼ turn ${t.direction}`;
    case 'nearlyHalf':
      return `⅜ turn ${t.direction}`;
    case 'half':
      return 'upside down';
  }
}

/**
 * Arc arrow around a piece (centre c, radius r) for the turn: from where the piece's top edge
 * points now (upVector) to straight up, the short way – a quarter arc for 90°, a half for 180°.
 * `head` is the arrowhead at the top (pointing along the turn).
 */
export function turnArc(rotationDeg: number, c: Point, r: number, headSize = r * 0.28): { d: string; start: Point; end: Point; head: [Point, Point, Point] } {
  const deg = signedDeg(rotationDeg);
  const u = upVector(rotationDeg);
  const start = { x: c.x + u.x * r, y: c.y + u.y * r };
  const end = { x: c.x, y: c.y - r };
  const cw = deg >= 0;
  const f = (n: number) => (Math.round(n * 100) / 100).toString();
  const d = `M${f(start.x)} ${f(start.y)}A${f(r)} ${f(r)} 0 0 ${cw ? 1 : 0} ${f(end.x)} ${f(end.y)}`;
  // At the top the turn moves right (clockwise) or left.
  const t = cw ? 1 : -1;
  const head: [Point, Point, Point] = [
    { x: end.x + t * headSize * 0.6, y: end.y },
    { x: end.x - t * headSize * 0.4, y: end.y - headSize * 0.5 },
    { x: end.x - t * headSize * 0.4, y: end.y + headSize * 0.5 },
  ];
  return { d, start, end, head };
}

/**
 * The piece's top edge as it lies in the photo: a segment of half-length `half` across the
 * direction upVector(rotationDeg), `reach` from the centre – where the "top" bar goes.
 */
export function topEdgeBar(c: Point, rotationDeg: number, reach: number, half: number): { from: Point; to: Point; outward: Point } {
  const u = upVector(rotationDeg);
  const n = { x: -u.y, y: u.x };
  const m = { x: c.x + u.x * reach, y: c.y + u.y * reach };
  return { from: { x: m.x - n.x * half, y: m.y - n.y * half }, to: { x: m.x + n.x * half, y: m.y + n.y * half }, outward: u };
}
