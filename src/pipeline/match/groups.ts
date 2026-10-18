/**
 * Groups of regions that belong together in the finished puzzle (see {@link RegionGroup}):
 * - 'assembled': physically joined in the photo — a matched 'patch' region, or touching regions
 *   (pieces and/or patches) whose placements agree with how they lie next to each other in the
 *   photo. Weak members of such a group are placed from their confident neighbours.
 * - 'neighbors': units that will connect once placed – loose pieces and whole assembled groups –
 *   whose placements are adjacent cells.
 */
import type { Point } from '../../cv/geometry';
import { polygonCentroid, resampleContour } from '../../cv/polygon';
import { cellKey, type CellRef, type DetectedRegion, type FitHint, type GridSpec, type Placement, type RegionGroup, type RegionMatch } from '../../model/types';

export interface GroupOptions {
  /** Reference px per grid cell. */
  cellW: number;
  cellH: number;
  /** Typical photo px per grid cell (median piece body size of the scan). */
  bodySize?: number;
}

/** Regions closer than this (fraction of the body size) count as touching. */
const TOUCH_GAP = 0.1;
/** Minimum shared-border length (fraction of the body size) for an assembled joint. */
const MIN_CONTACT = 0.4;
/** Maximum rotation difference (deg) between members of an assembled group. */
const MAX_ROTATION_DIFF = 15;
/** Maximum disagreement (fraction of a cell) between a member's placement and the layout. */
const MAX_LAYOUT_ERROR = 0.35;
/** Placements at or above this confidence anchor an assembled group. */
const ANCHOR_CONFIDENCE = 0.7;
/** Confidence factor of a placement inferred from a neighbour in an assembled group. */
const INFERRED_FACTOR = 0.9;
/** Location hints at or above this confidence link loose neighbours. */
const NEIGHBOR_HINT = 0.3;

const DEG = 180 / Math.PI;

function norm360(d: number): number {
  const v = d % 360;
  return v < 0 ? v + 360 : v;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
}

/** Confidence-weighted circular mean of angles in degrees. */
function circularMean(angles: number[], weights?: number[]): number {
  let sx = 0, sy = 0;
  angles.forEach((a, i) => {
    const w = weights ? Math.max(1e-3, weights[i]) : 1;
    sx += w * Math.cos(a / DEG);
    sy += w * Math.sin(a / DEG);
  });
  return norm360(Math.atan2(sy, sx) * DEG);
}

interface Node {
  region: DetectedRegion;
  match: RegionMatch;
  /** Photo point that the placement's x/y refer to (body center / region center). */
  anchor: Point;
  /** Photo px per cell for this region. */
  body: number;
  /** Outline resampled to ~2 px spacing (touch tests). */
  outline: Point[];
  /** Confidence of the region's own best placement (before any inference). */
  ownConfidence: number;
}

function cellsOf(n: Node): CellRef[] {
  const c = n.match.candidates[0];
  if (!c || n.match.status === 'unmatched') return [];
  if (n.region.kind === 'patch' && n.match.coveredCells && n.match.coveredCells.length > 0) return n.match.coveredCells;
  return [{ row: c.row, col: c.col }];
}

function cellOf(p: Point, grid: GridSpec, o: GroupOptions): CellRef {
  return {
    row: Math.min(grid.rows - 1, Math.max(0, Math.floor((p.y + 0.5) / o.cellH))),
    col: Math.min(grid.cols - 1, Math.max(0, Math.floor((p.x + 0.5) / o.cellW))),
  };
}

/** Where B's anchor lands in the reference when B is laid out rigidly next to A (A's placement). */
function predict(a: Node, pa: Placement, b: Node, cellGeo: number): Point {
  const s = cellGeo / ((a.body + b.body) / 2);
  const t = pa.rotationDeg / DEG;
  const dx = b.anchor.x - a.anchor.x, dy = b.anchor.y - a.anchor.y;
  return { x: pa.x + s * (Math.cos(t) * dx - Math.sin(t) * dy), y: pa.y + s * (Math.sin(t) * dx + Math.cos(t) * dy) };
}

