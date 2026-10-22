/**
 * Honest confidence (mock pipeline, a stored scan seeded through IndexedDB): places read "Sure" /
 * "Likely" / "Unsure – one of these N spots" and never a percentage, an unsure piece says why
 * (RegionMatch.uncertainReason) in the selection card and the details, the details offer the
 * spots side by side, and a spot marked as placed that a piece seems to belong in
 * (RegionMatch.placedConflict) shows a small note with "Unmark the spot" / "Keep the mark".
 * Screenshots (light and dark) go to $UX_SHOTS (default .debug/ui).
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { auditPage, formatViolations } from './audit';

const asset = (name: string) => fileURLToPath(new URL(`../../test-assets/${name}`, import.meta.url));
const SHOTS = process.env.UX_SHOTS ?? '.debug/ui';

async function shot(page: Page, info: TestInfo, name: string) {
  await page.waitForTimeout(250);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
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
  await expect(page.locator('[data-testid^="piece-item-"]').first()).toBeVisible();
}

interface Seeded {
  /** Unsure: three close spots, a plain area. */
  unsure: number;
  /** Its candidates (3–5 in the mock: the ones past the third are less likely). */
  unsureCandidates: number;
  /** Sure. */
  sure: number;
  /** Likely: one spot well ahead, an unclear outline. */
  likely: number;
  /** Conflicts with a placed spot (answered with Keep, then Unmark on the second). */
  keep: number;
  unmark: number;
  keepCell: { row: number; col: number };
  unmarkCell: { row: number; col: number };
}

/**
 * Rewrite five loose pieces of the stored scan: an unsure one (three close spots, plain area), a
 * sure one, a likely one (outline unclear) and two whose best place conflicts with a cell marked
 * as placed (those cells are put into the progress).
 */
async function seed(page: Page): Promise<Seeded> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('puzzle-solver');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const done = <T,>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result)), (req.onerror = () => reject(req.error))));
    type Cand = { row: number; col: number; confidence: number; x: number; y: number };
    type Match = { regionId: number; status: string; candidates: Cand[]; uncertainReason?: string; placedConflict?: { row: number; col: number } };
    type Scan = { puzzleId: string; result: { regions: { id: number; kind: string }[]; matches: Match[]; groups?: { kind: string; regionIds: number[] }[] } };
    const tx = db.transaction(['scans', 'progress'], 'readwrite');
    const scans = tx.objectStore('scans');
    const [scan] = (await done(scans.getAll())) as Scan[];
    const grouped = new Set((scan.result.groups ?? []).filter((g) => g.kind === 'assembled').flatMap((g) => g.regionIds));
    const loose = scan.result.matches.filter((m) => !grouped.has(m.regionId) && m.candidates.length >= 3 && m.status !== 'unmatched' && scan.result.regions.find((r) => r.id === m.regionId)?.kind === 'piece');
    if (loose.length < 5) throw new Error(`only ${loose.length} loose pieces`);
    const [u, s, l, k, x] = loose;
    const conf = (m: Match, cs: number[]) => m.candidates.forEach((c, i) => (c.confidence = cs[i] ?? 0.02));
    u.status = 'ambiguous';
    conf(u, [0.41, 0.38, 0.33, 0.06, 0.03]);
    u.uncertainReason = 'plain';
    s.status = 'confident';
    conf(s, [0.93, 0.2, 0.1]);
    delete s.uncertainReason;
    l.status = 'ambiguous';
    conf(l, [0.52, 0.11, 0.05]);
    l.uncertainReason = 'shape';
    // The conflicts: a free cell far from the pieces' own candidates.
    const taken = new Set(scan.result.matches.flatMap((m) => m.candidates.map((c) => `${c.row},${c.col}`)));
    const free: { row: number; col: number }[] = [];
    for (let row = 1; row < 20 && free.length < 2; row++) for (let col = 1; col < 20 && free.length < 2; col++) if (!taken.has(`${row},${col}`)) free.push({ row, col });
    k.status = 'ambiguous';
    conf(k, [0.44, 0.15, 0.05]);
    k.placedConflict = free[0];
    x.status = 'ambiguous';
    conf(x, [0.44, 0.15, 0.05]);
    x.placedConflict = free[1];
    await done(scans.put(scan));
    const progress = tx.objectStore('progress');
    const current = ((await done(progress.get(scan.puzzleId))) as { puzzleId: string; placed: Record<string, { at: number }>; updatedAt: number } | undefined) ?? { puzzleId: scan.puzzleId, placed: {}, updatedAt: 0 };
    for (const c of free) current.placed[`${c.row},${c.col}`] = { at: 1 };
    current.updatedAt = Date.now();
    await done(progress.put(current));
    db.close();
    return { unsure: u.regionId, unsureCandidates: u.candidates.length, sure: s.regionId, likely: l.regionId, keep: k.regionId, unmark: x.regionId, keepCell: free[0], unmarkCell: free[1] };
  });
}

