import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMat3, similarityAbout, type Mat3, type Point } from '../../cv/geometry';
import { cloneRGBA, createRGBA, type RGBAImage } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';
import { drawPolygon } from '../../cv/raster';
import { warpRGBA } from '../../cv/warp';
import type { CellRef, RegionMatch } from '../../model/types';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { generateJigsaw, perturbReference, renderPiecesPhoto, Rng, type JigsawCut, type PieceTruth } from '../../testing/synth';
import { matchRegionsDetailed } from './colorCorrection';
import { capForBorder, capForSize, CONFIDENT_THRESHOLD, matchConfidence, matchRegionDetailed, outlineFactor, patchBodySize, scorePlacement, type MatchDetail } from './matchRegion';
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

  it('scores a given cell and rotation on the scale of the candidates (scorePlacement)', () => {
    const inputs = scene.truth.slice(0, 8).map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: true }));
    let diff = 0, worseTurned = 0;
    for (const inp of inputs) {
      const d = matchRegionDetailed(index, inp);
      const c = d.match.candidates[0];
      const same = scorePlacement(index, inp, d, { row: c.row, col: c.col }, c.rotationDeg)!;
      expect(same.row).toBe(c.row);
      expect(same.col).toBe(c.col);
      expect(angleError(same.rotationDeg, c.rotationDeg)).toBeLessThan(10);
      diff += Math.abs(same.score - c.score);
      const turned = scorePlacement(index, inp, d, { row: c.row, col: c.col }, c.rotationDeg + 180)!;
      expect(angleError(turned.rotationDeg, c.rotationDeg + 180)).toBeLessThan(10);
      if (turned.score < c.score - 0.05) worseTurned++;
    }
    expect(diff / inputs.length).toBeLessThan(0.02);
    expect(worseTurned).toBeGreaterThanOrEqual(7);
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

  it('places a large ragged block turned ~30° when the scan has no piece size', () => {
    // A photo of one assembled block (45 pieces, outline pieces missing) and nothing else: no single
    // piece gives the body size, so the block measures it from its own seams.
    const missing = new Set(['4,6', '4,9', '7,12', '10,8']);
    const block: number[] = [];
    for (let r = 4; r <= 10; r++) for (let c = 6; c <= 12; c++) if (!missing.has(`${r},${c}`)) block.push(r * cols + c);
    const cell = (cut.width / cut.cols + cut.height / cut.rows) / 2;
    for (const rotation of [32, 207]) {
      const { photo, truth } = renderPiecesPhoto(ref, cut, [block], {
        seed: 9, rotation, scale: 70 / cell, background: [196, 208, 218], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1, supersample: 2,
      });
      const input = inputFromTruth(photo, cut, truth[0], 1, { withBodySize: false, orientationError: 1.5 });
      expect(input.kind).toBe('patch');
      expect(input.expectedBodySize).toBeUndefined();
      expect(Math.abs(patchBodySize(input)! / 70 - 1)).toBeLessThan(0.08);
      const { value: m, ms } = timed(() => matchRegion(index, input));
      // Exactly its pieces, also on the ragged rim (the cells come from the block's own seams).
      const expected = block.map((p) => `${cut.pieces[p].row},${cut.pieces[p].col}`).sort();
      expect((m.coveredCells ?? []).map((x) => `${x.row},${x.col}`).sort(), `rotation ${rotation}`).toEqual(expected);
      expect(angleError(m.candidates[0].rotationDeg, truth[0].rotationDeg)).toBeLessThan(5);
      expect(m.status).toBe('confident');
      report(`Starry 20×16, ragged block of 45 at ${rotation}°`, { n: 1, top1: 1, top3: 1, rotation: 1 }, ms);
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

  it('builds the reference index (time logged, not asserted)', () => {
    table.push(`buildReferenceIndex 40×25 on ${ref.width}×${ref.height}: ${indexMs.toFixed(0)} ms`);
    expect(index.levels.map((l) => l.ppc)).toEqual([4, 8, 16, 32]);
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
    // 'confident' must mean right, even with the large plain sky areas.
    batch.value.forEach((m, i) => {
      if (m.status === 'confident') expect({ row: m.candidates[0].row, col: m.candidates[0].col }).toEqual({ row: scene.truth[i].row, col: scene.truth[i].col });
    });
    const noShape = scene.truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: false }));
    const ns = timed(() => matchRegions(index, noShape));
    const accNs = accuracy(ns.value, scene.truth);
    report('Great Wave 40×25, no shape, matchRegions', accNs, ns.ms / inputs.length);
    expect(accNs.top1).toBeGreaterThanOrEqual(0.7);
  });

  it('locates a 3×2 patch', () => {
    const items = [[10 * cols + 20, 10 * cols + 21, 10 * cols + 22, 11 * cols + 20, 11 * cols + 21, 11 * cols + 22]];
    const { photo, truth } = renderPiecesPhoto(ref, cut, items, { seed: 5, scale: 2.5, noiseSigma: 4, blurSigma: 0.8 });
    const input = inputFromTruth(photo, cut, truth[0], 1);
    const { value: m, ms } = timed(() => matchRegion(index, input));
    report('Great Wave 40×25, patch 3×2', { n: 1, top1: m.candidates[0].row === 10 && m.candidates[0].col === 20 ? 1 : 0, top3: 1, rotation: 1 }, ms);
    expect(m.coveredCells?.length).toBe(6);
    expect({ row: m.candidates[0].row, col: m.candidates[0].col }).toEqual({ row: 10, col: 20 });
    expect(angleError(m.candidates[0].rotationDeg, truth[0].rotationDeg)).toBeLessThan(5);
  });
});

