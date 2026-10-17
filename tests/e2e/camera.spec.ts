import { expect, test } from '@playwright/test';

// Chromium's fake camera: a synthetic video stream, permission granted without a prompt.
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('live camera: preview, quality meter and shutter', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/new');
  // Permission is already granted, so the camera starts by itself.
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect(page.locator('.camera-meter .meter-text')).not.toHaveText('Checking…', { timeout: 10_000 });
  await page.screenshot({ path: `.debug/ui/${info.project.name}-20-camera.png` });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.getByTestId('wizard-corners')).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});
