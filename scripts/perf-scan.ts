/**
 * Scan analysis timing harness: how long `analyzeScan` takes per photo and per pipeline stage, as
 * the app runs it (`deferGridEvidence`: the result first; the cell-size measurement after it, timed
 * on its own as `gridFollowUp`), and a hash of everything it returns (regions, contours, matches,
 * fits, groups, quality, the deferred grid evidence; not the timings) to prove that a speed-up
 * changes no result.
 *
 *   npx vite-node scripts/perf-scan.ts -- prepare --cache <dir>
 *   npx vite-node scripts/perf-scan.ts -- run --cache <dir> [--runs 3] [--only a,b] [--marks both|on|off] [--json out.json] [--hashes]
 *
 * `prepare` decodes the photos once (Chromium files with Playwright's Chromium, as on the phone;
 * others with jpeg-js) and renders the synthetic scenes, into raw RGBA files in `--cache` (outside
 * the repository: they hold the user's private photos and the puzzle's picture). `run` only reads
 * that cache and imports nothing but `analyzeScan` and `buildReferenceIndex`, so this file can be
 * copied into older checkouts to time them on exactly the same pixels.
 *
 * The set: the private files with their reference (fb17, fb18, fb20, fb24, a HABA file), the
 * committed 1500-piece feedback files (box-stripped: analysed against fb17's reference, the same
 * puzzle), the peacock photo (no reference: segmentation only) and three synthetic scenes.
 * `--marks on` analyses with placed marks (the frame and the top quarter of the grid, as a user
 * well into the puzzle), `off` without, `both` both (default). Runs are interleaved over the
 * photos (photo order, then repeat), so a busy machine slows all alike; best and median reported.
 * Prints timings and hashes only (nothing derived from the pictures).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import type { RGBAImage } from '../src/cv/image';
import type { CellRef, GridSpec } from '../src/model/types';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { buildReferenceIndex } from '../src/pipeline/match';
import { segmentPieces } from '../src/pipeline/pieces';

const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);
const MODE = args[0];
const CACHE = resolve(opt('cache') ?? '.debug/perf-cache');
const now = () => performance.now();

interface Entry {
  name: string;
  /** Photo file in the cache (raw RGBA) and its size. */
  photo: { file: string; width: number; height: number };
  /** Reference picture in the cache, or none (segmentation only). */
  reference?: { file: string; width: number; height: number };
  grid: GridSpec;
  cut: string;
}

function writeRaw(name: string, img: RGBAImage) {
  writeFileSync(resolve(CACHE, name), Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length));
  return { file: name, width: img.width, height: img.height };
}
function readRaw(r: { file: string; width: number; height: number }): RGBAImage {
  const buf = readFileSync(resolve(CACHE, r.file));
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length) };
}

