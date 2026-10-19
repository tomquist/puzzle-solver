/**
 * Splitting touching pieces (segment.ts, splitTouching): assembled groups stay one region, loose
 * pieces lying against them come off. The scenes are composed from rendered pieces moved into
 * contact, so every contact is exactly where the test puts it.
 */
import { describe, expect, it } from 'vitest';
import { traceOuterContour } from '../../cv/contour';
import type { Point } from '../../cv/geometry';
import { cloneRGBA, createMask, type Mask, type RGBAImage } from '../../cv/image';
import { dilate } from '../../cv/morphology';
import { fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, type PieceTruth, type RGB } from '../../testing/synth';
import { outerAngle, segmentPieces } from './segment';
import { drawOverlay } from './testkit';

const W = 1400, H = 1000;

/** Piece indices of a rows × cols block of an 8 × 10 cut. */
const block = (r0: number, c0: number, rows: number, cols: number): number[] =>
  Array.from({ length: rows * cols }, (_, i) => (r0 + Math.floor(i / cols)) * 10 + c0 + (i % cols));

/**
 * Items rendered on a plain table, then moved: `move` places or slides them (in turn) and the photo
 * is composed again, each piece with its rim and shadow, later items lying on earlier ones.
 */
function composedScene(painting: 'great-wave' | 'starry-night', items: (number | number[])[], background: RGB, rotation: 'any' | number) {
  const ref = painting === 'great-wave' ? resizeRGBA(loadTestAsset('great-wave'), 800, 538) : resizeRGBA(loadTestAsset('starry-night'), 800, 634);
  const cut = generateJigsaw(8, 10, ref.width, ref.height, 5);
  const opts = { seed: 3, background, noiseSigma: 2.5, scale: 1.05, width: W, height: H, rotation };
  const { photo, truth } = renderPiecesPhoto(ref, cut, items, opts);
  const table = renderPiecesPhoto(ref, cut, [], opts).photo;
  const cores = truth.map((t) => {
    const m = createMask(W, H);
    fillPolygon(m, t.outline, 1);
    return m;
  });
  const shift = new Map<number, Point>();
  const occupied = createMask(W, H);
  const covers = (k: number, d: Point, m: Mask) => {
    const c = cores[k];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!c.data[y * W + x]) continue;
        const X = x + d.x, Y = y + d.y;
        if (X >= 0 && Y >= 0 && X < W && Y < H && m.data[Y * W + X]) return true;
      }
    }
    return false;
  };
  const put = (k: number, d: Point) => {
    shift.set(k, d);
    const c = cores[k];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const X = x + d.x, Y = y + d.y;
        if (c.data[y * W + x] && X >= 0 && Y >= 0 && X < W && Y < H) occupied.data[Y * W + X] = 1;
      }
    }
  };
  const move = {
    /** Item k with its anchor centre at `to`. */
    place(k: number, to: Point) {
      put(k, { x: Math.round(to.x - truth[k].center.x), y: Math.round(to.y - truth[k].center.y) });
    },
    /** Item k from its anchor centre at `from` along `dir` until it touches what lies there, then `depth` px on. */
    slide(k: number, from: Point, dir: Point, depth: number) {
      const at = (t: number) => ({ x: Math.round(from.x - truth[k].center.x + dir.x * t), y: Math.round(from.y - truth[k].center.y + dir.y * t) });
      let t = 0;
      while (!covers(k, at(t), occupied)) if (++t > 2 * W) throw new Error('nothing to touch');
      put(k, at(t + depth));
    },
  };
  const compose = (): RGBAImage => {
    const out = cloneRGBA(table);
    const covered = createMask(W, H);
    truth.forEach((_, k) => {
      const d = shift.get(k) ?? { x: 0, y: 0 };
      const core = dilate(cores[k], 1), halo = dilate(cores[k], 6);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const X = x + d.x, Y = y + d.y;
          if (!halo.data[i] || X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const j = Y * W + X;
          // Rim and shadow only over table, the piece itself over anything.
          if (!core.data[i] && covered.data[j]) continue;
          out.data.set(photo.data.subarray(i * 4, i * 4 + 4), j * 4);
          if (core.data[i]) covered.data[j] = 1;
        }
      }
    });
    return out;
  };
  /** A point of item k (photo coordinates as rendered) where the item now lies; default its anchor centre. */
  const centre = (k: number, p: Point = truth[k].center): Point => {
    const d = shift.get(k) ?? { x: 0, y: 0 };
    return { x: p.x + d.x, y: p.y + d.y };
  };
  return { truth, move, compose, centre };
}

