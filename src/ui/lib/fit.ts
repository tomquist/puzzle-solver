/**
 * How two connected items fit together, in the scan photo (pure): where the moving item goes and
 * how it turns so it docks against the other one as that one lies on the table – for the "show
 * the fit" animation of the scan result.
 *
 * Conventions: `rotationDeg` is the clockwise turn from the photo to upright (ARCHITECTURE §3); an
 * item's puzzle axes in the photo are sideVector('right' / 'bottom', rotationDeg). One grid step
 * along the puzzle's columns is `w` photo px, along its rows `h` (cells need not be square: the
 * box picture's cell aspect decides, at the item's piece size). Where an item's cells lie in the
 * photo – from its member pieces, where the matcher put a patch, and a patch's real rim at the
 * joining side – is cellSpots' part.
 */
import type { Point } from '../../cv/geometry';
import type { CellRef, PuzzleSide } from '../../model/types';
import { cellAxes, cellPoint, cellStep, rimPoint, type CellItem } from './cellSpots';
import { sideVector } from './overlay';
import { signedDeg, turnedWords } from './rotation';
import { bezierPoint, type Route } from './route';

export interface FitItem extends CellItem {
  key: string;
  label: number | string;
  /** Pieces in the item (an assembled group > 1): the smaller one moves. */
  pieces: number;
}

export interface FitPose {
  /** Which item moves ('a' or 'b' of the call) – the smaller one; b on a tie. */
  mover: 'a' | 'b';
  /** The touching cells: of the moving item and of the one it docks against. */
  moverCell: CellRef;
  anchorCell: CellRef;
  /** Photo centre of the mover's touching cell now (the pivot of the move) … */
  pivot: Point;
  /** … and where it ends up, next to the anchor's touching cell. */
  docked: Point;
  /** Photo centre of the anchor's touching cell. */
  anchorPoint: Point;
  /** Clockwise turn of the mover on the way, the short way (−180, 180]. */
  rotateDeg: number;
  /** The anchor's side (finished puzzle) the mover joins, when the touching cells are neighbours. */
  side?: PuzzleSide;
  /** The seam between the touching cells: its middle, its direction and its length (photo px). */
  seam?: { center: Point; along: Point; length: number };
}

export { cellAxes, cellPoint };

/** The closest pair of cells of two items (grid distance; ties: the first in reading order). */
export function touchingCells(a: CellRef[], b: CellRef[]): [CellRef, CellRef] {
  let best: [CellRef, CellRef] = [a[0], b[0]];
  let bestD = Infinity;
  for (const ca of a) {
    for (const cb of b) {
      const d = Math.abs(ca.row - cb.row) + Math.abs(ca.col - cb.col);
      if (d < bestD) {
        bestD = d;
        best = [ca, cb];
      }
    }
  }
  return best;
}

const SIDES: Record<string, PuzzleSide> = { '0,1': 'right', '0,-1': 'left', '1,0': 'bottom', '-1,0': 'top' };
const OPPOSITE: Record<PuzzleSide, PuzzleSide> = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };

/**
 * The fit of `a` and `b` (see the file comment). The smaller item moves (b on a tie): it turns by
 * (its rotation − the anchor's rotation) – so it lies the way the anchor lies – about its touching
 * cell, which goes to the anchor's touching cell plus the grid offset between them along the
 * anchor's axes. `aspect` = cell width / height of the puzzle. Undefined without cells.
 */
export function fitPose(a: FitItem, b: FitItem, aspect: number): FitPose | undefined {
  if (!a.cells.length || !b.cells.length) return undefined;
  const mover = a.pieces > b.pieces ? 'b' : b.pieces > a.pieces ? 'a' : 'b';
  const m = mover === 'b' ? b : a;
  const anchor = mover === 'b' ? a : b;
  const [anchorCell, moverCell] = touchingCells(anchor.cells, m.cells);
  const dc = moverCell.col - anchorCell.col;
  const dr = moverCell.row - anchorCell.row;
  const side = SIDES[`${dr},${dc}`];
  // The touching cells, on the items' real rims where they join.
  const anchorPoint = side ? rimPoint(anchor, anchorCell, side, aspect) : cellPoint(anchor, anchorCell, aspect);
  const pivot = side ? rimPoint(m, moverCell, OPPOSITE[side], aspect) : cellPoint(m, moverCell, aspect);
  const { w, h } = cellStep(anchor, anchorCell, aspect);
  const right = sideVector('right', anchor.rotationDeg);
  const down = sideVector('bottom', anchor.rotationDeg);
  const docked = { x: anchorPoint.x + right.x * dc * w + down.x * dr * h, y: anchorPoint.y + right.y * dc * w + down.y * dr * h };
  const seam = side
    ? {
        center: { x: (anchorPoint.x + docked.x) / 2, y: (anchorPoint.y + docked.y) / 2 },
        along: dc !== 0 ? down : right,
        length: dc !== 0 ? h : w,
      }
    : undefined;
  return { mover, moverCell, anchorCell, pivot, docked, anchorPoint, rotateDeg: signedDeg(m.rotationDeg - anchor.rotationDeg), side, seam };
}

/** Point at u ∈ [0, 1] along a route (by segment, then segment parameter). */
function routeAt(route: Route, u: number): Point {
  const n = route.segments.length;
  if (u >= 1) return route.segments[n - 1][3];
  const x = Math.max(0, u * n);
  const i = Math.floor(x);
  return bezierPoint(route.segments[i], x - i);
}

/**
 * Where the mover's pivot passes on its way, `steps` + 1 points from pivot to docked: along the
 * connection line between the two (it leaves its own joining side and arrives at the anchor's
 * side from outside), shifted so it starts at the pivot and ends at the docked point; a straight
 * glide without a route. `moverAtStart`: the route starts at the mover's end.
 */
export function glidePath(pose: FitPose, route: Route | undefined, moverAtStart: boolean, steps = 12): Point[] {
  const out: Point[] = [];
  for (let k = 0; k <= steps; k++) {
    const s = k / steps;
    if (!route) {
      out.push({ x: pose.pivot.x + (pose.docked.x - pose.pivot.x) * s, y: pose.pivot.y + (pose.docked.y - pose.pivot.y) * s });
      continue;
    }
    const start = moverAtStart ? route.from : route.to;
    const end = moverAtStart ? route.to : route.from;
    const p = routeAt(route, moverAtStart ? s : 1 - s);
    const o0 = { x: pose.pivot.x - start.x, y: pose.pivot.y - start.y };
    const o1 = { x: pose.docked.x - end.x, y: pose.docked.y - end.y };
    out.push({ x: p.x + o0.x + (o1.x - o0.x) * s, y: p.y + o0.y + (o1.y - o0.y) * s });
  }
  return out;
}

const SIDE_WORDS: Record<PuzzleSide, string> = { top: 'above', right: 'on the right side of', bottom: 'below', left: 'on the left side of' };

/** "Piece #12 joins on the right side of #7, turned a quarter to the left." */
export function fitDescription(pose: FitPose, mover: { label: number | string; pieces: number }, anchor: { label: number | string }): string {
  const what = mover.pieces > 1 ? `The group #${mover.label}` : `Piece #${mover.label}`;
  const where = pose.side ? `joins ${SIDE_WORDS[pose.side]} #${anchor.label}` : `goes next to #${anchor.label}`;
  return `${what} ${where}, ${turnedWords(pose.rotateDeg)}.`;
}
