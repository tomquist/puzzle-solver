/**
 * What the placing views show (pure): the piece in the scan photo with enough surroundings to find
 * it on the table, an upright close-up of it, the box picture around its target with a few cells
 * of context, the target outline, and the location marker on the overview of the whole picture.
 */
import type { Point } from '../../cv/geometry';
import type { Rect } from '../../cv/image';
import type { CellRef, DetectedRegion, GridSpec } from '../../model/types';
import type { CellBounds, ScanItem } from './items';
import { supportDistance } from './labels';
import { cellSize, groupCellSize, regionSize } from './overlay';
import { topEdgeBar, upVector } from './rotation';

/** Start of a span of `size` within [0, total] centred on `center` (centred on the whole when it doesn't fit). */
function spanStart(center: number, size: number, total: number): number {
  if (size >= total) return (total - size) / 2;
  return Math.min(total - size, Math.max(0, center - size / 2));
}

/** Move a rectangle inside [0, width] × [0, height] without resizing it (centred where it doesn't fit). */
export function shiftInside(r: Rect, width: number, height: number): Rect {
  return { x: spanStart(r.x + r.width / 2, r.width, width), y: spanStart(r.y + r.height / 2, r.height, height), width: r.width, height: r.height };
}

/** Size of one puzzle piece in the photo for an item (body size; a group's pieces' median). */
export function itemPieceSize(item: ScanItem, regions: DetectedRegion[]): number {
  const members = regions.filter((r) => item.regionIds.includes(r.id));
  if (members.length === 0) return Math.max(item.bbox.width, item.bbox.height, 1);
  if (item.kind === 'piece' || (members.length === 1 && item.pieceCount <= 1)) return regionSize(members[0]);
  return groupCellSize(members, item.pieceCount);
}

/**
 * Square crop of the scan photo around an item, `piecesAcross` piece sizes wide (at least the item
 * plus a piece on each side), kept inside the photo – enough surroundings to find it on the table.
 */
export function pickupRect(bbox: Rect, pieceSize: number, photoWidth: number, photoHeight: number, piecesAcross = 3.5): Rect {
  const extent = Math.max(bbox.width, bbox.height);
  let side = Math.max(piecesAcross * pieceSize, extent + 2 * pieceSize);
  // Prefer no letterbox: at most the photo's short side, but never cut the item.
  side = Math.max(extent * 1.05, Math.min(side, Math.min(photoWidth, photoHeight)));
  return shiftInside({ x: bbox.x + bbox.width / 2 - side / 2, y: bbox.y + bbox.height / 2 - side / 2, width: side, height: side }, photoWidth, photoHeight);
}

/**
 * The "top" bar of an item as it lies in the photo: across the edge that must end up on top
 * (upVector), on a piece's body edge (knobs left out) or at a group's outline; `edge` is where the
 * outline ends in that direction (for the word "top" just outside) and `up` the direction.
 * `length` is the bar's length relative to the piece size.
 */
export interface TopBar {
  from: Point;
  to: Point;
  edge: Point;
  up: Point;
}

export function topBarFor(item: ScanItem, regions: DetectedRegion[], rotationDeg: number, length = 0.6): TopBar {
  const members = regions.filter((r) => item.regionIds.includes(r.id));
  const outline = members.flatMap((m) => m.contour);
  const up = upVector(rotationDeg);
  const single = item.kind === 'piece' && members.length === 1 ? members[0] : undefined;
  const c = single?.shape?.center ?? item.center;
  const size = itemPieceSize(item, regions);
  const extent = outline.length ? supportDistance(c, outline, up) : Math.max(item.bbox.width, item.bbox.height) / 2;
  const reach = single?.shape ? Math.min(single.shape.bodySize / 2, extent) : extent * 0.92;
  const bar = topEdgeBar(c, rotationDeg, reach, (size * length) / 2);
  return { from: bar.from, to: bar.to, edge: { x: c.x + up.x * extent, y: c.y + up.y * extent }, up };
}

