/**
 * Scan result → guided placing mode (mock pipeline): no-match pieces hidden, assembled grids and
 * connections shown, view options remembered across reloads, the screen kept on, selecting a
 * piece (its connections highlighted, everything else faded), press-and-hold for the clean photo,
 * and the placing flow from the first step to the finish card.
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

  // No "No match" filter; assembled grids (one label each) and connection lines are shown.
  await expect(page.getByRole('radio', { name: /No match/ })).toHaveCount(0);
  await expect(page.locator('[data-testid^="item-g"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="label-g"]')).toHaveCount(2);
  await expect(page.getByTestId('link').first()).toBeVisible();
  const notches = page.locator('.turn-tick');
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
  await expect(page.locator('.turn-tick')).toHaveCount(0);
  await expect(page.getByTestId('link')).toHaveCount(0);
  // Unsure pieces can be hidden too.
  await page.getByTestId('view-options').click();
  await page.getByRole('checkbox', { name: /Unsure pieces/ }).uncheck();
  await page.getByRole('checkbox', { name: /Turn hints/ }).check();
  await page.getByRole('checkbox', { name: /Connections/ }).check();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('[data-testid^="item-"]').count()).toBeLessThan(drawn);
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

test('result screen: select a piece to see its connections; hold the photo to see it clean', async ({ page }, info) => {
  await createPuzzleAndScan(page);
  const link = page.getByTestId('link').first();
  await expect(link).toBeVisible();
  const key = (await link.getAttribute('data-a'))!;
  const other = (await link.getAttribute('data-b'))!;
  const item = page.getByTestId(`item-${key}`);
  const photo = page.getByTestId('result-photo');
  const bar = page.getByTestId('selection-bar');
  const opacity = (el: SVGElement | HTMLElement) => Number(getComputedStyle(el).opacity);

  // Nothing selected: nothing is faded.
  await expect(page.locator('[data-testid^="item-"].faded')).toHaveCount(0);

  // Tap a piece on the photo: it is emphasised, its connections drawn strongly, the pieces it
  // joins ringed, everything else faded – and the photo stays visible.
  await item.click();
  await expect(item).toHaveClass(/\bselected\b/);
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('action-bar')).toHaveCount(0);
  const otherLabel = (await page.getByTestId(`label-${other}`).textContent())!.trim();
  await expect(page.getByTestId('selection-links')).toContainText(new RegExp(`(Joins|next to) .*#${otherLabel}\\b`));
  const active = page.locator('[data-testid="link"][data-active="true"]');
  expect(await active.count()).toBeGreaterThan(0);
  await expect(active.first()).toHaveClass(/\bactive\b/);
  await expect(page.getByTestId(`item-${other}`)).toHaveClass(/\blinked\b/);
  await expect(page.getByTestId(`ring-${key}`)).toBeVisible();
  await expect(page.getByTestId(`ring-${other}`)).toBeVisible();
  const faded = page.locator('[data-testid^="item-"].faded');
  expect(await faded.count()).toBeGreaterThan(0);
  await expect.poll(() => faded.first().evaluate(opacity)).toBeLessThan(0.5);
  await expect(page.locator('[data-testid^="label-"].faded').first()).toBeAttached();
  const inactive = page.locator('[data-testid="link"]:not([data-active])');
  if (await inactive.count()) await expect(inactive.first()).toHaveClass(/\bfaded\b/);
  await expect(photo).toBeInViewport();
  await shot(page, info, '01b-selected');

  // Tapping it again clears the selection; so does a tap on the empty photo.
  await item.click();
  await expect(bar).toBeHidden();
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await expect(page.locator('[data-testid^="item-"].faded')).toHaveCount(0);
  await page.getByTestId(`label-${key}`).click();
  await expect(bar).toBeVisible();
  await page.getByTestId('scan-overlay').click({ position: { x: 3, y: 3 } });
  await expect(bar).toBeHidden();

  // Press and hold: every annotation is hidden while held; releasing selects nothing.
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(photo).toHaveAttribute('data-peek', 'true');
  await expect.poll(() => page.getByTestId('scan-overlay').evaluate(opacity)).toBe(0);
  await shot(page, info, '01c-peek');
  await page.mouse.up();
  await expect(photo).toHaveAttribute('data-peek', 'false');
  await expect.poll(() => page.getByTestId('scan-overlay').evaluate(opacity)).toBe(1);
  await page.waitForTimeout(400);
  await expect(bar).toBeHidden();

  // Labels off (View): a clean photo; a selection (here from the list) still shows its piece,
  // its connections and the pieces it joins.
  await page.getByTestId('view-options').click();
  await page.getByRole('checkbox', { name: /Labels/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid^="label-"]')).toHaveCount(0);
  await expect(page.getByTestId('link')).toHaveCount(0);
  await page.getByTestId(`piece-item-${key}`).click();
  await expect(bar).toBeVisible();
  await expect(page.getByTestId(`piece-item-${key}`)).toHaveClass(/\bselected\b/);
  await expect(page.getByTestId(`label-${key}`)).toBeVisible();
  await expect(page.getByTestId(`label-${other}`)).toBeVisible();
  expect(await active.count()).toBeGreaterThan(0);
  await expect(photo).toBeInViewport();
  await shot(page, info, '01d-labels-off-selected');
  await page.getByTestId('view-options').click();
  await page.getByRole('checkbox', { name: /Labels/ }).check();
  await page.keyboard.press('Escape');

  // Details: the connections in words; closing them keeps the selection.
  await page.getByTestId('selection-details').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('detail-connections')).toContainText(/Joins|next to/);
  await expect(sheet.getByTestId('target-context')).toBeVisible();
  await shot(page, info, '01e-details');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(bar).toBeVisible();
  await page.getByTestId('selection-clear').click();
  await expect(bar).toBeHidden();
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
  // A one-cell group reads as a piece; otherwise a correct plural.
  await expect(page.getByTestId('place-kind')).not.toHaveText(/\b1 pieces\b/);
  await shot(page, info, '03-step-assembled');

  // Pick up: the piece with its surroundings; a tap toggles an upright close-up.
  const pickup = page.getByTestId('pickup');
  await expect(pickup).toHaveAttribute('aria-pressed', 'false');
  await pickup.click();
  await expect(pickup).toHaveAttribute('aria-pressed', 'true');
  await expect(pickup).toContainText(/Turned upright|Close-up/);
  await pickup.click();
  await expect(pickup).toHaveAttribute('aria-pressed', 'false');

  // Where it goes: the picture with several cells of context around a thin target outline (not
  // one cell filling the view), and the overview of the whole picture with a marker.
  const view = (await page.getByTestId('target-view').boundingBox())!;
  const target = (await page.getByTestId('target-outline').boundingBox())!;
  expect(target.width / view.width).toBeLessThan(0.6);
  expect(target.width / view.width).toBeGreaterThan(0.05);
  const overview = page.getByTestId('overview');
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('overview-marker')).toBeVisible();
  expect(await overview.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  expect((await overview.boundingBox())!.width / view.width).toBeGreaterThan(0.3);
  // It can be zoomed out to the whole picture and back to the spot.
  await page.getByRole('button', { name: 'Show whole picture' }).click();
  await page.getByTestId('zoom-to-start').click();
  await expect(page.getByTestId('zoom-to-start')).toBeHidden();

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
