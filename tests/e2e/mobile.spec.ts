/**
 * Mobile audit: walks every main screen with the mock pipeline and checks each one with
 * auditPage() (see audit.ts for the rules). Runs on the device matrix in playwright.config.ts;
 * screenshots go to .debug/mobile/<project>-<screen>.png and a JSON summary to
 * .debug/mobile/<project>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { auditPage, formatViolations, type Violation } from './audit';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));

class Auditor {
  readonly results: Record<string, Violation[]> = {};
  constructor(
    private page: Page,
    private info: TestInfo,
  ) {}

  async check(screen: string) {
    // Let images decode, sheets finish their entry animation and layout settle.
    await this.page.waitForTimeout(250);
    await this.page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    );
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await this.page.screenshot({ path: `.debug/mobile/${this.info.project.name}-${screen}.png` });
    const t0 = Date.now();
    const vs = await auditPage(this.page);
    if (process.env.AUDIT_TIMING) console.log(`${screen}: audit ${Date.now() - t0} ms`);
    this.results[screen] = vs;
    expect.soft(vs, `${this.info.project.name} / ${screen}:\n${formatViolations(vs)}`).toEqual([]);
  }

  save() {
    mkdirSync('.debug/mobile', { recursive: true });
    const summary = Object.fromEntries(Object.entries(this.results).map(([k, v]) => [k, v.length]));
    writeFileSync(`.debug/mobile/${this.info.project.name}.json`, JSON.stringify({ summary, violations: this.results }, null, 2));
  }
}

/**
 * CI runners and many Android phones render wider system fonts than the dev machine. On the
 * narrowest device every screen is audited with deliberately wide text, so layouts that only fit
 * with narrow fonts fail here instead of on CI or on a user's phone.
 */
const WIDE_FONT_PROJECTS = new Set(['android-small']);

