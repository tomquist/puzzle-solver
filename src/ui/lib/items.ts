/**
 * Scan results as the user handles them: *items* that are picked up and placed as one unit – an
 * assembled grid (a 'patch' region or several touching pieces) or a single piece – plus neighbour
 * links between items and the order in which the guided placing mode presents them. Pure.
 *
 * Hide rules: regions without a usable match (status 'unmatched', no candidates, kind 'unknown')
 * are not shown, listed or counted anywhere (the data stays stored in the scan).
 */
import type { Point } from '../../cv/geometry';
import type { Rect } from '../../cv/image';
import type { CellRef, DetectedRegion, GridSpec, RegionMatch, ScanResult } from '../../model/types';
import { cellsForPlacement, matchFor } from './pieces';
import { regionCenter } from './overlay';

export type ItemStatus = 'confident' | 'ambiguous';

export interface CellBounds {
  row0: number;
  col0: number;
  row1: number;
  col1: number;
}

export interface ItemPlacement {
  cells: CellRef[];
  bounds: CellBounds;
  /** Target centre in reference pixels. */
  x: number;
  y: number;
  /** Clockwise rotation from photo to upright (ARCHITECTURE §3); undefined when unknown. */
  rotationDeg?: number;
  confidence: number;
}

export interface ScanItem {
  /** 'g<groupId>' for assembled groups, 'r<regionId>' otherwise. */
  key: string;
  kind: 'assembled' | 'piece';
  /** Number shown on the badge (the smallest member region id). */
  label: number;
  regionIds: number[];
  /** Pieces in this item (cells of an assembled grid, 1 for a piece). */
  pieceCount: number;
  status: ItemStatus;
  /** Best first. Assembled groups have exactly one. */
  candidates: ItemPlacement[];
  /** Badge position in photo coordinates. */
  center: Point;
  /** Union bounding box of the members in photo coordinates. */
  bbox: Rect;
  /** Edge or corner piece(s) – for the "edge pieces only" view. */
  edge: boolean;
}

export interface ItemLink {
  a: string;
  b: string;
  source: 'group' | 'fit';
}

export interface ScanItems {
  items: ScanItem[];
  links: ItemLink[];
  /** Regions that are not shown (no usable match). */
  hiddenRegionIds: number[];
}

/** Assembled groups below this confidence are not shown. */
export const MIN_GROUP_CONFIDENCE = 0.2;
/** Assembled groups at or above this confidence count as confident. */
export const CONFIDENT_GROUP = 0.6;

export function boundsOf(cells: CellRef[]): CellBounds {
  let row0 = Infinity, col0 = Infinity, row1 = -Infinity, col1 = -Infinity;
  for (const c of cells) {
    row0 = Math.min(row0, c.row);
    col0 = Math.min(col0, c.col);
    row1 = Math.max(row1, c.row);
    col1 = Math.max(col1, c.col);
  }
  return { row0, col0, row1, col1 };
}

/** True when a region has no usable match and must not be shown. */
export function isHiddenRegion(region: DetectedRegion, match: RegionMatch | undefined): boolean {
  return region.kind === 'unknown' || !match || match.candidates.length === 0 || match.status === 'unmatched';
}

