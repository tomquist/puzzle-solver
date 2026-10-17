import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { clipDrawRects, MAX_CANVAS_AREA, orientedSize, parseImageHeader, stepDownSizes, targetSize } from './imageSize';

function jpegBytes(width: number, height: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4, 128);
  return new Uint8Array(jpeg.encode({ data, width, height }, 80).data);
}

/** Insert an APP1 EXIF segment with the given orientation right after SOI. */
function withExif(jpg: Uint8Array, orientation: number, little = true): Uint8Array {
  const tiff: number[] = [];
  const w16 = (v: number) => (little ? tiff.push(v & 255, v >> 8) : tiff.push(v >> 8, v & 255));
  const w32 = (v: number) => (little ? tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24) : tiff.push(v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255));
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]));
  w16(42);
  w32(8); // IFD0 offset
  w16(2); // entries
  // Make tag (ignored)
  w16(0x010f); w16(2); w32(4); tiff.push(65, 66, 67, 0);
  // Orientation (SHORT, count 1)
  w16(0x0112); w16(3); w32(1); w16(orientation); w16(0);
  w32(0); // next IFD
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = payload.length + 2;
  const seg = [0xff, 0xe1, len >> 8, len & 255, ...payload];
  return new Uint8Array([...jpg.slice(0, 2), ...seg, ...jpg.slice(2)]);
}

describe('targetSize', () => {
  it('limits the longer side and never upscales', () => {
    expect(targetSize(8064, 6048, 4096)).toMatchObject({ width: 4096, height: 3072 });
    expect(targetSize(1280, 870, 4096)).toEqual({ width: 1280, height: 870, scale: 1 });
    expect(targetSize(6048, 8064, 2400)).toMatchObject({ width: 1800, height: 2400 });
  });

  it('respects the iOS canvas area limit', () => {
    const t = targetSize(8064, 6048, 100_000);
    expect(t.width * t.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    expect(t.width / t.height).toBeCloseTo(8064 / 6048, 2);
    // A panorama: long side within maxSide but area too big.
    const p = targetSize(16000, 4000, 16384);
    expect(p.width * p.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    expect(p.width).toBeLessThanOrEqual(16384);
  });

  it('handles degenerate input', () => {
    expect(targetSize(0, 10, 100)).toEqual({ width: 0, height: 0, scale: 0 });
    expect(targetSize(10_000, 1, 100)).toMatchObject({ width: 100, height: 1 });
  });
});

describe('orientation', () => {
  it('swaps sizes for rotated EXIF orientations', () => {
    expect(orientedSize(4032, 3024, 1)).toEqual({ width: 4032, height: 3024 });
    expect(orientedSize(4032, 3024, 3)).toEqual({ width: 4032, height: 3024 });
    for (const o of [5, 6, 7, 8]) expect(orientedSize(4032, 3024, o)).toEqual({ width: 3024, height: 4032 });
  });
});

describe('stepDownSizes', () => {
  it('halves until within 2.5× of the target and ends at the target', () => {
    const steps = stepDownSizes({ width: 8064, height: 6048 }, { width: 1000, height: 750 });
    expect(steps.map((s) => s.width)).toEqual([4032, 2016, 1000]);
    expect(steps[steps.length - 1]).toEqual({ width: 1000, height: 750 });
  });
  it('is a single step for small reductions and empty when nothing shrinks', () => {
    expect(stepDownSizes({ width: 1500, height: 1000 }, { width: 1000, height: 667 })).toEqual([{ width: 1000, height: 667 }]);
    expect(stepDownSizes({ width: 100, height: 100 }, { width: 100, height: 100 })).toEqual([]);
  });
  it('keeps every intermediate within the canvas area limit', () => {
    const steps = stepDownSizes({ width: 20000, height: 15000 }, { width: 1000, height: 750 });
    for (const s of steps) expect(s.width * s.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
  });
});

describe('parseImageHeader', () => {
  it('reads JPEG size without EXIF', () => {
    expect(parseImageHeader(jpegBytes(30, 20))).toEqual({ format: 'jpeg', width: 30, height: 20, orientation: 1 });
  });
  it('reads JPEG EXIF orientation (both byte orders)', () => {
    expect(parseImageHeader(withExif(jpegBytes(30, 20), 6))).toEqual({ format: 'jpeg', width: 30, height: 20, orientation: 6 });
    expect(parseImageHeader(withExif(jpegBytes(30, 20), 8, false)).orientation).toBe(8);
  });
  it('reads PNG, GIF and WebP sizes', () => {
    const png = new PNG({ width: 17, height: 9 });
    expect(parseImageHeader(new Uint8Array(PNG.sync.write(png)))).toEqual({ format: 'png', width: 17, height: 9, orientation: 1 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0xc8, 0x00]);
    expect(parseImageHeader(gif)).toMatchObject({ format: 'gif', width: 300, height: 200 });
    const vp8x = new Uint8Array(30);
    vp8x.set([0x52, 0x49, 0x46, 0x46], 0);
    vp8x.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
    vp8x.set([0x3f, 0x1f, 0x00, 0xff, 0x0f, 0x00], 24); // 8000 × 4096
    expect(parseImageHeader(vp8x)).toMatchObject({ format: 'webp', width: 8000, height: 4096 });
  });
  it('recognises HEIC / AVIF and unknown data', () => {
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(parseImageHeader(heic).format).toBe('heic');
    const avif = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(parseImageHeader(avif).format).toBe('avif');
    expect(parseImageHeader(new TextEncoder().encode('not an image')).format).toBe('unknown');
  });
});

describe('clipDrawRects', () => {
  it('keeps rectangles that are inside the source', () => {
    const r = { sx: 10, sy: 10, sw: 50, sh: 50, dx: 0, dy: 0, dw: 100, dh: 100 };
    expect(clipDrawRects(r, 200, 200)).toEqual(r);
  });
  it('clips at the top-left and shifts the destination', () => {
    expect(clipDrawRects({ sx: -20, sy: -10, sw: 100, sh: 100, dx: 0, dy: 0, dw: 200, dh: 200 }, 1000, 1000)).toEqual({
      sx: 0, sy: 0, sw: 80, sh: 90, dx: 40, dy: 20, dw: 160, dh: 180,
    });
  });
  it('clips at the bottom-right', () => {
    expect(clipDrawRects({ sx: 950, sy: 900, sw: 100, sh: 200, dx: 5, dy: 5, dw: 100, dh: 100 }, 1000, 1000)).toEqual({
      sx: 950, sy: 900, sw: 50, sh: 100, dx: 5, dy: 5, dw: 50, dh: 50,
    });
  });
  it('returns null when nothing is visible', () => {
    expect(clipDrawRects({ sx: -200, sy: 0, sw: 100, sh: 100, dx: 0, dy: 0, dw: 10, dh: 10 }, 100, 100)).toBeNull();
  });
});
