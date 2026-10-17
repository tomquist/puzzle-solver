/**
 * Connected-component labelling of binary masks. Works on horizontal runs with union-find, so the
 * cost is one pass over the pixels plus work proportional to the number of runs (no per-pixel
 * allocations, no recursion).
 */
import type { Point } from './geometry';
import { createMask, type Mask, type Rect } from './image';

export interface ComponentStats {
  /** 1-based label as stored in the label image. */
  label: number;
  /** Number of pixels. */
  area: number;
  /** Tight bounding box (integer pixel coordinates). */
  bbox: Rect;
  /** Mean of the pixel coordinates (integer coordinates = pixel centers). */
  centroid: Point;
  /** True when any pixel lies on the outermost row/column of the image. */
  touchesBorder: boolean;
  /** First pixel in raster order (top-most, then left-most): a fast start for `traceOuterContour`. */
  start: Point;
}

/**
 * Horizontal runs of pixels with a given value, grouped into connected components.
 * Run i covers row `y[i]`, columns `x0[i]..x1[i]` (inclusive). Runs are in raster order and
 * `root[i]` is the index of the first run (in raster order) of run i's component.
 */
export interface Runs {
  count: number;
  y: Int32Array;
  x0: Int32Array;
  x1: Int32Array;
  root: Int32Array;
}

function grow(a: Int32Array<ArrayBuffer>, size: number): Int32Array<ArrayBuffer> {
  const b = new Int32Array(size);
  b.set(a);
  return b;
}

/**
 * Find the runs of pixels whose value equals `value` (nonzero counts as 1) and group them into
 * 4- or 8-connected components. Low-level building block for labelling, hole filling and filtering.
 */
export function labelRuns(m: Mask, value: 0 | 1, connectivity: 4 | 8 = 8): Runs {
  const { width: w, height: h, data } = m;
  const want = value === 1;
  let cap = Math.max(1024, h * 4);
  let ry = new Int32Array(cap), rx0 = new Int32Array(cap), rx1 = new Int32Array(cap), parent = new Int32Array(cap);
  let count = 0;
  const d = connectivity === 8 ? 1 : 0;
  let prevStart = 0, prevEnd = 0;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const curStart = count;
    let p = prevStart;
    let x = 0;
    while (x < w) {
      while (x < w && (data[row + x] !== 0) !== want) x++;
      if (x >= w) break;
      const xs = x;
      while (x < w && (data[row + x] !== 0) === want) x++;
      const xe = x - 1;
      if (count === cap) {
        cap *= 2;
        ry = grow(ry, cap); rx0 = grow(rx0, cap); rx1 = grow(rx1, cap); parent = grow(parent, cap);
      }
      const r = count++;
      ry[r] = y; rx0[r] = xs; rx1[r] = xe; parent[r] = r;
      // Merge with overlapping runs of the previous row.
      while (p < prevEnd && rx1[p] < xs - d) p++;
      for (let q = p; q < prevEnd && rx0[q] <= xe + d; q++) {
        const a = find(q), b = find(r);
        if (a < b) parent[b] = a;
        else if (b < a) parent[a] = b;
      }
    }
    prevStart = curStart;
    prevEnd = count;
  }
  // parent[i] <= i always holds (unions keep the smaller index), so one forward pass resolves roots.
  const root = parent.subarray(0, count);
  for (let i = 0; i < count; i++) root[i] = root[root[i]];
  return { count, y: ry.subarray(0, count), x0: rx0.subarray(0, count), x1: rx1.subarray(0, count), root };
}

/**
 * Label the connected components of the set pixels. Labels are 1..count in raster order of each
 * component's first pixel; background is 0. `stats[i]` describes label i + 1.
 */
export function labelComponents(m: Mask, connectivity: 4 | 8 = 8): { labels: Int32Array; count: number; stats: ComponentStats[] } {
  const { width: w, height: h } = m;
  const labels = new Int32Array(w * h);
  const runs = labelRuns(m, 1, connectivity);
  const { count: nRuns, y: ry, x0: rx0, x1: rx1, root } = runs;
  const labelOf = new Int32Array(nRuns);
  const stats: ComponentStats[] = [];
  const sums: { sx: number; sy: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < nRuns; i++) {
    const r = root[i];
    let lab: number;
    let s: ComponentStats;
    let acc: { sx: number; sy: number; x1: number; y1: number };
    if (r === i) {
      lab = stats.length + 1;
      s = {
        label: lab,
        area: 0,
        bbox: { x: rx0[i], y: ry[i], width: 0, height: 0 },
        centroid: { x: 0, y: 0 },
        touchesBorder: false,
        start: { x: rx0[i], y: ry[i] },
      };
      acc = { sx: 0, sy: 0, x1: rx1[i], y1: ry[i] };
      stats.push(s);
      sums.push(acc);
    } else {
      lab = labelOf[r];
      s = stats[lab - 1];
      acc = sums[lab - 1];
    }
    labelOf[i] = lab;
    const y = ry[i], a = rx0[i], b = rx1[i];
    const len = b - a + 1;
    s.area += len;
    acc.sx += (len * (a + b)) / 2;
    acc.sy += len * y;
    if (a < s.bbox.x) s.bbox.x = a;
    if (b > acc.x1) acc.x1 = b;
    if (y > acc.y1) acc.y1 = y;
    if (a === 0 || b === w - 1 || y === 0 || y === h - 1) s.touchesBorder = true;
    labels.fill(lab, y * w + a, y * w + b + 1);
  }
  for (let k = 0; k < stats.length; k++) {
    const s = stats[k], acc = sums[k];
    s.bbox.width = acc.x1 - s.bbox.x + 1;
    s.bbox.height = acc.y1 - s.bbox.y + 1;
    s.centroid = { x: acc.sx / s.area, y: acc.sy / s.area };
  }
  return { labels, count: stats.length, stats };
}

/**
 * Mask of one component cropped to `bbox` grown by `pad` pixels on every side, i.e. of size
 * (bbox.width + 2 pad) × (bbox.height + 2 pad); mask pixel (0, 0) is image pixel
 * (bbox.x - pad, bbox.y - pad). Parts outside the image stay 0.
 */
export function componentMask(labels: Int32Array, width: number, label: number, bbox: Rect, pad = 0): Mask {
  const height = width > 0 ? Math.floor(labels.length / width) : 0;
  const ox = bbox.x - pad, oy = bbox.y - pad;
  const out = createMask(bbox.width + 2 * pad, bbox.height + 2 * pad);
  const xa = Math.max(0, ox), xb = Math.min(width, ox + out.width);
  for (let my = 0; my < out.height; my++) {
    const y = oy + my;
    if (y < 0 || y >= height) continue;
    const src = y * width, dst = my * out.width - ox;
    for (let x = xa; x < xb; x++) if (labels[src + x] === label) out.data[dst + x] = 1;
  }
  return out;
}

/** Remove connected components (8-connected by default) with fewer than `minArea` pixels. */
export function removeSmallComponents(m: Mask, minArea: number, connectivity: 4 | 8 = 8): Mask {
  const { width: w, height: h } = m;
  const out = createMask(w, h);
  const { count, y: ry, x0: rx0, x1: rx1, root } = labelRuns(m, 1, connectivity);
  const area = new Float64Array(count);
  for (let i = 0; i < count; i++) area[root[i]] += rx1[i] - rx0[i] + 1;
  for (let i = 0; i < count; i++) {
    if (area[root[i]] >= minArea) out.data.fill(1, ry[i] * w + rx0[i], ry[i] * w + rx1[i] + 1);
  }
  return out;
}
