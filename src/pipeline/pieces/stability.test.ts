/**
 * Stability of the segmentation on dense layouts: the same photo with a little extra sensor noise or
 * re-encoded as JPEG must give (nearly) the same regions. Every decision that depends on the data
 * (threshold, table colours, reference size, splits) flips on such scenes if it is not robust.
 */
import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, jpegRoundTrip, renderPiecesPhoto, Rng } from '../../testing/synth';
import { segmentPieces } from './segment';
import type { Segmentation } from './types';

const PAINTING = resizeRGBA(loadTestAsset('starry-night'), 800, 634);

/**
 * About 30 pieces packed closely on a light mat: an assembled strip of five, seven touching or
 * overlapping pairs, a second lighter surface with its own lighting, phone JPEG.
 */
function denseScene(seed: number) {
  const cut = generateJigsaw(8, 10, PAINTING.width, PAINTING.height, seed * 7);
  const rng = new Rng(seed);
  const items: (number | number[])[] = [[0, 1, 2, 3, 4]];
  const pool = Array.from({ length: 80 }, (_, i) => i).filter((i) => i > 9);
  for (let k = 0; k < 28; k++) items.push(pool.splice(rng.int(pool.length), 1)[0]);
  return renderPiecesPhoto(PAINTING, cut, items, {
    seed, background: [158, 160, 138], noiseSigma: 2.5, illumination: 0.15, scale: [0.85, 0.95], margin: 5, packing: 1.5,
    pairs: { count: 7, gap: [-3, 2] }, secondSurface: {}, jpegQuality: 85,
  });
}

/** Uniform integer noise of ±amp on every colour channel (deterministic). */
function withNoise(img: RGBAImage, amp: number, seed: number): RGBAImage {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  let s = seed >>> 0;
  for (let i = 0; i < out.data.length; i++) {
    if ((i & 3) === 3) continue;
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out.data[i] += ((s >>> 16) % (2 * amp + 1)) - amp;
  }
  return out;
}

function labelMap(seg: Segmentation, W: number, H: number): Int32Array {
  const m = new Int32Array(W * H);
  for (const r of seg.regions) {
    const b = r.region.bbox;
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (r.mask.data[y * b.width + x]) m[(y + b.y) * W + x + b.x] = r.region.id;
  }
  return m;
}

/** Share of the regions of `a` that have a region in `b` with IoU ≥ 0.8. */
function agreement(a: Int32Array, b: Int32Array): number {
  const inter = new Map<number, Map<number, number>>(), areaA = new Map<number, number>(), areaB = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x) areaA.set(x, (areaA.get(x) ?? 0) + 1);
    if (y) areaB.set(y, (areaB.get(y) ?? 0) + 1);
    if (x && y) {
      const m = inter.get(x) ?? new Map<number, number>();
      m.set(y, (m.get(y) ?? 0) + 1);
      inter.set(x, m);
    }
  }
  let ok = 0;
  for (const [x, ax] of areaA) {
    let best = 0;
    for (const [y, v] of inter.get(x) ?? []) best = Math.max(best, v / (ax + (areaB.get(y) ?? 0) - v));
    if (best >= 0.8) ok++;
  }
  return areaA.size > 0 ? ok / areaA.size : 1;
}

describe('segmentPieces stability', () => {
  it('gives the same regions on a dense scene with extra noise or JPEG re-encoding', () => {
    const lines: string[] = [];
    for (const seed of [1, 2, 4]) {
      const { photo, truth } = denseScene(seed);
      const W = photo.width, H = photo.height;
      const base = segmentPieces(photo);
      const baseL = labelMap(base, W, H);
      // About one region per loose piece or assembled group.
      expect(Math.abs(base.regions.length - truth.length)).toBeLessThanOrEqual(0.15 * truth.length);
      for (const [name, img] of [['noise ±2', withNoise(photo, 2, 1000 + seed)], ['jpeg q90', jpegRoundTrip(photo, 90)]] as const) {
        const seg = segmentPieces(img);
        const agree = agreement(baseL, labelMap(seg, W, H));
        lines.push(`seed ${seed} ${name}: regions ${base.regions.length} -> ${seg.regions.length}, agreement ${agree.toFixed(2)}`);
        expect(Math.abs(seg.regions.length - base.regions.length)).toBeLessThanOrEqual(Math.max(2, 0.1 * base.regions.length));
        expect(agree).toBeGreaterThanOrEqual(0.8);
      }
    }
    console.log(`stability on dense scenes (truth ≈ 29 items):\n${lines.join('\n')}`);
  }, 60_000);
});
