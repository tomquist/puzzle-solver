import { describe, expect, it } from 'vitest';
import { applyMat3, type Point } from '../../cv/geometry';
import { createMask, createRGBA, cropRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, type JigsawCut, type PieceTruth, type RenderOptions } from '../../testing/synth';
import { fitPatchLattice, latticeCells, latticeCoords, latticePoint, type PatchLattice } from './patchLattice';

/** Crop, outline mask (holes filled, as the segmentation leaves small ones) and crop origin of a rendered item. */
function itemCrop(photo: RGBAImage, t: PieceTruth) {
  const pad = 6;
  const x0 = Math.max(0, t.bbox.x - pad), y0 = Math.max(0, t.bbox.y - pad);
  const rect = { x: x0, y: y0, width: Math.min(photo.width, t.bbox.x + t.bbox.width + pad) - x0, height: Math.min(photo.height, t.bbox.y + t.bbox.height + pad) - y0 };
  const image = cropRGBA(photo, rect);
  const mask = createMask(image.width, image.height);
  fillPolygon(mask, t.outline.map((p) => ({ x: p.x - x0, y: p.y - y0 })), 1);
  return { image, mask, origin: { x: x0, y: y0 } };
}

/** The true lattice of a rendered item (crop coordinates): its grid lines through the reference → photo transform. */
function truthLattice(cut: JigsawCut, t: PieceTruth, origin: Point): PatchLattice {
  const cw = cut.width / cut.cols, ch = cut.height / cut.rows;
  const o = applyMat3(t.transform, { x: 0, y: 0 }), ex = applyMat3(t.transform, { x: cw, y: 0 }), ey = applyMat3(t.transform, { x: 0, y: ch });
  return {
    origin: { x: o.x - origin.x, y: o.y - origin.y },
    angle: Math.atan2(ex.y - o.y, ex.x - o.x),
    pa: Math.hypot(ex.x - o.x, ex.y - o.y),
    pb: Math.hypot(ey.x - o.x, ey.y - o.y),
    strength: [-1, -1],
  };
}

/**
 * A lattice off by `dAngle` degrees, pitch × `fPitch` and the phase by `shift` cells along both
 * axes, about the seam crossing nearest the patch's middle (as a placement fitted to the whole
 * patch is off: least in its middle).
 */
function perturbed(l: PatchLattice, mask: Mask, dAngle: number, fPitch: number, shift: number): PatchLattice {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.data[y * mask.width + x]) { n++; sx += x; sy += y; }
  const q = latticeCoords(l, { x: sx / n, y: sy / n });
  const ka = Math.round(q.a), kb = Math.round(q.b);
  const P = latticePoint(l, ka + shift, kb + shift);
  const out: PatchLattice = { ...l, angle: l.angle + (dAngle * Math.PI) / 180, pa: l.pa * fPitch, pb: l.pb * fPitch };
  const o = latticePoint({ ...out, origin: { x: 0, y: 0 } }, ka, kb);
  return { ...out, origin: { x: P.x - o.x, y: P.y - o.y } };
}

/**
 * Worst distance (cells) of the pieces' real body centres from the middles of the lattice's cells
 * (each piece lies a little apart, shifted and turned in an assembled patch: gaps up to 2 px,
 * ±2 px, ±1.5°).
 */
function centreError(l: PatchLattice, t: PieceTruth, origin: Point, axes: ('a' | 'b')[] = ['a', 'b']): number {
  let worst = 0;
  for (const m of t.members ?? []) {
    const q = latticeCoords(l, { x: m.center.x - origin.x, y: m.center.y - origin.y });
    for (const k of axes) worst = Math.max(worst, Math.abs(q[k] - Math.floor(q[k]) - 0.5));
  }
  return worst;
}

