/**
 * Minimal drawing kit for debug images (Node tooling): a 5×7 bitmap font, labels with a backdrop,
 * markers, a heat-map colour scale and a "view" that draws photo-space geometry onto a downscaled
 * copy of the photo, with a legend header above it.
 */
import type { Point } from '../../src/cv/geometry';
import { createRGBA, type Rect, type RGBAImage } from '../../src/cv/image';
import { drawLine, drawPolygon } from '../../src/cv/raster';
import { resizeRGBA } from '../../src/cv/resize';

export type Color = [number, number, number, number];

/** Colours used consistently in every feedback image. */
export const COLORS = {
  confident: [40, 220, 80, 255] as Color,
  ambiguous: [255, 210, 0, 255] as Color,
  unmatched: [235, 235, 235, 255] as Color,
  fragment: [140, 140, 140, 255] as Color,
  missed: [255, 40, 40, 255] as Color,
  notPiece: [255, 0, 255, 255] as Color,
  merged: [255, 140, 0, 255] as Color,
  badOutline: [0, 210, 255, 255] as Color,
  wrongPlace: [80, 130, 255, 255] as Color,
  ok: [40, 200, 70, 255] as Color,
  bad: [230, 30, 30, 255] as Color,
  neutral: [90, 90, 90, 255] as Color,
  white: [255, 255, 255, 255] as Color,
  black: [0, 0, 0, 255] as Color,
  user: [40, 220, 80, 255] as Color,
  detected: [0, 210, 255, 255] as Color,
};

const GLYPHS: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11100100101000110001100011001011100', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100011000101010001000010000100', Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', ' ': '00000000000000000000000000000000000',
  '.': '00000000000000000000000000110001100', ',': '00000000000000000000011000010001000', ':': '00000011000110000000011000110000000',
  ';': '00000011000110000000011000010001000', '-': '00000000000000011111000000000000000', '+': '00000001000010011111001000010000000',
  '/': '00000000010001000100010001000000000', '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000',
  '#': '01010010101111101010111110101001010', '%': '11000110010001000100010001001100011', '<': '00010001000100010000010000010000010',
  '>': '01000001000001000001000100010001000', '=': '00000000001111100000111110000000000', '!': '00100001000010000100001000000000100',
  '?': '01110100010000100010001000000000100', "'": '01100001000100000000000000000000000', '_': '00000000000000000000000000000011111',
  '[': '01110010000100001000010000100001110', ']': '01110000100001000010000100001001110', '*': '00000001001010101110101010010000000',
  '|': '00100001000010000100001000010000100', '"': '01010010100101000000000000000000000', '@': '01110100011011110101101111000001110',
};

/** Width in px of `text` at the given scale (6 px advance per character at scale 1). */
export function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale;
}

function setPixel(img: RGBAImage, x: number, y: number, c: Color): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  const a = c[3] / 255;
  img.data[o] = img.data[o] * (1 - a) + c[0] * a;
  img.data[o + 1] = img.data[o + 1] * (1 - a) + c[1] * a;
  img.data[o + 2] = img.data[o + 2] * (1 - a) + c[2] * a;
  img.data[o + 3] = 255;
}

export function fillRect(img: RGBAImage, x: number, y: number, w: number, h: number, c: Color): void {
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(img.height, Math.ceil(y + h)); yy++) {
    for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(img.width, Math.ceil(x + w)); xx++) setPixel(img, xx, yy, c);
  }
}

/** Draw text (upper-cased; unknown characters become '?') with its top-left corner at (x, y). */
export function drawText(img: RGBAImage, x: number, y: number, text: string, color: Color, scale = 2, backdrop?: Color): void {
  const t = text.toUpperCase();
  if (backdrop) fillRect(img, x - scale, y - scale, textWidth(t, scale) + scale, 8 * scale + scale, backdrop);
  for (let k = 0; k < t.length; k++) {
    const g = GLYPHS[t[k]] ?? GLYPHS['?'];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row * 5 + col] !== '1') continue;
        fillRect(img, x + (k * 6 + col) * scale, y + row * scale, scale, scale, color);
      }
    }
  }
}