async function prepare() {
  const { chromiumDecoder, fromChromium } = await import('./feedback/chromium');
  const { decodeFeedbackImage, readFeedbackFile } = await import('./feedback/io');
  const { SCENARIOS, renderScene, makeReference } = await import('../bench/scanScenarios');
  mkdirSync(CACHE, { recursive: true });
  const chrome = await chromiumDecoder();
  const decode = async (img: Parameters<typeof decodeFeedbackImage>[0], chromium: boolean) => {
    if (chromium && !chrome) throw new Error('Chromium is needed: npx playwright install chromium');
    return chromium ? chrome!.decode(img) : decodeFeedbackImage(img);
  };
  const entries: Entry[] = [];
  const priv = resolve('test-corpus/private'), fb = resolve('test-corpus/feedback');
  const fb17 = readFeedbackFile(resolve(priv, 'fb17.json'));
  const ref1500 = writeRaw('ref-1500.rgba', await decode(fb17.reference!, fromChromium(fb17.app.userAgent)));
  const files: [string, string, boolean][] = [
    ['fb17', resolve(priv, 'fb17.json'), true],
    ['fb18', resolve(priv, 'fb18.json'), true],
    ['fb20', resolve(priv, 'fb20.json'), true],
    ['fb24', resolve(priv, 'fb24.json'), true],
    ['haba-oak', resolve(priv, '2026-10-20-haba-18-oak-grain.json'), false],
    ['grey-assembled-pair', resolve(fb, '2026-10-23-assembled-pair-grey-1500pc.json'), true],
    ['grey-dense', resolve(fb, '2026-10-23-dense-grey-table-1500pc.json'), true],
    ['grey-low-contrast', resolve(fb, '2026-10-23-grey-table-low-contrast-1500pc.json'), true],
    ['dense-table-frame', resolve(fb, '2026-10-18-dense-table-frame-1500pc.json'), true],
    ['touching-chain', resolve(fb, '2026-10-18-touching-chain-closeup-1500pc.json'), true],
    ['pale-light-table', resolve(fb, '2026-10-18-pale-pieces-light-table-1500pc.json'), true],
    ['blue-rebuilt', resolve(fb, '2026-10-20-blue-table-rebuilt-1500pc.json'), true],
    ['peacock', resolve(fb, 'flickr-tatters-peacock-white-cloth-1000pc.json'), false],
  ];
  for (const [name, path, ref1500Shared] of files) {
    const b = readFeedbackFile(path);
    const photo = writeRaw(`${name}.rgba`, await decode(b.scan!.photo, fromChromium(b.app.userAgent)));
    let reference: Entry['reference'];
    if (ref1500Shared && b.puzzle.grid.rows === 34 && b.puzzle.grid.cols === 45) reference = ref1500;
    else if (b.reference) reference = writeRaw(`${name}-ref.rgba`, await decode(b.reference, fromChromium(b.app.userAgent)));
    entries.push({ name, photo, reference, grid: b.puzzle.grid, cut: b.puzzle.cut });
    console.log(name, photo.width, photo.height, reference ? 'ref' : 'no ref');
  }
  await chrome?.close();
  for (const [scenario, seed] of [['starry-dense-touching', 34], ['starry-grids-dark', 11], ['wave-woodgrain', 0]] as const) {
    const s = SCENARIOS.find((x) => x.name === scenario)!;
    const sd = seed || s.seeds[0];
    const scene = renderScene(s, sd);
    const photo = writeRaw(`${scenario}.rgba`, scene.photo);
    const reference = writeRaw(`${scenario}-ref.rgba`, makeReference(s, sd));
    entries.push({ name: `syn-${scenario}`, photo, reference, grid: s.grid, cut: 'grid' });
    console.log(scenario, photo.width, photo.height);
  }
  writeFileSync(resolve(CACHE, 'entries.json'), JSON.stringify(entries, null, 1));
}

/** Placed marks of a user well into the puzzle: the frame and the top quarter of the grid. */
function marksFor(grid: GridSpec): CellRef[] {
  const out: CellRef[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (row === 0 || col === 0 || row === grid.rows - 1 || col === grid.cols - 1 || row < grid.rows / 4) out.push({ row, col });
    }
  }
  return out;
}

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

