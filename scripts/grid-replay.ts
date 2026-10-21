/**
 * Grid replay: does the grid belief (src/pipeline/gridBelief.ts) converge on real scans, and how
 * often does it ask? Takes the feedback files of one or more puzzles (full files: they must carry
 * the reference picture), treats each puzzle's scans as a sequence and replays the app's grid
 * handling from several starting points:
 *   (a) the right grid, (b) wrong neighbouring grids, (c) no piece count (an estimated grid),
 *   (d) a wrong piece count,
 * in the order the scans were taken and in shuffled orders. At every scan it analyses the photo
 * with the grid the app has at that moment, adds the scan's evidence and applies the decision; a
 * question is answered "Use it" (the replay counts it and whether it was right), an estimated grid
 * follows the measurement silently, and after a change the scans so far are re-analysed when the
 * cells changed by more than 8 % (the app then re-runs them; smaller changes only remap cells and
 * keep the evidence). Analyses are cached per file and grid (`--cache`).
 *
 *   npx vite-node scripts/grid-replay.ts -- --dir <folder with fb*.json> [--cache <dir>] [--shuffles 5]
 *        [--truth 4729x3547=34x45,2378x3000=6x3] [--only <file,...>] [--precompute <grid,...>] [--json out.json]
 *
 * The truth of a puzzle (rows x cols) defaults to the grid stored in its files. Nothing derived
 * from the files is written outside the cache and the --json report (counts and grids only).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GridEvidence, GridSpec } from '../src/model/types';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { estimateGrid } from '../src/pipeline/grid';
import { provisionalGrid } from '../src/pipeline/gridBelief';
import { replayGrid, shuffled, type ReplayOutcome, type ReplayStart } from '../src/testing/gridReplay';
import { buildReferenceIndex } from '../src/pipeline/match';
import { probeWanted, type GridProbe } from '../src/pipeline/match/cellSize';
import type { RGBAImage } from '../src/cv/image';
import { chromiumDecoder, fromChromium, type ChromiumDecoder } from './feedback/chromium';
import { decodeFeedbackImage, readFeedbackFile } from './feedback/io';
import type { FeedbackBundle } from '../src/feedback/format';

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DIR = opt('dir');
if (!DIR) throw new Error('--dir <folder with feedback files> is required');
const CACHE = resolve(opt('cache', '.debug/grid-replay')!);
const SHUFFLES = Number(opt('shuffles', '5'));
const ONLY = opt('only')?.split(',');
const PRECOMPUTE = opt('precompute');
const JSON_OUT = opt('json');
const truthArg = new Map((opt('truth') ?? '').split(',').filter(Boolean).map((t) => {
  const [ref, g] = t.split('=');
  const [rows, cols] = g.split('x').map(Number);
  return [ref, { rows, cols }] as const;
}));

mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------------------------------------
// Files and analyses
// ---------------------------------------------------------------------------------------------

interface ScanFile {
  name: string;
  path: string;
  createdAt: number;
  refKey: string;
}

const files: ScanFile[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !/\.(truth|review)\.json$/.test(f) && (!ONLY || ONLY.includes(f.replace(/\.json$/, ''))))
  .map((f) => {
    const path = resolve(DIR, f);
    // Read only what grouping needs (the files are large).
    const b = readFeedbackFile(path);
    return { name: f.replace(/\.json$/, ''), path, createdAt: b.scan?.analysedAt ?? b.createdAt, refKey: b.reference ? `${b.reference.width}x${b.reference.height}` : '', ok: !!b.reference && !!b.scan };
  })
  .filter((f) => f.ok)
  .map(({ ok: _ok, ...f }) => f);

let chrome: ChromiumDecoder | null | undefined;
const bundles = new Map<string, FeedbackBundle>();
const references = new Map<string, RGBAImage>();

function bundle(f: ScanFile): FeedbackBundle {
  let b = bundles.get(f.name);
  if (!b) {
    b = readFeedbackFile(f.path);
    bundles.set(f.name, b);
  }
  return b;
}

const cachePath = (f: ScanFile, g: GridSpec, probe: GridProbe | undefined) => resolve(CACHE, `${f.name}-${g.rows}x${g.cols}${probe === 'near' ? '-probe' : probe === 'wide' ? '-wide' : ''}.json`);

interface Analysed {
  evidence: GridEvidence;
  confident: number;
  ms: number;
}

/**
 * The scan's evidence at grid `g`; with `probe` (as the app: 'near' while the grid is not
 * confirmed, 'wide' while it is a guess) the analysis is redone with analyzeScan's gridProbe only
 * when it would trigger.
 */
async function analyse(f: ScanFile, g: GridSpec, probe?: GridProbe): Promise<Analysed> {
  const plain = await analyseOnce(f, g, undefined);
  if (!probe) return plain;
  const ref = bundle(f).reference!;
  const want = probeWanted(ref.width / g.cols, ref.height / g.rows, plain.evidence, plain.confident, probe);
  if (!want) return plain;
  // A 'far' probe is the same in both modes (cached once).
  return analyseOnce(f, g, want === 'far' ? 'near' : 'wide');
}

