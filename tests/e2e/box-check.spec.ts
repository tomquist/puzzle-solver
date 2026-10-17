/**
 * Real pipeline (Web Worker): a box photo whose picture is cut off by the photo edge must make the
 * corners step ask the user to check the corners; candidate labels are shown in plain words.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { cropRGBA, type RGBAImage } from '../../src/cv/image';
import { loadTestAsset } from '../../src/testing/nodeImageIO';
import { perturbReference, renderBoxPhoto } from '../../src/testing/synth';

function writePng(path: string, img: RGBAImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(path, PNG.sync.write(png));
}

test('cut-off box photo: the corners step asks to check the corners', async ({ page }, info) => {
  test.setTimeout(180_000);
  const dir = info.outputPath('fixtures');
  mkdirSync(dir, { recursive: true });
  const box = renderBoxPhoto(perturbReference(loadTestAsset('great-wave'), { seed: 7 }), { seed: 7, width: 1600, height: 1200 });
  // Cut away the top-left corner region of the picture (15 % of its width and height), so the
  // picture runs out of the photo at two sides.
  const xs = box.pictureQuad.map((p) => p.x);
  const ys = box.pictureQuad.map((p) => p.y);
  const cx = Math.round(Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * 0.15);
  const cy = Math.round(Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * 0.15);
  const photoPath = join(dir, 'cut-box.png');
  writePng(photoPath, cropRGBA(box.photo, { x: cx, y: cy, width: box.photo.width - cx, height: box.photo.height - cy }));

  await page.goto('/#/new');
  await page.getByTestId('photo-upload').setInputFiles(photoPath);
  await expect(page.getByTestId('wizard-corners')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Please check the corners')).toBeVisible();
  await page.screenshot({ path: '.debug/e2e/box-cut-off-corners.png' });
  // Candidate buttons use friendly names, never raw ids like "lid" or "frame-inner".
  const next = page.getByRole('button', { name: /^Next: / });
  if (await next.count()) await expect(next).toHaveText(/Next: (Picture|Whole lid|Inside the frame|Alternative|Whole photo)$/);
});