/** A label centred at (x, y), kept inside the image (skipped when `strict` and (x, y) is outside). */
export function drawLabel(img: RGBAImage, p: Point, text: string, color: Color, backdrop: Color = [0, 0, 0, 200], scale = 2, strict = false): void {
  if (strict && (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height)) return;
  const w = textWidth(text.toUpperCase(), scale), h = 8 * scale;
  const x = Math.max(scale, Math.min(img.width - w - scale, Math.round(p.x - w / 2)));
  const y = Math.max(scale, Math.min(img.height - h - scale, Math.round(p.y - h / 2)));
  drawText(img, x, y, text, color, scale, backdrop);
}

export function drawCircle(img: RGBAImage, c: Point, r: number, color: Color, thickness = 2): void {
  const n = Math.max(16, Math.ceil(r));
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) });
  drawPolygon(img, pts, color, thickness);
}

export function drawCross(img: RGBAImage, c: Point, r: number, color: Color, thickness = 2, diagonal = true): void {
  if (diagonal) {
    drawLine(img, { x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y + r }, color, thickness);
    drawLine(img, { x: c.x - r, y: c.y + r }, { x: c.x + r, y: c.y - r }, color, thickness);
  } else {
    drawLine(img, { x: c.x - r, y: c.y }, { x: c.x + r, y: c.y }, color, thickness);
    drawLine(img, { x: c.x, y: c.y - r }, { x: c.x, y: c.y + r }, color, thickness);
  }
}

/** Heat colour for t in 0..1: black → blue → cyan → yellow → red → white. */
export function heat(t: number): Color {
  const stops: [number, number, number][] = [[0, 0, 0], [20, 40, 160], [0, 190, 220], [250, 220, 0], [230, 30, 30], [255, 255, 255]];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, 255];
}

/** Legend / title lines: each line is a list of [text, colour] entries (wrapped to the width). */
export type HeaderLines = [string, Color][][];

/** A band with the header lines above `img` (entries flow onto further lines when too wide). */
export function withHeader(img: RGBAImage, lines: HeaderLines, scale = 2): RGBAImage {
  const placed: { x: number; y: number; text: string; color: Color }[] = [];
  let y = 6;
  const maxX = img.width - 8;
  for (const line of lines) {
    let x = 8;
    for (const [text, color] of line) {
      const words = text.toUpperCase().split(' ');
      let chunk = '';
      const flush = () => {
        if (!chunk) return;
        placed.push({ x, y, text: chunk, color });
        x += textWidth(chunk + ' ', scale);
        chunk = '';
      };
      for (const w of words) {
        const next = chunk ? `${chunk} ${w}` : w;
        if (x + textWidth(next, scale) > maxX && (chunk || x > 8)) {
          flush();
          if (x > 8) { x = 8 + 2 * 6 * scale; y += 10 * scale; }
          chunk = w;
        } else chunk = next;
      }
      flush();
      x += 2 * 6 * scale;
    }
    y += 10 * scale;
  }
  const band = createRGBA(img.width, y + 2, [24, 24, 28, 255]);
  for (const p of placed) drawText(band, p.x, p.y, p.text, p.color, scale);
  return vstack([band, img], 0);
}

/**
 * A rescaled copy of a photo (longest side = `maxSide`, small photos are enlarged up to 2×, crops
 * up to 8×). Geometry is given in photo coordinates and mapped to the view.
 */
export class View {
  readonly image: RGBAImage;
  readonly scale: number;
  private readonly origin: Point;

