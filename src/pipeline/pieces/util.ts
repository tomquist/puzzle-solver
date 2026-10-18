/** Small numeric helpers shared inside the pieces package. */
import type { Point } from '../../cv/geometry';
import { createGray, createMask, type GrayImage, type Mask, type RGBAImage } from '../../cv/image';

/** Median of a list (0 for an empty list). Does not modify the input. */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values).sort();
  return n % 2 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/** q-quantile (0..1, linear interpolation) of a list (0 for an empty list). */
export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values).sort();
  const pos = Math.max(0, Math.min(n - 1, q * (n - 1)));
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < n ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

/** Translate points by (dx, dy). */
export function offsetPoints(pts: readonly Point[], dx: number, dy: number): Point[] {
  return pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Colour of a (2r+1)² box neighbourhood with each pixel's own brightness, split like a JPEG: luma
 * (Y = 0.299 R + 0.587 G + 0.114 B) per pixel, the colour differences B − Y and R − Y box-averaged
 * (separable running sums, replicated borders), then back to RGB. Colour noise and a decoder's
 * chroma upsampling (phone JPEGs store colour at half resolution anyway) are averaged away while
 * brightness edges stay sharp.
 */
export function smoothChroma(img: RGBAImage, r: number): RGBAImage {
  if (r < 1) return img;
  const { width: w, height: h, data: src } = img;
  if (w < 3 || h < 3) return img;
  const n = w * h;
  // Luma / colour-difference split like a JPEG (gamma-encoded values): luma per pixel, the two
  // colour differences box-averaged (separable running sums, replicated borders).
  const Y = new Float32Array(n), cb = new Float32Array(n), cr = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
    Y[i] = y;
    cb[i] = src[p + 2] - y;
    cr[i] = src[p] - y;
  }
  const tmp = new Float32Array(n);
  const norm = 1 / ((2 * r + 1) * (2 * r + 1));
  for (const a of [cb, cr]) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc;
        acc += a[row + (x + r + 1 < w ? x + r + 1 : w - 1)] - a[row + (x - r > 0 ? x - r : 0)];
      }
    }
    // Vertical running sums row by row (cache friendly).
    const col = new Float32Array(w);
    for (let k = -r; k <= r; k++) {
      const row = Math.min(h - 1, Math.max(0, k)) * w;
      for (let x = 0; x < w; x++) col[x] += tmp[row + x];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w, add = (y + r + 1 < h ? y + r + 1 : h - 1) * w, rem = (y - r > 0 ? y - r : 0) * w;
      for (let x = 0; x < w; x++) {
        a[row + x] = col[x] * norm;
        col[x] += tmp[add + x] - tmp[rem + x];
      }
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = Y[i], R = y + cr[i], B = y + cb[i];
    out[p] = R;
    out[p + 1] = (y - 0.299 * R - 0.114 * B) / 0.587;
    out[p + 2] = B;
    out[p + 3] = src[p + 3];
  }
  return { width: w, height: h, data: out };
}

/**
 * Colour step within the pixel pairs of a JPEG colour sample (relative to the step between pairs)
 * below which a decoder replicated the sample: ≈ 0 then, ≈ 0.4–0.85 for interpolated or full colour.
 */
const REPLICATED_STEP = 0.1;

/**
 * A JPEG photo whose half-resolution colour the decoder replicated over 2×2 (or 2×1) pixels, as
 * jpeg-js does, re-interpolated the way browsers decode it (libjpeg's "fancy" upsampling: each
 * pixel's colour 3:1 from its own and the next colour sample per subsampled axis, 9:3:3:1 for
 * 4:2:0); the brightness of each pixel is kept. Every decoder then gives (within a gray level or
 * two) the same image. Photos without replicated colour (not subsampled, already interpolated,
 * resized) come back unchanged.
 */
