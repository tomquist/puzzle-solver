/**
 * Feedback files (mock pipeline): from the scan result's quiet link, mark one problem of each kind
 * on the photo (also on an outline the results hide), add a comment, create the file, download it
 * and check its contents with the real parser; and the box-photo/picture feedback from Settings.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeFeedbackImageBytes, parseFeedback, type FeedbackBundle, type FeedbackImage } from '../../src/feedback/format';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));

async function shot(page: Page, info: TestInfo, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `.debug/ui/${info.project.name}-feedback-${name}.png` });
}

async function createPuzzle(page: Page) {
  await page.goto('/?pipeline=mock#/new');
  await page.getByTestId('photo-upload').setInputFiles(asset('great-wave.jpg'));
  await expect(page.getByTestId('wizard-corners')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: '1000', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('wizard-reference')).toBeVisible();
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByTestId('tab-scan')).toBeVisible();
}

async function downloadFeedback(page: Page): Promise<{ bundle: FeedbackBundle; name: string }> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('fb-download').click();
  const download = await downloadPromise;
  const path = await download.path();
  return { bundle: parseFeedback(readFileSync(path, 'utf8')), name: download.suggestedFilename() };
}

function expectJpeg(img: FeedbackImage | undefined) {
  expect(img).toBeDefined();
  expect(img!.type).toBe('image/jpeg');
  expect(img!.width).toBeGreaterThan(100);
  expect(img!.height).toBeGreaterThan(100);
  const bytes = decodeFeedbackImageBytes(img!);
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
}

/** Id of the first outline with the given visibility on the feedback photo. */
async function regionId(page: Page, hidden: boolean, skip: number[] = []): Promise<number> {
  const ids = await page
    .locator(`[data-testid^="fb-region-"][data-hidden="${hidden}"]`)
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-testid')!.replace('fb-region-', ''))));
  const id = ids.find((i) => !skip.includes(i));
  expect(id, `a ${hidden ? 'hidden' : 'visible'} outline`).toBeDefined();
  return id!;
}

