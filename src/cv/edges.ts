import { gaussianBlurGray, sobel } from './filter';
import { createMask, type GrayImage, type Mask } from './image';

const TAN_22_5 = Math.tan(Math.PI / 8);
const TAN_67_5 = Math.tan((3 * Math.PI) / 8);

/**
 * Canny edge detector: optional Gaussian pre-blur (`sigma`, default 1; 0 disables), Sobel
 * gradients, non-maximum suppression along the quantised gradient direction and hysteresis.
 * `low`/`high` are in Sobel-magnitude units (an ideal step of height H gives ≈ 4H before blurring).
 * The outermost pixel ring is never marked.
 */
export function canny(img: GrayImage, low: number, high: number, sigma = 1): Mask {
  const { width: w, height: h } = img;
  const out = createMask(w, h);
  if (w < 3 || h < 3) return out;
  const src = sigma > 0 ? gaussianBlurGray(img, sigma) : img;
  const { gx, gy, magnitude } = sobel(src);
  const mag = magnitude.data, gxd = gx.data, gyd = gy.data;
  // 0 = suppressed / weak below low, 1 = candidate (> low), 2 = strong (> high).
  const state = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m <= low) continue;
      const ax = Math.abs(gxd[i]), ay = Math.abs(gyd[i]);
      let n1: number, n2: number;
      if (ay <= ax * TAN_22_5) { n1 = i - 1; n2 = i + 1; }
      else if (ay >= ax * TAN_67_5) { n1 = i - w; n2 = i + w; }
      else if (gxd[i] * gyd[i] > 0) { n1 = i - w - 1; n2 = i + w + 1; }
      else { n1 = i - w + 1; n2 = i + w - 1; }
      // Strict on one side, non-strict on the other, so plateaus yield a single-pixel edge.
      if (!(m > mag[n1] && m >= mag[n2])) continue;
      if (m > high) {
        state[i] = 2;
        out.data[i] = 1;
        stack[top++] = i;
      } else state[i] = 1;
    }
  }
  // Hysteresis: grow strong edges through 8-connected candidates.
  const offs = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  while (top > 0) {
    const i = stack[--top];
    for (let k = 0; k < 8; k++) {
      const j = i + offs[k];
      if (state[j] === 1) {
        state[j] = 2;
        out.data[j] = 1;
        stack[top++] = j;
      }
    }
  }
  return out;
}
