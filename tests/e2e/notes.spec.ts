/**
 * Notes for feedback (mock pipeline): "Doesn't fit" on a connection of the selected piece and "Not
 * this one" / "Not here" on its spot are noted with the scan – with Undo, kept across a reload –
 * and the feedback screen starts with them marked (removable); once the file is saved they are
 * marked sent. Screenshots of the new UI (light and dark) go to $NOTES_UI_DIR or .debug/ui/.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFeedback, type FeedbackBundle } from '../../src/feedback/format';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));
const SHOTS = process.env.NOTES_UI_DIR ?? '.debug/ui';

async function shot(page: Page, info: TestInfo, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-notes-${name}.png` });
}

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

/** createPuzzleAndScan until the mock scan has connection lines (it seeds its pieces randomly). */
async function createPuzzleWithLinks(page: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await createPuzzleAndScan(page);
    if ((await page.getByTestId('link').count()) > 0) return;
  }
  throw new Error('No mock scan with connection lines after 4 puzzles');
}

/** The connection line between two items (either way round). */
const linkBetween = (page: Page, a: string, b: string) => page.locator(`[data-testid="link"][data-a="${a}"][data-b="${b}"], [data-testid="link"][data-a="${b}"][data-b="${a}"]`);

async function downloadFeedback(page: Page): Promise<FeedbackBundle> {
  await page.getByTestId('fb-create').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('fb-download').click();
  const download = await downloadPromise;
  return parseFeedback(readFileSync((await download.path())!, 'utf8'));
}

const snackbar = (page: Page) => page.locator('.snackbar');

/**
 * The unsent notes and chosen spots stored with the scans (IndexedDB): a reload right after a tap
 * must not cut the write short in the test.
 */