/** Id of the piece / patch region holding a point. */
function regionAt(seg: ReturnType<typeof segmentPieces>, p: Point): number | undefined {
  const x = Math.round(p.x), y = Math.round(p.y);
  return seg.regions.find(({ region: r, mask }) => {
    const lx = x - r.bbox.x, ly = y - r.bbox.y;
    return r.kind !== 'unknown' && lx >= 0 && ly >= 0 && lx < r.bbox.width && ly < r.bbox.height && mask.data[ly * r.bbox.width + lx] === 1;
  })?.region.id;
}

/**
 * A 5 × 5 patch at the left with loose pieces lying against its right side (body ≈ 77 px); the
 * remaining single pieces in two columns at the right, for the size reference.
 */
function patchScene() {
  const s = composedScene('great-wave', [block(1, 1, 5, 5), 0, 9, 19, 29, 70, 79, 77, 60], [128, 128, 128], 'any');
  const pb = s.truth[0].bbox;
  const top = Math.round((H - pb.height) / 2);
  s.move.place(0, { x: 60 + s.truth[0].center.x - pb.x, y: top + s.truth[0].center.y - pb.y });
  const right = 60 + pb.width;
  const rest = (taken: number[]) => s.truth.map((_, k) => k).filter((k) => k > 0 && !taken.includes(k))
    .forEach((k, j) => s.move.place(k, { x: 950 + (j % 2) * 200, y: 150 + Math.floor(j / 2) * 220 }));
  return { ...s, top, right, height: pb.height, rest };
}

function debug(name: string, photo: RGBAImage, seg: ReturnType<typeof segmentPieces>, truth: PieceTruth[]) {
  if (DEBUG_IMAGES) savePng(`.debug/pieces/split-${name}.png`, drawOverlay(photo, seg, truth));
}

describe('splitting loose pieces off an assembled patch', () => {
  it('peels a piece whose tab lies on the patch edge off it, after a narrow contact was cut', () => {
    const s = patchScene();
    // One piece touching with a tab (cut at the narrowest necks), one with a tab pushed 16 px onto
    // the patch edge (a contact of about half a body, cut only at wider necks).
    s.move.slide(1, { x: s.right + 150, y: s.top + 0.25 * s.height }, { x: -1, y: 0 }, 3);
    s.move.slide(4, { x: s.right + 150, y: s.top + 0.8 * s.height }, { x: -1, y: 0 }, 16);
    s.rest([1, 4]);
    const photo = s.compose();
    const seg = segmentPieces(photo);
    debug('peel', photo, seg, s.truth);
    const patch = regionAt(seg, s.centre(0));
    expect(seg.regions.find((r) => r.region.id === patch)?.region.kind).toBe('patch');
    for (const k of [1, 4]) {
      const id = regionAt(seg, s.centre(k));
      expect(id, `piece ${k}`).toBeDefined();
      expect(id, `piece ${k}`).not.toBe(patch);
    }
  });

  it('opens the table enclosed between a patch and loose pieces lying around it', () => {
    const s = patchScene();
    // Two pieces against the patch side, 0.6 bodies apart, and a third one bridging them from the
    // right: the table between the four is closed all round (about 0.8 piece areas).
    const body = 84, mid = s.top + s.height / 2;
    s.move.slide(1, { x: s.right + 200, y: mid - 0.8 * body }, { x: -1, y: 0 }, 3);
    s.move.slide(2, { x: s.right + 200, y: mid + 0.8 * body }, { x: -1, y: 0 }, 3);
    s.move.slide(3, { x: s.right + 300, y: mid }, { x: -1, y: 0 }, 3);
    s.rest([1, 2, 3]);
    const photo = s.compose();
    const seg = segmentPieces(photo);
    debug('hole', photo, seg, s.truth);
    const patch = regionAt(seg, s.centre(0));
    // (The lower piece lies flat along the patch side: no neck to cut, it may stay with the patch.)
    const upper = regionAt(seg, s.centre(1)), bridge = regionAt(seg, s.centre(3));
    expect(upper).toBeDefined();
    expect(bridge).toBeDefined();
    expect(new Set([patch, upper, bridge]).size).toBe(3);
  });
});

