/**
 * Binary morphology on 0/1 masks. All operations run in O(width * height) independent of the
 * radius: square elements use separable running-count windows, disks use the exact Euclidean
 * distance transform (a disk of radius r = all offsets with dx² + dy² <= r²).
 *
 * Border handling (OpenCV convention): pixels outside the image are neutral, i.e. they never set a
 * pixel during dilation and never clear one during erosion. Nonzero input values count as set;
 * outputs are always 0/1.
 */
import { squaredDistanceTransform } from './distance';
import { createMask, type Mask } from './image';
import { labelRuns } from './components';

export type StructuringShape = 'square' | 'disk';

/** Square window: out = 1 where the (2r+1)² window holds any (dilate) / only (erode) set pixels. */
function squareMorph(m: Mask, r: number, dilate: boolean): Mask {
  const { width: w, height: h, data } = m;
  const tmp = new Uint8Array(w * h);
  // Horizontal pass with a running count per row.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    const pre = Math.min(r, w);
    for (let x = 0; x < pre; x++) count += data[row + x] !== 0 ? 1 : 0;
    for (let x = 0; x < w; x++) {
      const add = x + r;
      if (add < w && data[row + add] !== 0) count++;
      const rem = x - r - 1;
      if (rem >= 0 && data[row + rem] !== 0) count--;
      if (dilate) tmp[row + x] = count > 0 ? 1 : 0;
      else {
        const size = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
        tmp[row + x] = count === size ? 1 : 0;
      }
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
    if (dilate) {
      for (let x = 0; x < w; x++) o[row + x] = counts[x] > 0 ? 1 : 0;
    } else {
      const size = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
      for (let x = 0; x < w; x++) o[row + x] = counts[x] === size ? 1 : 0;
    }
  }
  return out;
}

function diskMorph(m: Mask, r: number, dilate: boolean): Mask {
  const out = createMask(m.width, m.height);
  const r2 = r * r;
  const o = out.data;
  if (dilate) {
    const d2 = squaredDistanceTransform(m, 1);
    for (let i = 0; i < o.length; i++) o[i] = d2[i] <= r2 ? 1 : 0;
  } else {
    const d2 = squaredDistanceTransform(m, 0);
    for (let i = 0; i < o.length; i++) o[i] = d2[i] > r2 ? 1 : 0;
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

/** Morphological closing (dilate, then erode): bridges gaps and fills notches narrower than the element. */
export function close(m: Mask, radius: number, shape: StructuringShape = 'square'): Mask {
  return erode(dilate(m, radius, shape), radius, shape);
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
