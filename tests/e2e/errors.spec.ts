import { expect, test } from '@playwright/test';

test('unreadable photo shows a friendly error and the upload stays available', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('photo-upload').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a jpeg') });
  await expect(page.getByRole('alert')).toContainText(/could not|decoded|read/i);
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  await expect(page.getByTestId('photo-upload')).toBeEnabled();
});

test('unknown routes and missing puzzles have helpful states', async ({ page }) => {
  await page.goto('/#/does-not-exist');
  await expect(page.getByRole('heading', { name: 'This page doesn’t exist' })).toBeVisible();
  await page.goto('/#/puzzle/nope/picture');
  await expect(page.getByRole('heading', { name: 'This puzzle is not on this device' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to my puzzles' }).click();
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
});
