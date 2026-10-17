import { rgbaToLab } from '../../cv/color';
import { gaussianBlurFloat } from '../../cv/filter';
import type { FloatImage, RGBAImage } from '../../cv/image';
import { resizeFloat } from '../../cv/resize';
import type { CutStyle, GridSpec } from '../../model/types';
import type { RefLevel, ReferenceIndex } from './types';

/** Lab channel weights: chroma counts more than lightness (prints differ mostly in tone). */
export const CHANNEL_WEIGHTS: [number, number, number] = [1, 1.6, 1.6];

/** Target pixels-per-cell of the pyramid levels (capped at the native resolution). */
const LEVEL_PPC = [8, 16, 32];

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

/**
 * Build the matching index of a reference image: a channel-weighted Lab pyramid at a few
 * pixels-per-cell levels (area downsampling), padded so templates can hang over the border.
 */
export function buildReferenceIndex(reference: RGBAImage, grid: GridSpec, cut: CutStyle): ReferenceIndex {
  const W = reference.width, H = reference.height;
  const cellW = W / grid.cols, cellH = H / grid.rows;
  const lab = rgbaToLab(reference);
  const [wl, wa, wb] = CHANNEL_WEIGHTS;
  for (let i = 0; i < lab.data.length; i += 3) {
    lab.data[i] *= wl;
    lab.data[i + 1] *= wa;
    lab.data[i + 2] *= wb;
  }
  const ppcs: number[] = [];
  for (const p of LEVEL_PPC) {
    const v = Math.min(p, cellW);
    if (!ppcs.some((q) => Math.abs(q - v) < 0.5)) ppcs.push(v);
  }
  const levels: RefLevel[] = ppcs.map((ppc) => {
    const scale = ppc / cellW;
    let img: FloatImage = scale >= 0.999 ? lab : resizeFloat(lab, Math.round(W * scale), Math.round(H * scale));
    // A slight blur makes the reference as soft as the resampled piece templates.
    img = gaussianBlurFloat(img, 0.5);
    const pad = Math.ceil(1.1 * ppc) + 3;
    const p = padLevel(img, pad);
    return { ppc, scaleX: img.width / W, scaleY: img.height / H, width: img.width, height: img.height, pad, ...p };
  });
  return { width: W, height: H, grid: { rows: grid.rows, cols: grid.cols }, cut, cellW, cellH, channelWeights: [wl, wa, wb], levels };
}
