import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMat3, similarityAbout, type Mat3, type Point } from '../../cv/geometry';
import { cloneRGBA, type RGBAImage } from '../../cv/image';
import { drawPolygon } from '../../cv/raster';
import { warpRGBA } from '../../cv/warp';
import type { CellRef, RegionMatch } from '../../model/types';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, type JigsawCut, type PieceTruth } from '../../testing/synth';
import { buildReferenceIndex, cellAt, matchRegion, matchRegions, type MatchInput, type ReferenceIndex } from './index';
import { accuracy, angleError, inputFromTruth, renderScenario, type Accuracy } from './testkit';

const table: string[] = [];
function report(name: string, acc: Accuracy, msPerRegion: number): void {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`.padStart(7);
  table.push(`${name.padEnd(44)} n=${String(acc.n).padStart(3)} top1=${pct(acc.top1)} top3=${pct(acc.top3)} rot≤10°=${pct(acc.rotation)} ${msPerRegion.toFixed(0).padStart(5)} ms/region`);
}
afterAll(() => {
  console.log(`\nMatching accuracy / timing (Node, single thread)\n${table.join('\n')}\n`);
});

function timed<T>(f: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
}

function bodyCenter(cut: JigsawCut, t: PieceTruth): Point {
  const c = cut.pieces[t.pieces[0]].corners;
  return { x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 };
}

describe('matchRegion — Starry Night 20×16 (320 pieces)', () => {
  const rows = 16, cols = 20;
  let ref: RGBAImage;
  let index: ReferenceIndex;
  let cut: JigsawCut;
  let scene: { photo: RGBAImage; truth: PieceTruth[] };

  beforeAll(() => {
    ref = loadTestAsset('starry-night');
    index = buildReferenceIndex(perturbReference(ref, { seed: 5 }), { rows, cols }, 'grid');
    cut = generateJigsaw(rows, cols, ref.width, ref.height, 101);
    scene = renderScenario(ref, cut, { seed: 1, n: 30, scale: [1, 1.5] });
  });

  it('places single pieces with ground-truth shapes', () => {
    const inputs = scene.truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: true }));
    const { value: matches, ms } = timed(() => inputs.map((inp) => matchRegion(index, inp)));
    const acc = accuracy(matches, scene.truth);
    report('Starry 20×16, shape, matchRegion', acc, ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.9);
    expect(acc.top3).toBeGreaterThanOrEqual(0.97);
    expect(acc.rotation).toBe(1);
    for (const m of matches) {
      expect(m.candidates.length).toBeGreaterThan(1);
      expect(m.candidates.length).toBeLessThanOrEqual(5);
      for (const c of m.candidates) {
        expect(c.rotationDeg).toBeGreaterThanOrEqual(0);
        expect(c.rotationDeg).toBeLessThan(360);
        expect(c.confidence).toBeGreaterThanOrEqual(0);
        expect(c.confidence).toBeLessThanOrEqual(1);
      }
      // Body center within the reported cell.
      const c0 = m.candidates[0];
      expect(cellAt(index, c0), 'x/y must lie in row/col').toEqual({ row: c0.row, col: c0.col });
    }
    expect(matches.filter((m) => m.status === 'confident').length).toBeGreaterThanOrEqual(0.8 * matches.length);
    if (DEBUG_IMAGES) {
      // Overlay: each photographed outline turned by rotationDeg and moved to x/y must cover its cell.
      const dbg = cloneRGBA(ref);
      matches.forEach((m, i) => {
        const c = m.candidates[0], t = scene.truth[i];
        const R = similarityAbout(t.center, { x: c.x, y: c.y }, (c.rotationDeg * Math.PI) / 180, 1 / t.scale);
        drawPolygon(dbg, t.outline.map((p) => applyMat3(R, p)), m.status === 'confident' ? [0, 255, 0, 255] : [255, 160, 0, 255], 2);
      });
      savePng('.debug/match/placements.png', dbg);
      savePng('.debug/match/scan.png', scene.photo);
    }
  });

  it('places single pieces without shape (orientation + expected body size)', () => {
    const inputs = scene.truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: false, orientationError: 1.5 }));
    const { value: matches, ms } = timed(() => inputs.map((inp) => matchRegion(index, inp)));
    const acc = accuracy(matches, scene.truth);
    report('Starry 20×16, no shape, matchRegion', acc, ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.9);
    expect(acc.top3).toBeGreaterThanOrEqual(0.97);
    expect(acc.rotation).toBe(1);
  });

  it('places single pieces without shape or body size (scale search)', () => {
    const inputs = scene.truth.slice(0, 12).map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withBodySize: false }));
    const { value: matches, ms } = timed(() => inputs.map((inp) => matchRegion(index, inp)));
    const acc = accuracy(matches, scene.truth.slice(0, 12));
    report('Starry 20×16, no shape, no body size', acc, ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.8);
  });

  it('matches a whole scan with colour correction (matchRegions)', () => {
    const inputs = scene.truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: false }));
    const { value: matches, ms } = timed(() => matchRegions(index, inputs));
    const acc = accuracy(matches, scene.truth);
    report('Starry 20×16, no shape, matchRegions', acc, ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.93);
    expect(acc.top3).toBeGreaterThanOrEqual(0.97);
  });

  it('puts edge and corner pieces on the border', () => {
    const edge = renderScenario(ref, cut, { seed: 2, n: 24, scale: [1, 1.5], filter: (p) => p.sides.includes('flat') });
    const inputs = edge.truth.map((t, i) => inputFromTruth(edge.photo, cut, t, i + 1, { withShape: true }));
    const { value: matches, ms } = timed(() => inputs.map((inp) => matchRegion(index, inp)));
    const acc = accuracy(matches, edge.truth);
    report('Starry 20×16, edge/corner pieces, shape', acc, ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.95);
    matches.forEach((m, i) => {
      const c = m.candidates[0];
      const p = cut.pieces[edge.truth[i].pieces[0]];
      if (c.row !== p.row || c.col !== p.col) return;
      // Rotation is exact enough that the flat sides face the border.
      expect(angleError(c.rotationDeg, edge.truth[i].rotationDeg)).toBeLessThan(10);
    });
  });

  it('locates 2×2 and 3×2 patches with covered cells and rotation', () => {
    const items = [
      [3 * cols + 4, 3 * cols + 5, 4 * cols + 4, 4 * cols + 5],
      [9 * cols + 12, 9 * cols + 13, 9 * cols + 14, 10 * cols + 12, 10 * cols + 13, 10 * cols + 14],
      [12 * cols + 1, 12 * cols + 2, 13 * cols + 1, 13 * cols + 2, 14 * cols + 1, 14 * cols + 2],
      [0 * cols + 16, 0 * cols + 17, 1 * cols + 16, 1 * cols + 17],
    ];
    const { photo, truth } = renderScenario(ref, cut, { seed: 3, items, scale: [1.1, 1.3] });
    for (let i = 0; i < truth.length; i++) {
      const input = inputFromTruth(photo, cut, truth[i], i + 1, { orientationError: -1 });
      expect(input.kind).toBe('patch');
      const { value: m, ms } = timed(() => matchRegion(index, input));
      const c = m.candidates[0];
      const expected = truth[i].pieces.map((p) => `${cut.pieces[p].row},${cut.pieces[p].col}`).sort();
      expect((m.coveredCells ?? []).map((x) => `${x.row},${x.col}`).sort()).toEqual(expected);
      expect({ row: c.row, col: c.col }).toEqual({ row: truth[i].row, col: truth[i].col });
      expect(angleError(c.rotationDeg, truth[i].rotationDeg)).toBeLessThan(5);
      expect(m.status).toBe('confident');
      report(`Starry 20×16, patch ${truth[i].pieces.length === 4 ? '2×2' : '3×2'}`, { n: 1, top1: 1, top3: 1, rotation: 1 }, ms);
    }
  });

  it('copes with a slightly mis-cropped reference (2 % offset, 1 % scale)', () => {
    // The user's picture quad was a little off: reference' = 1.01 · reference shifted by -2 %.
    const A: Mat3 = [1.01, 0, -0.02 * ref.width, 0, 1.01, -0.02 * ref.height, 0, 0, 1];
    const cropped = warpRGBA(perturbReference(ref, { seed: 6 }), A, ref.width, ref.height, { fill: [0, 0, 0, 255] });
    const idx = buildReferenceIndex(cropped, { rows, cols }, 'grid');
    const inside = scene.truth.filter((t) => {
      const p = applyMat3(A, bodyCenter(cut, t));
      return p.x > 0 && p.y > 0 && p.x < ref.width - 1 && p.y < ref.height - 1;
    });
    const expected = (t: PieceTruth): CellRef => cellAt(idx, applyMat3(A, bodyCenter(cut, t)));
    const inputs = inside.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: true }));
    const { value: matches, ms } = timed(() => inputs.map((inp) => matchRegion(idx, inp)));
    const acc = accuracy(matches, inside, expected);
    report('Starry 20×16, mis-cropped reference, shape', acc, ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.9);
    // Reported positions are where the body center really is in the mis-cropped reference.
    matches.forEach((m, i) => {
      const c = m.candidates[0];
      const e = expected(inside[i]);
      if (c.row !== e.row || c.col !== e.col) return;
      const p = applyMat3(A, bodyCenter(cut, inside[i]));
      expect(Math.hypot(c.x - p.x, c.y - p.y)).toBeLessThan(0.2 * idx.cellW);
    });
  });

  it('works for irregular cuts (pure sliding search)', () => {
    const idx = buildReferenceIndex(perturbReference(ref, { seed: 5 }), { rows, cols }, 'irregular');
    const sub = scene.truth.slice(0, 12);
    const inputs = sub.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: true }));
    const matches = inputs.map((inp) => matchRegion(idx, inp));
    let near = 0;
    matches.forEach((m, i) => {
      const p = bodyCenter(cut, sub[i]);
      if (Math.hypot(m.candidates[0].x - p.x, m.candidates[0].y - p.y) < 0.3 * idx.cellW) near++;
    });
    expect(near / sub.length).toBeGreaterThanOrEqual(0.9);
  });

  it('down-weights placed cells and honours maxCandidates', () => {
    const input = inputFromTruth(scene.photo, cut, scene.truth[0], 1, { withShape: true });
    const a = matchRegion(index, input, { maxCandidates: 3 });
    expect(a.candidates.length).toBe(3);
    const top = a.candidates[0];
    const b = matchRegion(index, input, { placedCells: [{ row: top.row, col: top.col }] });
    const same = b.candidates.find((c) => c.row === top.row && c.col === top.col);
    expect(same).toBeDefined();
    expect(same!.score).toBeCloseTo(top.score - 0.1, 5);
  });

  it('returns unmatched for an empty region and ignores background', () => {
    const input = inputFromTruth(scene.photo, cut, scene.truth[0], 1);
    const empty: MatchInput = { ...input, mask: { ...input.mask, data: new Uint8Array(input.mask.data.length) } };
    const m: RegionMatch = matchRegion(index, empty);
    expect(m.status).toBe('unmatched');
    expect(m.candidates).toEqual([]);
  });
});

describe('matchRegion — Great Wave 40×25 (1000 pieces)', () => {
  const rows = 25, cols = 40;
  let ref: RGBAImage;
  let index: ReferenceIndex;
  let cut: JigsawCut;
  let indexMs = 0;

  beforeAll(() => {
    ref = loadTestAsset('great-wave');
    const box = perturbReference(ref, { seed: 5 });
    const t = timed(() => buildReferenceIndex(box, { rows, cols }, 'grid'));
    index = t.value;
    indexMs = t.ms;
    cut = generateJigsaw(rows, cols, ref.width, ref.height, 202);
  });

  it('builds the reference index quickly', () => {
    table.push(`buildReferenceIndex 40×25 on ${ref.width}×${ref.height}: ${indexMs.toFixed(0)} ms`);
    expect(index.levels.map((l) => l.ppc)).toEqual([4, 8, 16, 32]);
    expect(indexMs).toBeLessThan(3000); // target < 1 s; generous for loaded CI machines
  });

  it('places random pieces of a scan (top-1 ≥ 75 %)', () => {
    const scene = renderScenario(ref, cut, { seed: 4, n: 30, scale: [2, 3] });
    const inputs = scene.truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: true }));
    const single = timed(() => inputs.map((inp) => matchRegion(index, inp)));
    report('Great Wave 40×25, shape, matchRegion', accuracy(single.value, scene.truth), single.ms / inputs.length);
    const batch = timed(() => matchRegions(index, inputs));
    const acc = accuracy(batch.value, scene.truth);
    report('Great Wave 40×25, shape, matchRegions', acc, batch.ms / inputs.length);
    expect(acc.top1).toBeGreaterThanOrEqual(0.75);
    expect(acc.rotation).toBeGreaterThanOrEqual(0.95);
    expect(single.ms / inputs.length).toBeLessThan(900); // target < 300 ms
    const noShape = scene.truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: false }));
    const ns = timed(() => matchRegions(index, noShape));
    const accNs = accuracy(ns.value, scene.truth);
    report('Great Wave 40×25, no shape, matchRegions', accNs, ns.ms / inputs.length);
    expect(accNs.top1).toBeGreaterThanOrEqual(0.7);
  });

  it('locates a 3×2 patch quickly', () => {
    const items = [[10 * cols + 20, 10 * cols + 21, 10 * cols + 22, 11 * cols + 20, 11 * cols + 21, 11 * cols + 22]];
    const { photo, truth } = renderPiecesPhoto(ref, cut, items, { seed: 5, scale: 2.5, noiseSigma: 4, blurSigma: 0.8 });
    const input = inputFromTruth(photo, cut, truth[0], 1);
    const { value: m, ms } = timed(() => matchRegion(index, input));
    report('Great Wave 40×25, patch 3×2', { n: 1, top1: m.candidates[0].row === 10 && m.candidates[0].col === 20 ? 1 : 0, top3: 1, rotation: 1 }, ms);
    expect(m.coveredCells?.length).toBe(6);
    expect({ row: m.candidates[0].row, col: m.candidates[0].col }).toEqual({ row: 10, col: 20 });
    expect(angleError(m.candidates[0].rotationDeg, truth[0].rotationDeg)).toBeLessThan(5);
    expect(ms).toBeLessThan(6000); // target < 2 s
  });
});
