import { defineConfig, devices } from '@playwright/test';

const DEV_PORT = 5173;
const PREVIEW_PORT = 4173;
/** The production build is previewed under a sub-path, like GitHub Pages serves it. */
const PREVIEW_BASE = '/puzzle-solver/';

const phoneChromium = (width: number, height: number, deviceScaleFactor: number) => ({
  browserName: 'chromium' as const,
  viewport: { width, height },
  screen: { width, height },
  deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
});

/**
 * E2E tests.
 * - phone / desktop (Chromium): UI smoke tests with the mock pipeline, camera, errors, real pipeline.
 * - iphone-13 (WebKit) and android-small (360 × 640): the smoke flow again in Safari's engine and on
 *   a small Android screen; iphone-13 also runs the real-pipeline (Web Worker) test.
 * - Mobile audit matrix (tests/e2e/mobile*.spec.ts): iphone-se, iphone-13, android-small, pixel-7,
 *   phone-landscape, ipad. Screenshots go to .debug/mobile/.
 * - pwa: production build served by `vite preview` under a sub-path (manifest, icons, offline).
 * - slow-phone: real pipeline with 4× CPU throttling.
 * WebKit projects need `npx playwright install webkit` (with system deps in CI).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // In CI, stream one line per test (so a slow run is visibly progressing) plus GitHub annotations.
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  // Fail the whole run instead of letting retries of a stuck test eat the CI job.
  globalTimeout: process.env.CI ? 20 * 60_000 : undefined,
  use: {
    baseURL: `http://localhost:${DEV_PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `npx vite --config tests/e2e/vite.e2e.config.ts --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // vite build without the tsc step: the PWA test only needs the bundle.
      command:
        `npx vite build --outDir .debug/preview-dist --emptyOutDir --logLevel warn && ` +
        `npx vite preview --outDir .debug/preview-dist --port ${PREVIEW_PORT} --strictPort --base ${PREVIEW_BASE}`,
      url: `http://localhost:${PREVIEW_PORT}${PREVIEW_BASE}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
  projects: [
    {
      name: 'phone',
      use: phoneChromium(390, 844, 2),
      testMatch: /(smoke|camera|errors|placing|feedback)\.spec\.ts/,
    },
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 860 } },
      testMatch: /(smoke|camera|errors|pipeline|box-check|placing|feedback)\.spec\.ts/,
    },
    {
      name: 'iphone-13',
      use: { ...devices['iPhone 13'] },
      // No fake camera in WebKit; the real pipeline runs here too (worker, IndexedDB, codecs).
      testMatch: /(smoke|errors|pipeline|mobile|placing|feedback)\.spec\.ts/,
    },
    {
      name: 'android-small',
      use: phoneChromium(360, 640, 3),
      testMatch: /(smoke|errors|mobile|mobile-camera|audit)\.spec\.ts/,
    },
    {
      name: 'iphone-se',
      use: { ...devices['iPhone SE'], viewport: { width: 375, height: 667 } },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile(-camera)?\.spec\.ts/,
    },
    {
      name: 'phone-landscape',
      use: phoneChromium(844, 390, 3),
      testMatch: /mobile(-camera)?\.spec\.ts/,
    },
    {
      name: 'ipad',
      use: { ...devices['iPad (gen 7)'] },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      name: 'pwa',
      use: { ...phoneChromium(390, 844, 2), baseURL: `http://localhost:${PREVIEW_PORT}${PREVIEW_BASE}` },
      testMatch: /pwa\.spec\.ts/,
    },
    {
      name: 'slow-phone',
      use: phoneChromium(390, 844, 2),
      testMatch: /throttle\.spec\.ts/,
    },
  ],
});
