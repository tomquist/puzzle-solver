/**
 * Binary morphology on 0/1 masks. All operations run in O(width * height) independent of the
 * radius: square elements are separable (row runs + running column counts); disks (all offsets
 * with dx² + dy² <= r², exact) use column distances plus a per-row interval sweep.
 *
 * Border handling: for erode/dilate/open, pixels outside the image are neutral (OpenCV
 * convention), i.e. they never set a pixel during dilation and never clear one during erosion;
 * `close` treats the outside as background (see there). Nonzero input values count as set; outputs
 * are always 0/1.
 */
import { createMask, type Mask } from './image';
import { labelRuns } from './components';

export type StructuringShape = 'square' | 'disk';

/** Square window: out = 1 where the (2r+1)² window holds any (dilate) / only (erode) set pixels. */
function squareMorph(m: Mask, r: number, isDilate: boolean): Mask {
  const { width: w, height: h, data } = m;
  const tmp = new Uint8Array(w * h);
  // Horizontal pass on runs of set pixels.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      while (x < w && data[row + x] === 0) x++;
      if (x >= w) break;
      const a = x;
      while (x < w && data[row + x] !== 0) x++;
      const b = x - 1;
      const lo = isDilate ? Math.max(0, a - r) : a === 0 ? 0 : a + r;
      const hi = isDilate ? Math.min(w - 1, b + r) : b === w - 1 ? b : b - r;
      if (lo <= hi) tmp.fill(1, row + lo, row + hi + 1);
    }
  }
  // Vertical pass with running counts per column, processed row by row.
  const out = createMask(w, h);
  const o = out.data;
  const counts = new Int32Array(w);
  const pre = Math.min(r, h);
  for (let y = 0; y < pre; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) counts[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const add = y + r;
    if (add < h) {
      const row = add * w;
      for (let x = 0; x < w; x++) counts[x] += tmp[row + x];
    }
    const rem = y - r - 1;
    if (rem >= 0) {
      const row = rem * w;
      for (let x = 0; x < w; x++) counts[x] -= tmp[row + x];
    }
    const row = y * w;
    if (isDilate) {
      for (let x = 0; x < w; x++) o[row + x] = counts[x] > 0 ? 1 : 0;
    } else {
      const size = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
      for (let x = 0; x < w; x++) o[row + x] = counts[x] === size ? 1 : 0;
    }
  }
  return out;
}

/**
 * Disk element {dx² + dy² <= r²}, exact. Dilation: per column, the vertical distance g to the
 * nearest set pixel; pixel (x, y) is covered iff some column q has g² + (x − q)² <= r², i.e. x lies
 * in the interval q ± span(g), and the union of those intervals is swept per row. Erosion is the
 * complement of the dilation of the unset pixels (outside pixels stay neutral).
 */
function diskMorph(m: Mask, r: number, isDilate: boolean): Mask {
  const { width: w, height: h, data } = m;
  const R = Math.min(Math.floor(r), w + h);
  const cap = R + 1;
  const span = new Int32Array(R + 1);
  for (let g = 0; g <= R; g++) span[g] = Math.floor(Math.sqrt(r * r - g * g) + 1e-9);
  const isTarget = (v: number): boolean => (v !== 0) === isDilate;
  const g = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) g[x] = isTarget(data[x]) ? 0 : cap;
  for (let i = w; i < w * h; i++) {
    if (isTarget(data[i])) continue;
    const v = g[i - w] + 1;
    g[i] = v < cap ? v : cap;
  }
  for (let i = w * (h - 1) - 1; i >= 0; i--) {
    const v = g[i + w] + 1;
    if (v < g[i]) g[i] = v;
  }
  const out = createMask(w, h);
  const o = out.data;
  const reach = new Int32Array(w).fill(-1);
  const hit = isDilate ? 1 : 0, miss = isDilate ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let q = 0; q < w; q++) {
      const gq = g[row + q];
      if (gq > R) continue;
      const sp = span[gq];
      const a = q > sp ? q - sp : 0;
      const e = q + sp;
      if (e > reach[a]) reach[a] = e;
    }
    let cur = -1;
    for (let x = 0; x < w; x++) {
      if (reach[x] > cur) cur = reach[x];
      reach[x] = -1;
      o[row + x] = cur >= x ? hit : miss;
    }
  }
  return out;
}