test('mobile audit: every main screen', async ({ page }, info) => {
  test.setTimeout(240_000);
  if (WIDE_FONT_PROJECTS.has(info.project.name)) {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent =
          'html, body, button, input, label, a { font-family: Verdana, "DejaVu Sans", sans-serif !important; letter-spacing: 0.03em !important; }';
        document.head.appendChild(style);
      });
    });
  }
  const a = new Auditor(page, info);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?pipeline=mock');
  await expect(page.getByRole('heading', { name: 'Find where every piece goes' })).toBeVisible();
  await a.check('01-home-empty');

  // Wizard 1: box photo
  await page.getByRole('link', { name: 'New puzzle' }).first().click();
  await expect(page.getByTestId('wizard-photo')).toBeVisible();
  await a.check('02-wizard-photo');
  await page.getByTestId('photo-upload').setInputFiles(asset('great-wave.jpg'));

  // Wizard 2: corners
  await expect(page.getByTestId('wizard-corners')).toBeVisible();
  await expect(page.getByTestId('corner-0')).toBeVisible();
  await a.check('03-wizard-corners');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Wizard 3: details
  await expect(page.getByTestId('wizard-details')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Great Wave');
  await page.getByRole('button', { name: '1000', exact: true }).click();
  await page.getByRole('textbox', { name: 'Width' }).fill('70');
  await page.getByRole('textbox', { name: 'Height' }).fill('50');
  await a.check('04-wizard-details');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Wizard 4: reference + close-ups
  await expect(page.getByTestId('wizard-reference')).toBeVisible();
  await a.check('05-wizard-reference');
  await page.getByTestId('closeup-upload').setInputFiles(asset('great-wave.jpg'));
  await expect(page.getByText(/Matched ·/)).toBeVisible();
  await a.check('06-wizard-closeups');

  // Wizard 5: save – first with a simulated full disk (error screen), then for real.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      IDBObjectStore.prototype.put = original;
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await page.getByTestId('save-puzzle').click();
  await expect(page.getByText(/storage is full/)).toBeVisible();
  await a.check('07-wizard-save-error');
  await page.getByRole('button', { name: 'Try again' }).click();

  // Workspace
  await expect(page.getByTestId('tab-scan')).toBeVisible();
  await a.check('08-workspace-scan');
  await page.getByTestId('photo-upload').setInputFiles(asset('starry-night.jpg'));
  await expect(page.getByTestId('analysing')).toBeVisible();
  await a.check('09-analysing');
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible();
  await a.check('10-scan-result');
  if (await page.locator('.quality-head').count()) {
    await page.locator('.quality-head').first().click();
    await a.check('11-scan-result-issues');
  }
  await page.getByRole('radio', { name: 'Both' }).click();
  await a.check('12-scan-result-both');
  await page.getByTestId('view-options').click();
  await expect(page.getByRole('dialog', { name: 'View options' })).toBeVisible();
  await a.check('12b-view-options');
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Photo' }).click();

  // A piece that has a suggested place (so the sheet shows its Placed / Not this one actions).
  await page.locator('[data-testid^="piece-item-"]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await a.check('13-piece-detail');
  await page.getByRole('dialog').getByTestId('mark-placed').click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await a.check('14-piece-detail-placed-snackbar');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // Guided placing mode: every step until the finish card.
  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  await a.check('15a-placing-step');
  let unsureChecked = false;
  for (let i = 0; i < 40 && !(await page.getByTestId('placing-done').isVisible()); i++) {
    if (!unsureChecked && (await page.getByTestId('not-here').isVisible())) {
      await a.check('15b-placing-unsure');
      unsureChecked = true;
    }
    const before = await page.locator('.topbar-sub').textContent();
    await page.getByTestId('placed').click();
    await expect.poll(async () => (await page.getByTestId('placing-done').isVisible()) || (await page.locator('.topbar-sub').textContent()) !== before).toBe(true);
  }
  await expect(page.getByTestId('placing-done')).toBeVisible();
  await a.check('15c-placing-done');
  await page.goBack();
  await expect(page.getByTestId('scan-result')).toBeVisible();

  // Send feedback (the quiet link at the end of the result): a few marks, then the file.
  await page.getByTestId('scan-feedback-link').click();
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  const fbPhoto = page.getByTestId('fb-photo');
  await expect(fbPhoto).toBeVisible();
  const fbBox = (await fbPhoto.boundingBox())!;
  await fbPhoto.click({ position: { x: fbBox.width * 0.1, y: fbBox.height * 0.1 } });
  const hiddenRegion = await page.locator('[data-testid^="fb-region-"][data-hidden="true"]').first().getAttribute('data-testid');
  await page.getByTestId('fb-mode-not_a_piece').click();
  await page.getByTestId(hiddenRegion!.replace('fb-region-', 'fb-hit-')).click();
  await expect(page.locator('[data-testid^="fb-mark-"]')).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await a.check('15d-feedback');
  const shownRegion = await page.locator('[data-testid^="fb-region-"][data-hidden="false"]').first().getAttribute('data-testid');
  await page.getByTestId('fb-mode-wrong_place').click();
  await page.getByTestId(shownRegion!.replace('fb-region-', 'fb-hit-')).click();
  await page.getByTestId('fb-correct-2').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await a.check('15d2-feedback-right-place');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByTestId('fb-create').click();
  await expect(page.getByTestId('fb-download')).toBeVisible({ timeout: 30_000 });
  await a.check('15e-feedback-file');
  await page.goBack();
  await expect(page.getByTestId('scan-result')).toBeVisible();

  const puzzleHash = new URL(page.url()).hash.replace(/\/scan\/.*$/, '');
  for (const tab of ['picture', 'history', 'settings'] as const) {
    await page.goto(`/?pipeline=mock${puzzleHash}/${tab}`);
    await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    if (tab === 'history') await expect(page.getByTestId('scan-row')).toHaveCount(1);
    await a.check(`16-${tab}`);
  }
  await page.getByRole('button', { name: 'Delete puzzle' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await a.check('17-settings-delete-confirm');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('settings-feedback').click();
  await expect(page.getByTestId('send-feedback')).toBeVisible();
  await a.check('17b-settings-feedback');

  await page.goto('/?pipeline=mock');
  await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
  await a.check('18-home');

  a.save();
  expect(errors).toEqual([]);
});