describe('assembled groups stay whole', () => {
  it('keeps a strip with pieces locked on top as one patch', () => {
    // A strip of seven pieces with three on top (like a title strip), slightly misaligned.
    const s = composedScene('starry-night', [[...block(4, 1, 1, 7), 31, 33, 36], 0, 9, 18, 27, 70, 79, 62, 47], [150, 118, 82], 3);
    const sb = s.truth[0].bbox;
    s.move.place(0, { x: 200 + s.truth[0].center.x - sb.x, y: 400 + s.truth[0].center.y - sb.y });
    s.truth.forEach((_, k) => { if (k > 0) s.move.place(k, { x: 150 + ((k - 1) % 4) * 250, y: k <= 4 ? 150 : 850 }); });
    const photo = s.compose();
    const seg = segmentPieces(photo);
    debug('strip', photo, seg, s.truth);
    const strip = s.truth[0].members!.map((m) => regionAt(seg, s.centre(0, m.center)));
    expect(new Set(strip).size).toBe(1);
    expect(seg.regions.find((r) => r.region.id === strip[0])?.region.kind).toBe('patch');
  });

  it('gives no grid direction to a part that reaches the cluster outline only along a tab', () => {
    // A strip (body 80 px) with a round knob on top. A part split off around the knob reaches the
    // outline along the curved knob only: its direction is noise and must not outvote the grid.
    const cluster = createMask(520, 160);
    for (let y = 40; y < 140; y++) for (let x = 10; x < 510; x++) cluster.data[y * 520 + x] = 1;
    const knob = (m: Mask) => { for (let y = 0; y < 160; y++) for (let x = 0; x < 520; x++) if ((x - 260) ** 2 + (y - 34) ** 2 <= 16 ** 2) m.data[y * 520 + x] = 1; };
    knob(cluster);
    const part = (fill: (m: Mask) => void) => {
      const m = createMask(520, 160);
      fill(m);
      let area = 0;
      for (const v of m.data) area += v;
      return { contour: traceOuterContour(m), area };
    };
    const around = part((m) => { knob(m); for (let y = 40; y < 110; y++) for (let x = 246; x < 275; x++) m.data[y * 520 + x] = 1; });
    const side = part((m) => { for (let y = 40; y < 140; y++) for (let x = 10; x < 150; x++) m.data[y * 520 + x] = 1; });
    const box = { mask: cluster, bbox: { x: 0, y: 0, width: 520, height: 160 } };
    const body = 80;
    // (Without a minimum of straight edge it still has a direction, from the knob's flanks.)
    expect(outerAngle(around, box)).not.toBeNull();
    expect(outerAngle(around, box, 0.15 * body)).toBeNull();
    const a = outerAngle(side, box, 0.15 * body);
    expect(a).not.toBeNull();
    expect(Math.min(a!, 90 - a!)).toBeLessThan(3);
  });
});