async function stored(page: Page): Promise<{ notes: number; spots: number }> {
  return page.evaluate(
    () =>
      new Promise<{ notes: number; spots: number }>((resolve, reject) => {
        const open = indexedDB.open('puzzle-solver');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('scans').objectStore('scans').getAll();
          req.onsuccess = () => {
            const scans = req.result as { feedbackNotes?: { sentAt?: number }[]; spotChoices?: object }[];
            db.close();
            resolve({
              notes: scans.reduce((n, s) => n + (s.feedbackNotes ?? []).filter((x) => x.sentAt === undefined).length, 0),
              spots: scans.reduce((n, s) => n + Object.keys(s.spotChoices ?? {}).length, 0),
            });
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );
}
const storedNotes = async (page: Page) => (await stored(page)).notes;

test('doesn’t fit: noted on a connection, undone, kept across a reload, pre-filled in feedback, sent', async ({ page }, info) => {
  await createPuzzleWithLinks(page);
  const line = page.getByTestId('link').first();
  const a = (await line.getAttribute('data-a'))!;
  const b = (await line.getAttribute('data-b'))!;
  await page.getByTestId(`label-${a}`).dispatchEvent('click');
  const bar = page.getByTestId('selection-bar');
  await expect(bar).toBeVisible();
  // One "Doesn't fit" per connection, a full-size target, named for screen readers.
  const noFit = bar.getByTestId(`no-fit-${b}`);
  await expect(noFit).toBeVisible();
  await expect(noFit).toHaveAccessibleName(/^#\d+ doesn’t fit$/);
  const box = (await noFit.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await shot(page, info, '01-selected-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, info, '01-selected-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Noted: the line goes, the bar no longer offers it, a snackbar says so with Undo.
  await noFit.click();
  await expect(snackbar(page)).toContainText(/^#\d+ and #\d+ don’t fit – noted for feedback/);
  const [labelA, labelB] = ((await snackbar(page).locator('span').first().textContent()) ?? '').match(/\d+/g)!.map(Number);
  await expect(linkBetween(page, a, b)).toHaveCount(0);
  await expect(bar.getByTestId(`no-fit-${b}`)).toHaveCount(0);
  await expect(page.getByTestId('notes-link')).toHaveText(/1 note for feedback · Send/);
  await shot(page, info, '02-noted-snackbar');

  // Undo: back as it was.
  await snackbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect(linkBetween(page, a, b)).toHaveCount(1);
  await expect(page.getByTestId('notes-link')).toHaveCount(0);

  // Again, then reload: still noted, still hidden.
  if (!(await bar.isVisible())) await page.getByTestId(`piece-item-${a}`).click();
  await bar.getByTestId(`no-fit-${b}`).click();
  await expect(linkBetween(page, a, b)).toHaveCount(0);
  await expect.poll(() => storedNotes(page)).toBe(1);
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await expect(linkBetween(page, a, b)).toHaveCount(0);
  await expect(page.getByTestId('notes-link')).toHaveText(/1 note for feedback/);
  await page.getByTestId('notes-link').scrollIntoViewIfNeeded();
  await shot(page, info, '03-notes-link');

  // The feedback screen starts with it: listed (from your notes), drawn on the photo.
  await page.getByTestId('notes-link').click();
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  const row = page.getByTestId('fb-mark-0');
  await expect(row).toHaveAttribute('data-kind', 'wrong_fit');
  await expect(row).toHaveAttribute('data-noted', 'true');
  await expect(row).toContainText('Doesn’t fit');
  await expect(row).toContainText(`#${labelA} and #${labelB}`);
  await expect(row.locator('.fb-picto')).toBeVisible();
  await expect(page.getByTestId('fb-noted-hint')).toHaveText('One is from your notes on the scan result – remove any that are wrong.');
  await expect(page.getByTestId('fb-fit-0')).toBeVisible();
  await page.getByTestId('fb-photo').scrollIntoViewIfNeeded();
  await shot(page, info, '04-feedback-photo');
  await row.scrollIntoViewIfNeeded();
  await shot(page, info, '04-feedback-prefilled-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, info, '04-feedback-prefilled-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // More marks can be added as before; the file holds the noted mark.
  await page.getByTestId('fb-mode-not_a_piece').click();
  const bundle = await downloadFeedback(page);
  expect(bundle.version).toBe(2);
  expect(bundle.marks).toContainEqual(expect.objectContaining({ kind: 'wrong_fit', a: labelA, b: labelB }));
  expect(JSON.stringify(bundle.marks)).not.toContain('noteIds');
  await expect.poll(() => storedNotes(page)).toBe(0);

  // Sent: no longer offered, the connection stays hidden.
  await page.locator('.topbar').getByRole('link', { name: 'Back' }).click();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await expect(page.getByTestId('notes-link')).toHaveCount(0);
  await expect(linkBetween(page, a, b)).toHaveCount(0);
  await page.getByTestId('scan-feedback-link').click();
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  await expect(page.getByTestId('fb-mark-0')).toHaveCount(0);
});

/** Text of the spot the details sheet shows ("No more suggestions" when none is left). */
async function shownSpot(page: Page): Promise<string> {
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId('detail-spot').or(sheet.getByTestId('detail-no-spot'))).toBeVisible();
  return (await sheet.getByTestId('detail-spot').count()) ? (await sheet.getByTestId('detail-spot').textContent())! : 'none';
}

test('not here: noted in the details and while placing, kept across a reload, removable in feedback', async ({ page }, info) => {
  await createPuzzleAndScan(page);
  // A single piece with a suggested place.
  const item = page.locator('[data-testid^="piece-item-r"]').first();
  const key = (await item.getAttribute('data-testid'))!.slice('piece-item-'.length);
  await item.click();
  await page.getByTestId('selection-details').click();
  const before = await shownSpot(page);
  await page.getByTestId('not-this-one').click();
  await expect(snackbar(page)).toContainText(/^#\d+ doesn’t go there – noted for feedback/);
  await expect.poll(() => shownSpot(page)).not.toBe(before);
  const after = await shownSpot(page);
  await shot(page, info, '05-not-this-one');
  // Undo puts the spot back and drops the note.
  await snackbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => shownSpot(page)).toBe(before);
  // Again; closed and reloaded, the spot shown and the note are kept.
  await page.getByTestId('not-this-one').click();
  await expect.poll(() => shownSpot(page)).toBe(after);
  await expect.poll(() => stored(page)).toEqual({ notes: 1, spots: 1 });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.getByTestId('notes-link')).toHaveText(/1 note for feedback/);
  await page.getByTestId(`piece-item-${key}`).click();
  await page.getByTestId('selection-details').click();
  expect(await shownSpot(page)).toBe(after);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // In the feedback screen: a wrong place with the rejected spot; removing it removes the note.
  await page.getByTestId('notes-link').click();
  const row = page.getByTestId('fb-mark-0');
  await expect(row).toHaveAttribute('data-kind', 'wrong_place');
  await expect(row).toContainText(/· not row \d+, column \d+/);
  await page.getByTestId('fb-remove-0').click();
  await expect(page.getByTestId('fb-mark-0')).toHaveCount(0);
  await expect.poll(() => storedNotes(page)).toBe(0);
  await page.locator('.topbar').getByRole('link', { name: 'Back' }).click();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await expect(page.getByTestId('notes-link')).toHaveCount(0);

  // While placing: "Not here" on the first step is noted too (and undone, and again).
  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  const instruction = await page.getByTestId('instruction').textContent();
  await page.getByTestId('not-here').click();
  await expect(snackbar(page)).toContainText(/doesn’t go there – noted for feedback/);
  await expect.poll(() => page.getByTestId('instruction').textContent()).not.toBe(instruction);
  await shot(page, info, '06-placing-not-here');
  await snackbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => page.getByTestId('instruction').textContent()).toBe(instruction);
  await page.getByTestId('not-here').click();
  await expect.poll(() => page.getByTestId('instruction').textContent()).not.toBe(instruction);
  await expect.poll(() => storedNotes(page)).toBe(1);
  await page.goBack();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.getByTestId('notes-link')).toHaveText(/1 note for feedback/);

  // Kept in feedback and sent with the file: then marked sent.
  await page.getByTestId('notes-link').click();
  await expect(page.getByTestId('fb-mark-0')).toHaveAttribute('data-kind', 'wrong_place');
  const bundle = await downloadFeedback(page);
  const mark = bundle.marks.find((m) => m.kind === 'wrong_place');
  expect(mark && mark.kind === 'wrong_place' && mark.rejected).toHaveLength(1);
  await expect.poll(() => storedNotes(page)).toBe(0);
  await page.locator('.topbar').getByRole('link', { name: 'Back' }).click();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await expect(page.getByTestId('notes-link')).toHaveCount(0);
});

test('doesn’t fit in the details sheet and while placing', async ({ page }, info) => {
  await createPuzzleWithLinks(page);
  const line = page.getByTestId('link').first();
  const a = (await line.getAttribute('data-a'))!;
  const b = (await line.getAttribute('data-b'))!;
  await page.getByTestId(`label-${a}`).dispatchEvent('click');
  await page.getByTestId('selection-details').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId(`detail-no-fit-${b}`)).toBeVisible();
  await sheet.getByTestId('detail-connections').scrollIntoViewIfNeeded();
  await shot(page, info, '07-details-connections');
  await sheet.getByTestId(`detail-no-fit-${b}`).click();
  await expect(snackbar(page)).toContainText(/don’t fit – noted for feedback/);
  await expect(sheet.getByTestId(`detail-no-fit-${b}`)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(linkBetween(page, a, b)).toHaveCount(0);

  // Placing: a step with a piece it joins offers "#n doesn't fit".
  await page.getByTestId('selection-clear').click();
  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  const total = Number(((await page.locator('.topbar-sub').textContent()) ?? '').match(/of (\d+)/)?.[1] ?? 0);
  let found = false;
  for (let i = 0; i < total && !found; i++) {
    const btn = page.locator('[data-testid^="place-no-fit-"]').first();
    if (await btn.count()) {
      await shot(page, info, '08-placing-no-fit');
      await btn.click();
      await expect(snackbar(page)).toContainText(/don’t fit – noted for feedback/);
      found = true;
    } else await page.keyboard.press('ArrowRight');
  }
  if (found) {
    await page.goBack();
    await expect(page.getByTestId('notes-link')).toHaveText(/2 notes for feedback/);
  }
});