async function run() {
  const entries: Entry[] = JSON.parse(readFileSync(resolve(CACHE, 'entries.json'), 'utf8'));
  const only = (opt('only') ?? '').split(',').filter(Boolean);
  const runs = Number(opt('runs', '3'));
  const marksMode = opt('marks', 'both');
  const variants = marksMode === 'both' ? [false, true] : [marksMode === 'on'];
  const chosen = entries.filter((e) => only.length === 0 || only.includes(e.name));
  const photos = new Map(chosen.map((e) => [e.name, readRaw(e.photo)]));
  const indexes = new Map<string, ReturnType<typeof buildReferenceIndex>>();
  const indexMs: Record<string, number> = {};
  for (const e of chosen) {
    if (!e.reference) continue;
    const key = `${e.reference.file}:${e.grid.rows}x${e.grid.cols}:${e.cut}`;
    if (indexes.has(key)) continue;
    const t = now();
    indexes.set(key, buildReferenceIndex(readRaw(e.reference), e.grid, e.cut as never));
    indexMs[key] = now() - t;
  }
  type Sample = Record<string, number>;
  const samples = new Map<string, Sample[]>();
  const hashes = new Map<string, string>();
  const startLoad = loadavg()[0];
  for (let k = 0; k < runs; k++) {
    for (const e of chosen) {
      for (const marks of variants) {
        if (marks && !e.reference) continue;
        const id = `${e.name}${marks ? '+marks' : ''}`;
        const photo = photos.get(e.name)!;
        let timings: Sample;
        let hashed: unknown;
        if (!e.reference) {
          const t = now();
          // (Photos no larger than the analysis size: segmented as they are.)
          const segTimings: Record<string, number> = {};
          const seg = segmentPieces(photo, { timings: segTimings });
          timings = { ...segTimings, scan: now() - t, segment: now() - t };
          hashed = { regions: seg.regions.map((r) => r.region), quality: seg.quality, background: seg.background };
        } else {
          const index = indexes.get(`${e.reference.file}:${e.grid.rows}x${e.grid.cols}:${e.cut}`)!;
          const t = now();
          const out = analyzeScan(index, photo, { deferGridEvidence: true, ...(marks ? { placedCells: marksFor(e.grid) } : {}) });
          const scanMs = now() - t;
          const tf = now();
          let evidence: unknown;
          if (out.gridFollowUp) {
            let r = out.gridFollowUp.next();
            while (!r.done) r = out.gridFollowUp.next();
            evidence = r.value;
          }
          timings = { ...out.result.timings, scan: scanMs, gridFollowUp: now() - tf };
          const { timings: _t, ...rest } = out.result;
          hashed = { ...rest, evidence };
        }
        const h = hashOf(hashed);
        if (hashes.has(id) && hashes.get(id) !== h) console.warn(`${id}: result differs between runs (${hashes.get(id)} vs ${h})`);
        hashes.set(id, h);
        (samples.get(id) ?? samples.set(id, []).get(id)!).push(timings);
        console.error(`run ${k + 1}/${runs} ${id}: ${timings.scan.toFixed(0)} ms (load ${loadavg()[0].toFixed(2)})`);
      }
    }
  }
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { best: s[0], median: s[s.length >> 1] };
  };
  const report: Record<string, { hash: string; stages: Record<string, { best: number; median: number }> }> = {};
  for (const [id, ss] of samples) {
    const keys = [...new Set(ss.flatMap((s) => Object.keys(s)))];
    const stages: Record<string, { best: number; median: number }> = {};
    for (const key of keys) stages[key] = stat(ss.map((s) => s[key] ?? 0));
    report[id] = { hash: hashes.get(id)!, stages };
  }
  const meta = { cpus: cpus().length, loadStart: startLoad, loadEnd: loadavg()[0], runs, indexMs };
  console.log(JSON.stringify(meta));
  for (const [id, r] of Object.entries(report)) {
    const s = r.stages;
    const main = ['scan', 'segment', 'match', 'fits', 'gridFollowUp'].filter((k) => s[k]).map((k) => `${k} ${s[k].best.toFixed(0)}/${s[k].median.toFixed(0)}`).join('  ');
    console.log(`${id.padEnd(28)} ${r.hash}  ${main}`);
  }
  if (flag('hashes')) for (const [id, r] of Object.entries(report)) console.log(`HASH ${id} ${r.hash}`);
  const json = opt('json');
  if (json) writeFileSync(json, JSON.stringify({ meta, report }, null, 1));
}

if (MODE === 'prepare') await prepare();
else if (MODE === 'run') await run();
else {
  console.error('usage: perf-scan.ts prepare|run --cache <dir> …');
  process.exit(1);
}
