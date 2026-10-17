/**
 * Browser-only image helpers: decode blobs (EXIF-correct) into RGBAImage, encode RGBAImage into
 * JPEG/PNG blobs, canvases, thumbnails and rotated crops for display.
 *
 * Never import this from `src/cv` or `src/pipeline` (they must stay DOM-free).
 */
import type { RGBAImage } from '../cv/image';
import { resizeRGBA } from '../cv/resize';
import { HEADER_BYTES, MAX_CANVAS_AREA, parseImageHeader, stepDownSizes, targetSize, type ImageHeader } from './imageSize';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Largest size (w, h) with the same aspect ratio whose longer side is <= maxSide (never upscales). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxSide || long === 0) return { width, height };
  const s = maxSide / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** A canvas of the given size: OffscreenCanvas when available, otherwise a detached <canvas>. */
export function createCanvas(width: number, height: number, preferDom = false): AnyCanvas {
  if (!preferDom && typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * Free a canvas' backing store right away (iOS Safari caps the total canvas memory of a page and
 * only reclaims it lazily otherwise).
 */
export function releaseCanvas(canvas: AnyCanvas | undefined | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function context2d(canvas: AnyCanvas, opts?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = canvas.getContext('2d', opts) as Ctx2D | null;
  if (!ctx) throw new Error('Canvas 2D context is not available');
  return ctx;
}

/** View an RGBAImage as DOM ImageData (no copy when the buffer is a plain ArrayBuffer). */
export function toImageData(img: RGBAImage): ImageData {
  const data =
    img.data.buffer instanceof ArrayBuffer
      ? (img.data as Uint8ClampedArray<ArrayBuffer>)
      : new Uint8ClampedArray(img.data);
  return new ImageData(data, img.width, img.height);
}

function imageDataToRGBA(id: ImageData): RGBAImage {
  return { width: id.width, height: id.height, data: id.data };
}

async function decodeWithImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The decoded image stays usable after the URL is revoked.
    URL.revokeObjectURL(url);
  }
}

const UNREADABLE = 'This file could not be opened as a photo. Try a JPEG or PNG image.';
const HEIC_UNSUPPORTED =
  'This browser cannot open HEIC photos. Use Safari, choose “Most Compatible” in the iPhone camera settings, or upload a JPEG.';

/** Thrown when a file is not a decodable image; `message` is user-presentable. */
export class UnreadableImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableImageError';
  }
}

/**
 * Draw `source` (sw × sh) into a new canvas of tw × th and read the pixels back. Large reductions
 * go through halving steps for quality; every canvas stays within the iOS canvas area limit and is
 * released immediately.
 */
function drawToRGBA(source: CanvasImageSource, sw: number, sh: number, tw: number, th: number): RGBAImage {
  let src: CanvasImageSource = source;
  let cur = { width: sw, height: sh };
  let prev: AnyCanvas | undefined;
  const steps = stepDownSizes(cur, { width: tw, height: th });
  if (steps.length === 0) steps.push({ width: tw, height: th });
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const last = i === steps.length - 1;
    const canvas = createCanvas(s.width, s.height);
    const ctx = context2d(canvas, last ? { willReadFrequently: true } : undefined);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cur.width, cur.height, 0, 0, s.width, s.height);
    releaseCanvas(prev);
    if (last) {
      const out = imageDataToRGBA(ctx.getImageData(0, 0, s.width, s.height));
      releaseCanvas(canvas);
      return out;
    }
    prev = canvas;
    src = canvas;
    cur = s;
  }
  throw new Error('unreachable');
}

/** createImageBitmap with built-in resizing, or undefined when the browser can't do it exactly. */
async function decodeResized(blob: Blob, tw: number, th: number): Promise<ImageBitmap | undefined> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
    if (bmp.width === tw && bmp.height === th) return bmp;
    bmp.close();
  } catch {
    // Options not supported – use the <img> path.
  }
  return undefined;
}

/**
 * Decode an image file/blob into an RGBAImage, applying the EXIF orientation of phone photos and
 * limiting the longer side to `maxSide` pixels and the area to {@link MAX_CANVAS_AREA}.
 *
 * A full-size canvas is never allocated: the size is read from the file header and the browser
 * decodes straight to the target size (createImageBitmap resize) where it can; otherwise an <img>
 * (which honours EXIF orientation everywhere) is drawn into a target-size canvas in halving steps.
 * Throws {@link UnreadableImageError} for files the browser can't decode (e.g. HEIC outside Safari).
 */
export async function blobToRGBA(blob: Blob, maxSide = 4096, maxArea = MAX_CANVAS_AREA): Promise<RGBAImage> {
  let header: ImageHeader = { format: 'unknown', orientation: 1 };
  try {
    header = parseImageHeader(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
  } catch {
    // Unreadable header: let the browser try.
  }
  // Fast path: size known, no EXIF rotation → decode directly at the target size.
  if (header.width && header.height && header.orientation === 1 && typeof createImageBitmap === 'function') {
    const t = targetSize(header.width, header.height, maxSide, maxArea);
    const bmp = await decodeResized(blob, t.width, t.height);
    if (bmp) {
      try {
        return drawToRGBA(bmp, bmp.width, bmp.height, bmp.width, bmp.height);
      } finally {
        bmp.close();
      }
    }
  }
  let img: HTMLImageElement;
  try {
    img = await decodeWithImageElement(blob);
  } catch {
    throw new UnreadableImageError(header.format === 'heic' ? HEIC_UNSUPPORTED : UNREADABLE);
  }
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) throw new UnreadableImageError(UNREADABLE);
  const t = targetSize(sw, sh, maxSide, maxArea);
  try {
    return drawToRGBA(img, sw, sh, t.width, t.height);
  } finally {
    img.src = '';
  }
}

