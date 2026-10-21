/**
 * Connection lines routed around the pieces (pure): each end leaves its piece through the joining
 * side along that side's outward normal (a short arm: 0.35–0.6 piece sizes, at most 0.4 of the
 * distance) and arrives at the other piece's joining side from outside. When the plain curve would
 * cut through either body (a joining side that faces away from the other piece), it goes round
 * that body; of the ways round (either side of either body) the shortest that stays out of both
 * bodies and never doubles back on itself (no hairpin) wins.
 */
import type { Point } from '../../cv/geometry';
import type { CellRef, DetectedRegion, PuzzleSide } from '../../model/types';
import type { ItemLink, ItemPlacement, ScanItem } from './items';
import { cellAxes, cellItemOf, cellPoint, rimPoint, scaleAspect, type CellScale } from './cellSpots';
import { regionSize, sideVector } from './overlay';

/** A piece's (or patch's) body as a rotated box in photo coordinates. */
export interface BodyBox {
  center: Point;
  /** Unit vectors of the body's axes in the photo (its puzzle right and down). */
  right: Point;
  down: Point;
  halfW: number;
  halfH: number;
  /**
   * The body's real outline(s), for bodies a box fits badly (an assembled patch with notches):
   * then a point is inside when it is inside an outline, and the box only places the way round.
   */
  outlines?: Point[][];
}

export interface RouteEnd {
  center: Point;
  /** Distance from `center` to where the line attaches (half the body size for a piece edge). */
  reach: number;
  /** Outward unit normal of the joining side; omitted = straight towards the other end. */
  dir?: Point;
  /** The body to keep the line out of (omitted: no check). */
  box?: BodyBox;
  /** Piece size in photo px (how far the line leaves an edge before it turns). */
  size?: number;
}

export interface Route {
  /** SVG path data from `from` to `to`. */
  d: string;
  from: Point;
  to: Point;
  /** The path as cubic segments [p0, c1, c2, p1] (for sampling, e.g. a glide along it). */
  segments: [Point, Point, Point, Point][];
}

const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const len = (a: Point) => Math.hypot(a.x, a.y);

/** Whether `p` lies inside the box shrunk by `margin` (photo px) on every side. */
export function insideBox(p: Point, box: BodyBox, margin = 0): boolean {
  const v = sub(p, box.center);
  return Math.abs(dot(v, box.right)) < box.halfW - margin && Math.abs(dot(v, box.down)) < box.halfH - margin;
}

/** Point at parameter t of a cubic Bézier. */
export function bezierPoint([p0, c1, c2, p1]: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y };
}

/** Evenly spaced samples (in parameter) of a route, `n` per segment. */
export function sampleRoute(route: Route, n = 24): Point[] {
  const out: Point[] = [];
  route.segments.forEach((s, i) => {
    for (let k = i === 0 ? 0 : 1; k <= n; k++) out.push(bezierPoint(s, k / n));
  });
  return out;
}

/** Whether `p` lies inside a polygon (even-odd rule). */
export function insidePolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Whether `p` is inside a body: its box shrunk a little (so touching its edge is fine), or its
 * outlines when known – then points within `skip` of the line's attach point don't count (the
 * line attaches at the joining edge, the outline's tabs reach past it).
 */
function insideBody(p: Point, box: BodyBox, attach: Point, skip: number): boolean {
  if (box.outlines?.length) return len(sub(p, attach)) >= skip && box.outlines.some((o) => o.length > 2 && insidePolygon(p, o));
  return insideBox(p, box, Math.min(box.halfW, box.halfH) * 0.08);
}

/**
 * Hermite points (position + tangent) → cubic segments. End tangents are the outward normals ×
 * 3k (so the first control point sits k out from the edge).
 */
function hermite(points: Point[], t0: Point, t1: Point): [Point, Point, Point, Point][] {
  const n = points.length;
  // Inner tangents: along the neighbours' chord, as long as the shorter of the two hops (so a
  // point beside a body is passed smoothly, without overshooting into it).
  const tangent = (i: number) => {
    if (i === 0) return t0;
    if (i === n - 1) return t1;
    const d = sub(points[i + 1], points[i - 1]);
    const l = len(d) || 1;
    const m = Math.min(len(sub(points[i + 1], points[i])), len(sub(points[i], points[i - 1])));
    return { x: (d.x / l) * m, y: (d.y / l) * m };
  };
  const segs: [Point, Point, Point, Point][] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ta = tangent(i);
    const tb = tangent(i + 1);
    segs.push([a, add(a, ta, 1 / 3), add(b, tb, -1 / 3), b]);
  }
  return segs;
}

