/** Self-test: the mobile audit must detect each kind of problem on a deliberately broken page. */
import { expect, test } from '@playwright/test';
import { auditPage } from './audit';

const BROKEN = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
  body { margin: 0; font: 16px sans-serif; }
  .tiny { width: 30px; height: 30px; }
  .grown { position: relative; width: 30px; height: 30px; }
  .grown::after { content: ''; position: absolute; inset: -8px; }
  .wide { width: 500px; height: 10px; background: red; }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; height: 60px; background: #333; }
  .primary { position: fixed; bottom: 10px; left: 10px; width: 100px; height: 48px; }
  input { font-size: 14px; }
  .fine { font-size: 10px; }
</style></head><body>
  <button class="tiny" id="tiny">x</button>
  <button class="grown" id="grown">ok</button>
  <p>An <a href="#">inline link</a> in a sentence.</p>
  <input type="text" aria-label="name">
  <p class="fine">fine print</p>
  <div class="wide"></div>
  <svg viewBox="0 0 1000 100" width="200" height="20"><text x="0" y="50" font-size="40">tiny svg</text></svg>
  <button class="btn-primary primary" id="covered">Go</button>
  <div class="bar"></div>
</body></html>`;

test('audit detects every rule', async ({ page }, info) => {
  test.skip(info.project.name !== 'android-small', 'runs once');
  await page.setContent(BROKEN);
  const vs = await auditPage(page);
  const rules = new Set(vs.map((v) => v.rule));
  for (const r of ['viewport', 'overflow', 'tap-target', 'input-font', 'small-text', 'covered', 'safe-area'] as const) {
    expect(rules, `rule ${r} should fire:\n${JSON.stringify(vs, null, 2)}`).toContain(r);
  }
  const taps = vs.filter((v) => v.rule === 'tap-target').map((v) => v.element);
  expect(taps.some((e) => e.includes('"x"'))).toBe(true);
  expect(taps.some((e) => e.includes('"ok"'))).toBe(false); // pseudo-element hit area counts
  expect(taps.some((e) => e.includes('inline link'))).toBe(false); // inline-link exception
  expect(vs.some((v) => v.rule === 'small-text' && v.element.includes('tiny svg'))).toBe(true);
});
