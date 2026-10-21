/**
 * Where an item's cells lie in the scan photo (pure) – for the "show the fit" animation and the
 * ends of the connection lines.
 *
 * A cell is placed from the nearest *anchor*: a photo point whose spot in the finished puzzle is
 * known – a member piece's body centre (its own cell, exact), or a patch's outline centre and
 * where the matcher put it in the box (any fraction of a cell) – stepping one cell size per cell
 * along the item's puzzle axes. Without anchors: the item's centre is its cells' middle.
 *
 * A patch's far cells drift that way (its turn and size are only known to a degree or a few per
 * cent; 4 cells out that is a quarter of a cell or more), so the cell at a joining side can be
 * moved onto the patch's real rim: rimPoint finds the side's edge – and its tab or blank – on the
 * outline.
 */
import type { Point } from '../../cv/geometry';
import type { CellRef, DetectedRegion, PuzzleSide } from '../../model/types';
import type { ItemPlacement, ScanItem } from './items';
import { regionSize, sideVector } from './overlay';

export interface CellAnchor {
  at: Point;
  row: number;
  col: number;
  /** A piece's own body centre (no correction needed at its cell). */
  exact?: boolean;
}

/** What placing an item's cells takes. */
export interface CellItem {
  /** Photo centre: the middle of its cells when there are no anchors. */
  center: Point;
  cells: CellRef[];
  /** Clockwise turn from the photo to upright. */
  rotationDeg: number;
  /** One piece's size in the photo (mean side). */
  cellPx: number;
  anchors?: CellAnchor[];
  /** The outline(s) to find a patch's real rim on (rimPoint). */
  outlines?: Point[][];
}

/** Cell width and height in photo px for a piece size (mean side) and a cell aspect w / h. */
export function cellAxes(cellPx: number, aspect: number): { w: number; h: number } {
  const r = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return { w: (cellPx * 2 * r) / (1 + r), h: (cellPx * 2) / (1 + r) };
}

/** The anchor nearest to a cell (grid distance; ties: the first). */
function nearestAnchor(item: CellItem, cell: CellRef): CellAnchor {
  let best: CellAnchor | undefined;
  let bestD = Infinity;
  for (const a of item.anchors ?? []) {
    const d = (a.row - cell.row) ** 2 + (a.col - cell.col) ** 2;
    if (d < bestD - 1e-9) {
      bestD = d;
      best = a;
    }
  }
  if (best) return best;
  const n = Math.max(1, item.cells.length);
  return { at: item.center, row: item.cells.reduce((s, c) => s + c.row, 0) / n, col: item.cells.reduce((s, c) => s + c.col, 0) / n };
}

/** Photo centre of one of an item's cells (may be fractional – e.g. the middle of a block). */
export function cellPoint(item: CellItem, cell: CellRef, aspect: number): Point {
  const a = nearestAnchor(item, cell);
  const { w, h } = cellAxes(item.cellPx, aspect);
  const right = sideVector('right', item.rotationDeg);
  const down = sideVector('bottom', item.rotationDeg);
  const dc = (cell.col - a.col) * w;
  const dr = (cell.row - a.row) * h;
  return { x: a.at.x + right.x * dc + down.x * dr, y: a.at.y + right.y * dc + down.y * dr };
}

/** Rays cast across a side, per cell width; how far out a ray looks (cell depths). */
const RAYS = 40;
const RAY_REACH = 1.15;
/** Largest corrections believed: across the side and along it (cell sizes). */
const MAX_ACROSS = 0.4;
const MAX_ALONG = 0.3;

/**
 * The centre of an item's cell with its `side` edge moved onto the item's real rim (its outlines)
 * and centred on that edge's tab or blank: rays cast outwards from the cell across the side find
 * where the outline ends; the flat parts give the edge, the bump or dent between them the middle.
 * The plain cellPoint when the item has no outlines, the cell is a piece's own (exact) or the rim
 * is not found where expected (not a rim there, a hole, a cut-off outline).
 */
