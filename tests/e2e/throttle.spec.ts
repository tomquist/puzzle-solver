/**
 * Slow phone: the REAL pipeline (Web Worker) with Chromium's CPU throttled 4× (CDP
 * Emulation.setCPUThrottlingRate). While a scan is analysed, progress messages must keep updating,
 * the UI must react to a tab tap within ~300 ms, and the scan must finish. Timings are written to
 * .debug/mobile/slow-phone.json.
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
const THROTTLE = 4;

function writePng(path: string, img: RGBAImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(path, PNG.sync.write(png));
}

function makeFixtures(dir: string): { boxPath: string; piecesPath: string } {
  mkdirSync(dir, { recursive: true });
  const painting = loadTestAsset('starry-night');
  const box = renderBoxPhoto(perturbReference(painting, { seed: 4 }), { seed: 4, width: 1800, height: 1350 });
  const cut = generateJigsaw(ROWS, COLS, painting.width, painting.height, 11);
  const items = new Rng(99).shuffle(cut.pieces.map((p) => p.index)).slice(0, 12);
  const { photo } = renderPiecesPhoto(painting, cut, items, { seed: 12, background: [36, 38, 44], noiseSigma: 3, blurSigma: 0.7 });
  const boxPath = join(dir, 'box.png');
  const piecesPath = join(dir, 'pieces.png');
  writePng(boxPath, box.photo);
  writePng(piecesPath, photo);
  return { boxPath, piecesPath };
}

interface Probe {
  progress: { t: number; text: string }[];
  maxGap: number;
  tapLatency?: number;
}

test('slow phone: progress updates, UI stays responsive, scan finishes', async ({ page }, info) => {
  test.setTimeout(420_000);
  const fx = makeFixtures(info.outputPath('fixtures'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // --- set up the puzzle at normal speed (real worker)
  await page.goto('/');
  await page.getByRole('link', { name: 'New puzzle' }).first().click();
  await page.getByTestId('photo-upload').setInputFiles(fx.boxPath);
  await expect(page.getByTestId('wizard-corners')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#pieces').fill(String(ROWS * COLS));
  await page.getByRole('button', { name: 'Custom' }).click();
  await page.getByRole('spinbutton', { name: 'Columns' }).fill(String(COLS));
  await page.getByRole('spinbutton', { name: 'Rows' }).fill(String(ROWS));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('wizard-reference')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible({ timeout: 60_000 });
  // Wait until the matcher is ready so we time the scan itself.
  await expect(page.getByText('Preparing the puzzle picture for matching…')).toBeHidden({ timeout: 120_000 });

  // --- throttle and instrument
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await page.evaluate(() => {
    const probe: Probe = { progress: [], maxGap: 0 };
    (window as unknown as { __probe: Probe }).__probe = probe;
    // Progress label changes.
    let last = '';
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid=analysing] .progress-head span');
      const text = el?.textContent ?? '';
      if (text && text !== last) {
        last = text;
        probe.progress.push({ t: performance.now(), text });
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    // Main-thread stalls (longest gap between 50 ms ticks).
    let prev = performance.now();
    setInterval(() => {
      const now = performance.now();
      probe.maxGap = Math.max(probe.maxGap, now - prev);
      prev = now;
    }, 50);
    // Tap → route change latency (pointerdown timestamp to hashchange handled).
    let down = 0;
    document.addEventListener('pointerdown', (e) => (down = e.timeStamp), true);
    window.addEventListener('hashchange', () => {
      if (down) probe.tapLatency = performance.now() - down;
    });
  });

  const t0 = Date.now();
  await page.getByTestId('photo-upload').setInputFiles(fx.piecesPath);
  await expect(page.getByTestId('analysing')).toBeVisible({ timeout: 30_000 });
  // Wait until the worker is busy matching, then tap another tab.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __probe: Probe }).__probe.progress.length), { timeout: 120_000 }).toBeGreaterThanOrEqual(3);
  const tapStart = Date.now();
  await page.getByRole('link', { name: 'Picture' }).click();
  await expect(page.getByTestId('tab-picture')).toBeVisible();
  const tapToVisible = Date.now() - tapStart;

  // The analysis continues in the worker and opens the result when done.
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 300_000 });
  const scanMs = Date.now() - t0;
  const probe = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const distinct = new Set(probe.progress.map((p) => p.text));
  const report = {
    throttle: THROTTLE,
    scanMs,
    progressUpdates: probe.progress.length,
    distinctMessages: [...distinct],
    progressSpanMs: probe.progress.length ? Math.round(probe.progress[probe.progress.length - 1].t - probe.progress[0].t) : 0,
    tapLatencyMs: probe.tapLatency !== undefined ? Math.round(probe.tapLatency) : null,
    tapToVisibleMs: tapToVisible,
    maxMainThreadGapMs: Math.round(probe.maxGap),
  };
  console.log('slow phone:', JSON.stringify(report));
  mkdirSync('.debug/mobile', { recursive: true });
  writeFileSync('.debug/mobile/slow-phone.json', JSON.stringify(report, null, 2));

  expect(distinct.size).toBeGreaterThanOrEqual(3);
  expect(report.progressSpanMs).toBeGreaterThan(0);
  expect(report.tapLatencyMs).not.toBeNull();
  expect(report.tapLatencyMs!).toBeLessThan(300);
  await expect(page.locator('[data-testid^="piece-item-"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});
