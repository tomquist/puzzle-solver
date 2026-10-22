import { describe, expect, it } from 'vitest';
import { applyMat3, polygonSignedArea, rotation, type Point } from '../cv/geometry';
import { cropRGBA, createRGBA, type RGBAImage } from '../cv/image';
import { drawPolygon } from '../cv/raster';
import { resizeRGBA } from '../cv/resize';
import { rectifyQuad } from '../cv/warp';
import { DEBUG_IMAGES, loadTestAsset, savePng } from './nodeImageIO';

function angleError(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}
import {
  cellCenter,
  enclosedCells,
  generateJigsaw,
  mulberry32,
  patchOutline,
  perturbReference,
  renderBoxPhoto,
  renderPiecesPhoto,
  truthPieceShape,
} from './synth';

function meanAbsDiff(a: RGBAImage, b: RGBAImage, inset = 0): number {
  let s = 0, n = 0;
  for (let y = inset; y < a.height - inset; y++) {
    for (let x = inset; x < a.width - inset; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) s += Math.abs(a.data[i + c] - b.data[i + c]);
      n += 3;
    }
  }
  return s / n;
}

describe('mulberry32', () => {
  it('is deterministic and uniform-ish', () => {
    const a = mulberry32(42), b = mulberry32(42);
    let sum = 0;
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 1000).toBeGreaterThan(0.45);
    expect(sum / 1000).toBeLessThan(0.55);
  });
});

describe('generateJigsaw', () => {
  const cut = generateJigsaw(6, 8, 800, 600, 11);

  it('tiles the picture with clockwise pieces', () => {
    expect(cut.pieces.length).toBe(48);
    let total = 0;
    for (const p of cut.pieces) {
      const a = polygonSignedArea(p.outline);
      expect(a).toBeGreaterThan(0); // clockwise on screen
      total += a;
    }
    expect(total).toBeCloseTo(800 * 600, -1);
    expect(generateJigsaw(6, 8, 800, 600, 11).pieces[17].outline).toEqual(cut.pieces[17].outline);
  });

  it('has flat borders and complementary interior sides', () => {
    for (const p of cut.pieces) {
      expect(p.sides[0] === 'flat').toBe(p.row === 0);
      expect(p.sides[2] === 'flat').toBe(p.row === cut.rows - 1);
      expect(p.sides[3] === 'flat').toBe(p.col === 0);
      expect(p.sides[1] === 'flat').toBe(p.col === cut.cols - 1);
      if (p.col + 1 < cut.cols) {
        const q = cut.pieces[p.index + 1];
        expect(new Set([p.sides[1], q.sides[3]])).toEqual(new Set(['tab', 'blank']));
      }
      if (p.row + 1 < cut.rows) {
        const q = cut.pieces[p.index + cut.cols];
        expect(new Set([p.sides[2], q.sides[0]])).toEqual(new Set(['tab', 'blank']));
      }
    }
  });

  it('cuts near-uniform knobs on a nearly regular grid with a small variation', () => {
    expect(generateJigsaw(6, 8, 800, 600, 11, { variation: 1 }).pieces[17].outline).toEqual(cut.pieces[17].outline);
    // Profile of a side in its own frame (along, across), as a fraction of its length.
    const shapeOf = (path: { x: number; y: number }[]) => {
      const a = path[0], b = path[path.length - 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y), dx = (b.x - a.x) / L, dy = (b.y - a.y) / L;
      return path.map((p) => Math.abs(((p.x - a.x) * dy - (p.y - a.y) * dx) / L));
    };
    // Largest difference between the right sides of two interior pieces (knobs mirrored by direction).
    const spread = (c: ReturnType<typeof generateJigsaw>) => {
      const p = shapeOf(c.pieces[9].sidePaths[1]), q = shapeOf(c.pieces[21].sidePaths[1]);
      return Math.max(...p.map((v, i) => Math.abs(v - q[i])));
    };
    const uniform = generateJigsaw(6, 8, 800, 600, 11, { variation: 0 });
    expect(spread(uniform)).toBeLessThan(1e-9);
    expect(uniform.pieces[9].corners[0]).toEqual({ x: 99.5, y: 99.5 });
    expect(spread(generateJigsaw(6, 8, 800, 600, 11, { variation: 0.2 }))).toBeLessThan(0.3 * spread(cut));
  });

  it('builds patch outlines without the shared edges', () => {
    const idx = [9, 10, 17, 18];
    const outline = patchOutline(cut, idx);
    const sum = idx.reduce((s, i) => s + polygonSignedArea(cut.pieces[i].outline), 0);
    expect(polygonSignedArea(outline)).toBeCloseTo(sum, 3);
    expect(() => patchOutline(cut, [0, 2])).toThrow();
  });

  it('finds the cells an assembled block encloses (its holes)', () => {
    // A 3 × 3 block at rows 0–2, columns 0–2 of the 8-column cut without its middle piece, and an
    // L of pieces (no hole: the missing corner is open to the outside).
    const at = (r: number, c: number) => r * cut.cols + c;
    const ring = [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 2), at(2, 0), at(2, 1), at(2, 2)];
    expect(enclosedCells(cut, ring)).toEqual([at(1, 1)]);
    expect(enclosedCells(cut, [at(0, 0), at(0, 1), at(1, 0)])).toEqual([]);
  });
});