test('scan feedback: marks of every kind, comment, file with photos and marks', async ({ page }, info) => {
  await createPuzzle(page);
  await page.getByTestId('photo-upload').setInputFiles(asset('starry-night.jpg'));
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  // Confirm some placements – they become ground truth in the file.
  await page.getByTestId('place-all').click();

  // The quiet link at the end of the result.
  const link = page.getByTestId('scan-feedback-link');
  await link.scrollIntoViewIfNeeded();
  await expect(link).toHaveText('Something wrong with this scan? Send feedback');
  await link.click();
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  await expect(page.getByTestId('fb-privacy')).toHaveText('The file contains your photos. Nothing is sent automatically – you choose where to send it.');
  const photo = page.getByTestId('fb-photo');
  await expect(photo).toBeVisible();

  // All outlines are drawn, including the ones the result screen hides.
  expect(await page.locator('[data-testid^="fb-region-"]').count()).toBeGreaterThan(5);
  expect(await page.locator('[data-testid^="fb-region-"][data-hidden="true"]').count()).toBeGreaterThan(0);

  // Missed piece (default mode): tap twice, then tap the second marker to remove it again.
  await expect(page.getByTestId('fb-mode-missed')).toHaveAttribute('aria-checked', 'true');
  const box = (await photo.boundingBox())!;
  await photo.click({ position: { x: box.width * 0.06, y: box.height * 0.08 } });
  await photo.click({ position: { x: box.width * 0.5, y: box.height * 0.08 } });
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(2);
  await page.getByTestId('fb-missed-1').click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(1);

  // Not a piece – on an outline the results hide.
  const hiddenId = await regionId(page, true);
  await page.getByTestId('fb-mode-not_a_piece').click();
  await page.getByTestId(`fb-hit-${hiddenId}`).click();
  // Several pieces / wrong outline / wrong place on visible pieces; a second tap removes a mark.
  const a = await regionId(page, false);
  const b = await regionId(page, false, [a]);
  const c = await regionId(page, false, [a, b]);
  await page.getByTestId('fb-mode-merged').click();
  await page.getByTestId(`fb-hit-${a}`).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(3);
  await page.getByTestId(`fb-hit-${a}`).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(2);
  await page.getByTestId(`fb-hit-${a}`).click();
  await page.getByTestId('fb-mode-bad_outline').click();
  await page.getByTestId(`fb-hit-${b}`).click();
  await page.getByTestId('fb-mode-wrong_place').click();
  await page.getByTestId(`fb-hit-${c}`).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(5);
  await expect(page.getByTestId('fb-mark-1')).toContainText('Not a piece');
  await expect(page.getByTestId('fb-mark-1')).toContainText('not shown in results');
  await shot(page, info, '1-marks');

  // The right place for the wrongly placed piece (optional).
  await page.getByTestId('fb-correct-4').click();
  const picture = page.getByTestId('fb-correct-picture');
  await expect(picture).toBeVisible();
  const pbox = (await picture.boundingBox())!;
  await picture.click({ position: { x: pbox.width * 0.3, y: pbox.height * 0.6 } });
  await shot(page, info, '2-right-place');
  await page.getByTestId('fb-correct-done').click();
  await expect(page.getByTestId('fb-mark-4')).toContainText('goes to row');

  await page.getByTestId('fb-comment').fill('Dark table, two pieces touching.');
  await expect(page.getByTestId('fb-include-reference')).toBeChecked();
  await expect(page.getByTestId('fb-include-box')).toBeChecked();
  await page.getByTestId('fb-create').click();
  await expect(page.getByTestId('fb-download')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fb-file-size')).toHaveText(/^\d+(\.\d)? (KB|MB)$/);
  console.log(`[${info.project.name}] feedback file size: ${await page.getByTestId('fb-file-size').textContent()}`);
  await shot(page, info, '3-file');

  const { bundle, name } = await downloadFeedback(page);
  expect(name).toMatch(/^puzzle-feedback-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  await expect(page.locator('.fb-done')).toBeVisible();

  // Photos: scan, reference, box (with its corners).
  expectJpeg(bundle.scan?.photo);
  expectJpeg(bundle.reference);
  expectJpeg(bundle.box?.photo);
  expect(bundle.box!.quad).toHaveLength(4);
  const scan = bundle.scan!;
  expect(scan.photo.width).toBe(scan.result.width);
  expect(scan.photo.height).toBe(scan.result.height);
  expect(scan.placements.length).toBeGreaterThan(0);
  const regionIds = new Set(scan.result.regions.map((r) => r.id));
  for (const p of scan.placements) expect(regionIds.has(p.regionId)).toBe(true);

  // Marks: one of each kind, in photo coordinates / on existing regions.
  expect(bundle.marks.map((m) => m.kind)).toEqual(['missed', 'not_a_piece', 'merged', 'bad_outline', 'wrong_place']);
  for (const m of bundle.marks) {
    if (m.kind === 'missed') {
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(scan.result.width);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(scan.result.height);
      // Tapped at ~6 % / 8 % of the photo.
      expect(Math.abs(m.x / scan.result.width - 0.06)).toBeLessThan(0.03);
      expect(Math.abs(m.y / scan.result.height - 0.08)).toBeLessThan(0.03);
    } else {
      expect(regionIds.has(m.regionId)).toBe(true);
    }
  }
  expect(bundle.marks[1]).toEqual({ kind: 'not_a_piece', regionId: hiddenId });
  expect(bundle.marks[2]).toEqual({ kind: 'merged', regionId: a });
  expect(bundle.marks[3]).toEqual({ kind: 'bad_outline', regionId: b });
  const wrong = bundle.marks[4];
  expect(wrong.kind === 'wrong_place' && wrong.regionId === c && wrong.correct).toBeTruthy();
  if (wrong.kind === 'wrong_place' && wrong.correct) {
    expect(wrong.correct.row).toBeLessThan(bundle.puzzle.grid.rows);
    expect(wrong.correct.col).toBeLessThan(bundle.puzzle.grid.cols);
  }
  expect(bundle.comment).toBe('Dark table, two pieces touching.');

  // App and puzzle facts – never the puzzle's name.
  expect(bundle.app.version).toBeTruthy();
  expect(bundle.app.userAgent).toBeTruthy();
  expect(bundle.app.viewport.width).toBeGreaterThan(0);
  expect(bundle.puzzle.pieceCount).toBe(1000);
  expect(JSON.stringify(bundle.puzzle)).not.toContain('Great Wave');

  // Changing anything makes the file stale again.
  await page.getByTestId('fb-comment').fill('Dark table.');
  await expect(page.getByTestId('fb-create')).toBeVisible();
});

test('settings feedback: box photo and puzzle picture without a scan', async ({ page }, info) => {
  await createPuzzle(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('tab-settings')).toBeVisible();
  const entry = page.getByTestId('settings-feedback');
  await entry.scrollIntoViewIfNeeded();
  await expect(entry).toHaveText('Send feedback about the box photo / picture');
  await entry.click();
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  await expect(page.getByTestId('fb-photo')).toHaveCount(0);
  await expect(page.getByTestId('fb-include-box')).toBeChecked();
  await shot(page, info, '4-settings');

  await page.getByTestId('fb-create').click();
  let { bundle } = await downloadFeedback(page);
  expect(bundle.scan).toBeUndefined();
  expect(bundle.marks).toEqual([]);
  expectJpeg(bundle.box?.photo);
  expect(bundle.box!.quad).toHaveLength(4);
  expectJpeg(bundle.reference);

  // Box photo only.
  await page.getByTestId('fb-include-reference').uncheck();
  await page.getByTestId('fb-create').click();
  ({ bundle } = await downloadFeedback(page));
  expect(bundle.reference).toBeUndefined();
  expectJpeg(bundle.box?.photo);
  expect(bundle.scan).toBeUndefined();
});

test('share: the file goes to the share sheet where files can be shared; cancelling is quiet', async ({ page }) => {
  // A browser that can share files (like Safari on iPhone): record what is shared, cancel the 2nd time.
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: { name: string; type: string; text: string }[]; __shareCalls: number };
    w.__shared = [];
    w.__shareCalls = 0;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: { files?: File[] }) => !!data.files?.length });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files: File[] }) => {
        w.__shareCalls++;
        if (w.__shareCalls === 2) throw new DOMException('Share canceled', 'AbortError');
        const f = data.files[0];
        w.__shared.push({ name: f.name, type: f.type, text: await f.text() });
      },
    });
  });
  await createPuzzle(page);
  await page.goto(`/?pipeline=mock${new URL(page.url()).hash}/feedback`);
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  await page.getByTestId('fb-create').click();
  await expect(page.getByTestId('fb-share')).toBeVisible();
  await expect(page.getByTestId('fb-download')).toBeVisible();
  await page.getByTestId('fb-share').click();
  await expect(page.locator('.fb-done')).toContainText('Shared');
  const shared = await page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; text: string }[] }).__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0].name).toMatch(/^puzzle-feedback-.*\.json$/);
  expect(shared[0].type).toBe('application/json');
  const bundle = parseFeedback(shared[0].text);
  expect(bundle.box).toBeDefined();
  expect(bundle.scan).toBeUndefined();
  // Closing the share sheet shows no error.
  await page.getByTestId('fb-share').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shareCalls: number }).__shareCalls)).toBe(2);
  await expect(page.getByText('Sharing didn’t work')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

