import { describe, expect, it } from 'vitest';
import type { Point } from '../../cv/geometry';
import { LABEL_DIRECTIONS, labelCenter, labelTail, labelWidth, outwardTick, placeLabels, supportDistance, type LabelSubject } from './labels';

const square = (cx: number, cy: number, half: number): Point[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];
const subject = (key: string, cx: number, cy: number, half = 20, radius = 8): LabelSubject => ({ key, center: { x: cx, y: cy }, outline: square(cx, cy, half), radius });

/** Distance from p to the axis-aligned square (0 inside). */
function distToSquare(p: Point, cx: number, cy: number, half: number): number {
  const dx = Math.max(0, Math.abs(p.x - cx) - half);
  const dy = Math.max(0, Math.abs(p.y - cy) - half);
  return Math.hypot(dx, dy);
}

describe('label placement', () => {
  it('measures the outline extent in a direction', () => {
    expect(supportDistance({ x: 0, y: 0 }, square(0, 0, 10), { x: 1, y: 0 })).toBe(10);
    expect(supportDistance({ x: 0, y: 0 }, square(0, 0, 10), LABEL_DIRECTIONS[0])).toBeCloseTo(10 * Math.SQRT2);
    expect(supportDistance({ x: 0, y: 0 }, [], { x: 1, y: 0 })).toBe(0);
  });

  it('puts a lone label above-right, outside the outline', () => {
    const s = subject('a', 100, 100);
    const spots = placeLabels([s], { width: 400, height: 400 }, 2);
    const spot = spots.get('a')!;
    expect(spot.dir).toEqual(LABEL_DIRECTIONS[0]);
    const c = labelCenter(s.center, spot, s.radius, 2);
    expect(c.x).toBeGreaterThan(100);
    expect(c.y).toBeLessThan(100);
    // The whole label disc is outside the piece.
    expect(distToSquare(c, 100, 100, 20)).toBeGreaterThanOrEqual(s.radius);
  });

  it('keeps labels inside the photo', () => {
    // Top-right corner: above-right would leave the photo.
    const s = subject('a', 375, 25);
    const spot = placeLabels([s], { width: 400, height: 400 })!.get('a')!;
    const c = labelCenter(s.center, spot, s.radius, 0);
    expect(c.x + s.radius).toBeLessThanOrEqual(400);
    expect(c.y - s.radius).toBeGreaterThanOrEqual(0);
  });

  it('avoids neighbouring pieces and other labels', () => {
    // A piece directly above-right of another one blocks that spot.
    const a = subject('a', 100, 100);
    const b = subject('b', 150, 50);
    const spots = placeLabels([a, b], { width: 400, height: 400 }, 2);
    const ca = labelCenter(a.center, spots.get('a')!, a.radius, 2);
    const cb = labelCenter(b.center, spots.get('b')!, b.radius, 2);
    expect(distToSquare(ca, 150, 50, 20)).toBeGreaterThan(0);
    expect(distToSquare(cb, 100, 100, 20)).toBeGreaterThan(0);
    expect(Math.hypot(ca.x - cb.x, ca.y - cb.y)).toBeGreaterThanOrEqual(a.radius + b.radius);
  });

  it('places every label of a crowded grid without overlaps between labels', () => {
    const subjects: LabelSubject[] = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) subjects.push(subject(`${r}-${c}`, 60 + c * 90, 60 + r * 90, 22, 9));
    const spots = placeLabels(subjects, { width: 600, height: 500 }, 1);
    expect(spots.size).toBe(subjects.length);
    const centers = subjects.map((s) => labelCenter(s.center, spots.get(s.key)!, s.radius, 1));
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        expect(Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y)).toBeGreaterThanOrEqual(17.9);
      }
      // Not on top of any piece.
      for (const s of subjects) expect(distToSquare(centers[i], s.center.x, s.center.y, 22)).toBeGreaterThan(0);
    }
  });

  it('keeps the turn-tick side free', () => {
    const s = { ...subject('a', 200, 200), avoid: { x: 0, y: -1 } };
    // Up-right would be first choice but lies within 45° of "up"; so would "up" itself.
    const dir = placeLabels([s], { width: 400, height: 400 }).get('a')!.dir;
    expect(dir.x * 0 + dir.y * -1).toBeLessThanOrEqual(0.7071 + 1e-9);
    expect(dir).toEqual({ x: 1, y: 0 });
  });

  it('draws a tail from the label to the outline and a tick outside the outline', () => {
    const spot = { dir: { x: 1, y: 0 }, reach: 20 };
    const [tip, b1, b2] = labelTail({ x: 0, y: 0 }, spot, 10, 5, 3);
    // Label centre at 20 + 10 + 5 = 35; the tip almost touches the outline at x = 20.
    expect(tip.x).toBeCloseTo(20.75);
    expect(b1.x).toBeCloseTo(29);
    expect(Math.abs(b1.y - b2.y)).toBeCloseTo(6);
    const tick = outwardTick({ x: 0, y: 0 }, 20, { x: 0, y: -1 }, 2, 6, 4);
    expect(tick[0]).toEqual({ x: 0, y: -28 });
    expect(tick[1].y).toBeCloseTo(-22);
  });

  it('sizes labels: circles for short numbers, pills for long ones', () => {
    expect(labelWidth('7', 20, 12.5)).toBe(20);
    expect(labelWidth('45', 20, 12.5)).toBe(20);
    expect(labelWidth('105', 20, 12.5)).toBeGreaterThan(20);
  });
});