/** Shared border length (px) of two outlines whose points come within `gap` px of each other. */
function contactLength(a: Point[], b: Point[], gap: number, spacing: number): number {
  const g2 = gap * gap;
  let n = 0;
  for (const p of a) {
    for (const q of b) {
      const dx = p.x - q.x, dy = p.y - q.y;
      if (dx * dx + dy * dy <= g2) {
        n++;
        break;
      }
    }
  }
  return n * spacing;
}

function bboxGap(a: DetectedRegion, b: DetectedRegion): number {
  const dx = Math.max(0, Math.max(a.bbox.x, b.bbox.x) - Math.min(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width));
  const dy = Math.max(0, Math.max(a.bbox.y, b.bbox.y) - Math.min(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height));
  return Math.hypot(dx, dy);
}

/** Quarter-turn-invariant difference (deg) of two outline orientations in (-45, 45]. */
function orientationDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 90;
  return Math.min(d, 90 - d);
}

/**
 * Build assembled and neighbour groups for one scan.
 *
 * Mutates `matches`: members of an assembled group whose own placement was weak (unmatched,
 * ambiguous or inconsistent with the group) get the placement implied by their confidently placed
 * neighbours as their best candidate (confidence = anchor confidence × {@link INFERRED_FACTOR}),
 * so they are no longer hidden. Recompute fit hints afterwards when that happened.
 */