/**
 * Where the word "top" goes in a view of `rect` (% of the view) and the direction the CSS moves it
 * by its own size (.top-label): just outside the outline in the "up" direction – or, when the view
 * has no room there (it would reach the border; the pill needs about 24 % across and 14 % up/down
 * in a 175 px view), just inside the bar, over the piece.
 */
export function topLabelSpot(bar: TopBar, rect: Rect): { x: number; y: number; dir: Point } {
  const pct = (p: Point) => ({ x: ((p.x - rect.x) / rect.width) * 100, y: ((p.y - rect.y) / rect.height) * 100 });
  const out = pct(bar.edge);
  const far = { x: out.x + bar.up.x * 24, y: out.y + bar.up.y * 14 };
  if (far.x >= 2 && far.x <= 98 && far.y >= 2 && far.y <= 98) return { ...out, dir: bar.up };
  const mid = pct({ x: (bar.from.x + bar.to.x) / 2, y: (bar.from.y + bar.to.y) / 2 });
  return { ...mid, dir: { x: -bar.up.x || 0, y: -bar.up.y || 0 } };
}

/** Square around an item that holds it at any rotation (for the upright close-up). */
export function closeupSquare(bbox: Rect, pad = 0.06): { cx: number; cy: number; side: number } {
  return { cx: bbox.x + bbox.width / 2, cy: bbox.y + bbox.height / 2, side: Math.hypot(bbox.width, bbox.height) * (1 + 2 * pad) };
}

/** Rectangle of a block of cells in reference pixels. */
export function blockRect(b: CellBounds, grid: GridSpec, width: number, height: number): Rect {
  const { w, h } = cellSize(grid, width, height);
  return { x: b.col0 * w, y: b.row0 * h, width: (b.col1 - b.col0 + 1) * w, height: (b.row1 - b.row0 + 1) * h };
}

/**
 * The part of the box picture to show around a target: at least `around` cells each way (the
 * block plus two cells on each side for larger groups), widened to the view's aspect (w / h) and
 * at least `minWidth` reference px wide (so a small picture is not blown up). Centred on the block;
 * may extend past the picture (the viewer keeps it inside).
 */
