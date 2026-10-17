/**
 * Real-photo corpus replay. Every `*.json` in test-corpus/ is a puzzle export from the app
 * (Settings → Export). Each piece the user confirmed as "Placed ✓" is a labelled example: its scan
 * photo is re-analysed with the current pipeline and the piece must still be matched to the cell
 * the user confirmed. Gated by bench/baseline.json like the synthetic suites.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Point } from '../src/cv/geometry';
import type { RGBAImage } from '../src/cv/image';
import { analyzeScan } from '../src/pipeline/analyzeScan';
import { buildReferenceIndex } from '../src/pipeline/match';
import type { DetectedRegion, ScanRecord } from '../src/model/types';
import type { PuzzleExportFile } from '../src/storage/exportFormat';
import { REPO_ROOT } from '../src/testing/nodeImageIO';
import { compareToBaseline, yieldToEventLoop, report, saveBaselineSuite, UPDATE_BASELINE, type MetricRecord } from './lib';

const CORPUS_DIR = resolve(REPO_ROOT, 'test-corpus');
const files = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')) : [];
const results: Record<string, MetricRecord> = {};

function decodeImage(entry: { type: string; base64: string }): RGBAImage {
  const buf = Buffer.from(entry.base64, 'base64');
  if (entry.type === 'image/png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  const raw = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
}

function centroid(r: DetectedRegion): Point {
  return { x: r.bbox.x + r.bbox.width / 2, y: r.bbox.y + r.bbox.height / 2 };
}

/** The new region that corresponds to a region of the stored scan (nearest bbox center inside the old bbox). */
function correspondingRegion(old: DetectedRegion, regions: DetectedRegion[]): DetectedRegion | undefined {
  const c = centroid(old);
  let best: DetectedRegion | undefined;
  let bestD = Infinity;
  for (const r of regions) {
    const p = centroid(r);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < bestD && d < Math.max(old.bbox.width, old.bbox.height) / 2) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

describe('real-photo corpus', () => {
  if (files.length === 0) {
    it.skip('no exports in test-corpus/ (see docs/TESTING.md)', () => {});
    return;
  }
  for (const file of files) {
    it(file, async () => {
      const data = JSON.parse(readFileSync(resolve(CORPUS_DIR, file), 'utf8')) as PuzzleExportFile;
      const { puzzle, progress, scans, blobs } = data;
      const reference = decodeImage(blobs[puzzle.reference.blobId]);
      const index = buildReferenceIndex(reference, puzzle.grid, puzzle.cut);
      const scansById = new Map<string, ScanRecord>(scans.map((s) => [s.id, s]));
      const labelled = Object.entries(progress.placed).filter(([, p]) => p.scanId && p.regionId !== undefined && scansById.has(p.scanId));
      const byScan = new Map<string, { cell: string; regionId: number }[]>();
      for (const [cell, p] of labelled) {
        const list = byScan.get(p.scanId!) ?? [];
        list.push({ cell, regionId: p.regionId! });
        byScan.set(p.scanId!, list);
      }
      let n = 0, top1 = 0, top3 = 0, found = 0;
      for (const [scanId, labels] of byScan) {
        await yieldToEventLoop();
        const scan = scansById.get(scanId)!;
        const photo = decodeImage(blobs[scan.photoBlobId]);
        const { result } = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height) });
        for (const { cell, regionId } of labels) {
          n++;
          const old = scan.result.regions.find((r) => r.id === regionId);
          const now = old && correspondingRegion(old, result.regions);
          if (!now) continue;
          found++;
          const cands = result.matches.find((m) => m.regionId === now.id)?.candidates ?? [];
          const keys = cands.map((c) => `${c.row},${c.col}`);
          if (keys[0] === cell) top1++;
          if (keys.slice(0, 3).includes(cell)) top3++;
        }
      }
      const rec: MetricRecord = { scenes: byScan.size, items: n, segRecall: n ? found / n : 1, top1: n ? top1 / n : 1, top3: n ? top3 / n : 1 };
      results[file] = rec;
      if (UPDATE_BASELINE) return;
      const problems = compareToBaseline('corpus', file, rec);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
  afterAll(() => {
    console.log('\n' + report('corpus', results, ['scenes', 'items', 'segRecall', 'top1', 'top3']) + '\n');
    if (UPDATE_BASELINE) saveBaselineSuite('corpus', results);
  });
});
