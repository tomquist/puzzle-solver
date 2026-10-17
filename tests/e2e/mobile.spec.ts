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
    await this.page.waitForTimeout(350);
    await this.page.screenshot({ path: `.debug/mobile/${this.info.project.name}-${screen}.png` });
    const vs = await auditPage(this.page);
    this.results[screen] = vs;
    expect.soft(vs, `${this.info.project.name} / ${screen}:\n${formatViolations(vs)}`).toEqual([]);
  }

  save() {
    mkdirSync('.debug/mobile', { recursive: true });
    const summary = Object.fromEntries(Object.entries(this.results).map(([k, v]) => [k, v.length]));
    writeFileSync(`.debug/mobile/${this.info.project.name}.json`, JSON.stringify({ summary, violations: this.results }, null, 2));
  }
}

test('mobile audit: every main screen', async ({ page }, info) => {
  test.setTimeout(240_000);
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
  await expect(page.getByTestId('region-1')).toBeVisible();
  await a.check('10-scan-result');
  await page.locator('.quality-head').first().click();
  await a.check('11-scan-result-issues');
  await page.getByRole('radio', { name: 'Both' }).click();
  await a.check('12-scan-result-both');

  await page.getByTestId('piece-item-1').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await a.check('13-piece-detail');
  await page.getByRole('dialog').getByTestId('mark-placed').click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await a.check('14-piece-detail-placed-snackbar');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  const puzzleHash = new URL(page.url()).hash.replace(/\/scan\/.*$/, '');
  for (const tab of ['picture', 'history', 'settings'] as const) {
    await page.goto(`/?pipeline=mock${puzzleHash}/${tab}`);
    await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    if (tab === 'history') await expect(page.getByTestId('scan-row')).toHaveCount(1);
    await a.check(`15-${tab}`);
  }
  await page.getByRole('button', { name: 'Delete puzzle' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await a.check('16-settings-delete-confirm');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/?pipeline=mock');
  await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
  await a.check('17-home');

  a.save();
  expect(errors).toEqual([]);
});
