/**
 * Pure helpers for decoding photos safely on phones: target-size math (max side + max canvas
 * area), EXIF orientation, step-down resize plans and a tiny image-header parser (JPEG / PNG /
 * GIF / WebP dimensions, JPEG EXIF orientation, HEIC/AVIF detection) so a 48 MP photo never needs a
 * full-size canvas. No DOM – unit-tested in Node.
 */

/**
 * iOS Safari refuses canvases larger than 16,777,216 px (4096²) – drawing silently produces a blank
 * canvas or throws. Every canvas the app creates stays within this area.
 */
export const MAX_CANVAS_AREA = 16_777_216;

export interface Size {
  width: number;
  height: number;
}

/**
 * Largest integer size with the same aspect ratio as `width × height` whose longer side is at most
 * `maxSide` and whose area is at most `maxArea`. Never upscales.
 */
export function targetSize(width: number, height: number, maxSide: number, maxArea = MAX_CANVAS_AREA): Size & { scale: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0, scale: 0 };
  const s = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxArea / (width * height)));
  let w = Math.max(1, Math.floor(width * s + 1e-9));
  let h = Math.max(1, Math.floor(height * s + 1e-9));
  if (s === 1) {
    w = width;
    h = height;
  }
  // Rounding can never increase the area above the cap because we floor, but be explicit.
  while (w * h > maxArea && w > 1 && h > 1) {
    if (w >= h) w--;
    else h--;
  }
  return { width: w, height: h, scale: w / width };
}

/** EXIF orientations 5–8 swap width and height. */
export function orientedSize(width: number, height: number, orientation: number): Size {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/**
 * Intermediate sizes for a high-quality downscale from `src` to `dst` by repeated halving (a single
 * large reduction with canvas drawImage aliases badly in some engines); reductions up to 2.5× are
 * drawn directly. Every step stays within
 * `maxArea`. The last entry is always `dst`. Empty when no reduction is needed.
 */
export function stepDownSizes(src: Size, dst: Size, maxArea = MAX_CANVAS_AREA): Size[] {
  const steps: Size[] = [];
  if (dst.width >= src.width && dst.height >= src.height) return steps;
  let cur = { ...src };
  for (let guard = 0; guard < 16; guard++) {
    if (cur.width <= dst.width * 2.5 && cur.height <= dst.height * 2.5) break;
    let next = { width: Math.max(dst.width, Math.ceil(cur.width / 2)), height: Math.max(dst.height, Math.ceil(cur.height / 2)) };
    if (next.width * next.height > maxArea) {
      const k = Math.sqrt(maxArea / (next.width * next.height));
      next = { width: Math.max(dst.width, Math.floor(next.width * k)), height: Math.max(dst.height, Math.floor(next.height * k)) };
    }
    steps.push(next);
    cur = next;
  }
  steps.push({ ...dst });
  return steps;
}

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'avif' | 'unknown';

export interface ImageHeader {
  format: ImageFormat;
  /** Stored (un-oriented) pixel size, when the header tells. */
  width?: number;
  height?: number;
  /** EXIF orientation 1–8 (1 = as stored). */
  orientation: number;
}

/** How many leading bytes of a file {@link parseImageHeader} wants. */
export const HEADER_BYTES = 512 * 1024;

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

function u16(b: Uint8Array, at: number, little: boolean): number {
  return little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1];
}

function u32(b: Uint8Array, at: number, little: boolean): number {
  return little
    ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
    : ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/** EXIF orientation from an APP1 payload starting with "Exif\0\0" at `start`. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const order = ascii(b, tiff, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const little = order === 'II';
  if (u16(b, tiff + 2, little) !== 42) return 1;
  const ifd = tiff + u32(b, tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = u16(b, ifd, little);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (u16(b, e, little) === 0x0112) {
      const v = u16(b, e + 8, little);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function parseJpeg(b: Uint8Array): ImageHeader {
  const h: ImageHeader = { format: 'jpeg', orientation: 1 };
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan: no more headers
    const len = u16(b, p + 2, false);
    const seg = p + 4;
    if (marker === 0xe1 && ascii(b, seg, 6) === 'Exif\0\0') {
      h.orientation = exifOrientation(b, seg, Math.min(b.length, p + 2 + len));
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && seg + 5 <= b.length) {
      h.height = u16(b, seg + 1, false);
      h.width = u16(b, seg + 3, false);
      break;
    }
    p += 2 + len;
  }
  return h;
}

function parseWebp(b: Uint8Array): ImageHeader {
  const h: ImageHeader = { format: 'webp', orientation: 1 };
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) {
    h.width = u16(b, 26, true) & 0x3fff;
    h.height = u16(b, 28, true) & 0x3fff;
  } else if (chunk === 'VP8L' && b.length >= 25) {
    const bits = u32(b, 21, true);
    h.width = (bits & 0x3fff) + 1;
    h.height = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X' && b.length >= 30) {
    h.width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    h.height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
  }
  return h;
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Identify the format and (where cheap) the size and orientation of an image from its first bytes. */
export function parseImageHeader(b: Uint8Array): ImageHeader {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return parseJpeg(b);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { format: 'png', width: u32(b, 16, false), height: u32(b, 20, false), orientation: 1 };
  }
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') {
    return { format: 'gif', width: u16(b, 6, true), height: u16(b, 8, true), orientation: 1 };
  }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return parseWebp(b);
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { format: 'avif', orientation: 1 };
    if (HEIF_BRANDS.has(brand)) return { format: 'heic', orientation: 1 };
  }
  return { format: 'unknown', orientation: 1 };
}

export interface DrawRects {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Clip a drawImage source rectangle to the source bounds (W × H) and shrink the destination
 * rectangle accordingly. Safari draws nothing at all when the source rectangle extends outside
 * the image (Chrome clips), so crops near picture edges must be clipped by hand. Returns null when
 * nothing of the source is inside the rectangle.
 */
export function clipDrawRects(r: DrawRects, W: number, H: number): DrawRects | null {
  if (r.sw <= 0 || r.sh <= 0) return null;
  const x0 = Math.max(0, r.sx);
  const y0 = Math.max(0, r.sy);
  const x1 = Math.min(W, r.sx + r.sw);
  const y1 = Math.min(H, r.sy + r.sh);
  if (x1 <= x0 || y1 <= y0) return null;
  const kx = r.dw / r.sw;
  const ky = r.dh / r.sh;
  return {
    sx: x0,
    sy: y0,
    sw: x1 - x0,
    sh: y1 - y0,
    dx: r.dx + (x0 - r.sx) * kx,
    dy: r.dy + (y0 - r.sy) * ky,
    dw: (x1 - x0) * kx,
    dh: (y1 - y0) * ky,
  };
}
