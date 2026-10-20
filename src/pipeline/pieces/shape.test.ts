import { describe, expect, it } from 'vitest';
import { traceOuterContour } from '../../cv/contour';
import { applyMat3, polygonSignedArea, rotation, type Point } from '../../cv/geometry';
import { createMask } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, truthPieceShape, type PieceTruth } from '../../testing/synth';
import { analyzePieceShape, bodyOrientation, dominantOrientation, orientationHistogram, sideProfile, sideProfilesAt } from './shape';
import { cornerError, quarterAngleError, sideAngleError } from './testkit';

/** Rasterise an outline and trace it back, like the segmentation does. */
function tracedOutline(outline: Point[]): Point[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of outline) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const ox = Math.floor(x0) - 3, oy = Math.floor(y0) - 3;
  const m = createMask(Math.ceil(x1) - ox + 4, Math.ceil(y1) - oy + 4);
  fillPolygon(m, outline.map((p) => ({ x: p.x - ox, y: p.y - oy })), 1);
  return traceOuterContour(m).map((p) => ({ x: p.x + ox, y: p.y + oy }));
}

/** Grid orientation of a rendered item, reduced to (−45, 45]. */
function truthOrientation(t: PieceTruth): number {
  const d = applyMat3(rotation((-t.rotationDeg * Math.PI) / 180), { x: 1, y: 0 });
  let o = (Math.atan2(d.y, d.x) * 180) / Math.PI;
  while (o <= -45) o += 90;
  while (o > 45) o -= 90;
  return o;
}

