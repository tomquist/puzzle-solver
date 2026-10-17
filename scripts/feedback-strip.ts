/**
 * Prepare a feedback file for committing to test-corpus/feedback/: remove the puzzle picture and
 * the box photo (they show the publisher's copyrighted artwork) and keep the scan photo, the app's
 * result, the user's marks and confirmed placements. Such files still replay segmentation and the
 * marks; matching checks need the picture and are skipped.
 *
 *   npm run feedback:strip -- <in.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseFeedback, serializeFeedback } from '../src/feedback/format';

function main(argv: string[]): number {
  const [input, output] = argv.filter((a) => a !== '--');
  if (!input || !output) {
    console.error('usage: npm run feedback:strip -- <in.json> <out.json>');
    return 1;
  }
  const bundle = parseFeedback(readFileSync(input, 'utf8'));
  const removed = [bundle.reference && 'reference picture', bundle.box && 'box photo'].filter(Boolean);
  delete bundle.reference;
  delete bundle.box;
  const text = serializeFeedback(bundle);
  writeFileSync(output, text);
  console.log(`${output}: ${(text.length / 1e6).toFixed(1)} MB; removed ${removed.length ? removed.join(' and ') : 'nothing'}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