async function analyseOnce(f: ScanFile, g: GridSpec, probe: GridProbe | undefined): Promise<Analysed> {
  const p = cachePath(f, g, probe);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as Analysed;
  const b = bundle(f);
  if (chrome === undefined) chrome = await chromiumDecoder();
  const photo = chrome && fromChromium(b.app.userAgent) ? await chrome.decode(b.scan!.photo) : decodeFeedbackImage(b.scan!.photo);
  let ref = references.get(f.refKey);
  if (!ref) {
    ref = decodeFeedbackImage(b.reference!);
    references.set(f.refKey, ref);
  }
  const index = buildReferenceIndex(ref, g, b.puzzle.cut);
  const t0 = performance.now();
  const { result } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), gridProbe: probe });
  const out: Analysed = { evidence: result.gridEvidence!, confident: result.matches.filter((m) => m.status === 'confident').length, ms: Math.round(performance.now() - t0) };
  writeFileSync(p, JSON.stringify(out));
  process.stderr.write(`  analysed ${f.name} at ${g.cols}×${g.rows}${probe ? ' (probe)' : ''}: ${out.evidence.sources.length} sources, ${out.ms} ms\n`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

const fmt = (g: GridSpec) => `${g.cols}×${g.rows}`;

async function main() {
  const groups = new Map<string, ScanFile[]>();
  for (const f of files) groups.set(f.refKey, [...(groups.get(f.refKey) ?? []), f]);
  if (PRECOMPUTE) {
    const grids = PRECOMPUTE.split(',').map((g) => {
      const [rows, cols] = g.split('x').map(Number);
      return { rows, cols };
    });
    for (const f of files) for (const g of grids) await analyse(f, g, args.includes('--wide') ? 'wide' : args.includes('--probe') ? 'near' : undefined);
    await chrome?.close();
    return;
  }
  const report: Record<string, ReplayOutcome[]> = {};
  for (const [refKey, list] of groups) {
    const scans = [...list].sort((a, b) => a.createdAt - b.createdAt);
    const byName = new Map(scans.map((f) => [f.name, f]));
    const b0 = bundle(scans[0]);
    const truth = truthArg.get(refKey) ?? b0.puzzle.grid;
    const ref = { width: b0.reference!.width, height: b0.reference!.height };
    const aspect = ref.width / ref.height;
    const stated = b0.puzzle.pieceCount;
    const wrongCount = truth.rows * truth.cols > 200 ? 1000 : 24;
    const neighbours: GridSpec[] = [
      { rows: truth.rows, cols: truth.cols - 1 },
      { rows: truth.rows - 1, cols: truth.cols },
      { rows: truth.rows, cols: truth.cols + 1 },
    ].filter((g) => g.rows > 0 && g.cols > 0);
    const starts: ReplayStart[] = [
      { label: `(a) right ${fmt(truth)}`, grid: truth, count: stated, countKind: 'exact', status: 'unconfirmed' },
      ...neighbours.map((g): ReplayStart => ({ label: `(b) wrong ${fmt(g)}`, grid: g, count: stated, countKind: 'exact', status: 'unconfirmed' })),
      { label: `(c) unknown count → ${fmt(provisionalGrid(aspect))}`, grid: provisionalGrid(aspect), count: 0, countKind: 'unknown', status: 'estimated' },
      { label: `(d) count ${wrongCount} → ${fmt(estimateGrid(wrongCount, aspect).best)}`, grid: estimateGrid(wrongCount, aspect).best, count: wrongCount, countKind: 'exact', status: 'unconfirmed' },
    ];
    console.log(`\n## Puzzle ${refKey} (${scans.length} scans, truth ${fmt(truth)}, box count ${stated})\n`);
    console.log('| start | order | 1st question (scan #, grid) | right | questions | wrong | silent switches | confirmed at | final |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    const outcomes: ReplayOutcome[] = [];
    const names = scans.map((f) => f.name);
    for (const st of starts) {
      const orders: [string, string[]][] = [['taken', names], ...Array.from({ length: SHUFFLES }, (_, k): [string, string[]] => [`shuffle ${k + 1}`, shuffled(names, k + 1)])];
      for (const [label, order] of orders) {
        const o = await replayGrid(order, st, truth, ref, async (id, g, probe) => (await analyse(byName.get(id)!, g, probe)).evidence, label);
        outcomes.push(o);
        console.log(`| ${st.label} | ${label} | ${o.first ? `#${o.first.at} ${fmt(o.first.grid)}` : '–'} | ${o.first ? (o.first.right ? 'yes' : 'NO') : '–'} | ${o.questions} | ${o.wrongQuestions} | ${o.silentSwitches} | ${o.confirmedAt ? `#${o.confirmedAt}` : '–'} | ${fmt(o.final)} ${o.right ? '✓' : '✗'} (${o.finalStatus}) |`);
        if (process.env.VERBOSE) for (const l of o.log) console.log(`    ${l}`);
      }
    }
    // Summary per start condition.
    console.log('\n| start | runs | max questions | first question right | final right |');
    console.log('|---|---:|---:|---:|---:|');
    for (const st of starts) {
      const os = outcomes.filter((o) => o.start === st.label);
      const asked = os.filter((o) => o.first);
      console.log(`| ${st.label} | ${os.length} | ${Math.max(...os.map((o) => o.questions))} | ${asked.length ? `${asked.filter((o) => o.first!.right).length}/${asked.length}` : '–'} | ${os.filter((o) => o.right).length}/${os.length} |`);
    }
    report[`${refKey} truth ${fmt(truth)}`] = outcomes;
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  await chrome?.close();
}

await main();