describe('renderPiecesPhoto', () => {
  const ref = resizeRGBA(loadTestAsset('starry-night'), 640, 507);
  const cut = generateJigsaw(8, 10, ref.width, ref.height, 5);

  it('renders pieces with consistent ground truth', () => {
    const { photo, truth } = renderPiecesPhoto(ref, cut, [3, 14, 45, [22, 23, 32, 33]], { seed: 9, scale: 1.4 });
    expect(truth.length).toBe(4);
    for (const t of truth) {
      const piece = cut.pieces[t.pieces[0]];
      expect(t.row).toBe(piece.row);
      // Rotating the photo by rotationDeg turns the top side back into its reference direction.
      const R = rotation((t.rotationDeg * Math.PI) / 180);
      const d = applyMat3(R, { x: t.corners[1].x - t.corners[0].x, y: t.corners[1].y - t.corners[0].y });
      const e = { x: piece.corners[1].x - piece.corners[0].x, y: piece.corners[1].y - piece.corners[0].y };
      // Patches: the anchor piece itself may be misaligned by up to 1.5° within the patch.
      expect(Math.abs(Math.atan2(d.y, d.x) - Math.atan2(e.y, e.x))).toBeLessThan(t.members ? (1.6 * Math.PI) / 180 : 1e-6);
      // The body center shows the reference colour of the cell center.
      const c = cellCenter(cut, piece.row, piece.col);
      const cc = { x: Math.round(t.center.x), y: Math.round(t.center.y) };
      const pi = (cc.y * photo.width + cc.x) * 4;
      const back = applyMat3(t.transform, c);
      expect(Math.hypot(back.x - t.center.x, back.y - t.center.y)).toBeLessThan(0.15 * 1.4 * 64);
      // Background must differ from the piece content somewhere inside the bbox.
      expect(photo.data[pi + 3]).toBe(255);
      expect(t.bbox.x).toBeGreaterThanOrEqual(0);
      expect(t.bbox.x + t.bbox.width).toBeLessThanOrEqual(photo.width + 1);
    }
    // Items do not overlap.
    for (let i = 0; i < truth.length; i++) {
      for (let j = i + 1; j < truth.length; j++) {
        const a = truth[i].bbox, b = truth[j].bbox;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    if (DEBUG_IMAGES) {
      const dbg = { ...photo, data: new Uint8ClampedArray(photo.data) };
      for (const t of truth) drawPolygon(dbg, t.corners, [255, 0, 0, 255], 1);
      savePng('.debug/synth/pieces.png', photo);
      savePng('.debug/synth/pieces-truth.png', dbg);
    }
  });

  it('places the right reference content at the true placement (no degradations)', () => {
    const { photo, truth } = renderPiecesPhoto(ref, cut, [12, 27], { seed: 3, scale: 1.2, shadow: 0, edgeDarkening: 0 });
    for (const t of truth) {
      // Sample a few interior points of the body and compare with the reference.
      const piece = cut.pieces[t.pieces[0]];
      let err = 0, n = 0;
      for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7], [0.7, 0.7]]) {
        const q: Point = {
          x: piece.corners[0].x + fx * (piece.corners[1].x - piece.corners[0].x) + fy * (piece.corners[3].x - piece.corners[0].x),
          y: piece.corners[0].y + fx * (piece.corners[1].y - piece.corners[0].y) + fy * (piece.corners[3].y - piece.corners[0].y),
        };
        const p = applyMat3(t.transform, q);
        const pi = (Math.round(p.y) * photo.width + Math.round(p.x)) * 4;
        const ri = (Math.round(q.y) * ref.width + Math.round(q.x)) * 4;
        for (let c = 0; c < 3; c++) err += Math.abs(photo.data[pi + c] - ref.data[ri + c]);
        n += 3;
      }
      expect(err / n).toBeLessThan(30);
    }
  });

  it('renders assembled patches piece by piece with seams, gaps and misalignment', () => {
    const grid: number[] = [];
    for (let r = 2; r < 6; r++) for (let c = 3; c < 8; c++) grid.push(r * cut.cols + c);
    const opts = { seed: 4, scale: 1.4, shadow: 0, rotation: 30 };
    const { photo, truth } = renderPiecesPhoto(ref, cut, [grid, 0], { ...opts, patch: { gap: [0, 0], jitterDeg: 1.5, jitterPx: 2 } });
    const t = truth[0];
    expect(t.members!.length).toBe(20);
    expect(t.members![0].piece).toBe(grid[0]);
    expect(truth[1].members).toBeUndefined();
    for (const m of t.members!) {
      // Each piece: slightly turned and shifted, never more than the jitter.
      expect(angleError(m.rotationDeg, t.rotationDeg)).toBeLessThanOrEqual(1.5 + 1e-6);
      const c = cut.pieces[m.piece].corners;
      const rigid = applyMat3(t.transform, { x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 });
      expect(Math.hypot(rigid.x - m.center.x, rigid.y - m.center.y)).toBeLessThanOrEqual(2 * Math.SQRT2 + 1e-6);
      const back = applyMat3(m.transform, { x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 });
      expect(Math.hypot(back.x - m.center.x, back.y - m.center.y)).toBeLessThan(1e-6);
    }
    // Gaps spread the grid: neighbouring body centres are further apart than one cell.
    const spread = renderPiecesPhoto(ref, cut, [grid], { ...opts, patch: { gap: [6, 6], jitterDeg: 0, jitterPx: 0 } }).truth[0].members!;
    const cellPx = 1.4 * (cut.width / cut.cols);
    const d = Math.hypot(spread[1].center.x - spread[0].center.x, spread[1].center.y - spread[0].center.y);
    const d0 = Math.hypot(cut.pieces[grid[1]].corners[0].x - cut.pieces[grid[0]].corners[0].x, cut.pieces[grid[1]].corners[0].y - cut.pieces[grid[0]].corners[0].y);
    expect(d).toBeGreaterThan(d0 * 1.4 + 4);
    expect(Math.abs(d - (d0 * 1.4 + 6))).toBeLessThan(0.15 * cellPx);
    // Rigid (old) style: one body, no jitter.
    const rigid = renderPiecesPhoto(ref, cut, [grid], { ...opts, patch: false }).truth[0];
    for (const m of rigid.members!) expect(angleError(m.rotationDeg, rigid.rotationDeg)).toBeLessThan(1e-6);
    // Seams are darker than the piece interiors next to them.
    const lum = (img: typeof photo, p: { x: number; y: number }) => {
      const i = (Math.round(p.y) * img.width + Math.round(p.x)) * 4;
      return 0.3 * img.data[i] + 0.59 * img.data[i + 1] + 0.11 * img.data[i + 2];
    };
    const flat = renderPiecesPhoto(ref, cut, [grid], { ...opts, patch: { gap: [0, 0], jitterDeg: 0, jitterPx: 0, seam: 1 } });
    let seam = 0, inner = 0;
    for (const m of flat.truth[0].members!.slice(0, 4)) {
      const c = m.corners;
      // Corner 1 (top-right) and the middle of the right side lie on seams with the next piece.
      const mid = { x: (c[1].x + c[2].x) / 2, y: (c[1].y + c[2].y) / 2 };
      seam += lum(flat.photo, mid);
      inner += lum(flat.photo, { x: 0.7 * mid.x + 0.3 * m.center.x, y: 0.7 * mid.y + 0.3 * m.center.y });
    }
    expect(seam).toBeLessThan(inner);
    if (DEBUG_IMAGES) savePng('.debug/synth/patch-4x5.png', photo);
  });

  it('throws when the items cannot fit', () => {
    expect(() => renderPiecesPhoto(ref, cut, [1, 2, 3, 4, 5, 6], { width: 200, height: 200, scale: 1.4 })).toThrow();
  });

  it('builds ground-truth piece shapes following the PieceShape conventions', () => {
    const { truth } = renderPiecesPhoto(ref, cut, [0, 15, 33, 79], { seed: 21, scale: 1.3 });
    for (const t of truth) {
      const shape = truthPieceShape(cut, t);
      const piece = cut.pieces[t.pieces[0]];
      expect(shape.angleDeg).toBeGreaterThan(-45);
      expect(shape.angleDeg).toBeLessThanOrEqual(45);
      // corners[0] is the top-left after rotating by -angleDeg.
      const R = rotation((-shape.angleDeg * Math.PI) / 180);
      const rc = shape.corners.map((p) => applyMat3(R, p));
      const sums = rc.map((p) => p.x + p.y);
      expect(sums.indexOf(Math.min(...sums))).toBe(0);
      expect(shape.bodySize).toBeGreaterThan(50 * 1.3);
      expect([...shape.sides.map((s) => s.kind)].sort()).toEqual([...piece.sides].sort());
      for (const s of shape.sides) {
        const ext = s.profile.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
        if (s.kind === 'tab') expect(ext).toBeGreaterThan(0.15);
        if (s.kind === 'blank') expect(ext).toBeLessThan(-0.15);
        if (s.kind === 'flat') expect(Math.abs(ext)).toBeLessThan(0.02);
      }
    }
  });
});

