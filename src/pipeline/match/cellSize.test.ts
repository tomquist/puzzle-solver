/**
 * The cell size measured from one scan (cellSize.ts) does not echo the grid the scan was analysed
 * with: the same photo analysed with the right grid, one column too few, and cells 25 % too large
 * (a wrong piece count, with the probe) measures the true cell (within its stated error),
 * and its cell centres sit in the middle of the true cells. Measured after the result
 * (deferGridEvidence, as the app does), a step at a time, it is the same evidence.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../cv/image';
import type { GridEvidence, GridSpec } from '../../model/types';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto } from '../../testing/synth';
import { analyzeScan } from '../analyzeScan';
import { buildReferenceIndex } from './referenceIndex';

describe('cell size of a scan', () => {
  const truth: GridSpec = { rows: 16, cols: 20 };
  let reference: RGBAImage, photo: RGBAImage;
  const evidence = new Map<string, GridEvidence>();
  let deferred: { placeholder: GridEvidence; steps: number; evidence: GridEvidence } | undefined;
  beforeAll(() => {
    const src = loadTestAsset('starry-night');
    const cut = generateJigsaw(truth.rows, truth.cols, src.width, src.height, 21);
    reference = perturbReference(src, { seed: 21 });
    const at = (r: number, c: number) => r * truth.cols + c;
    const block = (r0: number, c0: number, h: number, w: number) => Array.from({ length: h * w }, (_, k) => at(r0 + Math.floor(k / w), c0 + (k % w)));
    const items = [block(3, 3, 4, 5), block(9, 12, 3, 4), at(0, 0), at(1, 17), at(14, 2), at(12, 8), at(6, 15), at(15, 19)];
    photo = renderPiecesPhoto(src, cut, items, { seed: 71, background: [38, 40, 46], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1 }).photo;
    for (const [key, grid, probe] of [
      ['right', truth, undefined],
      ['cols-1', { rows: 16, cols: 19 }, undefined],
      ['cells+25%', { rows: 13, cols: 16 }, 'near'],
    ] as const) {
      const index = buildReferenceIndex(reference, grid, 'grid');
      evidence.set(key, analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), gridProbe: probe }).result.gridEvidence!);
      if (key === 'cells+25%') {
        const out = analyzeScan(index, photo, { maxSide: Math.max(photo.width, photo.height), gridProbe: probe, deferGridEvidence: true });
        let steps = 0;
        let r = out.gridFollowUp!.next();
        for (; !r.done; r = out.gridFollowUp!.next()) steps++;
        deferred = { placeholder: out.result.gridEvidence!, steps, evidence: r.value };
      }
    }
  }, 300_000);

  for (const key of ['right', 'cols-1', 'cells+25%']) {
    it(`measures the true cell when analysed with ${key}`, () => {
      const ev = evidence.get(key)!;
      const cw = Math.log(reference.width / truth.cols), ch = Math.log(reference.height / truth.rows);
      const patches = ev.sources.filter((s) => s.kind === 'patch' && (s.w || s.h));
      expect(patches.length).toBeGreaterThanOrEqual(1);
      // Every source within 2.5 of its own standard errors (+1 %): the synthetic cut's corners are
      // jittered by up to 7 % of a cell, so a patch with few seams scatters – and says so.
      for (const [axis, truthLog] of [['w', cw], ['h', ch]] as const) {
        for (const s of ev.sources) {
          const m = s[axis];
          if (m) expect(Math.abs(m.log - truthLog), `${s.kind} ${axis} ${key}`).toBeLessThan(2.5 * Math.hypot(m.se, 0.01));
        }
      }
      // Cell centres in the middle of the true cells (within a quarter cell).
      const cell = reference.width / truth.cols;
      const xs = ev.sources.flatMap((s) => s.x ?? []);
      expect(xs.length).toBeGreaterThanOrEqual(5);
      const off = xs.map((x) => {
        const f = (x + 0.5) / cell - 0.5;
        return Math.abs(f - Math.round(f));
      });
      off.sort((a, b) => a - b);
      expect(off[Math.floor(off.length / 2)], key).toBeLessThan(0.15);
    });
  }

  it('measures after the result, in steps, to the same evidence', () => {
    expect(deferred!.placeholder.pending).toBe(true);
    expect(deferred!.placeholder.sources).toEqual([]);
    // Patches' parts, pieces a few at a time, and the probe's re-matches: many short steps.
    expect(deferred!.steps).toBeGreaterThan(5);
    expect(deferred!.evidence).toEqual(evidence.get('cells+25%'));
  });
});
