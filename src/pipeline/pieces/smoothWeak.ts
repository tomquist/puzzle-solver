/**
 * Is a weak area of a region a shading of the table rather than part of a piece? A piece ends at a
 * crisp cut edge, while a sheen, a shading or a stain fades into the table: along the stretch of the
 * area's outline that faces the table, the fine-scale brightness energy stays at the table's own
 * level (the same test as peelSoft's, segment.ts, applied to one weak area of a region).
 */
import { createGray, type GrayImage, type Mask, type RGBAImage } from '../../cv/image';
import { boxBlurGray } from '../../cv/filter';
import { median } from './util';

/** Width (px) of the band on either side of the open outline in which a crisp edge is looked for. */
const RIM = 2;

/**
 * Share of the open outline of one weak area – its border with pixels outside `region`, a band of
 * RIM px on either side – that lies on a crisp brightness edge (fine-scale luminance energy above the
 * table's level: median + 5 MADs of the energy outside the region, at least 0.25 grey levels a MAD).
 * `labels` / `label` pick the area out of the frame `region` (frame size pw × ph at photo offset
 * ox, oy); `box` is the area's bounding box in the frame. Null when the area hardly faces the table
 * or the table around it cannot be measured.
 */
export function crispOpenOutline(img: RGBAImage, labels: Int32Array, label: number, box: { x: number; y: number; width: number; height: number }, region: Mask, ox: number, oy: number): number | null {
  const pw = region.width, ph = region.height, W = img.width, H = img.height;
  const pad = RIM + 8;
  const fx0 = Math.max(0, box.x - pad), fy0 = Math.max(0, box.y - pad);
  const fx1 = Math.min(pw, box.x + box.width + pad), fy1 = Math.min(ph, box.y + box.height + pad);
  const w = fx1 - fx0, h = fy1 - fy0;
  if (w <= 2 * RIM || h <= 2 * RIM) return null;
  // Luminance of the window (pixels outside the photo, in the padded frame, repeat the edge).
  const Y = createGray(w, h);
  for (let y = 0; y < h; y++) {
    const py = Math.min(H - 1, Math.max(0, y + fy0 + oy));
    for (let x = 0; x < w; x++) {
      const px = Math.min(W - 1, Math.max(0, x + fx0 + ox));
      const o = (py * W + px) * 4;
      Y.data[y * w + x] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    }
  }
  const energy = fineEnergy(Y);
  // The open outline: area pixels next to a pixel outside the region, and those outside pixels.
  const rim = new Uint8Array(w * h);
  let edge = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const f = (y + fy0) * pw + x + fx0;
      if (labels[f] !== label) continue;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (region.data[f + dy * pw + dx]) continue;
        edge++;
        for (let yy = Math.max(0, y - RIM); yy <= Math.min(h - 1, y + RIM); yy++) {
          for (let xx = Math.max(0, x - RIM); xx <= Math.min(w - 1, x + RIM); xx++) rim[yy * w + xx] = 1;
        }
      }
    }
  }
  if (edge === 0) return null;
  // The table's own energy: window pixels outside the region and off the rim.
  const tv: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (!region.data[(y + fy0) * pw + x + fx0] && !rim[y * w + x]) tv.push(energy.data[y * w + x]);
  }
  if (tv.length < 50) return null;
  const med = median(tv);
  const mad = median(tv.map((v) => Math.abs(v - med)));
  const t = med + 5 * Math.max(1.4826 * mad, 0.25);
  let n = 0, crisp = 0;
  for (let i = 0; i < w * h; i++) {
    if (!rim[i]) continue;
    n++;
    if (energy.data[i] > t) crisp++;
  }
  return crisp / n;
}

/** Fine-scale luminance energy: |Y − 5×5 mean|, averaged over 3×3 (as in peelSoft). */
function fineEnergy(Y: GrayImage): GrayImage {
  const local = boxBlurGray(Y, 2);
  const dev = createGray(Y.width, Y.height);
  for (let i = 0; i < dev.data.length; i++) dev.data[i] = Math.abs(Y.data[i] - local.data[i]);
  return boxBlurGray(dev, 1);
}