  /**
   * `crop`: show only this photo rectangle (zoom). `offset`: `photo` already is a crop whose pixel
   * (0, 0) is photo point `offset` (geometry is still given in full-photo coordinates).
   */
  constructor(photo: RGBAImage, opts: { maxSide?: number; crop?: Rect; offset?: Point } = {}) {
    const crop = opts.crop;
    const src = crop ? cropPadded(photo, crop) : photo;
    const maxSide = opts.maxSide ?? 1400;
    this.scale = Math.min(crop || opts.offset ? 8 : 2, maxSide / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * this.scale)), h = Math.max(1, Math.round(src.height * this.scale));
    const zoom = !!(crop || opts.offset);
    this.image = this.scale === 1 ? cropPadded(src, { x: 0, y: 0, width: w, height: h }) : zoom && this.scale > 1 ? resizeNearest(src, w, h, this.scale) : resizeRGBA(src, w, h);
    this.origin = crop ? { x: Math.round(crop.x), y: Math.round(crop.y) } : opts.offset ?? { x: 0, y: 0 };
  }

  /** Photo → view coordinates. */
  map(p: Point): Point {
    return { x: (p.x - this.origin.x + 0.5) * this.scale - 0.5, y: (p.y - this.origin.y + 0.5) * this.scale - 0.5 };
  }

  /** The view with a header band (see {@link withHeader}). */
  render(lines: HeaderLines, scale = 2): RGBAImage {
    return withHeader(this.image, lines, scale);
  }

  polygon(pts: Point[], color: Color, thickness = 2): void {
    if (pts.length >= 2) drawPolygon(this.image, pts.map((p) => this.map(p)), color, thickness);
  }

  line(a: Point, b: Point, color: Color, thickness = 2): void {
    drawLine(this.image, this.map(a), this.map(b), color, thickness);
  }

  label(p: Point, text: string, color: Color, backdrop?: Color, scale = 2, strict = false): void {
    drawLabel(this.image, this.map(p), text, color, backdrop, scale, strict);
  }

  circle(c: Point, rView: number, color: Color, thickness = 2): void {
    drawCircle(this.image, this.map(c), rView, color, thickness);
  }

  cross(c: Point, rView: number, color: Color, thickness = 2, diagonal = true): void {
    drawCross(this.image, this.map(c), rView, color, thickness, diagonal);
  }

}

function cropPadded(img: RGBAImage, r: Rect): RGBAImage {
  const out = createRGBA(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)), [24, 24, 28, 255]);
  const x0 = Math.round(r.x), y0 = Math.round(r.y);
  for (let y = 0; y < out.height; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < out.width; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4, d = (y * out.width + x) * 4;
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = 255;
    }
  }
  return out;
}

/** Nearest-neighbour enlargement (crisp pixels in zooms). */
function resizeNearest(img: RGBAImage, w: number, h: number, scale: number): RGBAImage {
  const out = createRGBA(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const s = (sy * img.width + sx) * 4, d = (y * w + x) * 4;
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = 255;
    }
  }
  return out;
}

/** Place images side by side (top-aligned) with a gap. */
export function hstack(images: RGBAImage[], gap = 8, bg: Color = [24, 24, 28, 255]): RGBAImage {
  const w = images.reduce((a, im) => a + im.width, 0) + gap * Math.max(0, images.length - 1);
  const h = Math.max(...images.map((im) => im.height));
  const out = createRGBA(w, h, bg);
  let x0 = 0;
  for (const im of images) {
    blit(out, im, x0, 0);
    x0 += im.width + gap;
  }
  return out;
}

/** Stack images vertically (left-aligned) with a gap. */
export function vstack(images: RGBAImage[], gap = 8, bg: Color = [24, 24, 28, 255]): RGBAImage {
  const w = Math.max(...images.map((im) => im.width));
  const h = images.reduce((a, im) => a + im.height, 0) + gap * Math.max(0, images.length - 1);
  const out = createRGBA(w, h, bg);
  let y0 = 0;
  for (const im of images) {
    blit(out, im, 0, y0);
    y0 += im.height + gap;
  }
  return out;
}

function blit(dst: RGBAImage, src: RGBAImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const s = y * src.width * 4;
    dst.data.set(src.data.subarray(s, s + src.width * 4), ((y + dy) * dst.width + dx) * 4);
  }
}
