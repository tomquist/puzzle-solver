import { beforeAll, describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../cv/image';
import type { DetectedRegion, FitHint, PieceShape, RegionMatch, SideKind } from '../../model/types';
import { loadTestAsset } from '../../testing/nodeImageIO';
import { generateJigsaw, perturbReference, truthPieceShape, type JigsawCut, type PieceTruth } from '../../testing/synth';
import { neighboursAgree, puzzleSideOf, profileMismatch, shapeFits } from './fits';
import { buildReferenceIndex, findFits, matchRegions, sampleEdgeStrips, type EdgeStrips, type MatchInput, type ReferenceIndex } from './index';
import { inputFromTruth, renderScenario } from './testkit';

function regionFromTruth(cut: JigsawCut, t: PieceTruth, id: number, orientationDeg: number): DetectedRegion {
  const single = t.pieces.length === 1;
  return {
    id,
    kind: single ? 'piece' : 'patch',
    bbox: t.bbox,
    contour: t.outline,
    area: t.bbox.width * t.bbox.height,
    touchesBorder: false,
    shape: single ? truthPieceShape(cut, t) : undefined,
    orientationDeg,
    issues: [],
  };
}

function find(hints: FitHint[], a: number, b: number): FitHint | undefined {
  return hints.find((h) => (h.a === a && h.b === b) || (h.a === b && h.b === a));
}

/** Side of region `id` in hint `h`. */
function sideOf(h: FitHint, id: number): string {
  return h.a === id ? h.sideA : h.sideB;
}

describe('findFits', () => {
  const rows = 16, cols = 20;
  let ref: RGBAImage;
  let index: ReferenceIndex;
  let cut: JigsawCut;
  let regions: DetectedRegion[];
  let matches: RegionMatch[];
  let truth: PieceTruth[];
  let inputs: MatchInput[];
  const at = (r: number, c: number) => r * cols + c;

  beforeAll(() => {
    ref = loadTestAsset('starry-night');
    index = buildReferenceIndex(perturbReference(ref, { seed: 5 }), { rows, cols }, 'grid');
    cut = generateJigsaw(rows, cols, ref.width, ref.height, 33);
    const items = [
      at(5, 5), at(5, 6), // horizontal neighbours
      at(9, 10), at(10, 10), // vertical neighbours
      [at(2, 14), at(2, 15), at(3, 14), at(3, 15)], // patch
      at(4, 15), // below the patch
      at(12, 3), at(7, 17), // unrelated
    ];
    const scene = renderScenario(ref, cut, { seed: 8, items, scale: [1.25, 1.25] });
    truth = scene.truth;
    inputs = truth.map((t, i) => inputFromTruth(scene.photo, cut, t, i + 1, { withShape: true }));
    regions = truth.map((t, i) => regionFromTruth(cut, t, i + 1, inputs[i].orientationDeg));
    matches = matchRegions(index, inputs);
  });

  it('maps local sides to puzzle sides consistently with the placement rotation', () => {
    for (let i = 0; i < truth.length; i++) {
      const shape = regions[i].shape;
      if (!shape) continue;
      const piece = cut.pieces[truth[i].pieces[0]];
      for (let s = 0; s < 4; s++) {
        const side = puzzleSideOf(shape, truth[i].rotationDeg, s);
        expect(shape.sides[s].kind).toBe(piece.sides[side]);
      }
    }
  });

  it('finds location (+shape) hints for neighbouring pieces and a piece next to a patch', () => {
    expect(matches.every((m) => m.status === 'confident')).toBe(true);
    const hints = findFits(regions, matches, { rows, cols });
    const h12 = find(hints, 1, 2)!;
    expect(h12).toBeDefined();
    expect(sideOf(h12, 1)).toBe('right');
    expect(sideOf(h12, 2)).toBe('left');
    expect(h12.reason).toBe('location+shape');
    const h34 = find(hints, 3, 4)!;
    expect(h34).toBeDefined();
    expect(sideOf(h34, 3)).toBe('bottom');
    expect(sideOf(h34, 4)).toBe('top');
    const hp = find(hints, 5, 6)!;
    expect(hp).toBeDefined();
    expect(sideOf(hp, 6)).toBe('top');
    expect(sideOf(hp, 5)).toBe('bottom');
    expect(hp.reason).toBe('location');
    // Nothing for the unrelated pieces, no flooding.
    expect(hints.filter((h) => [7, 8].includes(h.a) || [7, 8].includes(h.b))).toEqual([]);
    for (const h of hints) expect(h.confidence).toBeGreaterThan(0);
    const perRegion = new Map<number, number>();
    for (const h of hints) for (const id of [h.a, h.b]) perRegion.set(id, (perRegion.get(id) ?? 0) + 1);
    expect(Math.max(...perRegion.values())).toBeLessThanOrEqual(3);
  });

  it('finds shape-only hints when the locations are ambiguous', () => {
    // Pretend the image content was ambiguous: wrong, low-confidence locations, correct rotations.
    const vague: RegionMatch[] = matches.map((m, i) => ({
      regionId: m.regionId,
      status: 'ambiguous',
      candidates: [{ row: (i * 7) % rows, col: (i * 3) % cols, x: 0, y: 0, rotationDeg: truth[i].rotationDeg, score: 0.3, confidence: 0.2 }],
    }));
    const hints = findFits(regions, vague, { rows, cols });
    const h12 = find(hints, 1, 2)!;
    expect(h12?.reason).toBe('shape');
    expect(sideOf(h12, 1)).toBe('right');
    const h34 = find(hints, 3, 4)!;
    expect(h34?.reason).toBe('shape');
    expect(sideOf(h34, 4)).toBe('top');
    // Only strong, mutually best fits: no hints between pieces that are not neighbours.
    for (const h of hints) {
      const ok = (find([h], 1, 2) ?? find([h], 3, 4)) !== undefined;
      expect(ok).toBe(true);
    }
  });

  it('finds the same shape-only hints comparing sides with DTW and colour strips', () => {
    const vague: RegionMatch[] = matches.map((m, i) => ({
      regionId: m.regionId,
      status: 'ambiguous',
      candidates: [{ row: (i * 7) % rows, col: (i * 3) % cols, x: 0, y: 0, rotationDeg: truth[i].rotationDeg, score: 0.3, confidence: 0.2 }],
    }));
    const strips = new Map<number, EdgeStrips>();
    truth.forEach((t, i) => {
      if (t.pieces.length !== 1) return;
      const input = inputs[i];
      strips.set(i + 1, sampleEdgeStrips(input.image, input.mask, input.origin, t.outline, regions[i].shape!)!);
    });
    for (const opts of [{ shape: 'dtw' as const }, { shape: 'dtw-levelled' as const }]) {
      const hints = findFits(regions, vague, { rows, cols }, opts);
      expect(find(hints, 1, 2)?.reason).toBe('shape');
      expect(sideOf(find(hints, 1, 2)!, 1)).toBe('right');
      expect(find(hints, 3, 4)?.reason).toBe('shape');
      expect(sideOf(find(hints, 3, 4)!, 4)).toBe('top');
      for (const h of hints) expect((find([h], 1, 2) ?? find([h], 3, 4)) !== undefined).toBe(true);
    }
    // Colour joins the comparison: the brush strokes make the strips of a true pair only roughly
    // alike, which can cost a perfect shape match its margin – but it never invents a fit.
    for (const opts of [{ shape: 'dtw' as const, strips }, { shape: 'dtw-levelled' as const, strips }, { strips }]) {
      const hints = findFits(regions, vague, { rows, cols }, opts);
      expect(hints.length).toBeGreaterThan(0);
      for (const h of hints) expect((find([h], 1, 2) ?? find([h], 3, 4)) !== undefined).toBe(true);
    }
  });

  it('measures profile mismatch of complementary sides', () => {
    const a = [0, 0.1, 0.3, 0.1, 0];
    expect(profileMismatch(a, a.map((v) => -v).reverse())).toBeCloseTo(0, 10);
    expect(profileMismatch(a, a)).toBeGreaterThan(0.1);
  });
});

describe('neighboursAgree', () => {
  /** A unit-square piece with the given side kinds; knob profiles bulge out (tab) or in (blank). */
  const piece = (kinds: SideKind[], depth = 0.25): PieceShape => ({
    corners: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    sides: kinds.map((kind) => ({
      kind,
      length: 100,
      profile: Array.from({ length: 32 }, (_, i) => (kind === 'flat' || kind === 'unknown' ? 0 : (kind === 'tab' ? 1 : -1) * depth * Math.sin((Math.PI * i) / 31) ** 4)),
    })) as PieceShape['sides'],
    angleDeg: 0,
    bodySize: 100,
    center: { x: 50, y: 50 },
    kind: kinds.filter((k) => k === 'flat').length === 1 ? 'edge' : 'interior',
    confidence: 0.9,
  });

  it('holds for every pair of true neighbours of a cut, border pieces included', () => {
    const cut = generateJigsaw(5, 6, 600, 500, 3);
    const shapeOf = (r: number, c: number) => piece(cut.pieces[r * 6 + c].sides);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 6; c++) {
        if (c + 1 < 6) expect(neighboursAgree(shapeOf(r, c), 1, shapeOf(r, c + 1), 3)).toBe(true);
        if (r + 1 < 5) expect(neighboursAgree(shapeOf(r, c), 2, shapeOf(r + 1, c), 0)).toBe(true);
      }
    }
  });

  it('rules out sides whose neighbours disagree about the border, unknown sides allow anything', () => {
    // A top-border piece (side 0 flat) cannot put its right side against an interior piece's left side.
    const border = piece(['flat', 'tab', 'blank', 'blank']);
    const interior = piece(['tab', 'blank', 'tab', 'blank']);
    expect(neighboursAgree(border, 1, interior, 3)).toBe(false);
    expect(neighboursAgree(interior, 3, border, 1)).toBe(false);
    // …but against another top-border piece's left side it can.
    expect(neighboursAgree(border, 1, piece(['flat', 'blank', 'tab', 'blank']), 3)).toBe(true);
    expect(neighboursAgree(border, 1, piece(['unknown', 'blank', 'tab', 'blank']), 3)).toBe(true);
  });

  it('trusts only clear readings: a shallow "flat" (a partly filled blank) or a shallow knob tells nothing', () => {
    const interior = piece(['tab', 'blank', 'tab', 'blank']);
    const shallowFlat = piece(['flat', 'tab', 'blank', 'blank']);
    shallowFlat.sides[0].profile = shallowFlat.sides[0].profile.map((_, i) => -0.06 * Math.sin((Math.PI * i) / 31) ** 4);
    expect(neighboursAgree(shallowFlat, 1, interior, 3)).toBe(true);
    const border = piece(['flat', 'tab', 'blank', 'blank']);
    expect(neighboursAgree(border, 1, piece(['tab', 'blank', 'tab', 'blank'], 0.1), 3)).toBe(true);
    expect(neighboursAgree(border, 1, piece(['tab', 'blank', 'tab', 'blank'], 0.2), 3)).toBe(false);
  });

  it('keeps shape fits from pairing a border piece with an interior piece', () => {
    const region = (id: number, shape: PieceShape): DetectedRegion => ({
      id, kind: 'piece', bbox: { x: 0, y: 0, width: 100, height: 100 }, contour: [], area: 1e4, touchesBorder: false, shape, orientationDeg: 0, issues: [],
    });
    // The right side of piece 1 (top border) and the left side of piece 2 match perfectly in shape.
    const a = piece(['flat', 'tab', 'unknown', 'unknown']);
    const fits = (b: PieceShape) => shapeFits([region(1, a), region(2, b)]);
    expect(fits(piece(['flat', 'unknown', 'unknown', 'blank']))).toHaveLength(1);
    expect(fits(piece(['tab', 'unknown', 'unknown', 'blank']))).toHaveLength(0);
  });
});
