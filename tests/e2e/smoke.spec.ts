import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  // Let images decode and transitions settle.
  await page.waitForTimeout(250);
  await page.screenshot({ path: `.debug/ui/${info.project.name}-${name}.png`, fullPage });
}

test('create a puzzle, scan pieces, see results, and find it again after reload', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Home: empty state.
  await page.goto('/?pipeline=mock');
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
  await shot(page, info, '01-home-empty');

  // Wizard step 1: box photo via the file input.
  await page.getByRole('link', { name: 'New puzzle' }).first().click();
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  await shot(page, info, '02-wizard-photo');
  await page.getByTestId('photo-upload').setInputFiles(asset('great-wave.jpg'));

  // Step 2: corners.
  await expect(page.getByTestId('wizard-corners')).toBeVisible();
  const handle = page.getByTestId('corner-0');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.getByRole('button', { name: /Next: / }).click();
  await page.getByRole('button', { name: 'Auto-detect' }).click();
  // Drag the top-left corner a little (pointer events).
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 12, cy + 8, { steps: 4 });
  await shot(page, info, '03-corners-dragging');
  await page.mouse.up();
  await shot(page, info, '03-corners');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: details.
  await expect(page.getByTestId('wizard-details')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Great Wave');
  await page.getByRole('button', { name: '1000', exact: true }).click();
  await page.getByRole('textbox', { name: 'Width' }).fill('70');
  await page.getByRole('textbox', { name: 'Height' }).fill('50');
  await expect(page.getByText('best fit')).toBeVisible();
  await shot(page, info, '04-details', true);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4: reference + close-ups.
  await expect(page.getByTestId('wizard-reference')).toBeVisible();
  await expect(page.getByTestId('ref-size')).toContainText('px per piece');
  await shot(page, info, '05-reference');
  await page.getByTestId('closeup-upload').setInputFiles(asset('great-wave.jpg'));
  await expect(page.getByText(/Matched ·/)).toBeVisible();
  await page.getByRole('button', { name: /Build sharper picture/ }).click();
  const t0 = Date.now();
  await expect(page.getByText('The reference now uses your close-ups.')).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(10_000);
  await shot(page, info, '06-closeups', true);
  await page.getByTestId('save-puzzle').click();

  // Workspace: scan tab.
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Great Wave' })).toBeVisible();
  await shot(page, info, '07-workspace-scan');
  const puzzleUrl = page.url();

  // Scan a pieces photo.
  await page.getByTestId('photo-upload').setInputFiles(asset('starry-night.jpg'));
  await expect(page.getByTestId('analysing')).toBeVisible();
  await shot(page, info, '08-analysing');
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('region-1')).toBeVisible();
  await shot(page, info, '09-scan-result');
  await shot(page, info, '09-scan-result-full', true);

  // Quality issue → highlight.
  const qualityHead = page.locator('.quality-head');
  if (await qualityHead.count()) {
    await qualityHead.first().click();
    const show = page.locator('.issue-show').first();
    if (await show.count()) await show.click();
    await shot(page, info, '10-issue-highlight');
  }

  // Piece detail.
  await page.getByTestId('piece-item-1').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await shot(page, info, '11-piece-detail');
  const notThis = page.getByTestId('not-this-one');
  if (await notThis.isVisible()) {
    await notThis.click();
    await shot(page, info, '11-piece-detail-next');
  }
  const placeBtn = page.getByTestId('mark-placed');
  if (await placeBtn.isVisible()) {
    await placeBtn.click();
    await expect(page.getByRole('button', { name: /Placed – undo/ })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Mark all confident as placed (with undo snackbar).
  const placeAll = page.getByTestId('place-all');
  if (await placeAll.isVisible()) {
    await placeAll.click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await shot(page, info, '12-placed-snackbar');
  }

  // Split view.
  await page.getByRole('radio', { name: 'Both' }).click();
  await expect(page.locator('[data-testid^="marker-"]').first()).toBeVisible();
  await shot(page, info, '13-both');

  // Other tabs.
  for (const tab of ['picture', 'history', 'settings'] as const) {
    await page.goto(`${puzzleUrl.replace(/#.*$/, '')}${new URL(puzzleUrl).hash}/${tab}`);
    await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    if (tab === 'history') await expect(page.getByTestId('scan-row')).toHaveCount(1);
    await shot(page, info, `14-${tab}`, tab === 'settings');
  }

  // Export from settings (we are on the settings tab now).
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export puzzle' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/Great Wave.*\.json$/);
  const exported = await download.path();

  // Persistence: reload and find the puzzle on the home screen.
  await page.goto('/?pipeline=mock');
  await page.reload();
  const card = page.getByTestId('puzzle-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Great Wave');
  await expect(card).toContainText('1000 pieces');
  await shot(page, info, '15-home');

  // Import the exported file → a second puzzle; then delete it again.
  await page.getByTestId('import-file').setInputFiles(exported);
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await page.goto(`/?pipeline=mock${new URL(page.url()).hash}/settings`);
  await page.getByRole('button', { name: 'Delete puzzle' }).click();
  await shot(page, info, '16-delete-confirm');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete puzzle' }).click();
  await expect(page.getByTestId('puzzle-card')).toHaveCount(1);

  // Dark mode.
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, info, '17-home-dark');
  await page.getByTestId('puzzle-card').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await expect(page.getByText('Latest scan')).toBeVisible();
  await page.getByText('Latest scan').click();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.getByTestId('region-1')).toBeVisible();
  await shot(page, info, '18-scan-result-dark');
  await page.getByTestId('piece-item-2').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, info, '19-piece-detail-dark');

  expect(errors).toEqual([]);
});