function unionBox(regions: DetectedRegion[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regions) {
    x0 = Math.min(x0, r.bbox.x);
    y0 = Math.min(y0, r.bbox.y);
    x1 = Math.max(x1, r.bbox.x + r.bbox.width);
    y1 = Math.max(y1, r.bbox.y + r.bbox.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function meanCenter(regions: DetectedRegion[]): Point {
  const cs = regions.map(regionCenter);
  return { x: cs.reduce((s, c) => s + c.x, 0) / cs.length, y: cs.reduce((s, c) => s + c.y, 0) / cs.length };
}

const isEdgeShape = (r: DetectedRegion) => r.shape?.kind === 'edge' || r.shape?.kind === 'corner';

function onBorder(cells: CellRef[], grid: GridSpec): boolean {
  return cells.some((c) => c.row === 0 || c.col === 0 || c.row === grid.rows - 1 || c.col === grid.cols - 1);
}

function adjacent(a: CellRef[], b: CellRef[]): boolean {
  return a.some((p) => b.some((q) => Math.abs(p.row - q.row) + Math.abs(p.col - q.col) === 1));
}

/** Build the items, links and hidden regions of a scan result. */
export function buildScanItems(result: ScanResult, grid: GridSpec): ScanItems {
  const byId = new Map(result.regions.map((r) => [r.id, r]));
  const items: ScanItem[] = [];
  const itemOfRegion = new Map<number, string>();
  const consumed = new Set<number>();

  // Assembled groups (computed by the pipeline).
  for (const g of result.groups ?? []) {
    if (g.kind !== 'assembled') continue;
    const members = g.regionIds.map((id) => byId.get(id)).filter((r): r is DetectedRegion => !!r);
    if (!members.length) continue;
    members.forEach((m) => consumed.add(m.id));
    if (g.confidence < MIN_GROUP_CONFIDENCE || g.cells.length === 0) continue;
    const firstMatch = matchFor(result, members[0].id);
    const item: ScanItem = {
      key: `g${g.id}`,
      kind: 'assembled',
      label: Math.min(...members.map((m) => m.id)),
      regionIds: members.map((m) => m.id),
      pieceCount: g.cells.length,
      status: g.confidence >= CONFIDENT_GROUP ? 'confident' : 'ambiguous',
      candidates: [
        {
          cells: g.cells,
          bounds: g.bounds,
          x: g.x,
          y: g.y,
          rotationDeg: g.rotationDeg ?? firstMatch?.candidates[0]?.rotationDeg,
          confidence: g.confidence,
        },
      ],
      center: members.length === 1 ? regionCenter(members[0]) : meanCenter(members),
      bbox: unionBox(members),
      edge: onBorder(g.cells, grid),
    };
    items.push(item);
    members.forEach((m) => itemOfRegion.set(m.id, item.key));
  }

  // Remaining regions: single pieces, and patches from older scans without groups.
  const hiddenRegionIds: number[] = [];
  for (const r of result.regions) {
    if (consumed.has(r.id)) continue;
    const m = matchFor(result, r.id);
    if (isHiddenRegion(r, m)) {
      hiddenRegionIds.push(r.id);
      continue;
    }
    const match = m!;
    const candidates: ItemPlacement[] = match.candidates.map((p) => {
      const cells = cellsForPlacement(match, p);
      return { cells, bounds: boundsOf(cells), x: p.x, y: p.y, rotationDeg: p.rotationDeg, confidence: p.confidence };
    });
    const status: ItemStatus = match.status === 'confident' ? 'confident' : 'ambiguous';
    const item: ScanItem = {
      key: `r${r.id}`,
      kind: r.kind === 'patch' ? 'assembled' : 'piece',
      label: r.id,
      regionIds: [r.id],
      pieceCount: r.kind === 'patch' ? candidates[0].cells.length : 1,
      status,
      candidates,
      center: regionCenter(r),
      bbox: r.bbox,
      edge: isEdgeShape(r) || (r.kind === 'patch' && onBorder(candidates[0].cells, grid)),
    };
    items.push(item);
    itemOfRegion.set(r.id, item.key);
  }

  // Neighbour links: from 'neighbors' groups, or – for older scans – from location fits.
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const links: ItemLink[] = [];
  const seen = new Set<string>();
  const addLink = (a: string, b: string, source: ItemLink['source']) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ a, b, source });
  };
  if (result.groups) {
    for (const g of result.groups) {
      if (g.kind !== 'neighbors') continue;
      const keys = [...new Set(g.regionIds.map((id) => itemOfRegion.get(id)).filter((k): k is string => !!k))];
      if (keys.length < 2) continue;
      let linked = false;
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = itemByKey.get(keys[i])!.candidates[0].cells;
          const b = itemByKey.get(keys[j])!.candidates[0].cells;
          if (adjacent(a, b)) {
            addLink(keys[i], keys[j], 'group');
            linked = true;
          }
        }
      }
      if (!linked) for (let i = 1; i < keys.length; i++) addLink(keys[i - 1], keys[i], 'group');
    }
  } else {
    for (const f of result.fits) {
      if (f.confidence < 0.5 || f.reason === 'shape') continue;
      const a = itemOfRegion.get(f.a);
      const b = itemOfRegion.get(f.b);
      if (a && b) addLink(a, b, 'fit');
    }
  }

  return { items, links, hiddenRegionIds };
}