function normalized(m: Mask): Mask {
  const out = createMask(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) out.data[i] = m.data[i] !== 0 ? 1 : 0;
  return out;
}

function morph(m: Mask, radius: number, shape: StructuringShape, dilate: boolean): Mask {
  if (m.width === 0 || m.height === 0) return createMask(m.width, m.height);
  if (shape === 'disk') return radius < 1 ? normalized(m) : diskMorph(m, radius, dilate);
  const r = Math.floor(radius);
  return r < 1 ? normalized(m) : squareMorph(m, r, dilate);
}

/**
 * Binary erosion with a (2r+1)² square (default; r = floor(radius)) or a disk of the given radius.
 * Outside-image pixels are neutral, so objects touching the border are not eroded from there.
 */
export function erode(m: Mask, radius: number, shape: StructuringShape = 'square'): Mask {
  return morph(m, radius, shape, false);
}

/** Binary dilation with a (2r+1)² square (default; r = floor(radius)) or a disk of the given radius. */
export function dilate(m: Mask, radius: number, shape: StructuringShape = 'square'): Mask {
  return morph(m, radius, shape, true);
}

/** Morphological opening (erode, then dilate): removes specks and thin protrusions narrower than the element. */
export function open(m: Mask, radius: number, shape: StructuringShape = 'square'): Mask {
  return dilate(erode(m, radius, shape), radius, shape);
}

/**
 * Morphological closing (dilate, then erode): bridges gaps and fills notches narrower than the
 * element. Computed on a padded copy, so the outside counts as background: objects near the image
 * border are not bridged to it (the result is the exact closing of the mask in an empty plane).
 */
export function close(m: Mask, radius: number, shape: StructuringShape = 'square'): Mask {
  const { width: w, height: h } = m;
  const p = Math.ceil(radius);
  if (p < 1 || w === 0 || h === 0) return normalized(m);
  const W = w + 2 * p;
  const padded = createMask(W, h + 2 * p);
  for (let y = 0; y < h; y++) padded.data.set(m.data.subarray(y * w, y * w + w), (y + p) * W + p);
  const c = erode(dilate(padded, radius, shape), radius, shape);
  const out = createMask(w, h);
  for (let y = 0; y < h; y++) out.data.set(c.data.subarray((y + p) * W + p, (y + p) * W + p + w), y * w);
  return out;
}

/**
 * Fill holes: every unset region that is not 4-connected to the image border becomes set
 * (4-connected background is the dual of 8-connected foreground). With `maxHoleArea`, only holes
 * of at most that many pixels are filled.
 */
export function fillHoles(m: Mask, maxHoleArea = Infinity): Mask {
  const { width: w, height: h } = m;
  const out = normalized(m);
  if (w === 0 || h === 0) return out;
  const runs = labelRuns(m, 0, 4);
  const { count, y: ry, x0: rx0, x1: rx1, root } = runs;
  // Per root: area, and whether the region touches the border (-1).
  const area = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const r = root[i];
    if (area[r] < 0) continue;
    if (ry[i] === 0 || ry[i] === h - 1 || rx0[i] === 0 || rx1[i] === w - 1) area[r] = -1;
    else area[r] += rx1[i] - rx0[i] + 1;
  }
  const o = out.data;
  for (let i = 0; i < count; i++) {
    const a = area[root[i]];
    if (a < 0 || a > maxHoleArea) continue;
    o.fill(1, ry[i] * w + rx0[i], ry[i] * w + rx1[i] + 1);
  }
  return out;
}
