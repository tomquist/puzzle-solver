/**
 * End-to-end with the REAL pipeline (Web Worker): generated box photo → setup wizard → generated
 * pieces photo → results must place the pieces in their true cells; data survives a reload.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import type { RGBAImage } from '../../src/cv/image';
import { loadTestAsset } from '../../src/testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderBoxPhoto, renderPiecesPhoto, Rng } from '../../src/testing/synth';

const ROWS = 16;
const COLS = 20;

function writePng(path: string, img: RGBAImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(path, PNG.sync.write(png));
}

interface Fixtures {
  boxPath: string;
  piecesPath: string;
  /** "row R, column C" (1-based, as the UI writes it) of every rendered piece. */
  truthCells: string[];
}

function makeFixtures(dir: string): Fixtures {
  mkdirSync(dir, { recursive: true });
  const painting = loadTestAsset('starry-night');
  const box = renderBoxPhoto(perturbReference(painting, { seed: 4 }), { seed: 4, width: 1800, height: 1350 });
  const cut = generateJigsaw(ROWS, COLS, painting.width, painting.height, 11);
  const rng = new Rng(99);
  const items = rng.shuffle(cut.pieces.map((p) => p.index)).slice(0, 12);
  const { photo, truth } = renderPiecesPhoto(painting, cut, items, {
    seed: 12,
    background: [36, 38, 44],
    noiseSigma: 3,
    blurSigma: 0.7,
    gain: [1.05, 0.97, 0.94],
    illumination: 0.1,
  });
  const boxPath = join(dir, 'box.png');
  const piecesPath = join(dir, 'pieces.png');
  writePng(boxPath, box.photo);
  writePng(piecesPath, photo);
  return { boxPath, piecesPath, truthCells: truth.map((t) => `row ${t.row + 1}, column ${t.col + 1}`) };
}

test('real pipeline: set up from a box photo, scan pieces, find their places', async ({ page }, info) => {
  test.skip(!['desktop', 'iphone-13'].includes(info.project.name), 'pipeline e2e runs on desktop Chromium and iPhone WebKit');
  test.setTimeout(240_000);
  const fx = makeFixtures(info.outputPath('fixtures'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByRole('link', { name: 'New puzzle' }).first().click();
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  await page.getByTestId('photo-upload').setInputFiles(fx.boxPath);

  // Corners are auto-detected by the worker.
  await expect(page.getByTestId('wizard-corners')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('corner-0')).toBeVisible();
  await page.screenshot({ path: '.debug/e2e/real-01-corners.png' });
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByTestId('wizard-details')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Starry e2e');
  await page.locator('#pieces').fill(String(ROWS * COLS));
  await page.getByRole('button', { name: 'Custom' }).click();
  await page.getByRole('spinbutton', { name: 'Columns' }).fill(String(COLS));
  await page.getByRole('spinbutton', { name: 'Rows' }).fill(String(ROWS));
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByTestId('wizard-reference')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: '.debug/e2e/real-02-reference.png' });
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible({ timeout: 60_000 });

  // Scan the pieces photo with the real worker.
  await page.getByTestId('photo-upload').setInputFiles(fx.piecesPath);
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: '.debug/e2e/real-03-result.png', fullPage: true });

  const items = page.locator('[data-testid^="piece-item-"]');
  await expect(items).toHaveCount(fx.truthCells.length);
  const texts = await page.locator('.piece-item-where').allTextContents();
  const found = new Set(texts.map((t) => t.match(/row \d+, column \d+/)?.[0]).filter(Boolean));
  const correct = fx.truthCells.filter((c) => found.has(c)).length;
  console.log(`real pipeline e2e: ${correct}/${fx.truthCells.length} pieces placed in their true cell`);
  expect(correct / fx.truthCells.length).toBeGreaterThanOrEqual(0.8);

  // Persistence: the scan is still there after a reload.
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 30_000 });
  await expect(items).toHaveCount(fx.truthCells.length);
  expect(errors).toEqual([]);
});
