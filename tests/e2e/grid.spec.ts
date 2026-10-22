/**
 * The self-correcting grid (mock pipeline; `?mockGrid=rowsxcols` sets the grid its scans measure):
 * - the wizard accepts an unknown piece count: the grid is labelled estimated and follows the
 *   first scans without asking;
 * - a grid the scans contradict gets one small question ("Your pieces measure 41 × 25, not 40 × 25"),
 *   shown once: "Keep" is remembered across reloads and further scans, "Use" switches the grid and
 *   carries the scans over.
 * Screenshots (light and dark) go to .debug/ui/.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));

async function shot(page: Page, info: TestInfo, name: string, full = false) {
  await page.waitForTimeout(250);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `.debug/ui/${info.project.name}-grid-${name}-${scheme}.png`, fullPage: full });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Through the wizard to the workspace; `setup` fills the details step. */
async function createPuzzle(page: Page, mockGrid: string, setup: (page: Page) => Promise<void>) {
  await page.goto(`/?pipeline=mock&mockGrid=${mockGrid}#/new`);
  await page.getByTestId('photo-upload').setInputFiles(asset('great-wave.jpg'));
  await expect(page.getByTestId('wizard-corners')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await setup(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('wizard-reference')).toBeVisible();
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
}

async function scan(page: Page) {
  await page.getByTestId('photo-upload').setInputFiles(asset('starry-night.jpg'));
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 30_000 });
}

/** Back to the workspace's scan tab (from a scan result). */
async function toScanTab(page: Page) {
  const url = new URL(page.url());
  const puzzle = url.hash.match(/#\/puzzle\/[^/]+/)![0];
  await page.goto(`${url.pathname}${url.search}${puzzle}/scan`);
  await expect(page.getByTestId('tab-scan')).toBeVisible();
}

async function openSettings(page: Page) {
  const url = new URL(page.url());
  const puzzle = url.hash.match(/#\/puzzle\/[^/]+/)![0];
  await page.goto(`${url.pathname}${url.search}${puzzle}/settings`);
  await expect(page.getByTestId('tab-settings')).toBeVisible();
}

test('unknown piece count: an estimated grid that the first scan measures', async ({ page }, info) => {
  await createPuzzle(page, '20x30', async (p) => {
    await p.getByRole('radio', { name: 'I don’t know' }).click();
    await expect(p.locator('#pieces')).toHaveCount(0);
    await expect(p.getByTestId('grid-estimated')).toHaveText('Estimated – will be measured from your first scans.');
    await expect(p.getByText('estimated', { exact: true })).toBeVisible();
    await shot(p, info, 'wizard-unknown-count', true);
  });
  await openSettings(page);
  await expect(page.getByTestId('grid-status')).toHaveAttribute('data-status', 'estimated');
  await toScanTab(page);
  await scan(page);
  // The estimated grid follows the measurement without a question.
  await expect(page.getByText('Grid changed to 30 × 20.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByLabel('Columns')).toHaveValue('30');
  await expect(page.getByLabel('Rows')).toHaveValue('20');
  await expect(page.getByTestId('grid-status')).not.toHaveAttribute('data-status', 'estimated');
});

/** A puzzle with a custom 40 × 25 grid whose scans measure 41 × 25. */
async function puzzleOneColumnOff(page: Page) {
  await createPuzzle(page, '25x41', async (p) => {
    await p.getByRole('button', { name: '1000', exact: true }).click();
    await p.getByRole('button', { name: 'Custom' }).click();
    await p.getByLabel('Columns').fill('40');
    await p.getByLabel('Rows').fill('25');
  });
}

test('the grid question appears once, and "Keep" is remembered', async ({ page }, info) => {
  await puzzleOneColumnOff(page);
  await scan(page);
  // One scan never asks.
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  await toScanTab(page);
  await scan(page);
  const card = page.getByTestId('grid-suggestion');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('Your pieces measure 41 × 25, not 40 × 25.');
  await expect(page.getByTestId('grid-use')).toHaveText('Use 41 × 25');
  await expect(page.getByTestId('grid-keep')).toHaveText('Keep 40 × 25');
  await shot(page, info, 'suggestion-card');
  // Also on the workspace, until answered.
  await toScanTab(page);
  await expect(page.getByTestId('grid-suggestion')).toBeVisible();
  await page.getByTestId('grid-keep').click();
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  // Remembered: not after a reload, nor after another scan that says the same.
  await page.reload();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  await scan(page);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByLabel('Columns')).toHaveValue('40');
});

test('"Use" switches the grid and carries the scans over', async ({ page }) => {
  await puzzleOneColumnOff(page);
  await scan(page);
  await toScanTab(page);
  await scan(page);
  await expect(page.getByTestId('grid-suggestion')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('grid-use').click();
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  await expect(page.getByText('Grid changed to 41 × 25.')).toBeVisible();
  // The scan result is still there, now on the new grid; no further question.
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await toScanTab(page);
  await scan(page);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('grid-suggestion')).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByLabel('Columns')).toHaveValue('41');
  await expect(page.getByTestId('grid-status')).toHaveAttribute('data-status', 'confirmed');
});