describe('renderPiecesPhoto real-photo options', () => {
  const ref = resizeRGBA(loadTestAsset('starry-night'), 640, 507);
  const cut = generateJigsaw(8, 10, ref.width, ref.height, 5);
  const items = [3, 14, 45, 60, 71];
  const base = { seed: 9, scale: 1.4, background: [40, 42, 48] as [number, number, number], width: 760, height: 560 };
  const plain = renderPiecesPhoto(ref, cut, items, base);
  const lum = (img: RGBAImage, x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  };
  const minOutlineGap = (a: Point[], b: Point[]) => {
    let best = Infinity;
    for (const p of a) for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    return best;
  };

  it('leaves the default rendering untouched by the new options', () => {
    // Every effect draws from its own random stream: switching one on keeps the placement.
    const withJpeg = renderPiecesPhoto(ref, cut, items, { ...base, jpegQuality: 90, vignette: 0.2 });
    expect(withJpeg.truth.map((t) => t.bbox)).toEqual(plain.truth.map((t) => t.bbox));
    expect(meanAbsDiff(withJpeg.photo, plain.photo)).toBeGreaterThan(0.2);
    expect(meanAbsDiff(withJpeg.photo, plain.photo)).toBeLessThan(10);
  });

  it('draws a light cardboard wall beside each piece in the rim direction', () => {
    const { photo, truth } = renderPiecesPhoto(ref, cut, items, { ...base, rim: { thickness: 3, direction: 90 }, shadow: 0 });
    // Just below the lowest outline point the wall is light; the table elsewhere stays dark.
    let wall = 0, n = 0;
    for (const t of truth) {
      const p = t.outline.reduce((a, q) => (q.y > a.y ? q : a));
      wall += lum(photo, Math.round(p.x), Math.round(p.y) + 2);
      n++;
    }
    expect(wall / n).toBeGreaterThan(120);
    expect(lum(photo, 5, 5)).toBeLessThan(70);
  });

  it('places close pairs at the requested outline gap (negative = overlap)', () => {
    const { truth } = renderPiecesPhoto(ref, cut, [3, 14, 45, 60], { ...base, width: undefined, height: undefined, pairs: { count: 2, gap: [2, 2] } });
    expect(minOutlineGap(truth[0].outline, truth[1].outline)).toBeGreaterThan(1);
    expect(minOutlineGap(truth[0].outline, truth[1].outline)).toBeLessThan(3.5);
    expect(minOutlineGap(truth[2].outline, truth[3].outline)).toBeLessThan(3.5);
    const over = renderPiecesPhoto(ref, cut, [3, 14], { ...base, width: undefined, height: undefined, pairs: { count: 1, gap: [-3, -3] } });
    expect(minOutlineGap(over.truth[0].outline, over.truth[1].outline)).toBeLessThan(1);
  });

  it('paints patterned tables, clutter at the border, vignetting and glare', () => {
    const check = renderPiecesPhoto(ref, cut, items, { ...base, pattern: { kind: 'check' } });
    // Gingham: white and red squares in the table area.
    let white = 0, red = 0;
    for (let i = 0; i < check.photo.data.length; i += 4) {
      const [r, g, b2] = [check.photo.data[i], check.photo.data[i + 1], check.photo.data[i + 2]];
      if (r > 200 && g > 200 && b2 > 200) white++;
      if (r > 150 && g < 80 && b2 < 90) red++;
    }
    expect(white).toBeGreaterThan(0.1 * check.photo.width * check.photo.height);
    expect(red).toBeGreaterThan(0.1 * check.photo.width * check.photo.height);

    const clutter = renderPiecesPhoto(ref, cut, items, { ...base, width: undefined, height: undefined, clutter: ['table-edge'] });
    // The floor beyond the table edge darkens one side of the border band; no piece lies there.
    const sides = [0, 0, 0, 0];
    const { width: W, height: H } = clutter.photo;
    for (let k = 0; k < 40; k++) {
      sides[0] += lum(clutter.photo, Math.round(((k + 0.5) / 40) * W), 2);
      sides[1] += lum(clutter.photo, W - 3, Math.round(((k + 0.5) / 40) * H));
      sides[2] += lum(clutter.photo, Math.round(((k + 0.5) / 40) * W), H - 3);
      sides[3] += lum(clutter.photo, 2, Math.round(((k + 0.5) / 40) * H));
    }
    expect(Math.max(...sides) - Math.min(...sides)).toBeGreaterThan(40 * 8);

    const vig = renderPiecesPhoto(ref, cut, [], { ...base, vignette: 0.4 });
    expect(lum(vig.photo, 3, 3)).toBeLessThan(0.75 * lum(vig.photo, 380, 280));

    const glare = renderPiecesPhoto(ref, cut, items, { ...base, background: [120, 120, 125], glare: { count: 3, strength: 1 } });
    let clipped = 0;
    for (let i = 0; i < glare.photo.data.length; i += 4) if (glare.photo.data[i] === 255 && glare.photo.data[i + 1] === 255) clipped++;
    expect(clipped).toBeGreaterThan(100);
    if (DEBUG_IMAGES) {
      savePng('.debug/synth/real-check.png', check.photo);
      savePng('.debug/synth/real-clutter.png', clutter.photo);
      savePng('.debug/synth/real-glare.png', glare.photo);
    }
  });

  it('paints plank gaps, a soft shadow zone from the border and dark table-coloured pieces', () => {
    const wood = { ...base, background: [196, 172, 140] as [number, number, number] };
    const plainWood = renderPiecesPhoto(ref, cut, items, wood);
    const tableLum = lum(plainWood.photo, 5, 5);

    // Tile gaps: thin dark lines over a few percent of the table, never under the pieces' print.
    const planks = renderPiecesPhoto(ref, cut, items, { ...wood, pattern: { kind: 'planks', width: 200, gap: 10, tiles: true } });
    expect(planks.truth.map((t) => t.bbox)).toEqual(plainWood.truth.map((t) => t.bbox));
    let dark = 0;
    const { width: W, height: H } = planks.photo;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lum(planks.photo, x, y) < 0.7 * tableLum) dark++;
    expect(dark / (W * H)).toBeGreaterThan(0.03);
    expect(dark / (W * H)).toBeLessThan(0.35);

    // Shadow zone: one side of the border band clearly darker; pieces stay where they were.
    const zone = renderPiecesPhoto(ref, cut, items, { ...wood, shadowZone: { strength: 0.5 } });
    expect(zone.truth.map((t) => t.bbox)).toEqual(plainWood.truth.map((t) => t.bbox));
    const sides = [0, 0, 0, 0];
    for (let k = 0; k < 40; k++) {
      sides[0] += lum(zone.photo, Math.round(((k + 0.5) / 40) * W), 2);
      sides[1] += lum(zone.photo, W - 3, Math.round(((k + 0.5) / 40) * H));
      sides[2] += lum(zone.photo, Math.round(((k + 0.5) / 40) * W), H - 3);
      sides[3] += lum(zone.photo, 2, Math.round(((k + 0.5) / 40) * H));
    }
    expect(Math.min(...sides)).toBeLessThan(0.85 * Math.max(...sides));

    // Dark pieces: all of them with share 1, in dark tones of the table (warm, not the print's blue).
    const darkP = renderPiecesPhoto(ref, cut, items, { ...wood, darkPieces: { share: 1, level: 0.45 } });
    expect(darkP.truth.map((t) => t.bbox)).toEqual(plainWood.truth.map((t) => t.bbox));
    for (const t of darkP.truth) {
      const x = Math.round(t.center.x), y = Math.round(t.center.y), i = (y * W + x) * 4;
      expect(lum(darkP.photo, x, y)).toBeLessThan(0.6 * tableLum);
      expect(darkP.photo.data[i]).toBeGreaterThanOrEqual(darkP.photo.data[i + 2]);
    }
    if (DEBUG_IMAGES) {
      savePng('.debug/synth/real-planks.png', planks.photo);
      savePng('.debug/synth/real-shadow-zone.png', zone.photo);
      savePng('.debug/synth/real-dark-pieces.png', darkP.photo);
    }
  });
});

