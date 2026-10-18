/**
 * Decode feedback images the way the app does in Chrome (src/platform/imageio.ts decodeExact:
 * createImageBitmap and one 1:1 drawImage), in Playwright's Chromium. Chrome's JPEG decoder
 * (libjpeg-turbo, smooth chroma upsampling) differs from jpeg-js by about one level on average and
 * up to ~25 at colour edges, enough to change segmentation; with this decoder a replay of a file
 * from a Chrome phone sees exactly the pixels the app analysed (for scans from app builds that
 * analyse the stored JPEG). Safari decodes differently again.
 */
import { chromium, type Browser } from '@playwright/test';
import type { RGBAImage } from '../../src/cv/image';
import type { FeedbackImage } from '../../src/feedback/format';

export interface ChromiumDecoder {
  decode(img: FeedbackImage): Promise<RGBAImage>;
  close(): Promise<void>;
}

/** A Chromium-backed decoder, or null when no Chromium can be launched here. */
export async function chromiumDecoder(): Promise<ChromiumDecoder | null> {
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch {
    return null;
  }
  const page = await browser.newPage();
  return {
    async decode(img) {
      const b64 = await page.evaluate(async ({ type, base64 }) => {
        const blob = await (await fetch(`data:${type};base64,${base64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        bmp.close();
        let s = '';
        for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
        return btoa(s);
      }, { type: img.type, base64: img.base64 });
      const data = new Uint8ClampedArray(Buffer.from(b64, 'base64'));
      if (data.length !== img.width * img.height * 4) throw new Error(`Chromium decoded ${data.length / 4} px, expected ${img.width}x${img.height}`);
      return { width: img.width, height: img.height, data };
    },
    close: () => browser.close(),
  };
}

/** True for files sent from a Chromium-engine browser (Chrome, Edge, … but not on iOS, where WebKit decodes). */
export const fromChromium = (userAgent: string): boolean => /Chrome\//.test(userAgent) && !/iPhone|iPad|iPod|CriOS/.test(userAgent);
