import { describe, expect, it } from 'vitest';
import type { Point } from '../../cv/geometry';
import { sideVector } from './overlay';
import { doublesBack, insideBox, insidePolygon, polylineLength, routeLink, sampleRoute, type BodyBox, type RouteEnd } from './route';

/** A square piece of body size 40 at `c`, needing `rot` to be upright, joining on `side`. */
function piece(c: Point, rot: number, side: 'top' | 'right' | 'bottom' | 'left'): RouteEnd & { box: BodyBox } {
  const box = { center: c, right: sideVector('right', rot), down: sideVector('bottom', rot), halfW: 20, halfH: 20 };
  return { center: c, reach: 20, dir: sideVector(side, rot), box, size: 40 };
}

/** No sample of the route lies inside either body (shrunk by 1 px: touching the edge is fine). */
function staysOut(a: RouteEnd & { box: BodyBox }, b: RouteEnd & { box: BodyBox }) {
  const r = routeLink(a, b)!;
  const pts = sampleRoute(r, 64);
  expect(pts.filter((p) => insideBox(p, a.box, 1))).toEqual([]);
  expect(pts.filter((p) => insideBox(p, b.box, 1))).toEqual([]);
  return r;
}

describe('routed connection lines', () => {
  it('goes straight out of facing sides', () => {
    const r = staysOut(piece({ x: 0, y: 0 }, 0, 'right'), piece({ x: 120, y: 0 }, 0, 'left'));
    expect(r.from).toEqual({ x: 20, y: 0 });
    expect(r.to).toEqual({ x: 100, y: 0 });
    expect(r.segments).toHaveLength(1);
  });

  it("goes round B when B's joining side faces away from A", () => {
    // B lies upside down: its future left side faces right, away from A.
    const a = piece({ x: 0, y: 0 }, 0, 'right');
    const b = piece({ x: 120, y: 0 }, 180, 'left');
    const r = staysOut(a, b);
    expect(r.to.x).toBeCloseTo(140);
    expect(r.segments.length).toBeGreaterThan(1);
    // It arrives at B's joining side from outside (moving back towards B).
    const last = r.segments[r.segments.length - 1];
    expect(last[2].x).toBeGreaterThan(140);
  });

  it("goes round A when A's joining side faces away, and round both when both do", () => {
    staysOut(piece({ x: 0, y: 0 }, 180, 'right'), piece({ x: 120, y: 0 }, 0, 'left'));
    staysOut(piece({ x: 0, y: 0 }, 180, 'right'), piece({ x: 120, y: 0 }, 180, 'left'));
  });

  it('handles sides at right angles and diagonal layouts', () => {
    // B below-right of A, joining with its top side, which faces down (B turned 180°).
    staysOut(piece({ x: 0, y: 0 }, 0, 'bottom'), piece({ x: 90, y: 110 }, 180, 'top'));
    // A's right side faces up (A needs a quarter turn clockwise), B far to the right.
    staysOut(piece({ x: 0, y: 0 }, 90, 'right'), piece({ x: 200, y: 30 }, 0, 'left'));
    // Close together, B's joining side facing away.
    staysOut(piece({ x: 0, y: 0 }, 0, 'right'), piece({ x: 70, y: 10 }, 180, 'left'));
  });

  it('never doubles back: ends facing away from each other, a short gap', () => {
    // Both joining sides face away: the line has to go round, but as one wide arc.
    const a = piece({ x: 0, y: 0 }, 0, 'left');
    const b = piece({ x: 150, y: 0 }, 0, 'right');
    const r = staysOut(a, b);
    const pts = sampleRoute(r, 32);
    expect(doublesBack(pts, 14)).toBe(false);
    expect(polylineLength(pts) / Math.hypot(r.to.x - r.from.x, r.to.y - r.from.y)).toBeLessThan(3);
  });

  it('no hairpin for a small patch lying in a notch of a big one (a real scan)', () => {
    // #8 (a small patch, turned 118°) joins the left side of #10 (a big patch); #8 lies in a notch of
    // #10's cell block, so the block box overlaps it – only the real outline tells them apart.
    const a: RouteEnd & { box: BodyBox } = {
      center: { x: 759, y: 1084 },
      reach: 87,
      dir: { x: 0.47, y: 0.88 },
      size: 174,
      box: { center: { x: 759, y: 1084 }, right: { x: -0.47, y: -0.88 }, down: { x: 0.88, y: -0.47 }, halfW: 87, halfH: 87 },
    };
    const outline = [
      { x: 1106, y: 640 },
      { x: 1660, y: 640 },
      { x: 1660, y: 1860 },
      { x: 1106, y: 1860 },
    ];
    const b: RouteEnd & { box: BodyBox } = {
      center: { x: 1174, y: 1120 },
      reach: 68,
      dir: { x: -0.997, y: 0.078 },
      size: 136,
      box: { center: { x: 1252, y: 1250 }, right: { x: -0.997, y: 0.078 }, down: { x: -0.078, y: -0.997 }, halfW: 407, halfH: 611, outlines: [outline] },
    };
    const r = routeLink(a, b)!;
    const pts = sampleRoute(r, 32);
    const straight = Math.hypot(r.to.x - r.from.x, r.to.y - r.from.y);
    expect(doublesBack(pts, 50)).toBe(false);
    expect(polylineLength(pts) / straight).toBeLessThan(1.5);
    expect(pts.filter((p) => insideBox(p, a.box, 1))).toEqual([]);
    // Never climbs far above the two ends (the old route went up past a third piece).
    expect(Math.min(...pts.map((p) => p.y))).toBeGreaterThan(Math.min(r.from.y, r.to.y) - 120);
    expect(pts.slice(4, -4).filter((p) => insidePolygon(p, outline))).toEqual([]);
  });

  it('keeps the path direction from a to b (the flow follows it)', () => {
    const r = routeLink(piece({ x: 0, y: 0 }, 0, 'right'), piece({ x: 120, y: 0 }, 180, 'left'))!;
    expect(r.d.startsWith('M20,0 C')).toBe(true);
  });

  it('falls back to a straight-ish curve without sides', () => {
    const r = routeLink({ center: { x: 0, y: 0 }, reach: 5 }, { center: { x: 0, y: 50 }, reach: 5 })!;
    expect(r.from).toEqual({ x: 0, y: 5 });
    expect(r.to).toEqual({ x: 0, y: 45 });
  });
});
