/**
 * Scan result → guided placing mode (mock pipeline): no-match pieces hidden, assembled grids and
 * connections shown, view options remembered across reloads, the screen kept on, and the placing
 * flow from the first step to the finish card.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));

async function shot(page: Page, info: TestInfo, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `.debug/ui/${info.project.name}-placing-${name}.png` });
}

/** Records wake-lock requests/releases (works in every engine). */
async function stubWakeLock(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __wake: { requests: number; releases: number; held: number } };
    w.__wake = { requests: 0, releases: 0, held: 0 };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          w.__wake.requests++;
          w.__wake.held++;
          const listeners: (() => void)[] = [];
          return {
            released: false,
            addEventListener: (_: string, l: () => void) => listeners.push(l),
            release: async () => {
              w.__wake.releases++;
              w.__wake.held--;
              listeners.forEach((l) => l());
            },
          };
        },
      },
    });
  });
}

/** Click a placing action and wait until the step changed (or the finish card is shown). */
async function act(page: Page, testId: string) {
  const before = await page.locator('.topbar-sub').textContent();
  await page.getByTestId(testId).click();
  await expect.poll(async () => (await page.getByTestId('placing-done').isVisible()) || (await page.locator('.topbar-sub').textContent()) !== before).toBe(true);
}

const wake = (page: Page) => page.evaluate(() => (window as unknown as { __wake: { requests: number; releases: number; held: number } }).__wake);

async function createPuzzleAndScan(page: Page) {
  await page.goto('/?pipeline=mock#/new');
  await page.getByTestId('photo-upload').setInputFiles(asset('great-wave.jpg'));
  await expect(page.getByTestId('wizard-corners')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: '1000', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('wizard-reference')).toBeVisible();
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await page.getByTestId('photo-upload').setInputFiles(asset('starry-night.jpg'));
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
}

test('result screen: hidden no-matches, groups, connections, view options, wake lock', async ({ page }, info) => {
  await stubWakeLock(page);
  await createPuzzleAndScan(page);

  // No "No match" filter; assembled grids (one badge each) and connection lines are shown.
  await expect(page.getByRole('radio', { name: /No match/ })).toHaveCount(0);
  await expect(page.locator('[data-testid^="item-g"]')).toHaveCount(2);
  await expect(page.getByTestId('link').first()).toBeVisible();
  const notches = page.locator('.badge-notch');
  expect(await notches.count()).toBeGreaterThan(0);
  // The list shows exactly the drawn items (hidden regions are neither drawn nor listed).
  const drawn = await page.locator('[data-testid^="item-"]').count();
  await expect(page.locator('[data-testid^="piece-item-"]')).toHaveCount(drawn);
  await expect(page.getByTestId('start-placing')).toBeVisible();
  await shot(page, info, '01-result');

  // The screen is kept on while the result is visible.
  await expect.poll(async () => (await wake(page)).held).toBe(1);

  // View options: turn hints and connections off, remembered across a reload.
  await page.getByTestId('view-options').click();
  await shot(page, info, '02-view-options');
  await page.getByRole('checkbox', { name: /Turn hints/ }).uncheck();
  await page.getByRole('checkbox', { name: /Connections/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(notches).toHaveCount(0);
  await expect(page.getByTestId('link')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await expect(page.locator('.badge-notch')).toHaveCount(0);
  await expect(page.getByTestId('link')).toHaveCount(0);
  // Unsure pieces can be hidden too.
  await page.getByTestId('view-options').click();
  await page.getByRole('checkbox', { name: /Unsure pieces/ }).uncheck();
  await page.getByRole('checkbox', { name: /Turn hints/ }).check();
  await page.getByRole('checkbox', { name: /Connections/ }).check();
  await page.keyboard.press('Escape');
  expect(await page.locator('[data-testid^="item-"]').count()).toBeLessThan(drawn);
  await page.getByTestId('view-options').click();
  await page.getByRole('checkbox', { name: /Unsure pieces/ }).check();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid^="item-"]')).toHaveCount(drawn);

  // Leaving the result releases the wake lock.
  await page.getByRole('link', { name: 'Scan more' }).click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await expect.poll(async () => (await wake(page)).held).toBe(0);

  // Turning "Keep screen on" off in Settings stops the requests.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByTestId('keep-screen-on').uncheck();
  const before = (await wake(page)).requests;
  await page.goBack();
  await page.goBack();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await page.waitForTimeout(300);
  expect((await wake(page)).requests).toBe(before);
});

test('guided placing: assembled grids first, Placed/Skip/Not here, finish card', async ({ page }, info) => {
  await stubWakeLock(page);
  await createPuzzleAndScan(page);
  const startText = await page.getByTestId('start-placing').textContent();
  const total = Number(startText?.match(/(\d+)/)?.[1]);
  expect(total).toBeGreaterThan(3);

  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  await expect.poll(async () => (await wake(page)).held).toBe(1);
  // Assembled grids come first.
  await expect(page.locator('[data-testid^="step-g"]')).toBeVisible();
  await expect(page.getByTestId('instruction')).toHaveText(/rows? \d+.*columns? \d+/);
  await expect(page.getByRole('heading', { level: 1, name: 'Placing' })).toBeVisible();
  await expect(page.getByText(`1 of ${total}`)).toBeVisible();
  await shot(page, info, '03-step-assembled');

  await act(page, 'placed');
  await expect(page.getByText(`2 of ${total}`)).toBeVisible();
  // Keyboard navigation back and forth.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText(`1 of ${total}`)).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(`2 of ${total}`)).toBeVisible();
  await act(page, 'skip');
  await expect(page.getByText(`3 of ${total}`)).toBeVisible();

  // Work through the rest; use "Not here" once on an unsure piece.
  let usedNotHere = false;
  for (let i = 0; i < total + 5 && !(await page.getByTestId('placing-done').isVisible()); i++) {
    if (!usedNotHere && (await page.getByTestId('not-here').isVisible())) {
      const line = await page.getByTestId('instruction').textContent();
      await shot(page, info, '04-step-unsure');
      await page.getByTestId('not-here').click();
      usedNotHere = true;
      // Either the next candidate is shown, or (no more candidates) the step was skipped.
      await expect.poll(async () => page.getByTestId('instruction').textContent()).not.toBe(line);
      continue;
    }
    await act(page, 'placed');
  }
  await expect(page.getByTestId('placing-done')).toBeVisible();
  await expect(page.getByTestId('placing-done')).toContainText(/skipped/);
  await shot(page, info, '05-done');

  // Review the skipped ones, then finish and go scan the next handful.
  await page.getByRole('button', { name: /Review/ }).click();
  await expect(page.getByTestId('placing')).toBeVisible();
  for (let i = 0; i < 5 && !(await page.getByTestId('placing-done').isVisible()); i++) await act(page, 'placed');
  await expect(page.getByTestId('placing-done')).toContainText('All placed');
  await page.getByTestId('scan-next').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await expect.poll(async () => (await wake(page)).held).toBe(0);

  // Back on the result, everything of this scan is placed.
  await page.getByText('Latest scan').click();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.getByText('All placed')).toBeVisible();
});