export function rimPoint(item: CellItem, cell: CellRef, side: PuzzleSide, aspect: number): Point {
  const p0 = cellPoint(item, cell, aspect);
  const anchor = nearestAnchor(item, cell);
  const polys = (item.outlines ?? []).filter((o) => o.length > 2);
  if (!polys.length || (anchor.exact && anchor.row === cell.row && anchor.col === cell.col)) return p0;
  const { w, h } = cellAxes(item.cellPx, aspect);
  const out = sideVector(side, item.rotationDeg);
  const vertical = side === 'top' || side === 'bottom';
  const along = sideVector(vertical ? 'right' : 'bottom', item.rotationDeg);
  // The cell's extent along the side (L) and across it (D).
  const L = vertical ? w : h;
  const D = vertical ? h : w;

  // Depth (along `out`, from the cell centre) at which each ray leaves the outline.
  const ts: number[] = [];
  const depth: number[] = [];
  for (let k = -RAYS * 0.6; k <= RAYS * 0.6; k++) {
    const t = (k / RAYS) * L;
    const o = { x: p0.x + along.x * t, y: p0.y + along.y * t };
    ts.push(t);
    depth.push(exitDepth(polys, o, out, 0.05 * D, RAY_REACH * D));
  }
  const inBand = (t: number, half: number) => Math.abs(t) <= half * L;
  const valid = (i: number) => Number.isFinite(depth[i]);
  // The flat level: the median over the side (a tab or blank covers about a third of it).
  const level0 = median(ts.flatMap((t, i) => (inBand(t, 0.5) && valid(i) ? [depth[i]] : [])));
  if (level0 === undefined) return p0;
  // The tab or blank: the longest run of rays well off that level.
  let run: [number, number] | undefined;
  let start = -1;
  for (let i = 0; i <= ts.length; i++) {
    const off = i < ts.length && inBand(ts[i], 0.5) && (!valid(i) || Math.abs(depth[i] - level0) > 0.12 * D);
    if (off && start < 0) start = i;
    if (!off && start >= 0) {
      if (!run || i - 1 - start > run[1] - run[0]) run = [start, i - 1];
      start = -1;
    }
  }
  const width = run ? ts[run[1]] - ts[run[0]] : 0;
  const knob = run && width >= 0.12 * L && width <= 0.6 * L ? run : undefined;
  // The edge: the flat parts only.
  const flat = ts.flatMap((t, i) => (inBand(t, 0.5) && valid(i) && !(knob && i >= knob[0] - 1 && i <= knob[1] + 1) ? [depth[i]] : []));
  const level = median(flat);
  if (level === undefined || flat.length < ts.filter((t) => inBand(t, 0.5)).length * 0.3) return p0;
  const across = level - D / 2;
  if (Math.abs(across) > MAX_ACROSS * D) return p0;
  const mid = knob ? (ts[knob[0]] + ts[knob[1]]) / 2 : 0;
  const alongBy = Math.abs(mid) <= MAX_ALONG * L ? mid : 0;
  return { x: p0.x + out.x * across + along.x * alongBy, y: p0.y + out.y * across + along.y * alongBy };
}

/** Where a ray from `o` along `dir` first leaves the polygons between depths `from` and `to`. */
function exitDepth(polys: Point[][], o: Point, dir: Point, from: number, to: number): number {
  const hits: number[] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      // Solve o + s·dir = a + u·(b − a).
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dir.x * -ey - dir.y * -ex;
      if (Math.abs(den) < 1e-12) continue;
      const rx = a.x - o.x;
      const ry = a.y - o.y;
      const s = (rx * -ey - ry * -ex) / den;
      const u = (dir.x * ry - dir.y * rx) / den;
      if (u >= 0 && u < 1 && s >= from && s <= to) hits.push(s);
    }
  }
  hits.sort((x, y) => x - y);
  for (const s of hits) {
    const beyond = { x: o.x + dir.x * (s + 0.5), y: o.y + dir.y * (s + 0.5) };
    if (!polys.some((p) => insidePolygon(beyond, p))) return s;
  }
  return NaN;
}

function insidePolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** What the scan tells about cell sizes: the box picture's cell in its px, the pieces' body size. */
export interface CellScale {
  /** Reference (box picture) px per cell – to read where the matcher put a patch. */
  refCell?: { w: number; h: number };
  /** Median body size of the scan's single pieces (photo px per cell). */
  bodySize?: number;
}

/** The cell aspect (w / h) a scale implies (square without the box picture). */
export function scaleAspect(scale: CellScale): number {
  return scale.refCell && scale.refCell.h > 0 ? scale.refCell.w / scale.refCell.h : 1;
}

/**
 * The CellItem of a scan item at a placement: anchors from its members (pieces: their body centre
 * at their cell; patches: their outline centre where the matcher put it, when the box picture's
 * cell size is known) and its piece size – a piece's body, a group's median member body, else the
 * scan's typical body size (a patch outline's area per cell counts its rim's tabs and holes).
 */
export function cellItemOf(item: ScanItem, placement: ItemPlacement, regions: Map<number, DetectedRegion>, scale: CellScale = {}): CellItem | undefined {
  const rot = placement.rotationDeg;
  if (rot === undefined || !placement.cells.length) return undefined;
  const members = item.regionIds.map((id) => regions.get(id)).filter((m): m is DetectedRegion => !!m);
  const bodies = members.filter((m) => m.kind === 'piece' && m.shape).map((m) => m.shape!.bodySize);
  let cellPx: number;
  if (item.kind === 'piece' && members[0]) cellPx = regionSize(members[0]);
  else if (bodies.length) cellPx = median(bodies)!;
  else if (scale.bodySize && scale.bodySize > 0) cellPx = scale.bodySize;
  else cellPx = Math.sqrt(Math.max(1, members.reduce((s, m) => s + m.area, 0) / placement.cells.length));
  const anchors: CellAnchor[] = (placement.anchors ?? []).flatMap((a) => {
    if (a.cell) return [{ at: a.at, row: a.cell.row, col: a.cell.col, exact: true }];
    if (!scale.refCell || a.x === undefined || a.y === undefined) return [];
    return [{ at: a.at, row: (a.y + 0.5) / scale.refCell.h - 0.5, col: (a.x + 0.5) / scale.refCell.w - 0.5 }];
  });
  const patches = members.filter((m) => m.kind !== 'piece' && m.contour.length > 2);
  return {
    center: item.center,
    cells: placement.cells,
    rotationDeg: rot,
    cellPx,
    anchors: anchors.length ? anchors : undefined,
    outlines: patches.length ? members.filter((m) => m.contour.length > 2).map((m) => m.contour) : undefined,
  };
}
