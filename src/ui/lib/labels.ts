/**
 * Where to draw the number label of each item on the scan photo: just outside its outline, so the
 * piece itself stays visible, on the side with the least overlap with other pieces and labels
 * (pure).
 *
 * A label sits on a ray from the item centre in one of eight directions, past the outline's
 * extent in that direction: centre + dir × (reach + labelRadius + gap). As the label never crosses
 * that support line it cannot cover its own piece. The direction is chosen once at the most
 * crowded zoom (the fitted photo); at higher zoom the label (constant screen size) only gets
 * relatively smaller and stays next to the outline.
 */
import type { Point } from '../../cv/geometry';

export interface LabelSubject {
  key: string;
  center: Point;
  /** Outline points of the item (photo px); empty → a small disc around the centre. */
  outline: Point[];
  /** Label radius (half its width) in photo px at the zoom the placement is computed for. */
  radius: number;
  /** A direction to keep free (e.g. where the item's turn tick is drawn). */
  avoid?: Point;
}

export interface LabelSpot {
  /** Unit direction from the item centre. */
  dir: Point;
  /** Extent of the outline in that direction (photo px from the centre). */
  reach: number;
}

const D = Math.SQRT1_2;
/** Candidate directions, most preferred first: above-right, right, above, …. */
export const LABEL_DIRECTIONS: Point[] = [
  { x: D, y: -D },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: D, y: D },
  { x: -D, y: -D },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: -D, y: D },
];

/** Largest projection of the outline (relative to `center`) on `dir`. */
export function supportDistance(center: Point, outline: Point[], dir: Point): number {
  let best = 0;
  for (const p of outline) best = Math.max(best, (p.x - center.x) * dir.x + (p.y - center.y) * dir.y);
  return best;
}

/** Centre of a label of radius `r` placed at `spot` with `gap` between it and the outline. */
export function labelCenter(center: Point, spot: LabelSpot, r: number, gap: number): Point {
  const d = spot.reach + r + gap;
  return { x: center.x + spot.dir.x * d, y: center.y + spot.dir.y * d };
}

interface Prepared {
  s: LabelSubject;
  reach: number[];
  /** Rough body radius (for overlap with other items' labels). */
  body: number;
}

/**
 * Pick a direction for every subject's label. Greedy, most crowded items first, then one
 * refinement pass with all other labels known. `bounds` keeps labels inside the photo; `gap` is
 * the space between outline and label (photo px).
 */
export function placeLabels(subjects: LabelSubject[], bounds: { width: number; height: number }, gap = 0): Map<string, LabelSpot> {
  const prep: Prepared[] = subjects.map((s) => {
    const reach = LABEL_DIRECTIONS.map((d) => supportDistance(s.center, s.outline, d));
    const body = reach.reduce((a, b) => a + b, 0) / reach.length;
    return { s, reach, body };
  });
  const pos = new Map<string, Point>();
  const choice = new Map<string, number>();

  const cost = (p: Prepared, k: number): number => {
    const r = p.s.radius;
    const c = labelCenter(p.s.center, { dir: LABEL_DIRECTIONS[k], reach: p.reach[k] }, r, gap);
    let total = k * 0.08;
    // The side kept free for the turn tick.
    const av = p.s.avoid;
    if (av && LABEL_DIRECTIONS[k].x * av.x + LABEL_DIRECTIONS[k].y * av.y > 0.7) total += 1.5;
    // Outside the photo.
    const out = Math.max(0, r - c.x) + Math.max(0, c.x + r - bounds.width) + Math.max(0, r - c.y) + Math.max(0, c.y + r - bounds.height);
    total += (3 * out) / r;
    for (const q of prep) {
      if (q === p) continue;
      // Other pieces' bodies.
      const db = Math.hypot(c.x - q.s.center.x, c.y - q.s.center.y);
      total += Math.max(0, r + q.body - db) / r;
      // Other labels already placed.
      const qc = pos.get(q.s.key);
      if (qc) {
        const dl = Math.hypot(c.x - qc.x, c.y - qc.y);
        total += (2 * Math.max(0, r + q.s.radius + gap - dl)) / r;
      }
    }
    return total;
  };
  const best = (p: Prepared) => {
    let k0 = 0;
    let c0 = Infinity;
    for (let k = 0; k < LABEL_DIRECTIONS.length; k++) {
      const c = cost(p, k);
      if (c < c0 - 1e-9) {
        c0 = c;
        k0 = k;
      }
    }
    return k0;
  };
  const place = (p: Prepared, k: number) => {
    choice.set(p.s.key, k);
    pos.set(p.s.key, labelCenter(p.s.center, { dir: LABEL_DIRECTIONS[k], reach: p.reach[k] }, p.s.radius, gap));
  };

  // Most crowded first: they have the fewest good options.
  const crowd = (p: Prepared) =>
    prep.filter((q) => q !== p && Math.hypot(q.s.center.x - p.s.center.x, q.s.center.y - p.s.center.y) < 2.5 * (p.body + q.body + p.s.radius + q.s.radius)).length;
  const order = [...prep].sort((a, b) => crowd(b) - crowd(a) || a.s.center.y - b.s.center.y || a.s.center.x - b.s.center.x);
  for (const p of order) place(p, best(p));
  for (const p of order) {
    pos.delete(p.s.key);
    place(p, best(p));
  }

  const out = new Map<string, LabelSpot>();
  for (const p of prep) {
    const k = choice.get(p.s.key) ?? 0;
    out.set(p.s.key, { dir: LABEL_DIRECTIONS[k], reach: p.reach[k] });
  }
  return out;
}

/**
 * Short tail from a label (radius `r`, placed at `spot` with `gap`) to its item's outline, so it is
 * clear which piece a label belongs to. The base lies inside the label (drawn over it).
 */
export function labelTail(center: Point, spot: LabelSpot, r: number, gap: number, halfWidth: number): [Point, Point, Point] {
  const { dir } = spot;
  const c = labelCenter(center, spot, r, gap);
  const tipD = spot.reach + gap * 0.15;
  const tip = { x: center.x + dir.x * tipD, y: center.y + dir.y * tipD };
  const base = { x: c.x - dir.x * r * 0.6, y: c.y - dir.y * r * 0.6 };
  const n = { x: -dir.y, y: dir.x };
  return [tip, { x: base.x + n.x * halfWidth, y: base.y + n.y * halfWidth }, { x: base.x - n.x * halfWidth, y: base.y - n.y * halfWidth }];
}

/**
 * Small triangle just outside an outline, pointing outward along unit vector `dir` – e.g. at the
 * side of a piece that is "up" in the finished puzzle (a subtle turn hint that covers nothing).
 * `reach` is the outline's extent in that direction, `gap` the space to the outline.
 */
export function outwardTick(center: Point, reach: number, dir: Point, gap: number, length: number, halfWidth: number): [Point, Point, Point] {
  const b = reach + gap;
  const t = b + length;
  const n = { x: -dir.y, y: dir.x };
  const base = { x: center.x + dir.x * b, y: center.y + dir.y * b };
  return [{ x: center.x + dir.x * t, y: center.y + dir.y * t }, { x: base.x + n.x * halfWidth, y: base.y + n.y * halfWidth }, { x: base.x - n.x * halfWidth, y: base.y - n.y * halfWidth }];
}

/** Width of a number label: a circle for up to two characters, a pill for more (screen px). */
export function labelWidth(text: string, height: number, fontSize: number): number {
  const n = [...text].length;
  return n <= 2 ? height : Math.max(height, n * fontSize * 0.62 + fontSize * 0.7);
}
