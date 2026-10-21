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

/** Count the camera tracks that are still running (getUserMedia wrapped to remember its streams). */
async function trackStreams(page: import('@playwright/test').Page, delayMs = 0) {
  await page.addInitScript((delay) => {
    const streams: MediaStream[] = [];
    (window as unknown as { __streams: MediaStream[] }).__streams = streams;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await original(c);
      streams.push(s);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return s;
    };
  }, delayMs);
  return () => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);
}

async function setHidden(page: import('@playwright/test').Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('the camera turns off while the page is hidden and comes back with it', async ({ page }) => {
  const live = await trackStreams(page);
  await page.goto('/?pipeline=mock#/new');
  await expect(page.locator('video.camera-video')).toBeVisible();
  expect(await live()).toBe(1);
  await setHidden(page, true); // another tab, the app in the background, the phone locked
  await expect.poll(live).toBe(0);
  await setHidden(page, false);
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect.poll(live).toBe(1);
});

test('the camera turns off when leaving the screen, also while it is still opening', async ({ page }) => {
  const live = await trackStreams(page, 1500);
  await page.goto('/?pipeline=mock#/new');
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  // Leave before the (slowed) camera has opened.
  await page.evaluate(() => (location.hash = '#/'));
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
  await page.waitForTimeout(2500);
  expect(await live()).toBe(0);
});
