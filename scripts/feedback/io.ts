/**
 * Node-side reading and writing of feedback files (see src/feedback/format.ts): JSON parsing plus
 * JPEG / PNG decoding of the embedded images with jpeg-js / pngjs.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RGBAImage } from '../../src/cv/image';
import { decodeFeedbackImageBytes, encodeFeedbackImage, parseFeedback, type FeedbackBundle, type FeedbackImage } from '../../src/feedback/format';

/** Read and validate a feedback file (throws FeedbackFormatError for anything else). */
export function readFeedbackFile(path: string): FeedbackBundle {
  return parseFeedback(readFileSync(path, 'utf8'));
}

/** Decode an embedded image (JPEG, PNG; anything else is tried as JPEG). */
export function decodeFeedbackImage(img: FeedbackImage): RGBAImage {
  const bytes = decodeFeedbackImageBytes(img);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const isPng = img.type === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50);
  if (isPng) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
  }
  const raw = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length) };
}

/** Encode an image for a feedback file (JPEG like the app, or lossless PNG). */
export function encodeImageForFeedback(img: RGBAImage, type: 'image/jpeg' | 'image/png' = 'image/jpeg', quality = 90): FeedbackImage {
  let bytes: Uint8Array;
  if (type === 'image/png') {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    bytes = PNG.sync.write(png);
  } else {
    const data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    bytes = jpeg.encode({ width: img.width, height: img.height, data }, quality).data;
  }
  return encodeFeedbackImage(bytes, type, img.width, img.height);
}
