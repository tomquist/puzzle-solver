/**
 * Download the labelled part of the Puzzle-Map dataset (Hugging Face pablo-moreira/puzzle-map,
 * CC BY 4.0, see test-corpus/CREDITS.md) into test-corpus/puzzle-map/ (git-ignored) for
 * bench/puzzlemap.eval.ts: the annotation files, the reference pictures of the puzzles that have
 * labelled pieces, and every piece photo with at least one labelled piece (≈ 600 photos, ≈ 250 MB).
 *
 *   npm run corpus:fetch-puzzlemap [-- --limit <n>]
 *
 * The files are fetched from a fixed dataset revision, so the benchmark numbers stay comparable.
 * Files already present are skipped (re-run to resume). Nothing from the dataset is committed: the
 * pictures show the publishers' artwork (Marvel, DC, a children's puzzle), which the dataset's
 * licence cannot cover.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REPO_ROOT } from '../src/testing/nodeImageIO';

const REPO = 'pablo-moreira/puzzle-map';
/** Dataset revision the benchmark was built on (2026-09-13). */
const REVISION = 'ffc40afb7c3e31dd48804e6e550b51287414f6e2';
const OUT = resolve(REPO_ROOT, 'test-corpus/puzzle-map');
const PARALLEL = 6;

interface PieceAnnotation {
  puzzle?: { name: string };
}

const url = (path: string) => `https://huggingface.co/datasets/${REPO}/resolve/${REVISION}/${path}`;

async function download(path: string): Promise<boolean> {
  const dest = resolve(OUT, path);
  if (existsSync(dest)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = dest + '.part';
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      renameSync(tmp, dest);
      return true;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  mkdirSync(OUT, { recursive: true });
  await download('puzzles/annotations.json');
  await download('pieces/annotations.json');
  const pieces = JSON.parse(readFileSync(resolve(OUT, 'pieces/annotations.json'), 'utf8')) as Record<string, { pieces: PieceAnnotation[] }>;
  const photos = Object.keys(pieces).filter((f) => pieces[f].pieces.some((p) => p.puzzle)).sort().slice(0, limit);
  const puzzles = [...new Set(photos.flatMap((f) => pieces[f].pieces.flatMap((p) => (p.puzzle ? [p.puzzle.name] : []))))].sort();
  const todo = [...puzzles.map((p) => `puzzles/${p}`), ...photos.map((f) => `pieces/${f}`)];
  console.log(`Puzzle-Map @ ${REVISION.slice(0, 8)}: ${puzzles.length} reference pictures, ${photos.length} piece photos -> ${OUT}`);
  let fetched = 0, done = 0;
  const queue = [...todo];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      if (await download(path)) fetched++;
      if (++done % 50 === 0) console.log(`  ${done}/${todo.length}`);
    }
  }));
  writeFileSync(resolve(OUT, 'SOURCE.txt'), [
    `Puzzle-Map dataset by Pablo Moreira, https://huggingface.co/datasets/${REPO} (revision ${REVISION}),`,
    'licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); unmodified files.',
    'The pictures show third-party puzzle artwork: for local benchmarking only, do not commit or publish.',
    '',
  ].join('\n'));
  console.log(`done: ${fetched} downloaded, ${todo.length - fetched} already present`);
  return 0;
}

main(process.argv.slice(2)).then((code) => (process.exitCode = code), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
