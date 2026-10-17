/**
 * Region geometry for replaying feedback: rasterised region outlines, overlaps between the regions
 * stored in a feedback file and the regions the current pipeline finds, point-in-region tests.
 */
import type { Point } from '../../src/cv/geometry';
import { createMask, type Mask, type Rect } from '../../src/cv/image';
import { fillPolygon } from '../../src/cv/raster';
import type { CellRef, DetectedRegion } from '../../src/model/types';

/** A region outline rasterised into a bbox-local mask. */
export interface RasterRegion {
  id: number;
  region: DetectedRegion;
  rect: Rect;
  mask: Mask;
  area: number;
}

/** Rasterise every region's contour (pixel centres inside the outline). */
export function rasterizeRegions(regions: DetectedRegion[], scale = 1): RasterRegion[] {
  return regions.map((region) => {
    const pts = region.contour.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (pts.length < 3) {
      const b = region.bbox;
      x0 = b.x * scale; y0 = b.y * scale; x1 = (b.x + b.width) * scale; y1 = (b.y + b.height) * scale;
      pts.splice(0, pts.length, { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 });
    }
    const rect = { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1) - Math.floor(x0) + 1, height: Math.ceil(y1) - Math.floor(y0) + 1 };
    const mask = createMask(rect.width, rect.height);
    fillPolygon(mask, pts.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y })));
    let area = 0;
    for (let i = 0; i < mask.data.length; i++) area += mask.data[i];
    return { id: region.id, region, rect, mask, area };
  });
}

/** Number of pixels in both regions. */
export function intersection(a: RasterRegion, b: RasterRegion): number {
  const x0 = Math.max(a.rect.x, b.rect.x), y0 = Math.max(a.rect.y, b.rect.y);
  const x1 = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width);
  const y1 = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const ra = (y - a.rect.y) * a.rect.width - a.rect.x, rb = (y - b.rect.y) * b.rect.width - b.rect.x;
    for (let x = x0; x < x1; x++) if (a.mask.data[ra + x] && b.mask.data[rb + x]) n++;
  }
  return n;
}

export function iou(a: RasterRegion, b: RasterRegion): number {
  const i = intersection(a, b);
  return i === 0 ? 0 : i / (a.area + b.area - i);
}

/** True when photo point `p` lies inside the region. */
export function containsPoint(r: RasterRegion, p: Point): boolean {
  const x = Math.round(p.x) - r.rect.x, y = Math.round(p.y) - r.rect.y;
  return x >= 0 && y >= 0 && x < r.rect.width && y < r.rect.height && r.mask.data[y * r.rect.width + x] === 1;
}

/** Distance from `p` to the region's bounding box (0 inside). */
export function distanceToRect(r: Rect, p: Point): number {
  const dx = Math.max(0, r.x - p.x, p.x - (r.x + r.width));
  const dy = Math.max(0, r.y - p.y, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** Overlaps of region `a` with every region of `others` (largest first; only non-empty ones). */
export function overlaps(a: RasterRegion, others: RasterRegion[]): { r: RasterRegion; inter: number; iou: number; ofA: number; ofB: number }[] {
  const out: { r: RasterRegion; inter: number; iou: number; ofA: number; ofB: number }[] = [];
  for (const b of others) {
    const inter = intersection(a, b);
    if (inter === 0) continue;
    out.push({ r: b, inter, iou: inter / (a.area + b.area - inter), ofA: inter / Math.max(1, a.area), ofB: inter / Math.max(1, b.area) });
  }
  return out.sort((p, q) => q.inter - p.inter);
}

/** Best IoU partner of `a` in `others` (undefined below `minIoU`). */
export function correspondent(a: RasterRegion, others: RasterRegion[], minIoU = 0.5): RasterRegion | undefined {
  const best = overlaps(a, others).sort((p, q) => q.iou - p.iou)[0];
  return best && best.iou >= minIoU ? best.r : undefined;
}

export function centroidOf(r: RasterRegion): Point {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < r.rect.height; y++) {
    for (let x = 0; x < r.rect.width; x++) {
      if (!r.mask.data[y * r.rect.width + x]) continue;
      sx += x; sy += y; n++;
    }
  }
  if (n === 0) return { x: r.rect.x + r.rect.width / 2, y: r.rect.y + r.rect.height / 2 };
  return { x: r.rect.x + sx / n, y: r.rect.y + sy / n };
}

export const cellKey = (c: CellRef): string => `${c.row},${c.col}`;

/** Jaccard index of two cell sets. */
export function cellJaccard(a: CellRef[], b: CellRef[]): number {
  const A = new Set(a.map(cellKey)), B = new Set(b.map(cellKey));
  let inter = 0;
  A.forEach((k) => { if (B.has(k)) inter++; });
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const formatCells = (cells: CellRef[]): string =>
  cells.length === 0 ? '-' : cells.length <= 2 ? cells.map((c) => `r${c.row}c${c.col}`).join('+') : `${cells.length} cells from r${cells[0].row}c${cells[0].col}`;
