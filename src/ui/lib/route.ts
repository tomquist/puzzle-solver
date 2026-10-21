/**
 * Connection lines routed around the pieces (pure): each end leaves its piece through the joining
 * side along that side's outward normal and arrives at the other piece's joining side from
 * outside – and when the plain curve would still cut through either piece's body (a joining side
 * that faces away from the other piece), it goes around that body on the shorter side.
 */
import type { Point } from '../../cv/geometry';
import type { CellRef, DetectedRegion, PuzzleSide } from '../../model/types';
import type { ItemLink, ItemPlacement, ScanItem } from './items';
import { groupCellCenter, groupCellSize, regionSize, sideVector } from './overlay';

/** A piece's (or patch's) body as a rotated box in photo coordinates. */
export interface BodyBox {
  center: Point;
  /** Unit vectors of the body's axes in the photo (its puzzle right and down). */
  right: Point;
  down: Point;
  halfW: number;
  halfH: number;
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

/** Whether a route enters a body (a little shrunk, so touching its edge is fine). */
function crosses(segs: [Point, Point, Point, Point][], box: BodyBox | undefined): boolean {
  if (!box) return false;
  const margin = Math.min(box.halfW, box.halfH) * 0.08;
  for (const s of segs) for (let k = 1; k < 24; k++) if (insideBox(bezierPoint(s, k / 24), box, margin)) return true;
  return false;
}

/**
 * Hermite points (position + tangent) → cubic segments. End tangents are the outward normals ×
 * 3k (so the first control point sits k out from the edge); inner tangents Catmull-Rom.
 */
function hermite(points: Point[], t0: Point, t1: Point): [Point, Point, Point, Point][] {
  const n = points.length;
  const tangent = (i: number) => (i === 0 ? t0 : i === n - 1 ? t1 : { x: (points[i + 1].x - points[i - 1].x) / 2, y: (points[i + 1].y - points[i - 1].y) / 2 });
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
 * A point beside `box`, out of the way of a line that must reach the side `dir` of it coming from
 * `toward`: on the box's side (perpendicular to `dir`) that faces `toward`, past its corner.
 */
function aroundPoint(box: BodyBox, dir: Point, toward: Point, clearance: number): Point {
  // The two candidate sides: ± the axis perpendicular to dir.
  const alongRight = Math.abs(dot(dir, box.right)) < Math.abs(dot(dir, box.down));
  const perp = alongRight ? box.right : box.down;
  const half = alongRight ? box.halfW : box.halfH;
  const halfAlong = alongRight ? box.halfH : box.halfW;
  const sign = dot(sub(toward, box.center), perp) >= 0 ? 1 : -1;
  // Beside the body, a little towards the joining side, so the line wraps round its corner.
  return add(add(box.center, perp, sign * (half + clearance)), dir, halfAlong * 0.5);
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
  // Leave / enter each edge for 0.6–1 piece sizes, more when the ends are far apart.
  const k = Math.min(Math.max(len(sub(to, from)) * 0.3, size * 0.6), size);
  const t0 = { x: dirA.x * 3 * k, y: dirA.y * 3 * k };
  const t1 = { x: -dirB.x * 3 * k, y: -dirB.y * 3 * k };

  let points = [from, to];
  let segs = hermite(points, t0, t1);
  const clearance = size * 0.45;
  // Around B when the plain curve cuts through it, then around A (each on the shorter side).
  if (crosses(segs, b.box)) {
    points = [from, aroundPoint(b.box!, dirB, from, clearance), to];
    segs = hermite(points, t0, t1);
  }
  if (crosses(segs, a.box)) {
    points = [from, aroundPoint(a.box!, dirA, points[1] ?? to, clearance), ...points.slice(1)];
    segs = hermite(points, t0, t1);
  }
  const f = (p: Point) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
  const d = `M${f(from)}` + segs.map((s) => ` C${f(s[1])} ${f(s[2])} ${f(s[3])}`).join('');
  return { d, from, to, segments: segs };
}

/**
 * One end of a connection line for an item of the scan: a piece leaves through its joining side
 * (its body as the box to stay out of); an assembled group through the joining side of its
 * touching cell (the group's cell block as the box); without a known side or turn, straight from
 * its centre, `fallbackReach` out.
 */
export function itemRouteEnd(
  item: ScanItem,
  placement: ItemPlacement | undefined,
  regions: Map<number, DetectedRegion>,
  side: PuzzleSide | undefined,
  cell: CellRef | undefined,
  fallbackReach: number,
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
    } else if (cell && placement && placement.cells.length > 0) {
      const members = item.regionIds.map((id) => regions.get(id)).filter((m): m is DetectedRegion => !!m);
      const px = groupCellSize(members, placement.cells.length);
      const { row0, col0, row1, col1 } = placement.bounds;
      const mid = groupCellCenter(item.center, placement.cells, { row: (row0 + row1) / 2, col: (col0 + col1) / 2 }, rot, px);
      return {
        center: groupCellCenter(item.center, placement.cells, cell, rot, px),
        reach: px / 2,
        dir,
        size: px,
        box: { center: mid, right, down, halfW: ((col1 - col0 + 1) * px) / 2, halfH: ((row1 - row0 + 1) * px) / 2 },
      };
    }
  }
  return { center: item.center, reach: fallbackReach };
}

/** The routed line of a link between two items (from a to b), or null when they coincide. */
export function linkRoute(
  l: ItemLink,
  a: { item: ScanItem; placement: ItemPlacement | undefined },
  b: { item: ScanItem; placement: ItemPlacement | undefined },
  regions: Map<number, DetectedRegion>,
  fallbackReach: (key: string) => number,
): Route | null {
  return routeLink(
    itemRouteEnd(a.item, a.placement, regions, l.sideA, l.cellA, fallbackReach(l.a)),
    itemRouteEnd(b.item, b.placement, regions, l.sideB, l.cellB, fallbackReach(l.b)),
  );
}