export function interpolateReplicatedChroma(img: RGBAImage): RGBAImage {
  const { width: w, height: h, data: src } = img;
  if (w < 4 || h < 4) return img;
  // Colour (R − G, B − G: independent of the brightness) steps within and between pixel pairs.
  const step = (o: number, q: number) => Math.abs(src[o] - src[o + 1] - src[q] + src[q + 1]) + Math.abs(src[o + 2] - src[o + 1] - src[q + 2] + src[q + 1]);
  let inH = 0, outH = 0, inV = 0, outV = 0;
  for (let y = 0; y + 1 < h; y += 3) {
    for (let x = 0; x + 1 < w; x++) {
      const o = (y * w + x) * 4;
      if (x & 1) outH += step(o, o + 4);
      else inH += step(o, o + 4);
    }
  }
  for (let x = 0; x < w; x += 3) {
    for (let y = 0; y + 1 < h; y++) {
      const o = (y * w + x) * 4;
      if (y & 1) outV += step(o, o + 4 * w);
      else inV += step(o, o + 4 * w);
    }
  }
  const sx = inH < REPLICATED_STEP * outH ? 2 : 1, sy = inV < REPLICATED_STEP * outV ? 2 : 1;
  if (sx === 1 && sy === 1) return img;
  // Luma per pixel; colour differences B − Y and R − Y per colour sample (mean over its pixels).
  const n = w * h, cw = Math.ceil(w / sx), ch = Math.ceil(h / sy);
  const Y = new Float32Array(n), cb = new Float32Array(cw * ch), cr = new Float32Array(cw * ch), cnt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / sy) * cw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4, k = row + Math.floor(x / sx);
      const l = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      Y[i] = l;
      cb[k] += src[p + 2] - l;
      cr[k] += src[p] - l;
      cnt[k]++;
    }
  }
  for (let k = 0; k < cnt.length; k++) {
    cb[k] /= cnt[k];
    cr[k] /= cnt[k];
  }
  // Nearest sample (weight 3/4) and the next one towards the pixel (1/4) per subsampled axis.
  const near = (v: number, s: number, len: number): [number, number] => {
    const c = Math.floor(v / s);
    if (s === 1) return [c, c];
    const next = v % 2 === 0 ? c - 1 : c + 1;
    return [c, Math.min(len - 1, Math.max(0, next))];
  };
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    const [r0, r1] = near(y, sy, ch);
    for (let x = 0; x < w; x++) {
      const [c0, c1] = near(x, sx, cw);
      const a = r0 * cw + c0, b = r0 * cw + c1, c = r1 * cw + c0, d = r1 * cw + c1;
      const vb = (9 * cb[a] + 3 * cb[b] + 3 * cb[c] + cb[d]) / 16, vr = (9 * cr[a] + 3 * cr[b] + 3 * cr[c] + cr[d]) / 16;
      const i = y * w + x, p = i * 4, l = Y[i], R = l + vr, B = l + vb;
      out[p] = R;
      out[p + 1] = (l - 0.299 * R - 0.114 * B) / 0.587;
      out[p + 2] = B;
      out[p + 3] = src[p + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Separable (2r+1)² box filter of the RGB channels (alpha copied), with replicated borders.
 * Running sums, O(1) per pixel independent of r.
 */
export function boxBlurRGB(img: RGBAImage, r: number): RGBAImage {
  const { width: w, height: h, data: src } = img;
  if (r < 1 || w === 0 || h === 0) return img;
  const tmp = new Uint16Array(w * h * 3);
  const n = 2 * r + 1;
  // Horizontal sums.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(row + Math.min(w - 1, Math.max(0, k))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 3 + c] = acc;
        acc += src[(row + Math.min(w - 1, x + r + 1)) * 4 + c] - src[(row + Math.max(0, x - r)) * 4 + c];
      }
    }
  }
  // Vertical sums.
  const out = new Uint8ClampedArray(w * h * 4);
  const norm = 1 / (n * n);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = acc * norm + 0.5;
        acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - r) * w + x) * 3 + c];
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = src[i];
  return { width: w, height: h, data: out };
}

/** 2×2 average downsample of a gray image (odd trailing row/column dropped). */
export function halveGray(img: GrayImage): GrayImage {
  const w = img.width >> 1, h = img.height >> 1, W = img.width, s = img.data;
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * W, r1 = r0 + W;
    for (let x = 0; x < w; x++) out.data[y * w + x] = 0.25 * (s[r0 + 2 * x] + s[r0 + 2 * x + 1] + s[r1 + 2 * x] + s[r1 + 2 * x + 1]);
  }
  return out;
}

/** Nearest-neighbour 2× upsample of a mask to `width` × `height` (replicates the last row/column). */
export function doubleMask(m: Mask, width: number, height: number): Mask {
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(m.height - 1, y >> 1);
    const src = sy * m.width, dst = y * width;
    for (let x = 0; x < width; x++) out.data[dst + x] = m.data[src + Math.min(m.width - 1, x >> 1)];
  }
  return out;
}
