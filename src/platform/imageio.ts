/**
 * Browser-only image helpers: decode blobs (EXIF-correct) into RGBAImage, encode RGBAImage into
 * JPEG/PNG blobs, canvases, thumbnails and rotated crops for display.
 *
 * Never import this from `src/cv` or `src/pipeline` (they must stay DOM-free).
 */
import type { RGBAImage } from '../cv/image';

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

/**
 * Decode an image file/blob into an RGBAImage, applying the EXIF orientation of phone photos and
 * limiting the longer side to `maxSide` pixels.
 */
export async function blobToRGBA(blob: Blob, maxSide = 4096): Promise<RGBAImage> {
  let source: ImageBitmap | HTMLImageElement;
  let sw: number;
  let sh: number;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    source = bitmap;
    sw = bitmap.width;
    sh = bitmap.height;
  } catch {
    // Older browsers: <img> applies EXIF orientation by default (CSS image-orientation: from-image).
    let img: HTMLImageElement;
    try {
      img = await decodeWithImageElement(blob);
    } catch {
      throw new Error(UNREADABLE);
    }
    source = img;
    sw = img.naturalWidth;
    sh = img.naturalHeight;
  }
  if (!sw || !sh) throw new Error(UNREADABLE);
  const { width, height } = fitWithin(sw, sh, maxSide);
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  bitmap?.close();
  return imageDataToRGBA(ctx.getImageData(0, 0, width, height));
}

/** Encode an RGBAImage (JPEG by default). */
export async function rgbaToBlob(img: RGBAImage, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  const canvas = createCanvas(img.width, img.height);
  const ctx = context2d(canvas);
  ctx.putImageData(toImageData(img), 0, 0);
  return canvasToBlob(canvas, type, quality);
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
  return canvasToBlob(canvas, 'image/jpeg', 0.85);
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
  return imageDataToRGBA(ctx.getImageData(0, 0, width, height));
}

/** True for errors thrown when IndexedDB/storage quota is exhausted. */
export function isQuotaError(e: unknown): boolean {
  if (e instanceof DOMException) return e.name === 'QuotaExceededError' || e.code === 22;
  if (e instanceof Error) return /quota/i.test(e.name) || /quota/i.test(e.message);
  return false;
}
