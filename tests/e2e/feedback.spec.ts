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

interface PhotoRegion {
  id: number;
  hidden: boolean;
  tone: string;
  /** Centre as a fraction of the photo. */
  fx: number;
  fy: number;
  /** Bounding box as fractions of the photo. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Detected regions as drawn on the feedback photo. */
async function photoRegions(page: Page): Promise<PhotoRegion[]> {
  return page.getByTestId('fb-photo').evaluate((svg) => {
    const vb = (svg as SVGSVGElement).viewBox.baseVal;
    return [...svg.querySelectorAll('[data-testid^="fb-region-"]')].map((g) => {
      const bb = (g.querySelector('.fb-line') as SVGGraphicsElement).getBBox();
      return {
        id: Number(g.getAttribute('data-testid')!.slice('fb-region-'.length)),
        hidden: g.getAttribute('data-hidden') === 'true',
        tone: g.getAttribute('data-tone') ?? '',
        fx: Number(g.getAttribute('data-cx')) / vb.width,
        fy: Number(g.getAttribute('data-cy')) / vb.height,
        x0: bb.x / vb.width,
        y0: bb.y / vb.height,
        x1: (bb.x + bb.width) / vb.width,
        y1: (bb.y + bb.height) / vb.height,
      };
    });
  });
}

/** Points (fractions of the photo) well away from every detected region and from each other. */
async function emptySpots(page: Page, n: number): Promise<{ fx: number; fy: number }[]> {
  const regions = await photoRegions(page);
  const box = (await page.getByTestId('fb-photo').boundingBox())!;
  const mx = 26 / box.width;
  const my = 26 / box.height;
  const spots: { fx: number; fy: number }[] = [];
  for (let fy = 0.04; fy < 0.8 && spots.length < n; fy += 0.02) {
    for (let fx = 0.04; fx < 0.8 && spots.length < n; fx += 0.02) {
      const free = regions.every((r) => fx < r.x0 - mx || fx > r.x1 + mx || fy < r.y0 - my || fy > r.y1 + my);
      const apart = spots.every((p) => Math.hypot((p.fx - fx) * box.width, (p.fy - fy) * box.height) > 60);
      if (free && apart) spots.push({ fx, fy });
    }
  }
  expect(spots, 'empty spots on the photo').toHaveLength(n);
  return spots;
}

/** Tap the feedback photo at a point given as fractions of the photo. */
async function tapPhoto(page: Page, fx: number, fy: number) {
  const photo = page.getByTestId('fb-photo');
  const box = (await photo.boundingBox())!;
  await photo.click({ position: { x: fx * box.width, y: fy * box.height } });
}

/** Regions whose centre is easy to tap (not under the zoom buttons in the bottom-right corner). */
function tappable(regions: PhotoRegion[]): PhotoRegion[] {
  return regions.filter((r) => r.fx < 0.8 || r.fy < 0.75);
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

  // Every detection is coloured like on the result screen; the hidden ones are hatched grey.
  await expect(page.getByTestId('fb-photo-hint')).toHaveText('Coloured = found by the app. Tap Missed piece and then any piece without colour.');
  await expect(page.getByTestId('fb-key')).toContainText('Found but not shown');
  const regions = await photoRegions(page);
  expect(regions.length).toBeGreaterThan(5);
  expect(regions.filter((r) => r.hidden).length).toBeGreaterThan(0);
  expect(new Set(regions.map((r) => r.tone))).toEqual(new Set(['confident', 'ambiguous', 'patch', 'hidden']));
  const fillOf = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fill);
  expect(await fillOf('.fb-region.st-confident .fb-fill')).toBe('rgb(34, 197, 94)');
  expect(await fillOf('.fb-region.st-ambiguous .fb-fill')).toBe('rgb(245, 158, 11)');
  expect(await fillOf('.fb-region.is-hidden .fb-fill')).toMatch(/^url\(/);

  // Missed piece (default mode) on empty spots: tap twice, then tap the second marker to remove it.
  await expect(page.getByTestId('fb-mode-missed')).toHaveAttribute('aria-checked', 'true');
  const [spot, spot2] = await emptySpots(page, 2);
  await tapPhoto(page, spot.fx, spot.fy);
  await tapPhoto(page, spot2.fx, spot2.fy);
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(2);
  await page.getByTestId('fb-missed-1').click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(1);

  // "Missed" on a piece the app did find: a note instead of a mark, with better marks one tap away.
  const shown = tappable(regions.filter((r) => !r.hidden && r.tone !== 'patch'));
  const [a, b, c] = shown.map((r) => r.id);
  expect(c, 'three tappable found pieces').toBeDefined();
  const regionB = shown[1];
  await tapPhoto(page, regionB.fx, regionB.fy);
  const note = page.getByTestId('fb-found-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(regionB.tone === 'ambiguous' ? 'This piece was found (unsure)' : 'This piece was found');
  await expect(note).toContainText('use Wrong place or Wrong outline instead?');
  await expect(page.getByTestId(`fb-region-${b}`)).toHaveClass(/pending/);
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(1);
  await shot(page, info, '0-found-note');
  await page.getByTestId('fb-found-bad_outline').click();
  await expect(note).toHaveCount(0);
  await expect(page.getByTestId('fb-mark-1')).toHaveAttribute('data-kind', 'bad_outline');
  // … or added anyway (then removed again from the list).
  await tapPhoto(page, shown[2].fx, shown[2].fy);
  await page.getByTestId('fb-found-missed').click();
  await expect(page.getByTestId('fb-mark-2')).toHaveAttribute('data-kind', 'missed');
  await page.getByTestId('fb-remove-2').click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(2);
  // A found-but-hidden piece says so; dismissing adds nothing.
  const hiddenRegion = tappable(regions.filter((r) => r.hidden)).sort((p, q) => (q.x1 - q.x0) * (q.y1 - q.y0) - (p.x1 - p.x0) * (p.y1 - p.y0))[0];
  await tapPhoto(page, hiddenRegion.fx, hiddenRegion.fy);
  await expect(note).toContainText('This piece was found but not shown');
  await expect(page.getByTestId('fb-found-wrong_place')).toHaveCount(0);
  await page.getByTestId('fb-found-dismiss').click();
  await expect(note).toHaveCount(0);
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(2);

  // Not a piece – on a region the results hide.
  const hiddenId = hiddenRegion.id;
  await page.getByTestId('fb-mode-not_a_piece').click();
  await page.getByTestId(`fb-hit-${hiddenId}`).click();
  // Several pieces / wrong place on found pieces; a second tap removes a mark.
  await page.getByTestId('fb-mode-merged').click();
  await page.getByTestId(`fb-hit-${a}`).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(4);
  await page.getByTestId(`fb-hit-${a}`).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(3);
  await page.getByTestId(`fb-hit-${a}`).click();
  await page.getByTestId('fb-mode-wrong_place').click();
  await page.getByTestId(`fb-hit-${c}`).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(5);
  await expect(page.getByTestId('fb-mark-2')).toContainText('Not a piece');
  await expect(page.getByTestId('fb-mark-2')).toContainText('found but not shown');
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
  expect(bundle.marks.map((m) => m.kind)).toEqual(['missed', 'bad_outline', 'not_a_piece', 'merged', 'wrong_place']);
  for (const m of bundle.marks) {
    if (m.kind === 'missed') {
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(scan.result.width);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(scan.result.height);
      // Where it was tapped – on no detected region.
      expect(Math.abs(m.x / scan.result.width - spot.fx)).toBeLessThan(0.02);
      expect(Math.abs(m.y / scan.result.height - spot.fy)).toBeLessThan(0.02);
    } else {
      expect(regionIds.has(m.regionId)).toBe(true);
    }
  }
  expect(bundle.marks[1]).toEqual({ kind: 'bad_outline', regionId: b });
  expect(bundle.marks[2]).toEqual({ kind: 'not_a_piece', regionId: hiddenId });
  expect(bundle.marks[3]).toEqual({ kind: 'merged', regionId: a });
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


test('share on Android: JSON files cannot be shared there, so the same content goes out as .txt', async ({ page }) => {
  // Chrome on Android shares text/plain files but not application/json.
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: { name: string; type: string; text: string }[] };
    w.__shared = [];
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data: { files?: File[] }) => !!data.files?.length && data.files.every((f) => f.type === 'text/plain'),
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files: File[] }) => {
        const f = data.files[0];
        w.__shared.push({ name: f.name, type: f.type, text: await f.text() });
      },
    });
  });
  await createPuzzle(page);
  await page.goto(`/?pipeline=mock${new URL(page.url()).hash}/feedback`);
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  await page.getByTestId('fb-create').click();
  await page.getByTestId('fb-share').click();
  await expect(page.locator('.fb-done')).toContainText('Shared');
  const shared = await page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; text: string }[] }).__shared);
  expect(shared[0].name).toMatch(/^puzzle-feedback-.*\.txt$/);
  expect(shared[0].type).toBe('text/plain');
  expect(parseFeedback(shared[0].text).box).toBeDefined();
});
