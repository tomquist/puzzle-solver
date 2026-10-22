/**
 * Live glare warning and capture tips (Chromium's fake camera playing a generated video: loose
 * pieces on a dark cloth, several of them reflecting a lamp). The real pipeline's assessFrame
 * finds the glare in the live meter; with the torch on (a stubbed torch – the fake camera has
 * none) the meter says to turn it off and offers the button. The pieces tips have "More tips".
 * Screenshots (light and dark) go to $UX_SHOTS (default .debug/ui).
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RGBAImage } from '../../src/cv/image';
import { resizeRGBA } from '../../src/cv/resize';
import { addGlare } from '../../src/pipeline/pieces/testkit';
import { loadTestAsset } from '../../src/testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto } from '../../src/testing/synth';
import { auditPage, formatViolations } from './audit';

const SHOTS = process.env.UX_SHOTS ?? '.debug/ui';
const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));

/**
 * A few frames of raw YUV 4:2:0 video (Y4M, BT.601 limited range – what Chromium's file capture
 * device expects) showing `img`.
 */
function y4m(img: RGBAImage, frames = 4): Buffer {
  const { width: w, height: h, data: d } = img;
  const y = Buffer.alloc(w * h);
  const u = Buffer.alloc((w / 2) * (h / 2));
  const v = Buffer.alloc((w / 2) * (h / 2));
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  for (let i = 0; i < w * h; i++) y[i] = clamp(16 + (219 / 255) * (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]));
  for (let by = 0; by < h / 2; by++) {
    for (let bx = 0; bx < w / 2; bx++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const p = ((2 * by + dy) * w + 2 * bx + dx) * 4;
        r += d[p] / 4;
        g += d[p + 1] / 4;
        b += d[p + 2] / 4;
      }
      u[by * (w / 2) + bx] = clamp(128 + (224 / 255) * (-0.168736 * r - 0.331264 * g + 0.5 * b));
      v[by * (w / 2) + bx] = clamp(128 + (224 / 255) * (0.5 * r - 0.418688 * g - 0.081312 * b));
    }
  }
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), y, u, v);
  return Buffer.concat(parts);
}

/** Loose Starry Night pieces on a dark cloth, six of them with a lamp's reflection. */
function glareVideo(): string {
  const ref = resizeRGBA(loadTestAsset('starry-night'), 800, 634);
  const cut = generateJigsaw(8, 10, ref.width, ref.height, 10);
  const items = Array.from({ length: 16 }, (_, i) => (i * 5 + 3) % 80);
  const { photo, truth } = renderPiecesPhoto(ref, cut, items, { seed: 3, background: [38, 42, 50], noiseSigma: 2.5, illumination: 0.1, scale: 1.4 });
  const frame = resizeRGBA(addGlare(photo, truth.slice(0, 6), 0.3, 5), 640, 480);
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../.debug/fake-camera/glare.y4m');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, y4m(frame));
  return path;
}

test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${glareVideo()}`] },
});

/** The fake camera has no torch: report one and accept turning it on and off. */
async function stubTorch(page: Page) {
  await page.addInitScript(() => {
    const caps = MediaStreamTrack.prototype.getCapabilities;
    MediaStreamTrack.prototype.getCapabilities = function () {
      return { ...(caps ? caps.call(this) : {}), torch: true } as MediaTrackCapabilities;
    };
    const apply = MediaStreamTrack.prototype.applyConstraints;
    MediaStreamTrack.prototype.applyConstraints = function (c?: MediaTrackConstraints) {
      if (c?.advanced?.some((a) => 'torch' in a)) return Promise.resolve();
      return apply.call(this, c);
    };
  });
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.waitForTimeout(300);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the live meter warns about glare and, with the torch on, offers to turn it off', async ({ page }, info) => {
  await stubTorch(page);
  // The real pipeline (no ?pipeline=mock): assessFrame in the worker.
  await page.goto('/#/new');
  await expect(page.locator('video.camera-video')).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  const meter = page.getByTestId('camera-meter');
  await expect(meter).toHaveAttribute('data-problem', 'glare', { timeout: 30_000 });
  await expect(meter).toContainText('Glare – move the light or tilt the lamp');
  await expect(page.getByTestId('glare-torch-off')).toHaveCount(0);
  await shot(page, info, 'glare-meter');

  // Torch on: the meter names the cause and offers the fix.
  await page.getByRole('button', { name: 'Torch on' }).click();
  await expect(meter).toContainText('Glare – turn the torch off');
  await expect(page.getByTestId('glare-torch-off')).toBeVisible();
  await shot(page, info, 'glare-torch');
  const vs = await auditPage(page);
  expect.soft(vs, formatViolations(vs)).toEqual([]);
  await page.getByTestId('glare-torch-off').click();
  await expect(page.getByRole('button', { name: 'Torch on' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('glare-torch-off')).toHaveCount(0);
  await expect(meter).toContainText('Glare – move the light or tilt the lamp');
});

test('piece-scan tips: short, with more tips on glare, the cloth and the lens', async ({ page }, info) => {
  await page.goto('/?pipeline=mock#/new');
  // The camera starts by itself (permission granted): upload once it is live, not while the
  // capture card is being swapped for the preview.
  await expect(page.locator('video.camera-video')).toBeVisible();
  await page.getByTestId('photo-upload').setInputFiles(asset('great-wave.jpg'));
  await expect(page.getByTestId('wizard-corners')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: '1000', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();

  // Live camera: the tips over the preview, "More tips" closed until asked for.
  const tips = page.getByTestId('camera-tips');
  await expect(tips).toBeVisible();
  await expect(tips).toContainText('Photograph loose pieces');
  const more = tips.getByTestId('more-tips');
  await expect(more.getByText('A matte cloth in a colour unlike the puzzle')).toBeHidden();
  await more.getByText('More tips').click();
  await expect(more.getByText('Glare? Flash and torch off; a lamp from the side, not from above')).toBeVisible();
  await expect(more.getByText('A matte cloth in a colour unlike the puzzle')).toBeVisible();
  await expect(more).toContainText('2× lens');
  await shot(page, info, 'tips-live');
  const vs = await auditPage(page);
  expect.soft(vs, formatViolations(vs)).toEqual([]);

  // Without the live camera: the same tips on the capture card.
  await page.getByRole('button', { name: 'Close camera' }).click();
  const card = page.locator('.capture-card');
  await expect(card).toContainText('Photograph loose pieces');
  await card.getByTestId('more-tips').getByText('More tips').click();
  await expect(card.getByText('A matte cloth in a colour unlike the puzzle')).toBeVisible();
  await shot(page, info, 'tips-card');
});