// ---------------------------------------------------------------------------------------------
// Placing order
// ---------------------------------------------------------------------------------------------

function centreCell(p: ItemPlacement): { r: number; c: number } {
  return { r: (p.bounds.row0 + p.bounds.row1) / 2, c: (p.bounds.col0 + p.bounds.col1) / 2 };
}

/**
 * Serpentine sweep across the picture: bands of about a quarter of the rows, left→right in even
 * bands and right→left in odd ones, so consecutive targets are close together (less hand travel).
 */
export function sweepCompare(grid: GridSpec): (a: ItemPlacement, b: ItemPlacement) => number {
  const band = Math.max(1, Math.round(grid.rows / 4));
  return (a, b) => {
    const pa = centreCell(a);
    const pb = centreCell(b);
    const ba = Math.floor(pa.r / band);
    const bb = Math.floor(pb.r / band);
    if (ba !== bb) return ba - bb;
    const dir = ba % 2 === 0 ? 1 : -1;
    return dir * (pa.c - pb.c) || pa.r - pb.r;
  };
}

/**
 * The order of the guided placing mode: assembled grids first, then confident pieces, then unsure
 * ones – each tier in a serpentine sweep across the picture – and linked neighbours always right
 * after each other. `skip` excludes items (e.g. already placed).
 */
export function placingOrder(
  items: ScanItem[],
  links: ItemLink[],
  grid: GridSpec,
  skip: (item: ScanItem) => boolean = () => false,
  placementOf: (item: ScanItem) => ItemPlacement | undefined = (i) => i.candidates[0],
): ScanItem[] {
  const cmp = sweepCompare(grid);
  const todo = items.filter((i) => !skip(i) && placementOf(i));
  const byPlacement = (a: ScanItem, b: ScanItem) => cmp(placementOf(a)!, placementOf(b)!);
  const tier = (i: ScanItem) => (i.kind === 'assembled' ? 0 : i.status === 'confident' ? 1 : 2);
  const sorted = [...todo].sort((a, b) => tier(a) - tier(b) || byPlacement(a, b));
  const neighbours = new Map<string, string[]>();
  for (const l of links) {
    neighbours.set(l.a, [...(neighbours.get(l.a) ?? []), l.b]);
    neighbours.set(l.b, [...(neighbours.get(l.b) ?? []), l.a]);
  }
  const inTodo = new Set(sorted.map((i) => i.key));
  const byKey = new Map(sorted.map((i) => [i.key, i]));
  const out: ScanItem[] = [];
  const done = new Set<string>();
  const visit = (i: ScanItem) => {
    if (done.has(i.key)) return;
    done.add(i.key);
    out.push(i);
    const next = (neighbours.get(i.key) ?? []).filter((k) => inTodo.has(k) && !done.has(k)).map((k) => byKey.get(k)!);
    next.sort(byPlacement).forEach(visit);
  };
  sorted.forEach(visit);
  return out;
}

/** Keys of the items linked to `key`. */
export function linkedTo(key: string, links: ItemLink[]): string[] {
  return links.flatMap((l) => (l.a === key ? [l.b] : l.b === key ? [l.a] : []));
}

/** "row 5, column 12" style text for a placement (ranges for assembled grids). */
export function cellsText(p: ItemPlacement): string {
  const { row0, col0, row1, col1 } = p.bounds;
  const rows = row0 === row1 ? `row ${row0 + 1}` : `rows ${row0 + 1}–${row1 + 1}`;
  const cols = col0 === col1 ? `column ${col0 + 1}` : `columns ${col0 + 1}–${col1 + 1}`;
  return `${rows}, ${cols}`;
}

export function itemTitle(item: ScanItem): string {
  return item.kind === 'assembled' ? `Assembled grid #${item.label}` : `Piece #${item.label}`;
}

export interface ItemCounts {
  items: number;
  pieces: number;
  assembled: number;
  unsure: number;
}

export function itemCounts(items: ScanItem[]): ItemCounts {
  return {
    items: items.length,
    pieces: items.reduce((s, i) => s + i.pieceCount, 0),
    assembled: items.filter((i) => i.kind === 'assembled').length,
    unsure: items.filter((i) => i.status === 'ambiguous').length,
  };
}
