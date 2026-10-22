/**
 * Node-only helpers for tests: decode JPEG/PNG test assets into RGBAImage and write debug PNGs.
 * Never import this from app code (it uses `fs` and Node-only codecs).
 *
 * Debug output convention: write to `.debug/<area>/<name>.png` (git-ignored) so results can be
 * inspected visually, e.g. `savePng('.debug/segment/mask.png', maskToRGBA(mask))`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RGBAImage } from '../cv/image';
import type { PlacementTuning } from '../pipeline/analyzeScan';

export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');

export function loadImageFile(path: string): RGBAImage {
  const abs = resolve(REPO_ROOT, path);
  const buf = readFileSync(abs);
  if (abs.toLowerCase().endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
  }
  const raw = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length) };
}

/** Load one of the bundled test paintings (see test-assets/README.md). */
export function loadTestAsset(name: 'starry-night' | 'great-wave'): RGBAImage {
  return loadImageFile(`test-assets/${name}.jpg`);
}

export function savePng(path: string, img: RGBAImage): void {
  const abs = resolve(REPO_ROOT, path);
  mkdirSync(dirname(abs), { recursive: true });
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(abs, PNG.sync.write(png));
}

/** True when the DEBUG_IMAGES env var is set; tests should only write debug PNGs then. */
export const DEBUG_IMAGES = !!process.env.DEBUG_IMAGES;

/**
 * Segmentation options for A/B runs of the benchmark and the feedback tools: GRAPH_CUT=1 / 0 turns
 * the graph-cut outline refinement on / off, GRAIN=1 / 0 the wood-grain table model (off by
 * default; unset: the pipeline's default).
 */
export const SEGMENT_OPTIONS: { graphCut?: boolean; grain?: boolean } = {
  ...(process.env.GRAPH_CUT === undefined ? {} : { graphCut: process.env.GRAPH_CUT !== '0' }),
  ...(process.env.GRAIN === undefined ? {} : { grain: process.env.GRAIN !== '0' }),
};

/**
 * Consistency pass of analyzeScan for A/B runs of the benchmark and the feedback tools:
 * CONSISTENCY=1 / 0 turns it on / off (unset: the pipeline's default).
 */
export const CONSISTENCY: boolean | undefined = process.env.CONSISTENCY === undefined ? undefined : process.env.CONSISTENCY !== '0';

/**
 * Placement knobs of analyzeScan for A/B runs and sweeps of the benchmark and the feedback tools
 * (unset: the pipeline's defaults): PLACED_PENALTY=<score> (placed-cell penalty), PLACED_GAIN=<confidence>
 * (most the marks may lift a confidence over the photo's own), UNIQUE_CELLS=1 / 0
 * (one cell per piece within a scan), CLAIM_SLACK=<score> (how far down a piece may move to a free
 * candidate).
 */
export const PLACEMENT_TUNING: PlacementTuning = {
  ...(process.env.PLACED_PENALTY === undefined ? {} : { placedPenalty: Number(process.env.PLACED_PENALTY) }),
  ...(process.env.PLACED_GAIN === undefined ? {} : { placedGain: Number(process.env.PLACED_GAIN) }),
  ...(process.env.UNIQUE_CELLS === undefined ? {} : { uniqueCells: process.env.UNIQUE_CELLS !== '0' }),
  ...(process.env.CLAIM_SLACK === undefined ? {} : { claimSlack: Number(process.env.CLAIM_SLACK) }),
};
