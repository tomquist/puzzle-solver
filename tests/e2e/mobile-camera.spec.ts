/** Mobile audit of the live camera screens (Chromium fake camera; see mobile.spec.ts). */
import { expect, test } from '@playwright/test';
import { auditPage, formatViolations } from './audit';

test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('mobile audit: live camera', async ({ page }, info) => {
  await page.goto('/?pipeline=mock#/new');
  await expect(page.locator('video.camera-video')).toBeVisible();
  await expect(page.locator('.camera-meter .meter-text')).not.toHaveText('Checking…', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `.debug/mobile/${info.project.name}-20-camera.png` });
  const vs = await auditPage(page);
  expect.soft(vs, formatViolations(vs)).toEqual([]);
  // The shutter must be fully inside the viewport and tappable.
  const shutter = page.getByRole('button', { name: 'Take photo' });
  const box = await shutter.boundingBox();
  const vp = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.screenshot({ path: `.debug/mobile/${info.project.name}-21-camera-no-tips.png` });
  await shutter.click();
  await expect(page.getByTestId('wizard-corners')).toBeVisible({ timeout: 20_000 });
});

// CI runners and many phones have wider system fonts than the dev machine: the camera action
// row must wrap instead of overflowing (regression: "Upload photo" spilled past a 360 px screen).
test('mobile audit: live camera with wide system fonts', async ({ page }) => {
  await page.goto('/?pipeline=mock#/new');
  await page.addStyleTag({
    content: 'html, body, button, label, a { font-family: Verdana, "DejaVu Sans", sans-serif !important; letter-spacing: 0.05em !important; }',
  });
  await expect(page.locator('video.camera-video')).toBeVisible();
  await page.waitForTimeout(300);
  const vs = (await auditPage(page)).filter((v) => v.rule === 'overflow');
  expect(vs, formatViolations(vs)).toEqual([]);
});
