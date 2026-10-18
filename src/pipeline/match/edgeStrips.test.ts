import { describe, expect, it } from 'vitest';
import { rgbToLab } from '../../cv/color';
import type { Point } from '../../cv/geometry';
import { createMask, createRGBA } from '../../cv/image';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw } from '../../testing/synth';
import { arcPositionOf, outlineArc, pathBetween, pointAtArc, sampleEdgeStrips, sampleSideStrip } from './edgeStrips';
import { puzzleSideOf } from './fits';
import { stripMismatch } from './sideCompare';
import { inputFromTruth, renderScenario } from './testkit';

const square: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

describe('outline arcs', () => {
  it('parametrises a clockwise outline by arc length, whichever way it was given', () => {
    for (const contour of [square, [...square].reverse()]) {
      const arc = outlineArc(contour);
      expect(arc.total).toBeCloseTo(40, 9);
      // Clockwise on screen: along the top edge to the right first.
      const p = pointAtArc(arc, arcPositionOf(arc, { x: 3, y: -1 }) + 2);
      expect(p.x).toBeCloseTo(5, 9);
      expect(p.y).toBeCloseTo(0, 9);
    }
    const arc = outlineArc(square);
    expect(arcPositionOf(arc, { x: 11, y: 4 })).toBeCloseTo(14, 9);
    expect(pointAtArc(arc, 25)).toEqual({ x: 5, y: 10 });
    expect(pointAtArc(arc, -5)).toEqual({ x: 0, y: 5 });
  });

  it('returns the outline between two positions, wrapping past the start', () => {
    const arc = outlineArc(square);
    expect(pathBetween(arc, 35, 5)).toEqual([{ x: 0, y: 5 }, { x: 0, y: 0 }, { x: 5, y: 0 }]);
    expect(pathBetween(arc, 5, 15)).toEqual([{ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
  });
});

describe('edge strips', () => {
  /** A square piece (pixels 10..49) whose border band shows one colour per side; table grey outside. */
  function sidedPiece(colourAt: (x: number, y: number) => [number, number, number]) {
    const img = createRGBA(60, 60, [128, 128, 128, 255]);
    const mask = createMask(60, 60);
    for (let y = 10; y < 50; y++) {
      for (let x = 10; x < 50; x++) {
        mask.data[y * 60 + x] = 1;
        img.data.set([...colourAt(x, y), 255], (y * 60 + x) * 4);
      }
    }
    const corners: [Point, Point, Point, Point] = [{ x: 10, y: 10 }, { x: 49, y: 10 }, { x: 49, y: 49 }, { x: 10, y: 49 }];
    return { img, mask, corners };
  }

  it('samples the colour just inside each side, side by side in PieceShape order', () => {
    const colours: [number, number, number][] = [[220, 30, 30], [30, 200, 40], [30, 40, 220], [230, 220, 30]];
    // Nearest side wins: top, right, bottom, left.
    const { img, mask, corners } = sidedPiece((x, y) => {
      const d = [y - 10, 49 - x, 49 - y, x - 10];
      return colours[d.indexOf(Math.min(...d))];
    });
    const strips = sampleEdgeStrips(img, mask, { x: 0, y: 0 }, corners, { corners, bodySize: 39 })!;
    expect(strips).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const lab = rgbToLab(...colours[i]);
      // Away from the corners the strip shows the side's own colour.
      for (let k = 6; k < 26; k++) {
        for (let c = 0; c < 3; c++) expect(strips.sides[i][k * 3 + c]).toBeCloseTo(lab[c], 0);
      }
    }
  });

  it('runs from the start corner to the end corner of each side (clockwise)', () => {
    // Brightness grows to the right: the top side gets brighter along its strip, the bottom one darker.
    const { img, mask, corners } = sidedPiece((x) => [x * 5, x * 5, x * 5]);
    const strips = sampleEdgeStrips(img, mask, { x: 0, y: 0 }, corners, { corners, bodySize: 39 })!;
    const L = (i: number, k: number) => strips.sides[i][k * 3];
    expect(L(0, 31)).toBeGreaterThan(L(0, 0) + 30);
    expect(L(2, 31)).toBeLessThan(L(2, 0) - 30);
    // A crop with an origin: the same strip.
    const crop = sampleSideStrip(img, mask, { x: 0, y: 0 }, [corners[0], corners[1]], [2, 3])!;
    for (let k = 0; k < 32; k++) expect(crop[k * 3]).toBeCloseTo(L(0, k), 3);
  });

  it('gives null when no piece pixel lies inside the outline', () => {
    const img = createRGBA(20, 20), mask = createMask(20, 20);
    expect(sampleSideStrip(img, mask, { x: 0, y: 0 }, [{ x: 2, y: 2 }, { x: 18, y: 2 }], [2, 3])).toBeNull();
  });

  it('tells the true partner of a side from the other sides of a scan by colour', () => {
    const ref = loadTestAsset('starry-night');
    const cols = 20;
    const cut = generateJigsaw(16, cols, ref.width, ref.height, 33);
    const at = (r: number, c: number) => r * cols + c;
    const items = [at(5, 5), at(5, 6), at(9, 10), at(12, 3), at(7, 17), at(2, 14)];
    const { photo, truth } = renderScenario(ref, cut, { seed: 8, items, scale: [1.25, 1.25] });
    const sides = truth.map((t, n) => {
      const input = inputFromTruth(photo, cut, t, n + 1, { withShape: true });
      const strips = sampleEdgeStrips(input.image, input.mask, input.origin, t.outline, input.shape!)!;
      // Strips by puzzle side (0 top … 3 left).
      const byPuzzle: Float32Array[] = [];
      for (let i = 0; i < 4; i++) byPuzzle[puzzleSideOf(input.shape!, t.rotationDeg, i)] = strips.sides[i];
      return byPuzzle;
    });
    // Piece 0 (r5 c5) touches piece 1 (r5 c6) with its right side. The painting's brush strokes
    // change colour within a few pixels, so the two strips agree only roughly – but far better than
    // unrelated sides do.
    const truePair = stripMismatch(sides[0][1], sides[1][3]);
    const others: number[] = [];
    for (let n = 1; n < sides.length; n++) for (let i = 0; i < 4; i++) if (!(n === 1 && i === 3)) others.push(stripMismatch(sides[0][1], sides[n][i]));
    others.sort((a, b) => a - b);
    expect(truePair).toBeLessThan(0.75 * others[others.length >> 1]);
    expect(others.filter((d) => d < truePair).length).toBeLessThanOrEqual(2);
  });
});