const starry = loadTestAsset('starry-night');
const cut = generateJigsaw(16, 20, starry.width, starry.height, 7);
const cellSize = (cut.width / cut.cols + cut.height / cut.rows) / 2;
const RENDER: RenderOptions = { background: [196, 208, 218], noiseSigma: 3, blurSigma: 0.7, illumination: 0.1, supersample: 2 };

/** Cells of a rows × cols block at (r0, c0) without the listed "row,col" cells. */
function block(r0: number, c0: number, rows: number, cols: number, missing: string[] = []): number[] {
  const skip = new Set(missing);
  const out: number[] = [];
  for (let r = r0; r < r0 + rows; r++) for (let c = c0; c < c0 + cols; c++) if (!skip.has(`${r},${c}`)) out.push(r * cut.cols + c);
  return out;
}

describe('fitPatchLattice', () => {
  it('finds the seams of a large ragged block from a prior that is off in angle, pitch and phase', () => {
    const items = block(4, 6, 7, 7, ['4,6', '4,9', '7,12', '10,8']);
    for (const rotation of [23, 207]) {
      const { photo, truth } = renderPiecesPhoto(starry, cut, [items], { ...RENDER, seed: 3, rotation, scale: 80 / cellSize });
      const { image, mask, origin } = itemCrop(photo, truth[0]);
      const exact = truthLattice(cut, truth[0], origin);
      const prior = perturbed(exact, mask, 1.5, 1.04, 0.25);
      expect(centreError(prior, truth[0], origin), `rotation ${rotation}: prior`).toBeGreaterThan(0.3);
      const fit = fitPatchLattice(image, mask, prior);
      expect(fit.strength[0]).toBeGreaterThan(0);
      expect(fit.strength[1]).toBeGreaterThan(0);
      // As good as the true grid (the pieces themselves lie up to ~0.1 cells off it).
      expect(centreError(fit, truth[0], origin), `rotation ${rotation}: fitted`).toBeLessThan(Math.max(0.1, centreError(exact, truth[0], origin) + 0.02));
      // (The seams lie a gap of up to 2 px further apart than the bodies.)
      expect(Math.abs(fit.pa / exact.pa - 1)).toBeLessThan(0.025);
    }
  });

  it('fits cells 1.6× wider than tall (a 6 × 3 portrait puzzle)', () => {
    const w = Math.round(0.79 * starry.height), x0 = Math.round((starry.width - w) / 2);
    const picture = createRGBA(w, starry.height);
    for (let y = 0; y < starry.height; y++) picture.data.set(starry.data.subarray((y * starry.width + x0) * 4, (y * starry.width + x0 + w) * 4), y * w * 4);
    const haba = generateJigsaw(6, 3, picture.width, picture.height, 44);
    const items = haba.pieces.map((p) => p.index).filter((i) => i !== 7 && i !== 13);
    const geo = Math.sqrt((haba.width / haba.cols) * (haba.height / haba.rows));
    const { photo, truth } = renderPiecesPhoto(picture, haba, [items], { ...RENDER, seed: 5, rotation: 14, scale: 150 / geo });
    const { image, mask, origin } = itemCrop(photo, truth[0]);
    const exact = truthLattice(haba, truth[0], origin);
    expect(exact.pa / exact.pb).toBeGreaterThan(1.5);
    const prior = perturbed(exact, mask, -1, 0.97, 0.2);
    const fit = fitPatchLattice(image, mask, prior);
    expect(centreError(prior, truth[0], origin)).toBeGreaterThan(0.2);
    expect(centreError(fit, truth[0], origin)).toBeLessThan(Math.max(0.1, centreError(exact, truth[0], origin) + 0.02));
  });

  it('fixes the phase along the three cells of a small patch and keeps the placement elsewhere', () => {
    const { photo, truth } = renderPiecesPhoto(starry, cut, [block(2, 14, 3, 2)], { ...RENDER, seed: 7, rotation: 61, scale: 90 / cellSize });
    const { image, mask, origin } = itemCrop(photo, truth[0]);
    const exact = truthLattice(cut, truth[0], origin);
    const prior = perturbed(exact, mask, 0, 1, 0.25);
    const fit = fitPatchLattice(image, mask, prior);
    // Rows (b): three cells, two seams – the phase is fitted, not the pitch. Columns (a): two cells,
    // one seam between knobs as strong as it – the placement's.
    expect(fit.strength[0]).toBe(-1);
    expect(fit.strength[1]).toBeGreaterThan(0);
    expect(fit.angle).toBe(prior.angle);
    expect([fit.pa, fit.pb]).toEqual([prior.pa, prior.pb]);
    expect(centreError(prior, truth[0], origin, ['b'])).toBeGreaterThan(0.2);
    expect(centreError(fit, truth[0], origin, ['b'])).toBeLessThan(0.1);
  });

  it('places the straight edges of a two-piece patch, and keeps the placement where knobs are as strong as its one seam', () => {
    const { photo, truth } = renderPiecesPhoto(starry, cut, [block(8, 3, 1, 2)], { ...RENDER, seed: 7, rotation: 140, scale: 90 / cellSize });
    const { image, mask, origin } = itemCrop(photo, truth[0]);
    const prior = perturbed(truthLattice(cut, truth[0], origin), mask, 0.5, 1, 0.2);
    const fit = fitPatchLattice(image, mask, prior);
    // Across the pair (b, one piece): its two long straight edges. Along it (a, two pieces): the
    // seam between them and the knobs at both ends – the placement's phase.
    expect(fit.strength[0]).toBe(-1);
    expect(fit.strength[1]).toBeGreaterThan(0);
    expect([fit.angle, fit.pa, fit.pb]).toEqual([prior.angle, prior.pa, prior.pb]);
    expect(centreError(prior, truth[0], origin, ['b'])).toBeGreaterThan(0.15);
    expect(centreError(fit, truth[0], origin, ['b'])).toBeLessThan(0.1);
  });

  it('keeps the prior where the seams do not show (heavy blur, no cut lines)', () => {
    const items = block(4, 6, 5, 5);
    const { photo, truth } = renderPiecesPhoto(starry, cut, [items], {
      ...RENDER, seed: 11, rotation: 37, scale: 70 / cellSize, blurSigma: 4, edgeDarkening: 0.05, patch: false,
    });
    const { image, mask, origin } = itemCrop(photo, truth[0]);
    const exact = truthLattice(cut, truth[0], origin);
    const prior = perturbed(exact, mask, 0.3, 1.01, 0.1);
    const fit = fitPatchLattice(image, mask, prior);
    // Whatever it trusts, it never moves the lattice far from where the seams are.
    expect(centreError(fit, truth[0], origin)).toBeLessThanOrEqual(Math.max(centreError(prior, truth[0], origin), 0.15));
  });

  it('gives up without a mask', () => {
    const prior: PatchLattice = { origin: { x: 10, y: 10 }, angle: 0.3, pa: 20, pb: 20, strength: [-1, -1] };
    const fit = fitPatchLattice(createRGBA(40, 40, [128, 128, 128, 255]), createMask(40, 40), prior);
    expect(fit).toEqual(prior);
  });
});