describe('matchRegion — featureless pieces', () => {
  // Left half: smooth colour waves (featureless pieces that only see gentle ramps) with one small
  // plain patch of a unique colour; right half: textured painting. Featureless pieces must not be
  // reported 'confident' when wrong; their alternatives must name distinct places.
  const W = 1000, H = 800, rows = 16, cols = 20;
  let ref: RGBAImage;
  let index: ReferenceIndex;

  beforeAll(() => {
    const starry = resizeRGBA(loadTestAsset('starry-night'), 1000, 792);
    ref = createRGBA(W, H, [0, 0, 0, 255]);
    const mottle = (x: number, y: number) => 1.2 * Math.sin(x / 37 + Math.sin(y / 53)) + 0.8 * Math.sin(y / 29 - x / 71);
    for (let y = 0; y < H; y++) {
      const t = y / (H - 1);
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (Math.abs(x - 225) < 60 && Math.abs(y - 625) < 60) {
          // A plain patch of a colour found nowhere else (2.4 cells wide, around cell r12 c4).
          ref.data[o] = 205;
          ref.data[o + 1] = 70;
          ref.data[o + 2] = 55;
        } else if (x < W / 2) {
          // Broad colour waves (a few cells long): locally every piece just sees a gentle ramp.
          const m = mottle(x, y);
          const w1 = 14 * Math.sin((2 * Math.PI * x) / 230 + 1), w2 = 12 * Math.sin((2 * Math.PI * y) / 190);
          const w3 = 9 * Math.sin((2 * Math.PI * (x + y)) / 310);
          ref.data[o] = 150 + 60 * t + w1 + w3 + m;
          ref.data[o + 1] = 180 + 30 * t + w2 + 0.5 * w3 + m;
          ref.data[o + 2] = 215 - 25 * t + 0.6 * w1 - w2 + m;
        } else {
          const s = (Math.min(791, y) * 1000 + x) * 4;
          ref.data[o] = starry.data[s];
          ref.data[o + 1] = starry.data[s + 1];
          ref.data[o + 2] = starry.data[s + 2];
        }
      }
    }
    index = buildReferenceIndex(perturbReference(ref, { seed: 2 }), { rows, cols }, 'grid');
  });

  it('reports plain pieces as ambiguous with spread-out alternatives', () => {
    let plainConfident = 0, plainN = 0, texturedConfident = 0, texturedN = 0, naiveWrong = 0;
    for (const seed of [1, 2]) {
      const cut = generateJigsaw(rows, cols, W, H, 70 + seed);
      const rng = new Rng(seed);
      const unique = cut.pieces[12 * cols + 4];
      const plain = [unique, ...rng.shuffle(cut.pieces.filter((p) => p.col < cols / 2 - 1 && p !== unique)).slice(0, 15)];
      const textured = rng.shuffle(cut.pieces.filter((p) => p.col > cols / 2)).slice(0, 8);
      const g = () => rng.uniform(0.9, 1.1);
      const { photo, truth } = renderPiecesPhoto(ref, cut, [...plain, ...textured].map((p) => p.index), {
        seed, scale: [1.5, 1.8], noiseSigma: 3, blurSigma: 0.7, gain: [g(), g(), g()], illumination: 0.2,
      });
      const inputs = truth.map((t, i) => inputFromTruth(photo, cut, t, i + 1, { withShape: true }));
      // Single pass (no colour correction yet): score and margin alone are fooled by plain pieces.
      inputs.forEach((inp, i) => {
        const d = matchRegionDetailed(index, inp);
        const t = truth[i], c0 = d.match.candidates[0];
        const correct = c0.row === t.row && c0.col === t.col;
        if (!correct && matchConfidence(d.features!.score, d.features!.margin) >= CONFIDENT_THRESHOLD) naiveWrong++;
        if (!correct) expect(d.match.status, `single pass: confident but wrong r${t.row}c${t.col}`).not.toBe('confident');
      });
      const details = matchRegionsDetailed(index, inputs);
      details.forEach((d, i) => {
        const m = d.match, t = truth[i], c0 = m.candidates[0];
        const isPlain = t.col < cols / 2;
        const correct = c0.row === t.row && c0.col === t.col;
        if (t.row === 12 && t.col === 4) {
          // Plain but of a unique colour: the colour narrows it down to its patch, yet the cell
          // within that patch stays undetermined, so it must not be called confident unless right.
          expect(Math.max(Math.abs(c0.row - t.row), Math.abs(c0.col - t.col))).toBeLessThanOrEqual(1);
          if (!correct) expect(m.status).not.toBe('confident');
          return;
        }
        if (isPlain) plainN++;
        else texturedN++;
        if (m.status === 'confident') {
          expect(correct, `confident but wrong: r${t.row}c${t.col} -> r${c0.row}c${c0.col}`).toBe(true);
          if (isPlain) plainConfident++;
          else texturedConfident++;
        }
        // Alternatives: distinct, well-spread places with ordered confidences summing to ≤ 1.
        expect(m.candidates.length).toBeLessThanOrEqual(5);
        let sum = 0;
        m.candidates.forEach((c, k) => {
          sum += c.confidence;
          expect(c.confidence).toBeGreaterThanOrEqual(0);
          if (k > 0) expect(c.confidence).toBeLessThanOrEqual(m.candidates[k - 1].confidence + 1e-9);
          for (let j = 0; j < k; j++) {
            const o = m.candidates[j];
            expect(Math.hypot(c.x - o.x, c.y - o.y)).toBeGreaterThanOrEqual(0.9 * Math.sqrt(index.cellW * index.cellH) - 1e-6);
            expect(`${c.row},${c.col}`).not.toBe(`${o.row},${o.col}`);
          }
        });
        expect(sum).toBeLessThanOrEqual(1 + 1e-6);
        if (m.status !== 'confident') {
          expect(m.candidates.length).toBe(5);
          expect(c0.confidence).toBeLessThan(CONFIDENT_THRESHOLD);
        }
      });
    }
    table.push(`featureless test: plain confident ${plainConfident}/${plainN} (single pass, score+margin alone would give ${naiveWrong} confident-wrong), textured confident ${texturedConfident}/${texturedN}`);
    expect(naiveWrong).toBeGreaterThan(0);
    expect(plainConfident).toBeLessThanOrEqual(plainN / 4);
    expect(texturedConfident).toBeGreaterThanOrEqual(0.8 * texturedN);
  });
});

