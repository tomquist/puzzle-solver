import { rgbaToLab } from '../../cv/color';
import { gaussianBlurFloat } from '../../cv/filter';
import type { FloatImage, RGBAImage } from '../../cv/image';
import { resizeFloat, resizeRGBA } from '../../cv/resize';
import type { CutStyle, GridSpec } from '../../model/types';
import type { RefLevel, ReferenceIndex } from './types';

/** Lab channel weights: chroma counts more than lightness (prints differ mostly in tone). */
export const CHANNEL_WEIGHTS: [number, number, number] = [1, 1.6, 1.6];

/**
 * Target pixels-per-cell of the pyramid levels (capped at the native resolution): 4 = prefilter,
 * 8 = dense coarse search, 16 / 32 = refinement.
 */
const LEVEL_PPC = [4, 8, 16, 32];

function padLevel(img: FloatImage, pad: number): { data: Float32Array; sq: Float32Array; stride: number; rows: number } {
  const { width: w, height: h } = img;
  const stride = w + 2 * pad, rows = h + 2 * pad;
  const data = new Float32Array(stride * rows * 3);
  const sq = new Float32Array(stride * rows);
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - pad));
    for (let x = 0; x < stride; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - pad));
      const s = (sy * w + sx) * 3, d = (y * stride + x) * 3;
      const a = img.data[s], b = img.data[s + 1], c = img.data[s + 2];
      data[d] = a;
      data[d + 1] = b;
      data[d + 2] = c;
      sq[y * stride + x] = a * a + b * b + c * c;
    }
  }
  return { data, sq, stride, rows };
}

/** Row-wise prefix sums of the centred channels and squared norms (for the dense coarse search). */
function addPrefix(level: RefLevel): void {
  const { stride, rows, data } = level;
  const N = stride * rows;
  const c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    c[0] += data[i * 3];
    c[1] += data[i * 3 + 1];
    c[2] += data[i * 3 + 2];
  }
  const center: [number, number, number] = [c[0] / N, c[1] / N, c[2] / N];
  const W1 = stride + 1;
  const P = new Float64Array(rows * W1 * 4);
  for (let y = 0; y < rows; y++) {
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    const pr = y * W1 * 4;
    for (let x = 0; x < stride; x++) {
      const q = (y * stride + x) * 3;
      const v0 = data[q] - center[0], v1 = data[q + 1] - center[1], v2 = data[q + 2] - center[2];
      a0 += v0;
      a1 += v1;
      a2 += v2;
      a3 += v0 * v0 + v1 * v1 + v2 * v2;
      const o = pr + (x + 1) * 4;
      P[o] = a0;
      P[o + 1] = a1;
      P[o + 2] = a2;
      P[o + 3] = a3;
    }
  }
  level.prefix = P;
  level.center = center;
}

/**
 * Build the matching index of a reference image: a channel-weighted Lab pyramid at a few
 * pixels-per-cell levels (area downsampling), padded so templates can hang over the border.
 */
export function buildReferenceIndex(reference: RGBAImage, grid: GridSpec, cut: CutStyle): ReferenceIndex {
  const W = reference.width, H = reference.height;
  const cellW = W / grid.cols, cellH = H / grid.rows;
  const ppcs: number[] = [];
  for (const p of LEVEL_PPC) {
    const v = Math.min(p, cellW);
    if (!ppcs.some((q) => Math.abs(q - v) < 0.5)) ppcs.push(v);
  }
  const sizeOf = (ppc: number) => ({ w: Math.max(1, Math.round((W * ppc) / cellW)), h: Math.max(1, Math.round((H * ppc) / cellW)) });
  // Lab of the finest level; a much larger reference (e.g. a high-res composite) is shrunk in RGB first.
  const fine = sizeOf(ppcs[ppcs.length - 1]);
  const src = fine.w * 2 < W ? resizeRGBA(reference, fine.w * 2, fine.h * 2) : reference;
  const lab = rgbaToLab(src);
  const [wl, wa, wb] = CHANNEL_WEIGHTS;
  for (let i = 0; i < lab.data.length; i += 3) {
    lab.data[i] *= wl;
    lab.data[i + 1] *= wa;
    lab.data[i + 2] *= wb;
  }
  // Area-downsample fine to coarse, each level from the next finer one.
  const raw: FloatImage[] = new Array(ppcs.length);
  let prev: FloatImage = lab;
  for (let li = ppcs.length - 1; li >= 0; li--) {
    const { w, h } = sizeOf(ppcs[li]);
    prev = prev.width === w && prev.height === h ? prev : resizeFloat(prev, w, h);
    raw[li] = prev;
  }
  const levels: RefLevel[] = ppcs.map((ppc, li) => {
    // A slight blur makes the reference as soft as the resampled piece templates.
    const img = gaussianBlurFloat(raw[li], 0.5);
    const pad = Math.ceil(1.1 * ppc) + 3;
    const p = padLevel(img, pad);
    const level: RefLevel = { ppc, scaleX: img.width / W, scaleY: img.height / H, width: img.width, height: img.height, pad, ...p, center: [0, 0, 0] };
    // Prefix sums for the levels searched densely (prefilter and coarse).
    if (li <= 1 && ppc < 12) addPrefix(level);
    return level;
  });
  return { width: W, height: H, grid: { rows: grid.rows, cols: grid.cols }, cut, cellW, cellH, channelWeights: [wl, wa, wb], levels };
}

/**
 * The same matching index read with other cells (`cellW` × `cellH` reference px): the pyramid is
 * the picture's and does not change, only what a cell means – its levels' pixels per cell, the
 * template scale of a piece, the cells reported. Used to measure a scan at another scale than the
 * puzzle's grid (match/cellSize.ts) without rebuilding the pyramid; the grid is the nearest whole one.
 */
export function withCells(index: ReferenceIndex, cellW: number, cellH: number): ReferenceIndex {
  const k = cellW / index.cellW;
  return {
    ...index,
    grid: { rows: Math.max(1, Math.round(index.height / cellH)), cols: Math.max(1, Math.round(index.width / cellW)) },
    cellW,
    cellH,
    levels: index.levels.map((l) => ({ ...l, ppc: l.ppc * k })),
  };
}
