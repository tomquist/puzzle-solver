/**
 * Inspect a feedback file from the app ("Send feedback"): re-run the current pipeline on the scan
 * photo, judge the user's marks and write annotated images plus a summary.
 *
 *   npm run feedback:inspect -- <file.json> [more.json …] [--out <dir>] [--no-box]
 *
 * Output: .debug/feedback/<file name>/ (or <dir>/<file name>/ with --out); see
 * scripts/feedback/inspect.ts for the list of images.
 */
import { basename, resolve } from 'node:path';
import { REPO_ROOT } from '../src/testing/nodeImageIO';
import { readFeedbackFile } from './feedback/io';
import { writeInspection } from './feedback/inspect';
import { replayFeedback } from './feedback/replay';

function main(argv: string[]): number {
  const files: string[] = [];
  let out = resolve(REPO_ROOT, '.debug/feedback');
  let skipBox = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = resolve(argv[++i] ?? out);
    else if (a === '--no-box') skipBox = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: npm run feedback:inspect -- <file.json> [more.json …] [--out <dir>] [--no-box]');
      return 0;
    } else if (a !== '--') files.push(a);
  }
  if (files.length === 0) {
    console.error('usage: npm run feedback:inspect -- <file.json> [more.json …] [--out <dir>] [--no-box]');
    return 2;
  }
  let failed = 0;
  for (const f of files) {
    const name = basename(f).replace(/\.json$/i, '');
    try {
      const bundle = readFeedbackFile(resolve(f));
      const replay = replayFeedback(bundle, name, { skipBox });
      const dir = resolve(out, name);
      const { summary, files: written } = writeInspection(replay, dir);
      console.log(summary);
      console.log(`\nimages: ${dir}/ (${written.filter((p) => p.endsWith('.png')).map((p) => basename(p)).join(', ')})\n`);
    } catch (e) {
      failed++;
      console.error(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