/**
 * A point beside `box`, on side `sign` of the axis perpendicular to `dir`, a little towards the
 * joining side – so a line round it wraps the body's corner.
 */
function aroundPoint(box: BodyBox, dir: Point, sign: number, clearance: number): Point {
  const alongRight = Math.abs(dot(dir, box.right)) < Math.abs(dot(dir, box.down));
  const perp = alongRight ? box.right : box.down;
  const half = alongRight ? box.halfW : box.halfH;
  const halfAlong = alongRight ? box.halfH : box.halfW;
  return add(add(box.center, perp, sign * (half + clearance)), dir, halfAlong * 0.5);
}

/** Sampled points of cubic segments, `n` per segment. */
function samples(segs: [Point, Point, Point, Point][], n = 20): Point[] {
  const out: Point[] = [segs[0][0]];
  for (const s of segs) for (let k = 1; k <= n; k++) out.push(bezierPoint(s, k / n));
  return out;
}

/** Length of a polyline. */
export function polylineLength(pts: Point[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += len(sub(pts[i], pts[i - 1]));
  return l;
}

/**
 * Whether a path doubles back on itself: two of its points closer than `gap` although the path
 * between them is more than four times as long (a hairpin, or a loop).
 */
export function doublesBack(pts: Point[], gap: number): boolean {
  const along: number[] = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + len(sub(pts[i], pts[i - 1])));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 2; j < pts.length; j++) {
      if (along[j] - along[i] > gap * 4 && len(sub(pts[j], pts[i])) < gap) return true;
    }
  }
  return false;
}

/** Route a connection from `a` to `b` (see the file comment). */
export function routeLink(a: RouteEnd, b: RouteEnd): Route | null {
  const between = sub(b.center, a.center);
  const dist = len(between);
  if (dist < 1e-6) return null;
  const towardB = { x: between.x / dist, y: between.y / dist };
  const dirA = a.dir ?? towardB;
  const dirB = b.dir ?? { x: -towardB.x, y: -towardB.y };
  const from = add(a.center, dirA, a.reach);
  const to = add(b.center, dirB, b.reach);
  const size = ((a.size ?? a.reach * 2) + (b.size ?? b.reach * 2)) / 2;
  const gap = len(sub(to, from));
  // A short arm out of each edge: 0.35–0.6 piece sizes (more with distance), at most 0.4 of the gap.
  const k = Math.min(Math.min(Math.max(gap * 0.3, size * 0.35), size * 0.6), Math.max(gap * 0.4, 1));
  const t0 = { x: dirA.x * 3 * k, y: dirA.y * 3 * k };
  const t1 = { x: -dirB.x * 3 * k, y: -dirB.y * 3 * k };
  const clearance = size * 0.45;
  const skip = size * 0.45;

  // The candidates: straight, round B (either side), round A (either side), round both.
  const ways: Point[][] = [[from, to]];
  const sides = (box: BodyBox, dir: Point, toward: Point) => {
    const alongRight = Math.abs(dot(dir, box.right)) < Math.abs(dot(dir, box.down));
    const perp = alongRight ? box.right : box.down;
    const near = dot(sub(toward, box.center), perp) >= 0 ? 1 : -1;
    return [near, -near];
  };
  if (b.box) for (const sb of sides(b.box, dirB, from)) ways.push([from, aroundPoint(b.box, dirB, sb, clearance), to]);
  if (a.box) for (const sa of sides(a.box, dirA, to)) ways.push([from, aroundPoint(a.box, dirA, sa, clearance), to]);
  if (a.box && b.box) {
    const va = aroundPoint(a.box, dirA, sides(a.box, dirA, to)[0], clearance);
    ways.push([from, va, aroundPoint(b.box, dirB, sides(b.box, dirB, va)[0], clearance), to]);
  }

  let best: { segs: [Point, Point, Point, Point][]; score: number } | undefined;
  for (const points of ways) {
    const segs = hermite(points, t0, t1);
    const pts = samples(segs);
    const inside = pts.filter((p) => (a.box && insideBody(p, a.box, from, skip)) || (b.box && insideBody(p, b.box, to, skip))).length;
    const hairpin = doublesBack(pts, size * 0.35);
    // Good ways first (out of both bodies, no hairpin), then by length.
    const score = (inside > 0 ? 1e9 + inside * 1e6 : 0) + (hairpin ? 1e8 : 0) + polylineLength(pts);
    if (!best || score < best.score) best = { segs, score };
  }
  const segs = best!.segs;
  const f = (p: Point) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
  const d = `M${f(from)}` + segs.map((s) => ` C${f(s[1])} ${f(s[2])} ${f(s[3])}`).join('');
  return { d, from, to, segments: segs };
}