describe('matchRegion — outline reliability', () => {
  const detail = (conf: number): MatchDetail => ({
    match: {
      regionId: 1,
      status: conf >= CONFIDENT_THRESHOLD ? 'confident' : 'ambiguous',
      candidates: [0, 1].map((i) => ({ row: 0, col: i, x: 0, y: 0, rotationDeg: 0, score: 0.8, confidence: i === 0 ? conf : 0.01 })),
    },
  });

  it('caps the confidence of outlines that include table or shadow', () => {
    const clean = detail(0.99);
    capForBorder(clean, { outline: { borderTable: 0.1 } });
    expect(clean.match.status).toBe('confident');
    expect(clean.match.candidates[0].confidence).toBeCloseTo(0.99, 6);
    // Mostly table around the border: at most 'ambiguous'.
    const shadowed = detail(0.99);
    capForBorder(shadowed, { outline: { borderTable: 0.5 } });
    expect(shadowed.match.status).toBe('ambiguous');
    expect(shadowed.match.candidates[0].confidence).toBeLessThan(CONFIDENT_THRESHOLD);
    // In a scan where most outlines include shadow, every outline is suspect.
    const scanWide = detail(0.99);
    capForBorder(scanWide, { outline: { borderTable: 0.05 } }, 0.22);
    expect(scanWide.match.status).toBe('ambiguous');
    const normalScan = detail(0.99);
    capForBorder(normalScan, { outline: { borderTable: 0.22 } }, 0.06);
    expect(normalScan.match.status).toBe('confident');
    expect(normalScan.match.candidates[0].confidence).toBeGreaterThan(0.98);
    // Real photo (test-corpus/feedback/2026-10-18-wood-planks-1500pc.json): wood table, diffuse
    // light, median 0.17, placements right. It must not lose every confident match.
    const woodTable = detail(0.9);
    capForBorder(woodTable, { outline: { borderTable: 0.17 } }, 0.17);
    expect(woodTable.match.status).toBe('confident');
    expect(woodTable.match.candidates[0].confidence).toBeGreaterThan(0.85);
  });

  it('keeps regions that are clearly not one piece from being confident', () => {
    // A mask of `area` pixels; the scan's body size 100 px.
    const mask = (area: number) => ({ width: 100, height: Math.ceil(area / 100), data: new Uint8Array(Math.ceil(area / 100) * 100).fill(1, 0, area) });
    const one = detail(0.95);
    capForSize(one, { kind: 'piece', mask: mask(10000), expectedBodySize: 100 });
    expect(one.match.status).toBe('confident');
    // Two pieces merged, or a piece with a patch of table: 1.7 pieces.
    const merged = detail(0.95);
    capForSize(merged, { kind: 'piece', mask: mask(17000), expectedBodySize: 100 });
    expect(merged.match.status).toBe('ambiguous');
    expect(merged.match.candidates[0].confidence).toBeLessThan(CONFIDENT_THRESHOLD);
    // Half a piece.
    const half = detail(0.95);
    capForSize(half, { kind: 'piece', mask: mask(5000), expectedBodySize: 100 });
    expect(half.match.status).toBe('ambiguous');
    // A small patch of touching (loose) pieces vs. an assembled one, and a large touching block.
    const pair = detail(0.95);
    capForSize(pair, { kind: 'patch', mask: mask(22000), expectedBodySize: 100, outline: { issues: ['touching_pieces'] } });
    expect(pair.match.status).toBe('ambiguous');
    const assembled = detail(0.95);
    capForSize(assembled, { kind: 'patch', mask: mask(22000), expectedBodySize: 100 });
    expect(assembled.match.status).toBe('confident');
    const block = detail(0.95);
    capForSize(block, { kind: 'patch', mask: mask(80000), expectedBodySize: 100, outline: { issues: ['touching_pieces'] } });
    expect(block.match.status).toBe('confident');
  });

  it('discounts doubtful segmentation', () => {
    expect(outlineFactor({ kind: 'piece' })).toBe(1);
    expect(outlineFactor({ kind: 'piece', outline: { issues: ['touching_pieces'], solidity: 0.9 } })).toBe(1);
    expect(outlineFactor({ kind: 'piece', outline: { issues: ['low_contrast', 'shape_uncertain'] } })).toBeCloseTo(0.855, 6);
    expect(outlineFactor({ kind: 'piece', outline: { solidity: 0.5 } })).toBeCloseTo(0.85, 6);
    expect(outlineFactor({ kind: 'patch', outline: { issues: ['shape_uncertain'], solidity: 0.5 } })).toBe(1);
  });
});