export function targetContext(
  b: CellBounds,
  grid: GridSpec,
  width: number,
  height: number,
  opts: { aspect?: number; around?: number; minWidth?: number } = {},
): Rect {
  const { aspect = 1, around = 7, minWidth = 0 } = opts;
  const { w, h } = cellSize(grid, width, height);
  const block = blockRect(b, grid, width, height);
  let cw = Math.max(around, b.col1 - b.col0 + 1 + 4) * w;
  let ch = Math.max(around, b.row1 - b.row0 + 1 + 4) * h;
  if (cw / ch < aspect) cw = ch * aspect;
  else ch = cw / aspect;
  if (cw < minWidth) {
    cw = minWidth;
    ch = minWidth / aspect;
  }
  return { x: block.x + block.width / 2 - cw / 2, y: block.y + block.height / 2 - ch / 2, width: cw, height: ch };
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/** Outline of a set of cells: the edges between a cell of the set and one outside it. */
export function cellsOutlinePath(cells: CellRef[], grid: GridSpec, width: number, height: number): string {
  const { w, h } = cellSize(grid, width, height);
  const set = new Set(cells.map((c) => `${c.row},${c.col}`));
  const has = (r: number, c: number) => set.has(`${r},${c}`);
  let d = '';
  for (const { row, col } of cells) {
    const x0 = col * w, y0 = row * h, x1 = x0 + w, y1 = y0 + h;
    if (!has(row - 1, col)) d += `M${f(x0)} ${f(y0)}H${f(x1)}`;
    if (!has(row, col + 1)) d += `M${f(x1)} ${f(y0)}V${f(y1)}`;
    if (!has(row + 1, col)) d += `M${f(x0)} ${f(y1)}H${f(x1)}`;
    if (!has(row, col - 1)) d += `M${f(x0)} ${f(y0)}V${f(y1)}`;
  }
  return d;
}

/** The whole picture minus the given cells (fill-rule evenodd): to dim everything but the target. */
export function outsideMaskPath(cells: CellRef[], grid: GridSpec, width: number, height: number): string {
  const { w, h } = cellSize(grid, width, height);
  let d = `M0 0H${f(width)}V${f(height)}H0Z`;
  for (const { row, col } of cells) d += `M${f(col * w)} ${f(row * h)}h${f(w)}v${f(h)}h${f(-w)}Z`;
  return d;
}

/**
 * Corner marks around a rectangle (like a camera's focus frame): four L shapes with arms of
 * `arm` px, `pad` px outside the rectangle so they never cover what they frame.
 */
export function cornerBrackets(r: Rect, arm: number, pad = 0): string {
  const x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.width + pad, y1 = r.y + r.height + pad;
  const a = Math.min(arm, (x1 - x0) / 2, (y1 - y0) / 2);
  return (
    `M${f(x0)} ${f(y0 + a)}V${f(y0)}H${f(x0 + a)}` +
    `M${f(x1 - a)} ${f(y0)}H${f(x1)}V${f(y0 + a)}` +
    `M${f(x1)} ${f(y1 - a)}V${f(y1)}H${f(x1 - a)}` +
    `M${f(x0 + a)} ${f(y1)}H${f(x0)}V${f(y1 - a)}`
  );
}

/**
 * Location marker on the overview of the whole picture: a box around the target (at least
 * `minFrac` of the picture's longer side, so a single cell is still visible) and crosshair lines
 * from the picture's edges up to the box.
 */
export function overviewMarker(target: Rect, width: number, height: number, minFrac = 0.04): { box: Rect; cross: string } {
  const min = Math.max(width, height) * minFrac;
  const bw = Math.max(target.width, min);
  const bh = Math.max(target.height, min);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const box = { x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh };
  const cross = [
    box.y > 0 ? `M${f(cx)} 0V${f(box.y)}` : '',
    box.y + bh < height ? `M${f(cx)} ${f(box.y + bh)}V${f(height)}` : '',
    box.x > 0 ? `M0 ${f(cy)}H${f(box.x)}` : '',
    box.x + bw < width ? `M${f(box.x + bw)} ${f(cy)}H${f(width)}` : '',
  ].join('');
  return { box, cross };
}

export type InsetCorner = 'top-left' | 'top-right' | 'bottom-left';

/**
 * Where an inset in each corner lies in the view (fractions of its size, with some margin): the
 * CSS keeps it within 42 % of the width and 36 % of the height, 8 px from the edges.
 */
const INSET_BOXES: Record<InsetCorner, Rect> = {
  'top-left': { x: 0, y: 0, width: 0.5, height: 0.41 },
  'top-right': { x: 0.5, y: 0, width: 0.5, height: 0.41 },
  'bottom-left': { x: 0, y: 0.59, width: 0.5, height: 0.41 },
};

/**
 * Which corner of the target view the overview inset goes in so it does not cover the target
 * (bottom-right holds the zoom buttons): of the corners that stay clear of where the target lies
 * in the (picture-clamped) context view, the one farthest from it (top-left on a tie); if none is
 * clear, the farthest one.
 */
export function insetCorner(target: Rect, context: Rect, width: number, height: number): InsetCorner {
  const view = shiftInside(context, width, height);
  const t = { x: (target.x - view.x) / view.width, y: (target.y - view.y) / view.height, width: target.width / view.width, height: target.height / view.height };
  const corners = Object.keys(INSET_BOXES) as InsetCorner[];
  const overlaps = (b: Rect) => t.x < b.x + b.width && t.x + t.width > b.x && t.y < b.y + b.height && t.y + t.height > b.y;
  const dist = (c: InsetCorner) => {
    const b = INSET_BOXES[c];
    return Math.hypot(b.x + b.width / 2 - (t.x + t.width / 2), b.y + b.height / 2 - (t.y + t.height / 2));
  };
  const clear = corners.filter((c) => !overlaps(INSET_BOXES[c]));
  return (clear.length ? clear : corners).reduce((best, c) => (dist(c) > dist(best) + 0.02 ? c : best));
}