const placedKeys = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('puzzle-solver');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const req = db.transaction('progress').objectStore('progress').getAll();
    const all = await new Promise<{ placed: Record<string, unknown> }[]>((resolve) => (req.onsuccess = () => resolve(req.result)));
    db.close();
    return Object.keys(all[0]?.placed ?? {});
  });

test('places read as words, unsure pieces say why and offer their spots', async ({ page }, info) => {
  await createPuzzleAndScan(page);
  const s = await seed(page);
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();

  // No percentages anywhere on the result.
  await expect(page.getByTestId(`piece-item-r${s.unsure}`)).toBeVisible();
  expect(await page.getByTestId('scan-result').innerText()).not.toMatch(/\d\s?%/);
  await expect(page.getByTestId(`piece-item-r${s.unsure}`)).toContainText('unsure · 3 spots');
  await expect(page.getByTestId(`piece-item-r${s.likely}`)).toContainText('likely');

  // Unsure: the card says so and why.
  await page.getByTestId(`piece-item-r${s.unsure}`).click();
  const bar = page.getByTestId('selection-bar');
  await expect(bar.getByTestId('selection-certainty')).toHaveText('Unsure – one of 3 spots');
  await expect(bar.getByTestId('uncertain-reason')).toHaveText('Plain area – many spots look alike');
  await shot(page, info, 'unsure-card');

  // The details: the same words, the reason with what to do, and the three spots side by side.
  await page.getByTestId('selection-details').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId('detail-certainty')).toHaveText('Unsure – one of these 3 spots');
  await expect(sheet.getByTestId('uncertain-reason')).toContainText('Plain area – many spots look alike. Compare the options with your piece.');
  await expect(sheet.getByRole('heading', { name: 'One of these 3 spots' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Spot 1 of 3' })).toBeVisible();
  await expect(sheet.getByTestId('spot-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByTestId('spot-2')).toContainText('Spot 3');
  if (s.unsureCandidates > 3) await expect(sheet.getByTestId('spot-3')).toContainText('Less likely');
  await expect(sheet.locator('[data-testid^="spot-"]')).toHaveCount(s.unsureCandidates);
  expect(await sheet.innerText()).not.toMatch(/\d\s?%/);
  await sheet.getByTestId('uncertain-reason').scrollIntoViewIfNeeded();
  await shot(page, info, 'unsure-details');
  const vs = await auditPage(page);
  expect.soft(vs, formatViolations(vs)).toEqual([]);
  // Choosing another spot shows it.
  await sheet.getByTestId('spot-1').click();
  await expect(sheet.getByRole('heading', { name: 'Spot 2 of 3' })).toBeVisible();
  await expect(sheet.getByTestId('spot-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Sure: one word, no reason.
  await page.getByTestId(`piece-item-r${s.sure}`).click();
  await expect(bar.getByTestId('selection-certainty')).toHaveText('Sure');
  await expect(bar.getByTestId('uncertain-reason')).toHaveCount(0);
  await shot(page, info, 'sure-card');
  await page.getByTestId('selection-details').click();
  await expect(sheet.getByTestId('detail-certainty')).toHaveText('Sure');
  await expect(sheet.getByTestId('certainty').first()).toHaveAttribute('data-certainty', 'sure');
  await expect(sheet.getByRole('heading', { name: 'Goes here' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Other possibilities' })).toBeVisible();
  await shot(page, info, 'sure-details');
  await page.keyboard.press('Escape');

  // Likely: an unclear outline.
  await page.getByTestId(`piece-item-r${s.likely}`).click();
  await expect(bar.getByTestId('selection-certainty')).toHaveText('Likely – check it');
  await expect(bar.getByTestId('uncertain-reason')).toHaveText('Outline unclear – check the piece');
});

test('a spot marked placed that a piece belongs in: a note to unmark it or keep it', async ({ page }, info) => {
  await createPuzzleAndScan(page);
  const s = await seed(page);
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  const keyOf = (c: { row: number; col: number }) => `${c.row},${c.col}`;
  expect(await placedKeys(page)).toEqual(expect.arrayContaining([keyOf(s.keepCell), keyOf(s.unmarkCell)]));

  // The list says it; the selection card shows the note (non-blocking: the card still works).
  await expect(page.getByTestId(`piece-item-r${s.keep}`)).toContainText('its spot is marked placed');
  await page.getByTestId(`piece-item-r${s.keep}`).click();
  const bar = page.getByTestId('selection-bar');
  const note = bar.getByTestId('placed-conflict');
  await expect(note).toContainText(`You marked row ${s.keepCell.row + 1}, column ${s.keepCell.col + 1} as placed, but this piece looks like it belongs there.`);
  await shot(page, info, 'conflict-card');
  const vsCard = await auditPage(page);
  expect.soft(vsCard, formatViolations(vsCard)).toEqual([]);

  // The details show it too.
  await page.getByTestId('selection-details').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId('placed-conflict')).toContainText(`You marked this spot (row ${s.keepCell.row + 1}, column ${s.keepCell.col + 1}) as placed, but this piece looks like it belongs there.`);
  await sheet.getByTestId('placed-conflict').scrollIntoViewIfNeeded();
  await shot(page, info, 'conflict-details');
  const vsSheet = await auditPage(page);
  expect.soft(vsSheet, formatViolations(vsSheet)).toEqual([]);
  // Keep the mark: the note goes, the spot stays placed, and it stays answered after a reload.
  await sheet.getByTestId('conflict-keep').click();
  await expect(sheet.getByTestId('placed-conflict')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(note).toHaveCount(0);
  expect(await placedKeys(page)).toContain(keyOf(s.keepCell));
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await page.getByTestId(`piece-item-r${s.keep}`).click();
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  await expect(page.getByTestId('placed-conflict')).toHaveCount(0);

  // Unmark the spot: the cell is free again (with Undo), and the note goes.
  await page.getByTestId(`piece-item-r${s.unmark}`).click();
  await expect(page.getByTestId('placed-conflict')).toBeVisible();
  await page.getByTestId('conflict-unmark').click();
  await expect(page.getByTestId('placed-conflict')).toHaveCount(0);
  await expect.poll(() => placedKeys(page)).not.toContain(keyOf(s.unmarkCell));
  await expect(page.getByText(`row ${s.unmarkCell.row + 1}, column ${s.unmarkCell.col + 1} unmarked`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => placedKeys(page)).toContain(keyOf(s.unmarkCell));
  await expect(page.getByTestId('placed-conflict')).toBeVisible();
});

test('the placing mode says why a piece is unsure', async ({ page }) => {
  await createPuzzleAndScan(page);
  const s = await seed(page);
  await page.reload();
  await expect(page.getByTestId('scan-result')).toBeVisible();
  await page.getByTestId('start-placing').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  // Walk to the unsure piece.
  for (let i = 0; i < 40 && !(await page.getByTestId(`step-r${s.unsure}`).isVisible()); i++) {
    const before = await page.locator('.topbar-sub').textContent();
    await page.getByTestId('skip').click();
    await expect.poll(async () => (await page.getByTestId('placing-done').isVisible()) || (await page.locator('.topbar-sub').textContent()) !== before).toBe(true);
    if (await page.getByTestId('placing-done').isVisible()) break;
  }
  await expect(page.getByTestId(`step-r${s.unsure}`)).toBeVisible();
  await expect(page.getByTestId('place-certainty')).toHaveText('Unsure – one of these 3 spots');
  await expect(page.getByTestId('uncertain-reason')).toHaveText('Plain area – many spots look alike');
});