describe('analyzePieceShape', () => {
  const ref = resizeRGBA(loadTestAsset('starry-night'), 640, 507);

  it('finds corners, side kinds and piece kinds on traced outlines (sweep of cuts, rotations, scales)', () => {
    let n = 0, cornersOk = 0, sidesOk = 0, kindsOk = 0, found = 0, angleOk = 0;
    const errs: number[] = [];
    for (const [rows, cols, seed] of [[6, 8, 1], [8, 10, 2], [7, 9, 3]]) {
      const cut = generateJigsaw(rows, cols, ref.width, ref.height, seed);
      const items = cut.pieces.filter((_, i) => i % 3 === seed % 3).map((p) => p.index);
      const { truth } = renderPiecesPhoto(ref, cut, items, { seed, scale: [0.7, 1.8] });
      for (const t of truth) {
        n++;
        const shape = analyzePieceShape(tracedOutline(t.outline));
        if (!shape) continue;
        found++;
        const ts = truthPieceShape(cut, t);
        const ce = cornerError(shape, ts);
        errs.push(ce.error / ts.bodySize);
        if (ce.error <= 0.05 * ts.bodySize) cornersOk++;
        for (let j = 0; j < 4; j++) if (shape.sides[j].kind === ts.sides[(j + ce.shift) % 4].kind) sidesOk++;
        if (shape.kind === ts.kind) kindsOk++;
        if (sideAngleError(shape, ts, ce.shift) < 3) angleOk++;
      }
    }
    errs.sort((a, b) => a - b);
    console.log(`shape on traced truth outlines: n=${n} found=${found} corners≤5%=${cornersOk} sides=${sidesOk}/${4 * n} kinds=${kindsOk} angle<3°=${angleOk} median corner err=${(100 * errs[errs.length >> 1]).toFixed(2)}%`);
    expect(found).toBe(n);
    expect(cornersOk / n).toBeGreaterThanOrEqual(0.97);
    expect(sidesOk / (4 * n)).toBeGreaterThanOrEqual(0.98);
    expect(kindsOk / n).toBeGreaterThanOrEqual(0.97);
    expect(angleOk / n).toBeGreaterThanOrEqual(0.95);
  });

  it('follows the PieceShape conventions (local frame, clockwise sides, outward profiles)', () => {
    const cut = generateJigsaw(6, 8, ref.width, ref.height, 11);
    const { truth } = renderPiecesPhoto(ref, cut, [0, 9, 14, 30, 47], { seed: 4, scale: 1.4 });
    for (const t of truth) {
      const s = analyzePieceShape(tracedOutline(t.outline))!;
      expect(s).not.toBeNull();
      expect(s.angleDeg).toBeGreaterThan(-45);
      expect(s.angleDeg).toBeLessThanOrEqual(45);
      // corners[0] is the top-left corner after rotating the photo by −angleDeg.
      const R = rotation((-s.angleDeg * Math.PI) / 180);
      const rc = s.corners.map((p) => applyMat3(R, p));
      const sums = rc.map((p) => p.x + p.y);
      expect(sums.indexOf(Math.min(...sums))).toBe(0);
      // Side 0 points right in the local frame, the corners run clockwise on screen.
      expect(rc[1].x - rc[0].x).toBeGreaterThan(0);
      expect(polygonSignedArea(s.corners)).toBeGreaterThan(0);
      // Side lengths, body size, center.
      for (let j = 0; j < 4; j++) {
        const a = s.corners[j], b = s.corners[(j + 1) % 4];
        expect(s.sides[j].length).toBeCloseTo(Math.hypot(b.x - a.x, b.y - a.y), 6);
        expect(s.sides[j].profile.length).toBe(32);
      }
      expect(s.bodySize).toBeCloseTo(s.sides.reduce((x, d) => x + d.length, 0) / 4, 6);
      expect(Math.hypot(s.center.x - t.center.x, s.center.y - t.center.y)).toBeLessThan(0.05 * s.bodySize);
      // Tabs bulge outward (positive), blanks inward (negative).
      for (const side of s.sides) {
        const ext = side.profile.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
        if (side.kind === 'tab') expect(ext).toBeGreaterThan(0.12);
        if (side.kind === 'blank') expect(ext).toBeLessThan(-0.12);
        if (side.kind === 'flat') expect(Math.abs(ext)).toBeLessThan(0.08);
      }
      expect(s.confidence).toBeGreaterThan(0.6);
    }
  });

  it('accepts counter-clockwise outlines and any start point', () => {
    const cut = generateJigsaw(5, 5, 500, 500, 3);
    const { truth } = renderPiecesPhoto(ref, cut, [12], { seed: 2, scale: 1.2 });
    const c = tracedOutline(truth[0].outline);
    const a = analyzePieceShape(c)!;
    const b = analyzePieceShape([...c.slice(57), ...c.slice(0, 57)].reverse())!;
    for (let j = 0; j < 4; j++) expect(Math.hypot(a.corners[j].x - b.corners[j].x, a.corners[j].y - b.corners[j].y)).toBeLessThan(1.5);
    expect(b.sides.map((s) => s.kind)).toEqual(a.sides.map((s) => s.kind));
  });

  it('rejects degenerate outlines and is unsure about non-piece shapes', () => {
    expect(analyzePieceShape([])).toBeNull();
    expect(analyzePieceShape([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBeNull();
    const circle: Point[] = Array.from({ length: 400 }, (_, i) => ({ x: 200 + 80 * Math.cos((i / 400) * 2 * Math.PI), y: 200 + 80 * Math.sin((i / 400) * 2 * Math.PI) }));
    const c = analyzePieceShape(circle);
    expect(c === null || c.confidence < 0.5).toBe(true);
    // A plain rectangle: four flat sides => 'unknown' kind (not a real puzzle piece), but corners exact.
    const rect = tracedOutline([{ x: 10, y: 10 }, { x: 130, y: 10 }, { x: 130, y: 110 }, { x: 10, y: 110 }]);
    const r = analyzePieceShape(rect)!;
    expect(r.sides.every((s) => s.kind === 'flat')).toBe(true);
    expect(r.kind).toBe('unknown');
    expect(Math.hypot(r.corners[0].x - 10, r.corners[0].y - 10)).toBeLessThan(1.5);
  });
});

describe('sideProfilesAt', () => {
  it('reproduces the analysed profiles at the found corners and follows corners moved along the outline', () => {
    const ref = resizeRGBA(loadTestAsset('starry-night'), 640, 507);
    const cut = generateJigsaw(5, 5, 500, 500, 3);
    const { truth } = renderPiecesPhoto(ref, cut, [12], { seed: 2, scale: 1.2 });
    const c = tracedOutline(truth[0].outline);
    const shape = analyzePieceShape(c)!;
    const same = sideProfilesAt(c, shape.corners)!;
    for (let i = 0; i < 4; i++) {
      expect(same[i].length).toBeCloseTo(shape.sides[i].length, 9);
      expect(same[i].profile).toEqual(shape.sides[i].profile);
    }
    // Corner 1 moved 4 px clockwise: side 0 grows (its end runs past the corner), side 1 shrinks.
    const moved = sideProfilesAt(c, shape.corners, [0, 4, 0, 0])!;
    expect(moved[0].profile).not.toEqual(shape.sides[0].profile);
    expect(moved[1].length).toBeLessThan(shape.sides[1].length - 2);
    expect(moved[2].profile).toEqual(shape.sides[2].profile);
    expect(sideProfilesAt([], shape.corners)).toBeNull();
  });
});

describe('sideProfile', () => {
  it('measures outward deviation relative to the side length', () => {
    // Clockwise outline: top side runs left → right, outward is up (−y).
    const path = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 50, y: -25 }, { x: 60, y: 0 }, { x: 100, y: 0 }];
    const { length, profile } = sideProfile(path, path[0], path[4]);
    expect(length).toBe(100);
    // Peak 0.25 at t = 0.5; the nearest samples (t = 15/31, 16/31) see ≈ 0.21.
    expect(Math.max(...profile)).toBeGreaterThan(0.2);
    expect(Math.max(...profile)).toBeLessThanOrEqual(0.25);
    expect(Math.min(...profile)).toBeGreaterThanOrEqual(0);
    expect(profile[0]).toBeCloseTo(0, 6);
    expect(profile[31]).toBeCloseTo(0, 6);
  });
});

describe('dominantOrientation', () => {
  const ref = resizeRGBA(loadTestAsset('great-wave'), 640, 430);
  const cut = generateJigsaw(8, 10, ref.width, ref.height, 5);

  it('recovers the grid orientation of pieces and assembled patches', () => {
    const items = [[1, 2], [11, 12, 21, 22], [33, 34, 35], [44, 54, 55], [60, 61, 70, 71, 62, 72], 5, 17, 26, 39, 48, 77];
    const errs: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const { truth } = renderPiecesPhoto(ref, cut, items, { seed, scale: 1.3 });
      for (const t of truth) errs.push(quarterAngleError(dominantOrientation(t.outline), truthOrientation(t)));
    }
    errs.sort((a, b) => a - b);
    console.log(`dominantOrientation error: median ${errs[errs.length >> 1].toFixed(2)}°, max ${errs[errs.length - 1].toFixed(2)}°`);
    expect(errs[Math.floor(0.9 * errs.length)]).toBeLessThan(3);
    expect(errs[errs.length - 1]).toBeLessThan(6);
  });

  it('returns values in (−45, 45] and handles degenerate input', () => {
    expect(dominantOrientation([])).toBe(0);
    const sq = (deg: number): Point[] => {
      const R = rotation((deg * Math.PI) / 180);
      return [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }].map((p) => applyMat3(R, p));
    };
    for (const deg of [0, 10, 44, 45, 46, -30, 89, 135]) {
      const o = dominantOrientation(sq(deg));
      expect(o).toBeGreaterThan(-45);
      expect(o).toBeLessThanOrEqual(45);
      expect(quarterAngleError(o, deg)).toBeLessThan(0.5);
    }
  });

  it('separates assembled patches (one grid) from differently rotated pieces (second peak)', () => {
    const { truth } = renderPiecesPhoto(ref, cut, [[11, 12, 21, 22], [33, 34, 35]], { seed: 2, scale: 1.3 });
    for (const t of truth) expect(orientationHistogram(t.outline).secondPeak).toBeLessThan(0.42);
  });

  it('bodyOrientation averages the four body sides', () => {
    const { truth } = renderPiecesPhoto(ref, cut, [13, 24, 36, 47, 58], { seed: 3, scale: 1.4 });
    for (const t of truth) {
      const s = analyzePieceShape(tracedOutline(t.outline))!;
      expect(quarterAngleError(bodyOrientation(s), truthOrientation(t))).toBeLessThan(4);
    }
  });
});
