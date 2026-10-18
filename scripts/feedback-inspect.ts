/**
 * Inspect a feedback file from the app ("Send feedback"): re-run the current pipeline on the scan
 * photo, judge the user's marks and write annotated images plus a summary.
 *
 *   npm run feedback:inspect -- <file.json> [more.json …] [--out <dir>] [--no-box] [--decoder auto|chromium|jpeg-js]
 *
 * --decoder: how the scan photo is decoded. `auto` (default) uses Playwright's Chromium for files
 * from Chromium browsers (exactly the pixels the app analysed there) and jpeg-js otherwise.
 *
 * Output: .debug/feedback/<file name>/ (or <dir>/<file name>/ with --out); see
 * scripts/feedback/inspect.ts for the list of images.
 */
import { basename, resolve } from 'node:path';
import { REPO_ROOT } from '../src/testing/nodeImageIO';
import { readFeedbackFile } from './feedback/io';
import { writeInspection } from './feedback/inspect';
import { replayFeedback } from './feedback/replay';
import { readReview } from './feedback/review';
import { chromiumDecoder, fromChromium, type ChromiumDecoder } from './feedback/chromium';

async function main(argv: string[]): Promise<number> {
  const files: string[] = [];
  let out = resolve(REPO_ROOT, '.debug/feedback');
  let skipBox = false;
  let decoder = 'auto';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = resolve(argv[++i] ?? out);
    else if (a === '--no-box') skipBox = true;
    else if (a === '--decoder') decoder = argv[++i] ?? decoder;
    else if (a === '-h' || a === '--help') {
      console.log('usage: npm run feedback:inspect -- <file.json> [more.json …] [--out <dir>] [--no-box] [--decoder auto|chromium|jpeg-js]');
      return 0;
    } else if (a !== '--') files.push(a);
  }
  if (files.length === 0) {
    console.error('usage: npm run feedback:inspect -- <file.json> [more.json …] [--out <dir>] [--no-box] [--decoder auto|chromium|jpeg-js]');
    return 2;
  }
  let failed = 0;
  let chrome: ChromiumDecoder | null | undefined;
  for (const f of files) {
    const name = basename(f).replace(/\.json$/i, '');
    try {
      const bundle = readFeedbackFile(resolve(f));
      let scanPhoto;
      if (bundle.scan && (decoder === 'chromium' || (decoder === 'auto' && fromChromium(bundle.app.userAgent)))) {
        if (chrome === undefined) chrome = await chromiumDecoder();
        if (chrome) scanPhoto = await chrome.decode(bundle.scan.photo);
        else if (decoder === 'chromium') throw new Error('Chromium is not available here (npx playwright install chromium)');
      }
      console.log(`${name}: scan photo decoded with ${scanPhoto ? 'Chromium' : 'jpeg-js'}`);
      const replay = replayFeedback(bundle, name, { skipBox, review: readReview(resolve(f)), scanPhoto });
      const dir = resolve(out, name);
      const { summary, files: written } = writeInspection(replay, dir);
      console.log(summary);
      console.log(`\nimages: ${dir}/ (${written.filter((p) => p.endsWith('.png')).map((p) => basename(p)).join(', ')})\n`);
    } catch (e) {
      failed++;
      console.error(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await chrome?.close();
  return failed > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => (process.exitCode = code));