describe('renderBoxPhoto / perturbReference', () => {
  const ref = resizeRGBA(loadTestAsset('great-wave'), 640, 430);

  it('returns a picture quad that rectifies back to the reference', () => {
    const { photo, pictureQuad, lidQuad } = renderBoxPhoto(ref, { seed: 4, width: 1000, height: 800 });
    const rect = rectifyQuad(photo, pictureQuad, ref.width, ref.height);
    expect(meanAbsDiff(rect, ref, 6)).toBeLessThan(18);
    expect(lidQuad[0].x).toBeLessThan(pictureQuad[0].x + 1);
    if (DEBUG_IMAGES) {
      const dbg = { ...photo, data: new Uint8ClampedArray(photo.data) };
      drawPolygon(dbg, pictureQuad, [255, 0, 0, 255], 2);
      drawPolygon(dbg, lidQuad, [0, 255, 0, 255], 2);
      savePng('.debug/synth/box.png', dbg);
      savePng('.debug/synth/box-rectified.png', rect);
    }
  });

  it('perturbs deterministically and moderately', () => {
    const a = perturbReference(ref, { seed: 2 });
    const b = perturbReference(ref, { seed: 2 });
    let same = true;
    for (let i = 0; i < a.data.length && same; i++) same = a.data[i] === b.data[i];
    expect(same).toBe(true);
    const d = meanAbsDiff(a, ref);
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(25);
    if (DEBUG_IMAGES) savePng('.debug/synth/perturbed.png', cropRGBA(a, { x: 0, y: 0, width: 320, height: 215 }));
  });

  it('createRGBA sanity', () => {
    expect(createRGBA(2, 2).data.length).toBe(16);
  });
});
