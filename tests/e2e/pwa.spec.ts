/**
 * Installability + offline, against the production build served by `vite preview` under a
 * sub-path (as on GitHub Pages). See the `pwa` project in playwright.config.ts.
 */
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

test('manifest, icons, service worker and offline start', async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  // Default mode: the real pipeline Web Worker is created at start-up (its script must be cached).
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();

  // --- manifest
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifestUrl = new URL(href!, page.url()).href;
  expect(manifestUrl).toBe(new URL('manifest.webmanifest', baseURL).href);
  const res = await page.request.get(manifestUrl);
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as Manifest;
  expect(manifest.name).toBeTruthy();
  expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  // start_url and scope resolve inside the sub-path.
  expect(new URL(manifest.start_url, manifestUrl).href).toBe(new URL('./', baseURL).href);

  // --- icons: 192 + 512 "any" and a 512 maskable; each loads and has the declared size.
  const sizes = new Set(manifest.icons.map((i) => `${i.sizes}/${i.purpose ?? 'any'}`));
  for (const want of ['192x192/any', '512x512/any', '512x512/maskable']) expect(sizes).toContain(want);
  for (const icon of manifest.icons) {
    const r = await page.request.get(new URL(icon.src, manifestUrl).href);
    expect(r.ok(), icon.src).toBe(true);
    expect(r.headers()['content-type']).toContain('image/png');
    const png = PNG.sync.read(await r.body());
    expect(`${png.width}x${png.height}`).toBe(icon.sizes);
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  const appleRes = await page.request.get(new URL(apple!, page.url()).href);
  expect(appleRes.ok()).toBe(true);
  expect(PNG.sync.read(await appleRes.body()).width).toBe(180);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', /^#/);

  // --- service worker: registered relative to the sub-path and controlling the page.
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, script: r.active?.scriptURL ?? '' };
  });
  expect(reg.scope).toBe(new URL('./', baseURL).href);
  expect(reg.script).toMatch(/\/puzzle-solver\/sw\.js\?v=/);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 15_000 });

  // Second visit through the service worker, so lazily loaded files (pipeline worker) get cached.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
  await expect
    .poll(async () => page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const k of keys) for (const req of await (await caches.open(k)).keys()) urls.push(req.url);
      return urls;
    }), { timeout: 15_000 })
    .toEqual(expect.arrayContaining([expect.stringMatching(/assets\/index-.*\.js$/), expect.stringMatching(/pipeline\.worker-.*\.js$/), expect.stringMatching(/manifest\.webmanifest$/)]));

  // --- offline: the app still starts and navigates.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
  await page.getByRole('link', { name: 'New puzzle' }).first().click();
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  // A fresh tab offline, opened at the start URL without the query string.
  const page2 = await context.newPage();
  await page2.goto(new URL('./', baseURL).href);
  await expect(page2.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
  // The pipeline worker script is available offline too.
  const workerOk = await page2.evaluate(async () => {
    const entry = (await caches.keys()).length ? performance.getEntriesByType('resource').map((e) => e.name) : [];
    const all: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) all.push(r.url);
    const url = all.find((u) => /pipeline\.worker-.*\.js$/.test(u));
    if (!url) return `no worker in cache (${entry.length} entries)`;
    const res = await fetch(url);
    return res.ok ? 'ok' : `status ${res.status}`;
  });
  expect(workerOk).toBe('ok');
  await context.setOffline(false);
});
