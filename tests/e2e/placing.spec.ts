/**
 * Scan result → guided placing mode (mock pipeline): no-match pieces hidden, assembled grids and
 * connections shown, view options remembered across reloads, the screen kept on, selecting a
 * piece (its connections highlighted, everything else faded), press-and-hold for the clean photo,
 * the placing flow from the first step to the finish card, and how to turn a piece (the cut-out
 * turning upright, the "top" bar, plain words; "now → then" frames with reduced motion).
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { flowDirections, linkId } from '../../src/ui/lib/linkGraph';

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

/** The selection colour (--sel) as computed. */
const SELECTION_COLOUR = 'rgb(46, 230, 255)';

/** Dash pattern (screen px), colour, opacity, drawn width (screen px) and flow of a connection's line. */
async function lineStyle(link: Locator) {
  return link.evaluate((g) => {
    const el = g.querySelector('.link-line') as SVGGraphicsElement;
    const svg = el.ownerSVGElement!;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const cs = getComputedStyle(el);
    const dash = cs.strokeDasharray === 'none' ? [] : cs.strokeDasharray.split(/[ ,]+/).map((v) => parseFloat(v) * scale);
    const flow = (el.getAnimations() as CSSAnimation[]).map((a) => a.animationName);
    return { dash, stroke: cs.stroke, px: parseFloat(cs.strokeWidth) * scale, opacity: Number(getComputedStyle(g).opacity), flow, direction: cs.animationDirection };
  });
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

/**
 * createPuzzleAndScan until the scan has connection lines: the mock pipeline seeds its pieces with
 * the (random) puzzle id, and a few seeds give no linked pair that is shown.
 */
async function createPuzzleWithLinks(page: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await createPuzzleAndScan(page);
    if ((await page.getByTestId('link').count()) > 0) return;
  }
  throw new Error('No mock scan with connection lines after 4 puzzles');
}