describe('latticeCells', () => {
  /** A patch drawn on a lattice: body squares of `cells`, with a tab from every piece into each missing neighbour. */
  function drawPatch(l: PatchLattice, cells: Set<string>, w: number, h: number): Mask {
    const mask = createMask(w, h);
    const quad = (a0: number, b0: number, a1: number, b1: number) => [latticePoint(l, a0, b0), latticePoint(l, a1, b0), latticePoint(l, a1, b1), latticePoint(l, a0, b1)];
    for (const key of cells) {
      const [i, j] = key.split(',').map(Number);
      fillPolygon(mask, quad(i - 0.01, j - 0.01, i + 1.01, j + 1.01), 1);
      // Tabs (a neck and a head reaching 0.3 cells) into every missing neighbour.
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cells.has(`${i + di},${j + dj}`)) continue;
        const ca = i + 0.5 + di * 0.5, cb = j + 0.5 + dj * 0.5;
        const head: Point[] = [];
        for (let k = 0; k < 24; k++) {
          const t = (2 * Math.PI * k) / 24;
          head.push(latticePoint(l, ca + di * 0.18 + 0.13 * Math.cos(t), cb + dj * 0.18 + 0.13 * Math.sin(t)));
        }
        fillPolygon(mask, head, 1);
      }
    }
    return mask;
  }

  const l: PatchLattice = { origin: { x: 160, y: 40 }, angle: (27 * Math.PI) / 180, pa: 48, pb: 40, strength: [-1, -1] };
  const all = new Set<string>();
  for (let j = 0; j < 6; j++) for (let i = 0; i < 5; i++) all.add(`${i},${j}`);
  // Holes enclosed by the patch (2,2) and (1,4), edge notches (0,0) and (4,3).
  const present = new Set([...all].filter((k) => !['2,2', '1,4', '0,0', '4,3'].includes(k)));

  it('counts the pieces and neither holes nor notches the neighbours reach into', () => {
    const mask = drawPatch(l, present, 420, 400);
    const got = latticeCells(l, mask).map((c) => `${c.i},${c.j}`).sort();
    expect(got).toEqual([...present].sort());
  });

  it('never counts a hole the mask has filled when it shows the table', () => {
    const mask = drawPatch(l, present, 420, 400);
    const table = createMask(420, 400);
    for (const [i, j] of [[2, 2], [1, 4]]) {
      const q = [latticePoint(l, i, j), latticePoint(l, i + 1, j), latticePoint(l, i + 1, j + 1), latticePoint(l, i, j + 1)];
      fillPolygon(mask, q, 1);
      fillPolygon(table, q, 1);
    }
    // Filled without table information, the holes would count.
    expect(latticeCells(l, mask).map((c) => `${c.i},${c.j}`)).toContain('2,2');
    const got = latticeCells(l, mask, table).map((c) => `${c.i},${c.j}`).sort();
    expect(got).toEqual([...present].sort());
  });

  it("never counts a lone piece's knob as a cell, even when the lattice's cells are too small", () => {
    // A lone piece taken for a patch, its lattice from a placement whose scale is 20 % small: the
    // body spans 1.25 cells and its knob reaches into the middle of the next cell (more than half of
    // that cell's core), yet covers well under half of the cell.
    const k: PatchLattice = { origin: { x: 30, y: 30 }, angle: (8 * Math.PI) / 180, pa: 60, pb: 50, strength: [-1, -1] };
    const mask = createMask(200, 150);
    fillPolygon(mask, [latticePoint(k, 0, 0), latticePoint(k, 1.25, 0), latticePoint(k, 1.25, 1), latticePoint(k, 0, 1)], 1);
    const knob: Point[] = [];
    for (let n = 0; n < 32; n++) {
      const t = (2 * Math.PI * n) / 32;
      knob.push(latticePoint(k, 1.47 + 0.21 * Math.cos(t), 0.5 + 0.21 * Math.sin(t)));
    }
    fillPolygon(mask, knob, 1);
    const core = latticeCells(k, mask, undefined, 0).find((c) => c.i === 1 && c.j === 0);
    expect(core?.coverage).toBeGreaterThan(0.5);
    expect(latticeCells(k, mask).map((c) => `${c.i},${c.j}`)).toEqual(['0,0']);
  });

  it('decides on the body middle, so a lattice a fifth of a cell off still finds every cell', () => {
    const mask = drawPatch(l, present, 420, 400);
    const off: PatchLattice = { ...l, origin: latticePoint(l, 0.2, -0.2) };
    const got = latticeCells(off, mask).map((c) => `${c.i},${c.j}`).sort();
    expect(got).toEqual([...present].sort());
  });
});