/**
 * One end of a connection line for an item of the scan: a piece leaves through its joining side
 * (its body as the box to stay out of); an assembled group through the joining side of its
 * touching cell – where the fit animation docks (cellSpots: rimPoint) – with the group's cell
 * block as the box; without a known side or turn, straight from its centre, `fallbackReach` out.
 */
export function itemRouteEnd(
  item: ScanItem,
  placement: ItemPlacement | undefined,
  regions: Map<number, DetectedRegion>,
  side: PuzzleSide | undefined,
  cell: CellRef | undefined,
  fallbackReach: number,
  scale: CellScale = {},
): RouteEnd {
  const rot = placement?.rotationDeg;
  if (side && rot !== undefined) {
    const dir = sideVector(side, rot);
    const right = sideVector('right', rot);
    const down = sideVector('bottom', rot);
    if (item.kind === 'piece') {
      const region = regions.get(item.regionIds[0]);
      if (region) {
        const size = regionSize(region);
        return { center: item.center, reach: size / 2, dir, size, box: { center: item.center, right, down, halfW: size / 2, halfH: size / 2 } };
      }
    } else if (cell && placement) {
      const ci = cellItemOf(item, placement, regions, scale);
      if (ci) {
        const aspect = scaleAspect(scale);
        const { w, h } = cellAxes(ci.cellPx, aspect);
        const { row0, col0, row1, col1 } = placement.bounds;
        const across = side === 'top' || side === 'bottom' ? h : w;
        return {
          center: rimPoint(ci, cell, side, aspect),
          reach: across / 2,
          dir,
          size: ci.cellPx,
          // Its real outline too (a patch's cell block can have notches – another item may lie in one).
          box: {
            center: cellPoint(ci, { row: (row0 + row1) / 2, col: (col0 + col1) / 2 }, aspect),
            right,
            down,
            halfW: ((col1 - col0 + 1) * w) / 2,
            halfH: ((row1 - row0 + 1) * h) / 2,
            outlines: item.regionIds.flatMap((id) => (regions.get(id) ? [thin(regions.get(id)!.contour, 64)] : [])).filter((o) => o.length > 2),
          },
        };
      }
    }
  }
  return { center: item.center, reach: fallbackReach };
}

/** The routed line of a link between two items (from a to b), or null when they coincide. `scale`: see cellItemOf. */
export function linkRoute(
  l: ItemLink,
  a: { item: ScanItem; placement: ItemPlacement | undefined },
  b: { item: ScanItem; placement: ItemPlacement | undefined },
  regions: Map<number, DetectedRegion>,
  fallbackReach: (key: string) => number,
  scale: CellScale = {},
): Route | null {
  return routeLink(
    itemRouteEnd(a.item, a.placement, regions, l.sideA, l.cellA, fallbackReach(l.a), scale),
    itemRouteEnd(b.item, b.placement, regions, l.sideB, l.cellB, fallbackReach(l.b), scale),
  );
}

/** At most `max` points of a contour, evenly picked. */
function thin(contour: Point[], max: number): Point[] {
  const step = Math.max(1, Math.ceil(contour.length / max));
  return contour.filter((_, i) => i % step === 0);
}