export function buildGroups(regions: DetectedRegion[], matches: RegionMatch[], fits: FitHint[], grid: GridSpec, opts: GroupOptions): RegionGroup[] {
  const cellGeo = Math.sqrt(opts.cellW * opts.cellH);
  const byId = new Map(matches.map((m) => [m.regionId, m]));
  const bodies = regions.filter((r) => r.shape).map((r) => r.shape!.bodySize).sort((a, b) => a - b);
  const body = opts.bodySize ?? (bodies.length > 0 ? bodies[bodies.length >> 1] : 0);
  const nodes: Node[] = [];
  for (const region of regions) {
    const match = byId.get(region.id);
    if (!match || region.kind === 'unknown' || region.contour.length < 3) continue;
    const spacing = 2;
    let perim = 0;
    for (let i = 0; i < region.contour.length; i++) {
      const p = region.contour[i], q = region.contour[(i + 1) % region.contour.length];
      perim += Math.hypot(q.x - p.x, q.y - p.y);
    }
    const outline = resampleContour(region.contour, Math.max(16, Math.round(perim / spacing)));
    const anchor = region.kind === 'piece' && region.shape ? region.shape.center : polygonCentroid(region.contour);
    const own = match.status === 'unmatched' ? 0 : match.candidates[0]?.confidence ?? 0;
    nodes.push({ region, match, anchor, body: region.kind === 'piece' && region.shape ? region.shape.bodySize : body, outline, ownConfidence: own });
  }
  if (body <= 0) return [];

  // 1. Physical contact (shared border of at least MIN_CONTACT body sizes, aligned outlines).
  const touching: [number, number][] = [];
  const touches = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (bboxGap(a.region, b.region) > TOUCH_GAP * body) continue;
      if (orientationDiff(a.region.orientationDeg, b.region.orientationDeg) > 10) continue;
      const gap = Math.max(3, TOUCH_GAP * body);
      const contact = Math.min(contactLength(a.outline, b.outline, gap, 2), contactLength(b.outline, a.outline, gap, 2));
      if (contact < MIN_CONTACT * body) continue;
      touching.push([i, j]);
      touches.add(i);
      touches.add(j);
    }
  }

  // 2. Consistent joints and rescue of weak members, propagating from the most confident anchors.
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };
  const consistency: number[] = nodes.map(() => 1);
  const adj = nodes.map(() => [] as number[]);
  for (const [i, j] of touching) {
    adj[i].push(j);
    adj[j].push(i);
  }
  const placed = (n: Node) => n.match.status !== 'unmatched' && n.match.candidates.length > 0;
  const conf = (n: Node) => (placed(n) ? n.match.candidates[0].confidence : 0);
  const consistent = (a: Node, b: Node): number => {
    if (!placed(a) || !placed(b)) return -1;
    const pa = a.match.candidates[0], pb = b.match.candidates[0];
    if (angleDiff(pa.rotationDeg, pb.rotationDeg) > MAX_ROTATION_DIFF) return -1;
    const pred = predict(a, pa, b, cellGeo);
    const err = Math.hypot(pred.x - pb.x, pred.y - pb.y) / cellGeo;
    return err <= MAX_LAYOUT_ERROR ? 1 - err / MAX_LAYOUT_ERROR : -1;
  };
  const order = nodes.map((_, i) => i).filter((i) => touches.has(i)).sort((x, y) => conf(nodes[y]) - conf(nodes[x]));
  const visited = new Set<number>();
  for (const start of order) {
    if (visited.has(start) || conf(nodes[start]) < ANCHOR_CONFIDENCE) continue;
    visited.add(start);
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      const a = nodes[i];
      for (const j of adj[i]) {
        const b = nodes[j];
        const c = consistent(a, b);
        if (c >= 0) {
          union(i, j);
          consistency[j] = Math.min(consistency[j], c);
          if (!visited.has(j)) { visited.add(j); queue.push(j); }
          continue;
        }
        // Weak (or contradicting but weaker) neighbour: infer its placement from this anchor.
        const ca = conf(a);
        if (visited.has(j) || ca < ANCHOR_CONFIDENCE || conf(b) >= ANCHOR_CONFIDENCE || conf(b) >= ca) continue;
        if (b.region.kind === 'patch' && a.region.kind !== 'patch') continue;
        const pa = a.match.candidates[0];
        const pred = predict(a, pa, b, cellGeo);
        const cell = cellOf(pred, grid, opts);
        const inferred: Placement = {
          row: cell.row,
          col: cell.col,
          x: pred.x,
          y: pred.y,
          rotationDeg: pa.rotationDeg,
          score: 0,
          confidence: ca * INFERRED_FACTOR,
        };
        // Keep the region's own evidence when one of its candidates agrees with the layout.
        const own = b.match.candidates.findIndex((c) => Math.hypot(c.x - pred.x, c.y - pred.y) < 0.5 * cellGeo && angleDiff(c.rotationDeg, pa.rotationDeg) <= MAX_ROTATION_DIFF);
        if (own >= 0) {
          const c = b.match.candidates[own];
          inferred.score = c.score;
          inferred.x = c.x;
          inferred.y = c.y;
          inferred.rotationDeg = c.rotationDeg;
          inferred.confidence = Math.max(c.confidence, inferred.confidence);
        }
        const rest = b.match.candidates.filter((_, k) => k !== own).map((c) => ({ ...c, confidence: Math.min(c.confidence, (1 - inferred.confidence) / 2) }));
        b.match.candidates = [inferred, ...rest].slice(0, Math.max(5, b.match.candidates.length));
        if (b.region.kind === 'patch' && b.match.coveredCells && b.match.coveredCells.length > 0 && placed(b)) {
          // Shift the patch's covered cells along with its new placement.
          const old = b.match.coveredCells;
          const tl = old.reduce((p, q) => (q.row < p.row || (q.row === p.row && q.col < p.col) ? q : p));
          const dr = cell.row - tl.row, dc = cell.col - tl.col;
          b.match.coveredCells = old.map((q) => ({ row: q.row + dr, col: q.col + dc }));
        }
        b.match.status = inferred.confidence >= ANCHOR_CONFIDENCE ? 'confident' : 'ambiguous';
        union(i, j);
        consistency[j] = Math.min(consistency[j], 0.8);
        visited.add(j);
        queue.push(j);
      }
    }
  }

  // 3. Assembled groups: connected joints, and every matched patch region on its own.
  const comps = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(i);
  });
  const groups: RegionGroup[] = [];
  const inAssembled = new Set<number>();
  /** Members of each assembled group, by member (an assembled group links to neighbours as one unit). */
  const assembledMembers = new Map<number, number[]>();
  const makeGroup = (kind: RegionGroup['kind'], members: number[], confidence: number, rotations: boolean): RegionGroup | null => {
    const cells: CellRef[] = [];
    const seen = new Set<string>();
    for (const i of members) {
      for (const c of cellsOf(nodes[i])) {
        if (!seen.has(cellKey(c))) { seen.add(cellKey(c)); cells.push(c); }
      }
    }
    if (cells.length === 0) return null;
    const rots = members.map((i) => nodes[i].match.candidates[0].rotationDeg);
    const weights = members.map((i) => conf(nodes[i]));
    const mean = circularMean(rots, weights);
    const agree = rots.every((r) => angleDiff(r, mean) <= MAX_ROTATION_DIFF);
    let x = 0, y = 0;
    for (const c of cells) {
      x += (c.col + 0.5) * opts.cellW - 0.5;
      y += (c.row + 0.5) * opts.cellH - 0.5;
    }
    const g: RegionGroup = {
      id: 0,
      kind,
      regionIds: members.map((i) => nodes[i].region.id).sort((a, b) => a - b),
      cells: cells.sort((a, b) => a.row - b.row || a.col - b.col),
      bounds: {
        row0: Math.min(...cells.map((c) => c.row)),
        col0: Math.min(...cells.map((c) => c.col)),
        row1: Math.max(...cells.map((c) => c.row)),
        col1: Math.max(...cells.map((c) => c.col)),
      },
      x: x / cells.length,
      y: y / cells.length,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
    if (rotations && agree) g.rotationDeg = mean;
    return g;
  };
  for (const members of comps.values()) {
    const multi = members.length >= 2;
    const patch = members.length === 1 && nodes[members[0]].region.kind === 'patch' && placed(nodes[members[0]]);
    if (!multi && !patch) continue;
    // The group is right when its best anchor is right and the layout holds.
    const anchor = Math.max(...members.map((i) => nodes[i].ownConfidence));
    const layout = members.reduce((a, i) => a + consistency[i], 0) / members.length;
    const g = makeGroup('assembled', members, anchor * (0.85 + 0.15 * layout), true);
    if (!g) continue;
    groups.push(g);
    members.forEach((i) => {
      inAssembled.add(i);
      assembledMembers.set(i, members);
    });
  }

  // 4. Neighbours: units – loose single pieces, and assembled groups as a whole (represented by
  // their first member) – linked by location hints (adjacent cells, compatible sides).
  const idx = new Map(nodes.map((n, i) => [n.region.id, i]));
  const unitOf = (i: number | undefined): number | undefined => {
    if (i === undefined) return undefined;
    const group = assembledMembers.get(i);
    if (group) return group[0];
    return !touches.has(i) && nodes[i].region.kind === 'piece' && placed(nodes[i]) ? i : undefined;
  };
  const nParent = nodes.map((_, i) => i);
  const nFind = (i: number): number => (nParent[i] === i ? i : (nParent[i] = nFind(nParent[i])));
  const edgeConf = new Map<number, number[]>();
  for (const h of fits) {
    if (h.reason === 'shape' || h.confidence < NEIGHBOR_HINT) continue;
    const a = unitOf(idx.get(h.a)), b = unitOf(idx.get(h.b));
    if (a === undefined || b === undefined || a === b) continue;
    nParent[nFind(a)] = nFind(b);
    for (const k of [a, b]) edgeConf.set(k, [...(edgeConf.get(k) ?? []), h.confidence]);
  }
  const nComps = new Map<number, number[]>();
  for (const i of edgeConf.keys()) {
    const r = nFind(i);
    if (!nComps.has(r)) nComps.set(r, []);
    nComps.get(r)!.push(i);
  }
  for (const units of nComps.values()) {
    if (units.length < 2) continue;
    const confs = units.flatMap((i) => edgeConf.get(i) ?? []);
    const members = units.flatMap((u) => assembledMembers.get(u) ?? [u]);
    const g = makeGroup('neighbors', members, Math.min(...confs), true);
    if (g) groups.push(g);
  }

  groups.sort((a, b) => Math.min(...a.regionIds) - Math.min(...b.regionIds));
  groups.forEach((g, i) => { g.id = i + 1; });
  return groups;
}