test('result screen: hidden no-matches, groups, connections, view options, wake lock', async ({ page }, info) => {
  await stubWakeLock(page);
  await createPuzzleWithLinks(page);

  // No "No match" filter; assembled grids (one label each) and connection lines are shown.
  await expect(page.getByRole('radio', { name: /No match/ })).toHaveCount(0);
  await expect(page.locator('[data-testid^="item-g"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="label-g"]')).toHaveCount(2);
  await expect(page.getByTestId('link').first()).toBeVisible();
  const notches = page.locator('.top-mark');
  expect(await notches.count()).toBeGreaterThan(0);
  // The list shows exactly the drawn items (hidden regions are neither drawn nor listed).
  const drawn = await page.locator('[data-testid^="item-"]').count();
  await expect(page.locator('[data-testid^="piece-item-"]')).toHaveCount(drawn);
  await expect(page.getByTestId('start-placing')).toBeVisible();
  await shot(page, info, '01-result');

  // The screen is kept on while the result is visible.
  await expect.poll(async () => (await wake(page)).held).toBe(1);

  // View options: top marks and connections off, remembered across a reload.
  await page.getByTestId('view-options').click();
  await shot(page, info, '02-view-options');
  await page.getByRole('checkbox', { name: /Top marks/ }).uncheck();
  await page.getByRole('checkbox', { name: /Connections/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(notches).toHaveCount(0);
  await expect(page.getByTestId('link')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await expect(page.locator('.top-mark')).toHaveCount(0);
  await expect(page.getByTestId('link')).toHaveCount(0);
  // Unsure pieces can be hidden too.
  await page.getByTestId('view-options').click();
  await page.getByRole('checkbox', { name: /Unsure pieces/ }).uncheck();
  await page.getByRole('checkbox', { name: /Top marks/ }).check();
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
  await createPuzzleWithLinks(page);
  const link = page.getByTestId('link').first();
  await expect(link).toBeVisible();
  const key = (await link.getAttribute('data-a'))!;
  const other = (await link.getAttribute('data-b'))!;
  const item = page.getByTestId(`item-${key}`);
  const photo = page.getByTestId('result-photo');
  const bar = page.getByTestId('selection-bar');
  const opacity = (el: SVGElement | HTMLElement) => Number(getComputedStyle(el).opacity);

  // Nothing selected: nothing is faded; lines are dotted (about 3 px dashes, 4.5 px gaps on
  // screen), about 1.5 screen px, readable, and flow toward the bigger side.
  await expect(page.locator('[data-testid^="item-"].faded')).toHaveCount(0);
  const line = await lineStyle(link);
  expect(line.dash).toHaveLength(2);
  expect(line.dash[0]).toBeGreaterThan(2.5);
  expect(line.dash[0]).toBeLessThan(3.5);
  expect(line.px).toBeGreaterThan(1.2);
  expect(line.px).toBeLessThan(1.8);
  expect(line.opacity).toBeGreaterThan(0.7);
  expect(line.flow).toEqual(['link-flow']);
  expect(line.direction).toBe((await link.getAttribute('data-flow')) === 'a' ? 'reverse' : 'normal');

  // Tap a piece on the photo: it is emphasised, its connections drawn strongly, the pieces it
  // joins outlined, everything else faded and the photo around them darkened – the photo stays
  // visible.
  await item.click();
  await expect(item).toHaveClass(/\bselected\b/);
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('action-bar')).toHaveCount(0);
  const otherLabel = (await page.getByTestId(`label-${other}`).textContent())!.trim();
  await expect(page.getByTestId('selection-links')).toContainText(new RegExp(`(Joins|next to) .*#${otherLabel}\\b`));
  const active = page.locator('[data-testid="link"][data-active="true"]');
  expect(await active.count()).toBeGreaterThan(0);
  await expect(active.first()).toHaveClass(/\bactive\b/);
  // Selected lines: dotted, about 3 screen px, in the selection colour, fully opaque, a flow of
  // their own.
  const sel = await lineStyle(active.first());
  expect(sel.dash).toHaveLength(2);
  expect(sel.px).toBeGreaterThan(2.5);
  expect(sel.px).toBeLessThan(3.5);
  expect(sel.stroke).toBe(SELECTION_COLOUR);
  expect(sel.flow).toEqual(['link-flow-sel']);
  await expect.poll(async () => (await lineStyle(active.first())).opacity).toBe(1);
  // The joined piece: outline in the selection colour, a tint, its label fully visible.
  const joined = page.getByTestId(`item-${other}`);
  await expect(joined).toHaveClass(/\blinked\b/);
  expect(await joined.locator('.item-line').first().evaluate((el) => getComputedStyle(el).stroke)).toBe(SELECTION_COLOUR);
  expect(Number(await joined.locator('.item-fill').first().evaluate((el) => getComputedStyle(el).fillOpacity))).toBeGreaterThan(0);
  await expect.poll(() => page.getByTestId(`label-${other}`).evaluate(opacity)).toBe(1);
  await expect(page.getByTestId(`ring-${key}`)).toBeVisible();
  await expect(page.getByTestId(`ring-${other}`)).toBeVisible();
  await expect(page.getByTestId('selection-scrim')).toBeAttached();
  // Everything else fades to about 0.2.
  const faded = page.locator('[data-testid^="item-"].faded');
  expect(await faded.count()).toBeGreaterThan(0);
  await expect.poll(() => faded.first().evaluate(opacity)).toBeLessThanOrEqual(0.25);
  await expect(page.locator('[data-testid^="label-"].faded').first()).toBeAttached();
  const inactive = page.locator('[data-testid="link"]:not([data-level])');
  if (await inactive.count()) await expect(inactive.first()).toHaveClass(/\bfaded\b/);
  await expect(photo).toBeInViewport();
  await shot(page, info, '01b-selected');

  // The joined piece named in the bar is a link: the selection moves there, and back.
  await page.getByTestId(`mention-${other}`).click();
  await expect(joined).toHaveClass(/\bselected\b/);
  await expect(item).toHaveClass(/\blinked\b/);
  await page.getByTestId(`mention-${key}`).click();
  await expect(item).toHaveClass(/\bselected\b/);

  // Tapping it again clears the selection; so does a tap on the empty photo.
  await item.click();
  await expect(bar).toBeHidden();
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await expect(page.locator('[data-testid^="item-"].faded')).toHaveCount(0);
  await page.getByTestId(`label-${key}`).click();
  await expect(bar).toBeVisible();
  // (The mentions zoomed the photo in: back to the whole photo, then tap its empty corner.)
  const wholePhoto = photo.getByRole('button', { name: 'Show whole picture' });
  if (await wholePhoto.isVisible()) await wholePhoto.click();
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

test('result screen: full-screen photo – select inside, close, the selection stays', async ({ page }, info) => {
  await createPuzzleWithLinks(page);
  const key = (await page.getByTestId('link').first().getAttribute('data-a'))!;
  const fs = page.getByTestId('fullscreen');

  // Open: the photo fills the viewport, the page's bars are gone.
  await page.getByTestId('open-fullscreen-photo').click();
  await expect(fs).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await fs.boundingBox())!;
  expect(Math.abs(box.width - vp.width)).toBeLessThan(2);
  expect(Math.abs(box.height - vp.height)).toBeLessThan(2);
  await expect(page.getByTestId('action-bar')).toHaveCount(0);
  await shot(page, info, '06-fullscreen');

  // Select a piece inside: the same highlighting, and the info bar over the bottom.
  const item = fs.getByTestId(`item-${key}`);
  await item.click();
  await expect(item).toHaveClass(/\bselected\b/);
  await expect(fs.getByTestId('selection-bar')).toBeVisible();
  await expect(fs.locator('[data-testid="link"][data-active="true"]').first()).toBeAttached();
  // The labels toggle and press-and-hold work here too.
  await fs.getByTestId('fullscreen-labels').click();
  await expect(fs.getByTestId('fullscreen-labels')).toHaveAttribute('aria-pressed', 'false');
  await expect(fs.locator('[data-testid^="label-"]').first()).toBeVisible(); // the selection keeps its labels
  await fs.getByTestId('fullscreen-labels').click();
  await expect(fs.getByTestId('fullscreen-labels')).toHaveAttribute('aria-pressed', 'true');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height * 0.3 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await expect(fs.locator('.fs-peek')).toHaveAttribute('data-peek', 'true');
  await page.mouse.up();
  await expect(fs.locator('.fs-peek')).toHaveAttribute('data-peek', 'false');
  await expect(item).toHaveClass(/\bselected\b/);
  await shot(page, info, '06b-fullscreen-selected');

  // Close: back on the page, still selected.
  await fs.getByTestId('fullscreen-close').click();
  await expect(fs).toHaveCount(0);
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  await expect(page.getByTestId(`item-${key}`)).toHaveClass(/\bselected\b/);

  // Esc closes it too (and keeps the selection); so does the back gesture.
  await page.getByTestId('open-fullscreen-photo').click();
  await expect(fs).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fs).toHaveCount(0);
  await expect(page.getByTestId(`item-${key}`)).toHaveClass(/\bselected\b/);
  await page.getByTestId('open-fullscreen-photo').click();
  await expect(fs).toBeVisible();
  await page.goBack();
  await expect(fs).toHaveCount(0);
  await expect(page.getByTestId('scan-result')).toBeVisible();

  // The picture has full screen too (Picture / Both).
  await page.getByRole('radio', { name: 'Picture' }).click();
  await page.getByTestId('open-fullscreen-picture').click();
  await expect(fs).toBeVisible();
  await expect(fs.locator('[data-testid^="marker-"]').first()).toBeVisible();
  await fs.getByTestId('fullscreen-close').click();
  await expect(fs).toHaveCount(0);
});

/**
 * Chain four loose pieces of the stored mock scan (a "neighbors" group of them whose cells don't
 * touch links them one after the other) and reload. Returns the chain's item keys in order.
 */
async function addChain(page: Page): Promise<string[]> {
  const linked = new Set((await page.getByTestId('link').evaluateAll((gs) => gs.flatMap((g) => [g.getAttribute('data-a'), g.getAttribute('data-b')]))) as string[]);
  const loose = (await page.locator('[data-testid="scan-overlay"] [data-testid^="item-r"]').evaluateAll((gs) => gs.map((g) => g.getAttribute('data-testid')!.slice(5)))).filter((k) => !linked.has(k));
  expect(loose.length, 'loose pieces in the mock scan').toBeGreaterThanOrEqual(4);
  const chain = loose.slice(0, 4);
  await page.evaluate(async (regionIds) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('puzzle-solver');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const done = (req: IDBRequest) => new Promise((resolve) => (req.onsuccess = () => resolve(req.result)));
    const store = db.transaction('scans', 'readwrite').objectStore('scans');
    const [scan] = (await done(store.getAll())) as { result: { groups?: { id: number }[] } }[];
    const groups = scan.result.groups ?? [];
    groups.push({ id: Math.max(0, ...groups.map((g) => g.id)) + 1, kind: 'neighbors', regionIds, cells: [], bounds: { row0: 0, col0: 0, row1: 0, col1: 0 }, x: 0, y: 0, confidence: 0.5 } as { id: number });
    scan.result.groups = groups;
    await done(store.put(scan));
    db.close();
  }, chain.map((k) => Number(k.slice(1))));
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  // The chain: three links, one after the other (unless two of the cells happen to touch).
  for (let i = 1; i < chain.length; i++) {
    await expect(page.locator(`[data-testid="link"][data-a="${chain[i - 1]}"][data-b="${chain[i]}"]`)).toHaveCount(1);
  }
  return chain;
}

test('result screen: a selection lights up its connections of connections, and lines flow to the bigger side', async ({ page }, info) => {
  await createPuzzleAndScan(page);
  const [k0, k1, k2, k3] = await addChain(page);
  const levelOf = (k: string) => page.getByTestId(`item-${k}`).getAttribute('data-level');

  // The lines of the chain flow toward its anchor (all single pieces: the one with the most links,
  // then the first in the order) – as the pure function says.
  const order = await page.locator('[data-testid="scan-overlay"] [data-testid^="item-"]').evaluateAll((gs) => gs.map((g) => g.getAttribute('data-testid')!.slice(5)));
  const chainLinks = [
    { a: k0, b: k1 },
    { a: k1, b: k2 },
    { a: k2, b: k3 },
  ];
  const expected = flowDirections(
    order.filter((k) => [k0, k1, k2, k3].includes(k)).map((key) => ({ key, pieceCount: 1 })),
    chainLinks,
  );
  for (const l of chainLinks) {
    await expect(page.locator(`[data-testid="link"][data-a="${l.a}"][data-b="${l.b}"]`)).toHaveAttribute('data-flow', expected.get(linkId(l))!);
  }

  // Select the chain's end: its neighbour at level 1 (cyan, ring), the next ones at levels 2 and 3
  // – lighter, thinner, no ring, but clearly not faded – and the lines between them to match.
  await page.getByTestId(`label-${k0}`).click();
  await expect(page.getByTestId(`item-${k0}`)).toHaveClass(/\bselected\b/);
  expect(await levelOf(k1)).toBe('1');
  expect(await levelOf(k2)).toBe('2');
  expect(await levelOf(k3)).toBe('3');
  await expect(page.getByTestId(`item-${k1}`)).toHaveClass(/\blinked\b/);
  for (const k of [k2, k3]) {
    await expect(page.getByTestId(`item-${k}`)).toHaveClass(/\blinked2\b/);
    await expect(page.getByTestId(`item-${k}`)).not.toHaveClass(/\bfaded\b/);
    await expect.poll(() => page.getByTestId(`label-${k}`).evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    await expect(page.getByTestId(`ring-${k}`)).toHaveCount(0);
  }
  await expect(page.getByTestId(`ring-${k1}`)).toBeVisible();
  const lv2 = page.locator(`[data-testid="link"][data-a="${k1}"][data-b="${k2}"]`);
  await expect(lv2).toHaveAttribute('data-level', '2');
  const l2 = await lineStyle(lv2);
  expect(l2.stroke).toBe('rgb(166, 243, 255)');
  expect(l2.px).toBeLessThan((await lineStyle(page.locator('[data-testid="link"][data-level="1"]').first())).px);
  await expect(page.locator(`[data-testid="link"][data-a="${k2}"][data-b="${k3}"]`)).toHaveAttribute('data-level', '3');
  // The bar names the direct connection and counts the rest.
  await expect(page.getByTestId('selection-beyond')).toHaveText(/2 more beyond/);
  await shot(page, info, '01f-chain-selected');

  // The box picture (Both) and the full-screen view show the same reach.
  await page.getByRole('radio', { name: 'Both' }).click();
  await expect(page.getByTestId(`marker-${k2}`)).toHaveClass(/\blinked2\b/);
  await expect(page.getByTestId(`marker-${k1}`)).toHaveClass(/\blinked\b/);
  await page.getByTestId('open-fullscreen-photo').click();
  const fs = page.getByTestId('fullscreen');
  await expect(fs.getByTestId(`item-${k3}`)).toHaveAttribute('data-level', '3');
  await fs.getByTestId('fullscreen-close').click();

  // From the middle: both neighbours at level 1, the far end at level 2.
  await page.getByTestId(`mention-${k1}`).click();
  await expect(page.getByTestId(`item-${k1}`)).toHaveClass(/\bselected\b/);
  expect(await levelOf(k0)).toBe('1');
  expect(await levelOf(k2)).toBe('1');
  expect(await levelOf(k3)).toBe('2');

  // Reduced motion: still dotted, nothing moves.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await lineStyle(page.locator('[data-testid="link"][data-level="1"]').first());
  expect(still.dash).toHaveLength(2);
  expect(still.flow).toEqual([]);
});

test('result screen: a one-finger drag on the images scrolls the page until zoomed in', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium' || !info.project.use.hasTouch, 'real touch input via CDP (Chromium with touch)');
  await createPuzzleAndScan(page);
  await page.getByRole('radio', { name: 'Both' }).click();
  const cdp = await page.context().newCDPSession(page);
  const drag = async (x: number, y0: number, y1: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 10 }] });
    // Hold still before lifting the finger: no fling that keeps scrolling afterwards.
    await page.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const scrollY = () => page.evaluate(() => window.scrollY);
  const transform = () => page.getByTestId('result-photo').locator('.zoompan-content').evaluate((el) => (el as HTMLElement).style.transform);

  // At the fit zoom: dragging up on the photo – and on the picture – scrolls the page.
  for (const testId of ['result-photo', 'result-ref']) {
    const frame = testId === 'result-photo' ? page.getByTestId('result-photo') : page.locator('.result-ref');
    await frame.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -40));
    const b = (await frame.boundingBox())!;
    const y = Math.min(b.y + b.height * 0.6, page.viewportSize()!.height - 120);
    const before = await scrollY();
    await drag(b.x + b.width / 2, y, y - 200);
    await expect.poll(scrollY, { message: `drag on ${testId} scrolls the page` }).toBeGreaterThan(before + 60);
  }

  // Zoomed in (double-tap): one finger pans the image and the page stays put.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(scrollY).toBe(0);
  const photo = page.getByTestId('result-photo');
  const b = (await photo.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
  await expect(photo.getByRole('button', { name: 'Show whole picture' })).toBeVisible();
  const t0 = await transform();
  const before = await scrollY();
  await drag(b.x + b.width / 2, b.y + b.height * 0.6, b.y + b.height * 0.3);
  await expect.poll(transform).not.toBe(t0);
  expect(Math.abs((await scrollY()) - before)).toBeLessThan(5);
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
  await expect(pickup).toContainText('Close-up');
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
  // At least 30 % of the view's short side (on a wide screen the view is wide and short).
  expect((await overview.boundingBox())!.width / Math.min(view.width, view.height)).toBeGreaterThan(0.3);
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

/** A turn in plain words (never bare degrees), then where it goes. */
const TURN_WORDS = /^(Already the right way up|Turn it (a little|half a quarter|a quarter|nearly halfway round) to the (right|left)|Turn it upside down) · /;
/** The exact angle, only in the small print. */
const EXACT = /^(\d{1,3}° (clockwise|counter-clockwise)|180°)$/;

/** Skip through the placing steps until one whose turn guide is in `mode`; false at the end. */
async function stepToTurn(page: Page, mode: 'animate' | 'frames' | 'upright'): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await page.getByTestId('placing-done').isVisible()) return false;
    const guide = page.getByTestId('turn-guide');
    if ((await guide.count()) > 0 && (await guide.getAttribute('data-mode')) === mode) return true;
    await act(page, 'skip');
  }
  return false;
}

