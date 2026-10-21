/** Geometry for SVG overlays on photos and the reference picture (pure). */
import type { Point } from '../../cv/geometry';
import type { Rect } from '../../cv/image';
import type { CellRef, DetectedRegion, GridSpec, PuzzleSide } from '../../model/types';
import { upVector } from './rotation';

/** SVG path data for a closed polygon. */
export function polygonPath(points: Point[]): string {
  if (points.length === 0) return '';
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `L${f(points[i].x)} ${f(points[i].y)}`;
  return d + 'Z';
}

/** Area-weighted centroid of a polygon (falls back to the vertex mean for degenerate input). */
export function polygonCentroid(points: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const cross = points[j].x * points[i].y - points[i].x * points[j].y;
    a += cross;
    cx += (points[j].x + points[i].x) * cross;
    cy += (points[j].y + points[i].y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const n = Math.max(1, points.length);
    return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Where to put a region's number / arrow: shape center, contour centroid, or bbox center. */
export function regionCenter(region: DetectedRegion): Point {
  if (region.shape) return region.shape.center;
  if (region.contour.length >= 3) return polygonCentroid(region.contour);
  return { x: region.bbox.x + region.bbox.width / 2, y: region.bbox.y + region.bbox.height / 2 };
}

/** Characteristic size of a region (body size for pieces, else sqrt of area). */
export function regionSize(region: DetectedRegion): number {
  if (region.shape) return region.shape.bodySize;
  return Math.sqrt(Math.max(1, region.area));
}

export interface ArrowGeometry {
  /** Shaft start and tip. */
  from: Point;
  to: Point;
  /** Arrow head triangle (tip, left, right). */
  head: [Point, Point, Point];
}

/**
 * "Up" arrow for a region: pointing from `center` at upVector(rotationDeg), with its tip `length`
 * away. `start` is where the shaft begins (default slightly behind the center), `head` the
 * length of the arrow head (default 32 % of `length`).
 */
export function upArrow(center: Point, rotationDeg: number, length: number, opts: { start?: number; head?: number } = {}): ArrowGeometry {
  const u = upVector(rotationDeg);
  const start = opts.start ?? -length * 0.15;
  const hl = Math.min(length - start, opts.head ?? length * 0.32);
  const hw = hl * 0.7; // head half-width
  const from = { x: center.x + u.x * start, y: center.y + u.y * start };
  const to = { x: center.x + u.x * length, y: center.y + u.y * length };
  const base = { x: to.x - u.x * hl, y: to.y - u.y * hl };
  const n = { x: -u.y, y: u.x };
  return {
    from,
    to: base,
    head: [to, { x: base.x + n.x * hw, y: base.y + n.y * hw }, { x: base.x - n.x * hw, y: base.y - n.y * hw }],
  };
}

export function cellSize(grid: GridSpec, width: number, height: number): { w: number; h: number } {
  return { w: width / grid.cols, h: height / grid.rows };
}

/** Reference-pixel rectangle of a grid cell (ARCHITECTURE §3). */
export function cellRect(cell: CellRef, grid: GridSpec, width: number, height: number): Rect {
  const { w, h } = cellSize(grid, width, height);
  return { x: cell.col * w, y: cell.row * h, width: w, height: h };
}

/** Grid cell containing reference point (x, y), clamped into the grid. */
export function cellAt(x: number, y: number, grid: GridSpec, width: number, height: number): CellRef {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x / width) * grid.cols)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((y / height) * grid.rows)));
  return { row, col };
}

/** Grid lines as an SVG path (interior lines only). */
export function gridPath(grid: GridSpec, width: number, height: number): string {
  let d = '';
  for (let c = 1; c < grid.cols; c++) {
    const x = Math.round(((c * width) / grid.cols) * 10) / 10;
    d += `M${x} 0V${height}`;
  }
  for (let r = 1; r < grid.rows; r++) {
    const y = Math.round(((r * height) / grid.rows) * 10) / 10;
    d += `M0 ${y}H${width}`;
  }
  return d;
}

