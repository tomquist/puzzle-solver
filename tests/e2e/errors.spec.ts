import { expect, test } from '@playwright/test';

test('unreadable photo shows a friendly error and the upload stays available', async ({ page }) => {
  await page.goto('/?pipeline=mock#/new');
  await page.getByTestId('photo-upload').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a jpeg') });
  await expect(page.getByRole('alert')).toContainText(/could not|decoded|read/i);
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  await expect(page.getByTestId('photo-upload')).toBeEnabled();
});

test('HEIC photos get a specific explanation where the browser cannot decode them', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Safari decodes HEIC natively');
  await page.goto('/?pipeline=mock#/new');
  // An ISO-BMFF header with the "heic" brand (not decodable by Chromium).
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
  await page.getByTestId('photo-upload').setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic });
  await expect(page.getByRole('alert')).toContainText(/HEIC/);
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
});

test('unknown routes and missing puzzles have helpful states', async ({ page }) => {
  await page.goto('/?pipeline=mock#/does-not-exist');
  await expect(page.getByRole('heading', { name: 'This page doesn’t exist' })).toBeVisible();
  await page.goto('/?pipeline=mock#/puzzle/nope/picture');
  await expect(page.getByRole('heading', { name: 'This puzzle is not on this device' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to my puzzles' }).click();
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
});