test('guided placing: the piece turns upright on screen, a "top" bar, plain words', async ({ page }, info) => {
  await createPuzzleAndScan(page);
  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  expect(await stepToTurn(page, 'animate'), 'a step with a piece to turn').toBe(true);

  // The pick-up view shows the piece as it lies, with a "top" bar on the edge that goes on top.
  const pickup = page.getByTestId('pickup');
  await expect(pickup.getByTestId('top-bar').locator('.top-bar')).toHaveCount(1);
  await expect(pickup.locator('.top-label')).toHaveText('top');
  await expect(pickup).toHaveAttribute('aria-label', /"top" goes on top/);

  const line = (await page.getByTestId('instruction').textContent())!;
  expect(line).toMatch(TURN_WORDS);
  expect(line).not.toMatch(/°/);
  const exact = page.getByTestId('instruction-exact');
  await expect(exact).toHaveText(EXACT);
  const exactText = (await exact.textContent())!;

  // The cut-out piece (one pre-drawn image, with its "top" bar) turns with a CSS animation – three
  // loops – the short way, as the words say; the arc arrow grows with it.
  const guide = page.getByTestId('turn-guide');
  await expect(guide.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(guide.locator('.turn-top .top-bar')).toHaveCount(1);
  await expect(guide.locator('.turn-arc-grow')).toHaveCount(1);
  await expect(guide.locator('.turn-arc-head')).toHaveCount(1);
  expect(await guide.getAttribute('aria-label')).toContain(line.split(' · ')[0]);
  const turn = await guide.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue('--turn')));
  expect(Math.round(Math.abs(turn))).toBe(Number(exactText.match(/\d+/)![0]));
  if (/counter/.test(exactText)) expect(turn).toBeLessThan(0);
  else expect(turn).toBeGreaterThan(0);
  if (/to the right/.test(line)) expect(turn).toBeGreaterThan(0);
  if (/to the left/.test(line)) expect(turn).toBeLessThan(0);
  const spin = () =>
    guide.evaluate((el) => {
      const a = el.querySelector('.turn-spin')!.getAnimations()[0] as CSSAnimation | undefined;
      return a ? { name: a.animationName, iterations: a.effect?.getTiming().iterations, state: a.playState, t: Number(a.currentTime) } : undefined;
    });
  expect(await spin()).toMatchObject({ name: 'piece-turn', iterations: 3, state: 'running' });
  await shot(page, info, '06-turn-animated');

  // A tap replays it from the start.
  await page.waitForTimeout(900);
  const before = (await spin())!.t;
  await guide.click();
  const after = await spin();
  expect(after?.state).toBe('running');
  expect(after!.t).toBeLessThan(before);

  // Already upright (when the scan has such a piece): no animation, a "right way up" mark.
  if (await stepToTurn(page, 'upright')) {
    await expect(page.getByTestId('instruction')).toHaveText(/^Already the right way up · /);
    await expect(guide.locator('.turn-ok')).toHaveText('✓ right way up');
    expect(await guide.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  }
});

test('guided placing with reduced motion: "now → then" side by side, nothing moves', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await createPuzzleAndScan(page);
  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();

  let frames = 0;
  for (let i = 0; i < 60 && !(await page.getByTestId('placing-done').isVisible()); i++) {
    const guide = page.getByTestId('turn-guide');
    const line = (await page.getByTestId('instruction').textContent())!;
    if ((await guide.count()) > 0) {
      expect(line).toMatch(TURN_WORDS);
      const mode = await guide.getAttribute('data-mode');
      expect(mode).not.toBe('animate');
      if (mode === 'frames') {
        await expect(guide.locator('.turn-frame-cap')).toHaveText(['Now', 'Then']);
        await expect(guide.locator('.turn-frame img')).toHaveCount(2);
        await expect(guide.locator('.turn-arc-icon')).toBeVisible();
        expect(await guide.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
        if (frames++ === 0) await shot(page, info, '07-turn-reduced-motion');
      } else {
        await expect(guide.locator('.turn-ok')).toBeVisible();
      }
    } else {
      // Unknown turn (a group whose pieces disagree): just where it goes.
      expect(line).not.toMatch(/^(Turn|Already)/);
    }
    await act(page, 'skip');
  }
  expect(frames).toBeGreaterThan(0);
});
