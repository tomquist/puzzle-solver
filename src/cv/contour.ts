/**
 * Outer-contour tracing of 8-connected components (Suzuki–Abe border following, the algorithm
 * behind OpenCV's findContours, mirrored to run clockwise on screen).
 *
 * Contours are lists of pixel-center coordinates (integers), CLOCKWISE on screen (y down; positive
 * `polygonSignedArea`), starting at the component's first pixel in raster order, without a
 * duplicate closing point. Thin (1-pixel-wide) parts are walked out and back, so such pixels appear
 * twice; a single pixel yields a one-point contour. Holes are ignored.
 */
import { polygonSignedArea, type Point } from './geometry';
import type { Mask } from './image';
import { labelComponents, type ComponentStats } from './components';

// 8-neighbour directions, index increasing = clockwise on screen: E, SE, S, SW, W, NW, N, NE.
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const WEST = 4;

/**
 * Follow the border between the set pixel (x0, y0) and the unset region containing its neighbour
 * in direction `bgDir`, keeping that region on the left (clockwise around an outer border,
 * counter-clockwise around a hole).
 */
function followBorder(m: Mask, x0: number, y0: number, bgDir: number): Point[] {
  const { width: w, height: h, data } = m;
  const isSet = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] !== 0;
  // Predecessor of the start pixel: first set neighbour counter-clockwise from the background.
  let s = bgDir;
  let found = false;
  for (let k = 0; k < 7; k++) {
    s = (s + 7) & 7;
    if (isSet(x0 + DX[s], y0 + DY[s])) { found = true; break; }
  }
  if (!found) return [{ x: x0, y: y0 }];
  const x1 = x0 + DX[s], y1 = y0 + DY[s];
  const pts: Point[] = [];
  let cx = x0, cy = y0;
  // Each border pixel is entered at most 4 times; the cap only guards against corrupted input.
  const maxSteps = 4 * w * h + 8;
  for (let step = 0; step < maxSteps; step++) {
    pts.push({ x: cx, y: cy });
    // `s` points at the previous pixel; search clockwise starting just after it.
    let nx = cx, ny = cy;
    for (let k = 0; k < 8; k++) {
      s = (s + 1) & 7;
      nx = cx + DX[s];
      ny = cy + DY[s];
      if (isSet(nx, ny)) break;
    }
    if (nx === x0 && ny === y0 && cx === x1 && cy === y1) break;
    cx = nx;
    cy = ny;
    s = (s + 4) & 7;
  }
  return pts;
}

/** First pixel in raster order of the 8-connected component containing (sx, sy) (flood fill). */
function componentStart(m: Mask, sx: number, sy: number): Point {
  const { width: w, height: h, data } = m;
  const seen = new Uint8Array(w * h);
  let stack = new Int32Array(1024);
  let top = 0;
  let best = sy * w + sx;
  stack[top++] = best;
  seen[best] = 1;
  while (top > 0) {
    const i = stack[--top];
    if (i < best) best = i;
    const x = i % w, y = (i - x) / w;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX[k], yy = y + DY[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (seen[j] || data[j] === 0) continue;
      seen[j] = 1;
      if (top === stack.length) {
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        stack = bigger;
      }
      stack[top++] = j;
    }
  }
  return { x: best % w, y: Math.floor(best / w) };
}

/**
 * Outer boundary of the 8-connected component containing `start` (rounded to the nearest pixel;
 * default: the first set pixel in raster order). Returns [] when `start` is not a set pixel or the
 * mask is empty. Fast (O(contour length)) when `start` lies on the outer border with an unset
 * left neighbour, e.g. `ComponentStats.start`; otherwise it may flood-fill the component first.
 * The result does not depend on which pixel of the component `start` names.
 */
export function traceOuterContour(m: Mask, start?: Point): Point[] {
  const { width: w, height: h, data } = m;
  if (!start) {
    for (let i = 0; i < w * h; i++) {
      if (data[i] !== 0) return followBorder(m, i % w, Math.floor(i / w), WEST);
    }
    return [];
  }
  let x = Math.round(start.x);
  const y = Math.round(start.y);
  if (x < 0 || y < 0 || x >= w || y >= h || data[y * w + x] === 0) return [];
  // Walk left to a pixel whose left neighbour is unset; if that background is the outside (not a
  // hole) the traced border has non-negative signed area.
  while (x > 0 && data[y * w + x - 1] !== 0) x--;
  const pts = followBorder(m, x, y, WEST);
  if (polygonSignedArea(pts) > -0.25) {
    // Outer border found. Canonical start = its first pixel in raster order (= the component's).
    let b = pts[0];
    for (const p of pts) if (p.y < b.y || (p.y === b.y && p.x < b.x)) b = p;
    return b === pts[0] ? pts : followBorder(m, b.x, b.y, WEST);
  }
  const s = componentStart(m, x, y);
  return followBorder(m, s.x, s.y, WEST);
}

/**
 * Outer contours of all 8-connected components with at least `minArea` pixels, in raster order of
 * the components, together with their statistics.
 */
export function findOuterContours(m: Mask, minArea = 1): { contour: Point[]; stats: ComponentStats }[] {
  const { stats } = labelComponents(m, 8);
  const out: { contour: Point[]; stats: ComponentStats }[] = [];
  for (const s of stats) {
    if (s.area < minArea) continue;
    out.push({ contour: followBorder(m, s.start.x, s.start.y, WEST), stats: s });
  }
  return out;
}
