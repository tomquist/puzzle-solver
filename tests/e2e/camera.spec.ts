import { expect, test } from '@playwright/test';

// Chromium's fake camera: a synthetic video stream, permission granted without a prompt.
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('live camera: preview, quality meter and shutter', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?pipeline=mock#/new');
  // Permission is already granted, so the camera starts by itself.
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect(page.locator('.camera-meter .meter-text')).not.toHaveText('Checking…', { timeout: 10_000 });
  await page.screenshot({ path: `.debug/ui/${info.project.name}-20-camera.png` });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.getByTestId('wizard-corners')).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('camera tips: "Don’t show again" is remembered, Tips brings them back', async ({ page }) => {
  await page.goto('/?pipeline=mock#/new');
  await expect(page.locator('video.camera-video')).toBeVisible();
  const tips = page.locator('.camera-tips');
  await expect(tips).toBeVisible();

  // Plain "Got it" only hides them for now.
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(tips).toBeHidden();
  await page.reload();
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect(tips).toBeVisible();

  // With the checkbox they stay away, also after a reload.
  await page.getByTestId('tips-dont-show').check();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.reload();
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect(tips).toBeHidden();

  // The Tips button still shows them on demand; unticking brings them back for next time.
  await page.getByRole('button', { name: 'Tips' }).click();
  await expect(tips).toBeVisible();
  await expect(page.getByTestId('tips-dont-show')).toBeChecked();
  await page.getByTestId('tips-dont-show').uncheck();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.reload();
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect(tips).toBeVisible();
});