/**
 * Square crop (center + side) around a reference location that spans `cellsAcross` cells, used for
 * candidate previews (≈ 2.2 cells shows the piece plus its neighbourhood).
 */
export function cropAround(
  x: number,
  y: number,
  grid: GridSpec,
  width: number,
  height: number,
  cellsAcross = 2.2,
): { cx: number; cy: number; side: number } {
  const { w, h } = cellSize(grid, width, height);
  return { cx: x, cy: y, side: Math.max(w, h) * cellsAcross };
}

/** Marker radius on the reference so numbers stay legible but don't hide neighbouring cells. */
export function markerRadius(grid: GridSpec, width: number, height: number): number {
  const { w, h } = cellSize(grid, width, height);
  return Math.max(4, Math.min(w, h) * 0.42);
}

/** Bounding box (with padding fraction) of a region, clamped to the image. */
export function paddedBox(rect: Rect, pad: number, width: number, height: number): Rect {
  const px = rect.width * pad;
  const py = rect.height * pad;
  const x0 = Math.max(0, rect.x - px);
  const y0 = Math.max(0, rect.y - py);
  const x1 = Math.min(width, rect.x + rect.width + px);
  const y1 = Math.min(height, rect.y + rect.height + py);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

// ---------------------------------------------------------------------------------------------
// Zoom & pan
// ---------------------------------------------------------------------------------------------

export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

/** Transform that fits content (cw × ch) centered into a viewport (vw × vh). */
export function fitTransform(cw: number, ch: number, vw: number, vh: number, margin = 0): ViewTransform {
  if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min((vw - 2 * margin) / cw, (vh - 2 * margin) / ch);
  return { scale, x: (vw - cw * scale) / 2, y: (vh - ch * scale) / 2 };
}

/** Zoom by `factor` keeping viewport point `at` fixed; scale clamped to [minScale, maxScale]. */
export function zoomAt(t: ViewTransform, factor: number, at: Point, minScale: number, maxScale: number): ViewTransform {
  const scale = Math.min(maxScale, Math.max(minScale, t.scale * factor));
  const k = scale / t.scale;
  return { scale, x: at.x - (at.x - t.x) * k, y: at.y - (at.y - t.y) * k };
}

/**
 * Keep the content reachable: when it is smaller than the viewport it is centered on that axis,
 * otherwise it may not be dragged past its edges.
 */
export function clampPan(t: ViewTransform, cw: number, ch: number, vw: number, vh: number): ViewTransform {
  const w = cw * t.scale;
  const h = ch * t.scale;
  const x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, t.x));
  const y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, t.y));
  return { scale: t.scale, x, y };
}

/** Transform that centers content point p in the viewport at the given scale. */
export function centerOn(p: Point, scale: number, vw: number, vh: number): ViewTransform {
  return { scale, x: vw / 2 - p.x * scale, y: vh / 2 - p.y * scale };
}

/**
 * Transform that shows content rectangle `r` as large as it fits (scale clamped to
 * [minScale, maxScale]), centred on it and kept within the content (cw × ch).
 */
