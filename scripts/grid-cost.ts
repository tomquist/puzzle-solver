/**
 * Grid measurement cost: how long analyzeScan takes per scan and start condition with the
 * cell-size evidence and probe measured inside it ("inline", as before deferGridEvidence) and as
 * the app runs it now ("deferred": the result first, the measurement after it, a step at a time).
 * The two are run alternately, best of `--repeat` (default 3) each, so a busy machine slows both
 * alike. Feedback files with their reference picture.
 *
 *   npx vite-node scripts/grid-cost.ts -- --dir <folder> --only fb18,fb21 \
 *        --grids "4729x3547=34x45:a,34x44:b,27x37:d,27x37:c;2378x3000=6x3:a" [--repeat 3] [--json out.json]
 *
 * A grid's suffix is the start condition: a (right), b (a neighbour), d (a wrong count) analyse
 * with the 'near' probe (the grid is unconfirmed), c (no count: an estimated grid) with 'wide'.
 * VERBOSE=1 logs every step's time; DEFERRED_ONLY=1 skips the inline runs.
 * Prints timings only (nothing derived from the pictures).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GridEvidence, GridSpec } from '../src/model/types';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { buildReferenceIndex, type ReferenceIndex } from '../src/pipeline/match';
import type { GridProbe } from '../src/pipeline/match/cellSize';
import type { RGBAImage } from '../src/cv/image';
import { chromiumDecoder, fromChromium } from './feedback/chromium';
import { decodeFeedbackImage, readFeedbackFile } from './feedback/io';

const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DIR = opt('dir');
if (!DIR) throw new Error('--dir <folder with feedback files> is required');
const ONLY = (opt('only') ?? '').split(',').filter(Boolean);
const REPEAT = Number(opt('repeat', '3'));
const JSON_OUT = opt('json');
/** Per reference size: the grids and their start condition. */
const GRIDS = new Map(
  (opt('grids') ?? '').split(';').filter(Boolean).map((part) => {
    const [ref, list] = part.split('=');
    return [ref, list.split(',').map((g) => {
      const [grid, cond] = g.split(':');
      const [rows, cols] = grid.split('x').map(Number);
      return { grid: { rows, cols } as GridSpec, cond };
    })] as const;
  }),
);

interface Inline {
  /** Until the result, all of it. */
  result: number;
  /** The evidence measurement and the probe inside it. */
  evidence: number;
  probe: number;
  rematches: number;
}

interface Deferred {
  /** Until the result (what the user waits for). */
  result: number;
  /** The measurement after it, all steps, and its longest step (what a new scan may wait). */
  after: number;
  longestStep: number;
  steps: number;
  sources: number;
}

function inline(index: ReferenceIndex, photo: RGBAImage, probe: GridProbe): Inline {
  const t0 = performance.now();
  const out = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), gridProbe: probe });
  const result = performance.now() - t0;
  const tm = out.result.timings;
  return { result, evidence: tm.cellSizeMeasure ?? 0, probe: (tm.cellSize ?? 0) - (tm.cellSizeMeasure ?? 0), rematches: tm.cellSizeProbes ?? 0 };
}

function deferred(index: ReferenceIndex, photo: RGBAImage, probe: GridProbe): Deferred {
  const t0 = performance.now();
  const out = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), gridProbe: probe, deferGridEvidence: true });
  const result = performance.now() - t0;
  let after = 0, longestStep = 0, steps = 0, sources = 0;
  if (out.gridFollowUp) {
    let r: IteratorResult<void, GridEvidence>;
    do {
      const t1 = performance.now();
      r = out.gridFollowUp.next();
      const dt = performance.now() - t1;
      after += dt;
      longestStep = Math.max(longestStep, dt);
      if (process.env.VERBOSE) process.stderr.write(`  step ${steps}: ${Math.round(dt)} ms\n`);
      steps++;
    } while (!r.done);
    sources = r.value.sources.length;
  }
  return { result, after, longestStep, steps, sources };
}

const ms = (v: number) => String(Math.round(v));

async function main() {
  const chrome = await chromiumDecoder();
  const rows: { file: string; cond: string; grid: string; inline: Inline; deferred: Deferred }[] = [];
  for (const name of ONLY) {
    const b = readFeedbackFile(resolve(DIR!, `${name}.json`));
    const photo: RGBAImage = chrome && fromChromium(b.app.userAgent) ? await chrome.decode(b.scan!.photo) : decodeFeedbackImage(b.scan!.photo);
    const ref = decodeFeedbackImage(b.reference!);
    for (const { grid, cond } of GRIDS.get(`${ref.width}x${ref.height}`) ?? []) {
      const index = buildReferenceIndex(ref, grid, b.puzzle.cut);
      const probe: GridProbe = cond === 'c' ? 'wide' : 'near';
      let bi: Inline | undefined, bd: Deferred | undefined;
      for (let k = 0; k < REPEAT; k++) {
        const i = process.env.DEFERRED_ONLY ? { result: 0, evidence: 0, probe: 0, rematches: 0 } : inline(index, photo, probe);
        if (!bi || i.result < bi.result) bi = i;
        const d = deferred(index, photo, probe);
        if (!bd || d.result + d.after < bd.result + bd.after) bd = d;
      }
      const row = { file: name, cond, grid: `${grid.cols}×${grid.rows}`, inline: bi!, deferred: bd! };
      rows.push(row);
      const d = row.deferred, i = row.inline;
      console.log(
        `| ${name} | ${cond} | ${row.grid} | ${ms(i.result - i.evidence - i.probe)} | ${ms(i.evidence)} | ${ms(i.probe)} (${i.rematches}) | ${ms(i.result)} | ${ms(d.result)} | ${ms(d.after)} | ${ms(d.longestStep)} | ${d.steps} | ${d.sources} |`,
      );
    }
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
  await chrome?.close();
}

console.log('| file | start | grid | without evidence ms | evidence ms | probe ms (re-matches) | result inline ms | result deferred ms | after the result ms | longest step ms | steps | sources |');
console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
await main();