describe('matchRegion — an 18-piece portrait puzzle (6 rows × 3 columns, cells 1.6× wider than tall)', () => {
  it('places a lone block when the seams are spaced differently in the two directions', () => {
    const star = loadTestAsset('starry-night');
    const w = Math.round(0.79 * star.height), x0 = Math.round((star.width - w) / 2);
    const picture = createRGBA(w, star.height);
    for (let y = 0; y < star.height; y++) picture.data.set(star.data.subarray((y * star.width + x0) * 4, (y * star.width + x0 + w) * 4), y * w * 4);
    const grid = { rows: 6, cols: 3 };
    const cut = generateJigsaw(grid.rows, grid.cols, picture.width, picture.height, 44);
    // A box picture of high resolution: its cells are ~2.4× the pieces' size on the photo.
    const index = buildReferenceIndex(perturbReference(resizeRGBA(picture, picture.width * 1.6, picture.height * 1.6), { seed: 44 }), grid, 'grid');
    const block = cut.pieces.map((p) => p.index).filter((i) => i !== 0 && i !== 17);
    const cellGeo = Math.sqrt((cut.width / cut.cols) * (cut.height / cut.rows));
    const size = 160;
    for (const rotation of [12, 196]) {
      const { photo, truth } = renderPiecesPhoto(picture, cut, [block], {
        seed: 5, rotation, scale: size / cellGeo, background: [196, 208, 218], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1, supersample: 2,
      });
      const input = inputFromTruth(photo, cut, truth[0], 1, { withBodySize: false, orientationError: 1 });
      expect(input.kind).toBe('patch');
      // (The seams of three columns are too few for a reliable size; the whole range of sizes of an
      // 18-piece puzzle is searched as well.)
      const m = matchRegion(index, input);
      const expected = block.map((p) => `${cut.pieces[p].row},${cut.pieces[p].col}`).sort();
      expect((m.coveredCells ?? []).map((x) => `${x.row},${x.col}`).sort(), `rotation ${rotation}`).toEqual(expected);
      expect(angleError(m.candidates[0].rotationDeg, truth[0].rotationDeg)).toBeLessThan(5);
      expect(m.status).toBe('confident');
    }
  });
});