export function transformForRect(r: Rect, cw: number, ch: number, vw: number, vh: number, minScale: number, maxScale: number): ViewTransform {
  if (r.width <= 0 || r.height <= 0 || vw <= 0 || vh <= 0) return { scale: minScale, x: 0, y: 0 };
  const scale = Math.min(maxScale, Math.max(minScale, Math.min(vw / r.width, vh / r.height)));
  return clampPan(centerOn({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, scale, vw, vh), cw, ch, vw, vh);
}

/** Parts of a viewport covered by bars (CSS px), which fitted content keeps clear of. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The uncovered area of a viewport: its size and offset. */
export function insetArea(vw: number, vh: number, insets?: Insets): { w: number; h: number; dx: number; dy: number } {
  if (!insets) return { w: vw, h: vh, dx: 0, dy: 0 };
  return { w: Math.max(1, vw - insets.left - insets.right), h: Math.max(1, vh - insets.top - insets.bottom), dx: insets.left, dy: insets.top };
}

/** A transform moved by (dx, dy) – between viewport and inset-area coordinates. */
export function shiftTransform(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { scale: t.scale, x: t.x + dx, y: t.y + dy };
}

/** Bounding box of several rectangles (undefined for none). */
export function unionRect(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Segment from `a` to `b` shortened by `trimA` / `trimB` at its ends (so a connection line starts
 * at the edge of a badge instead of its centre). Null when the badges overlap.
 */
export function trimmedSegment(a: Point, b: Point, trimA: number, trimB = trimA): { from: Point; to: Point } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= trimA + trimB) return null;
  const ux = dx / len;
  const uy = dy / len;
  return { from: { x: a.x + ux * trimA, y: a.y + uy * trimA }, to: { x: b.x - ux * trimB, y: b.y - uy * trimB } };
}

/**
 * Unit vector, in photo coordinates, pointing out of the given side of a piece – the side as it
 * will be in the finished puzzle – for a piece that needs `rotationDeg` to become upright.
 */
export function sideVector(side: PuzzleSide, rotationDeg: number): Point {
  const up = upVector(rotationDeg);
  // Clockwise quarter turn on screen (y down): (x, y) -> (-y, x).
  const right = { x: -up.y, y: up.x };
  switch (side) {
    case 'top':
      return up;
    case 'right':
      return right;
    case 'bottom':
      return { x: -up.x, y: -up.y };
    case 'left':
      return { x: -right.x, y: -right.y };
  }
}

/** Photo pixels per cell of a group: its pieces' body size, or its area spread over its cells. */
export function groupCellSize(members: DetectedRegion[], cellCount: number): number {
  const bodies = members.filter((m) => m.kind === 'piece' && m.shape).map((m) => m.shape!.bodySize).sort((a, b) => a - b);
  if (bodies.length > 0) return bodies[bodies.length >> 1];
  const area = members.reduce((s, m) => s + m.area, 0);
  return Math.sqrt(Math.max(1, area / Math.max(1, cellCount)));
}

export interface CurveEnd {
  center: Point;
  /** Distance from `center` to where the curve attaches (half the body size for a piece edge). */
  reach: number;
  /** Outward unit normal of the joining edge; omitted = straight towards the other end. */
  dir?: Point;
}

/**
 * A connection between two pieces as a cubic Bézier curve that leaves `a` through the edge that
 * will touch `b` and arrives at the matching edge of `b`, so it shows which edges go together.
 */
export function connectionCurve(a: CurveEnd, b: CurveEnd): { d: string; from: Point; to: Point } | null {
  const dx = b.center.x - a.center.x;
  const dy = b.center.y - a.center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null;
  const towardB = { x: dx / dist, y: dy / dist };
  const dirA = a.dir ?? towardB;
  const dirB = b.dir ?? { x: -towardB.x, y: -towardB.y };
  const from = { x: a.center.x + dirA.x * a.reach, y: a.center.y + dirA.y * a.reach };
  const to = { x: b.center.x + dirB.x * b.reach, y: b.center.y + dirB.y * b.reach };
  const gap = Math.hypot(to.x - from.x, to.y - from.y);
  const avgReach = (a.reach + b.reach) / 2;
  // Leave/enter each edge for about one piece half-size: enough to show which edge, without
  // big loops across the photo when an edge faces away from the other piece.
  const k = Math.min(Math.max(gap * 0.3, avgReach * 0.8), avgReach * 2);
  const c1 = { x: from.x + dirA.x * k, y: from.y + dirA.y * k };
  const c2 = { x: to.x + dirB.x * k, y: to.y + dirB.y * k };
  const f = (n: number) => Math.round(n * 10) / 10;
  return { d: `M${f(from.x)},${f(from.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(to.x)},${f(to.y)}`, from, to };
}