/**
 * Encode an RGBAImage (JPEG by default). Images above the canvas area limit are first reduced in
 * pure TS so encoding also works on iOS.
 */
export async function rgbaToBlob(img: RGBAImage, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  let src = img;
  if (img.width * img.height > MAX_CANVAS_AREA) {
    const t = targetSize(img.width, img.height, Infinity);
    src = resizeRGBA(img, t.width, t.height);
  }
  const canvas = createCanvas(src.width, src.height);
  try {
    const ctx = context2d(canvas);
    ctx.putImageData(toImageData(src), 0, 0);
    return await canvasToBlob(canvas, type, quality);
  } finally {
    releaseCanvas(canvas);
  }
}

export async function canvasToBlob(canvas: AnyCanvas, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality);
  });
}

/** A DOM <canvas> holding the image (for display or as a drawImage source). */
export function rgbaToCanvas(img: RGBAImage): HTMLCanvasElement {
  const canvas = createCanvas(img.width, img.height, true) as HTMLCanvasElement;
  context2d(canvas).putImageData(toImageData(img), 0, 0);
  return canvas;
}

/** ImageBitmap of an RGBAImage – a cheap drawImage source for crops and loupes. */
export function rgbaToBitmap(img: RGBAImage): Promise<ImageBitmap> {
  return createImageBitmap(toImageData(img));
}

/** Small JPEG (longer side <= maxSide) for lists and cards. */
export async function makeThumbnail(img: RGBAImage, maxSide = 320): Promise<Blob> {
  const { width, height } = fitWithin(img.width, img.height, maxSide);
  const bitmap = await rgbaToBitmap(img);
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  try {
    return await canvasToBlob(canvas, 'image/jpeg', 0.85);
  } finally {
    releaseCanvas(canvas);
  }
}

// ---------------------------------------------------------------------------------------------
// Object URLs and downloads
// ---------------------------------------------------------------------------------------------

export function createObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function revokeObjectUrl(url: string | undefined): void {
  if (url) URL.revokeObjectURL(url);
}

/** Offer a blob as a file download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------------------------
// Crops for display
// ---------------------------------------------------------------------------------------------

export interface RotatedCropOptions {
  /** Center of the crop in source pixels. */
  cx: number;
  cy: number;
  /** Side length of the (square) crop in source pixels. */
  side: number;
  /**
   * Clockwise rotation (degrees) applied to the crop when drawn. To show a reference crop the way a
   * piece lies in the photo, pass `-placement.rotationDeg`.
   */
  rotationDeg?: number;
  /** Background for areas outside the source. */
  background?: string;
}

/**
 * Draw a square crop of `source` into the whole of `canvas`, rotated about its center. The source
 * area sampled is large enough that the rotated output has no empty corners (unless the source
 * itself ends).
 */
export function drawRotatedCrop(canvas: AnyCanvas, source: CanvasImageSource, opts: RotatedCropOptions): void {
  const ctx = context2d(canvas);
  const out = Math.min(canvas.width, canvas.height);
  const scale = out / opts.side;
  ctx.save();
  ctx.fillStyle = opts.background ?? '#00000000';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (opts.background) ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(((opts.rotationDeg ?? 0) * Math.PI) / 180);
  ctx.scale(scale, scale);
  // Sample a larger area (side * sqrt 2) so rotated corners are filled.
  const half = (opts.side * Math.SQRT2) / 2;
  ctx.drawImage(source, opts.cx - half, opts.cy - half, half * 2, half * 2, -half, -half, half * 2, half * 2);
  ctx.restore();
}

/** Draw an axis-aligned crop of `source` (source rect) scaled to fit `canvas` (letterboxed). */
export function drawCrop(
  canvas: AnyCanvas,
  source: CanvasImageSource,
  rect: { x: number; y: number; width: number; height: number },
  background?: string,
): void {
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const s = Math.min(canvas.width / rect.width, canvas.height / rect.height);
  const w = rect.width * s;
  const h = rect.height * s;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

/** Downscaled copy of an RGBAImage drawn from a canvas source (fast, uses the GPU path). */
export function sourceToRGBA(source: CanvasImageSource, sw: number, sh: number, maxSide: number): RGBAImage {
  const { width, height } = fitWithin(sw, sh, maxSide);
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas, { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const out = imageDataToRGBA(ctx.getImageData(0, 0, width, height));
  releaseCanvas(canvas);
  return out;
}

/** True for errors thrown when IndexedDB/storage quota is exhausted. */
export function isQuotaError(e: unknown): boolean {
  if (e instanceof DOMException) return e.name === 'QuotaExceededError' || e.code === 22;
  if (e instanceof Error) return /quota/i.test(e.name) || /quota/i.test(e.message);
  return false;
}
