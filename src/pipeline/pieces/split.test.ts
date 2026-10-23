/**
 * Splitting touching pieces (segment.ts, splitTouching): assembled groups stay one region, loose
 * pieces lying against them come off. The scenes are composed from rendered pieces moved into
 * contact, so every contact is exactly where the test puts it.
 */
import { describe, expect, it } from 'vitest';
import { traceOuterContour } from '../../cv/contour';
import type { Point } from '../../cv/geometry';
import { cloneRGBA, createMask, createRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { dilate, erode } from '../../cv/morphology';
import { fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, type PieceTruth, type RGB } from '../../testing/synth';
import type { SideKind } from '../../model/types';
import { cutSupport, outerAngle, outerTurn, PAIR_KEY, segmentPieces } from './segment';
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

describe('splitting always ends', () => {
  it('does not recurse without end on a piece lying inside a ring of the same colour', () => {
    // A light piece inside an octagonal ring of the same light colour, 3 px of dark table between
    // them, next to eight loose pieces. The split along the edges separates the piece from the
    // ring; filled, the ring was the whole cluster again, split again the same way (stack overflow).
    const ref = resizeRGBA(loadTestAsset('great-wave'), 800, 538);
    const cut = generateJigsaw(8, 10, ref.width, ref.height, 5);
    const table: RGB = [38, 42, 50];
    const { photo } = renderPiecesPhoto(ref, cut, [0, 9, 19, 29, 70, 79, 77, 60], { seed: 3, background: table, noiseSigma: 2.5, scale: 1.05, width: W, height: H, margin: 40 });
    const cx = 250, cy = 500, piece = cut.pieces[34];
    const pc = piece.corners.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    const inner = createMask(W, H);
    fillPolygon(inner, piece.outline.map((p) => ({ x: cx + 1.05 * (p.x - pc.x), y: cy + 1.05 * (p.y - pc.y) })), 1);
    const gap = dilate(inner, 3), ring = createMask(W, H);
    fillPolygon(ring, Array.from({ length: 8 }, (_, i) => ({ x: cx + 85 * Math.cos(((i + 0.5) * Math.PI) / 4), y: cy + 85 * Math.sin(((i + 0.5) * Math.PI) / 4) })), 1);
    // (Sensor noise: a sum of three uniform numbers, Lehmer generator.)
    let seed = 7;
    const uniform = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < 450; x++) {
        const i = y * W + x;
        const c = inner.data[i] || (ring.data[i] && !gap.data[i]) ? [225, 212, 185] : table;
        for (let k = 0; k < 3; k++) photo.data[i * 4 + k] = c[k] + 4 * (uniform() + uniform() + uniform() - 1.5);
      }
    }
    const seg = segmentPieces(photo);
    debug('ring', photo, seg, []);
    // The piece is a region of its own, and no pixel belongs to two regions.
    const id = regionAt(seg, { x: cx, y: cy });
    expect(id).toBeDefined();
    const owner = new Int32Array(W * H);
    for (const { region: r, mask } of seg.regions) {
      for (let y = 0; y < r.bbox.height; y++) {
        for (let x = 0; x < r.bbox.width; x++) {
          if (!mask.data[y * r.bbox.width + x]) continue;
          const i = (y + r.bbox.y) * W + x + r.bbox.x;
          expect(owner[i], `pixel ${x + r.bbox.x},${y + r.bbox.y}`).toBe(0);
          owner[i] = r.id;
        }
      }
    }
    expect(seg.regions.find((r) => r.region.id === id)!.region.bbox.width).toBeLessThan(140);
  });
});

/**
 * A drawn piece: side kinds top, right, bottom, left, where along each side its knob sits (default
 * the middle), and the knobs' size: discs of radius `knob` (default 0.16 body sizes) centred
 * `offset` (default 0.15) outside a side; blanks are the same disc cut in.
 */
interface Drawn {
  sides: [SideKind, SideKind, SideKind, SideKind];
  along?: [number, number, number, number];
  knob?: number;
  offset?: number;
}

/** Whether body point (u, v) (body units, the body is the unit square) lies in a drawn piece. */
function inPiece(u: number, v: number, piece: Drawn): boolean {
  const a = piece.along ?? [0.5, 0.5, 0.5, 0.5], r = piece.knob ?? 0.16, off = piece.offset ?? 0.15;
  const centre = (i: number, out: number): Point =>
    [{ x: a[0], y: -out }, { x: 1 + out, y: a[1] }, { x: a[2], y: 1 + out }, { x: -out, y: a[3] }][i];
  const near = (c: Point) => (u - c.x) ** 2 + (v - c.y) ** 2 <= r ** 2;
  if (piece.sides.some((s, i) => s === 'blank' && near(centre(i, -off)))) return false;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return true;
  return piece.sides.some((s, i) => s === 'tab' && near(centre(i, off)));
}

/**
 * Flat-printed pieces drawn on a grey table: each item is a piece or an assembled group of pieces
 * (body offsets in body units), turned and placed on its own; every piece is filled with one colour
 * and outlined by a 2 px dark rim, so that the pieces of a group meet along a dark seam.
 */
function drawnScene(items: { pieces: (Drawn & { at: Point })[]; centre: Point; deg: number; colour?: RGB; apart?: number }[], body: number) {
  const photo = createRGBA(W, H);
  let seed = 11;
  const uniform = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noise = () => (uniform() + uniform() - 1) * 4;
  for (let i = 0; i < W * H; i++) photo.data.set([150 + noise(), 152 + noise(), 156 + noise(), 255], i * 4);
  /** Photo position of body point (u, v) of piece p of item k. */
  const toPhoto = (k: number, p: number, u: number, v: number): Point => {
    const it = items[k], at = it.pieces[p].at, t = (it.deg * Math.PI) / 180;
    const x = (u + at.x) * body, y = (v + at.y) * body;
    return { x: it.centre.x + x * Math.cos(t) - y * Math.sin(t), y: it.centre.y + x * Math.sin(t) + y * Math.cos(t) };
  };
  items.forEach((it) => {
    const t = (it.deg * Math.PI) / 180;
    const owner = new Int32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - it.centre.x) / body, dy = (y - it.centre.y) / body;
        if (dx * dx + dy * dy > 9) continue;
        const bu = dx * Math.cos(t) + dy * Math.sin(t), bv = -dx * Math.sin(t) + dy * Math.cos(t);
        // The first piece claiming a pixel owns it (a tab lies in its partner's blank).
        const p = it.pieces.findIndex((q) => inPiece(bu - q.at.x, bv - q.at.y, q));
        if (p >= 0) owner[y * W + x] = p + 1;
      }
    }
    it.pieces.forEach((_, p) => {
      const m = createMask(W, H);
      for (let i = 0; i < W * H; i++) m.data[i] = owner[i] === p + 1 ? 1 : 0;
      // A thin line of table (and shadow) around a loose piece lying against others.
      if (it.apart) {
        const ring = dilate(m, it.apart);
        for (let i = 0; i < W * H; i++) if (ring.data[i] && !m.data[i]) photo.data.set([150 + noise(), 152 + noise(), 156 + noise(), 255], i * 4);
      }
      const inner = erode(m, 2);
      for (let i = 0; i < W * H; i++) {
        if (!m.data[i]) continue;
        const c = inner.data[i] ? it.colour ?? [205, 140, 62] : [70, 48, 30];
        photo.data.set([c[0] + noise(), c[1] + noise(), c[2] + noise(), 255], i * 4);
      }
    });
  });
  /** Photo positions of body points `uv` of piece p of item k. */
  const points = (k: number, p: number, uv: number[][]): Point[] => uv.map(([u, v]) => toPhoto(k, p, u, v));
  return { photo, points };
}

const filledMask = (w: number, h: number): Mask => ({ width: w, height: h, data: new Uint8Array(w * h).fill(1) });

describe('cuts follow seams', () => {
  it('keeps an assembled pair whole instead of cutting a piece at its waist', () => {
    // The upper piece has big knobs at top and bottom and deep blanks on both sides, low on them:
    // its waist between the blanks (0.32 bodies) is narrower than the side it shares with the lower
    // piece, its partner in an assembled pair, so the narrowest neck of the pair runs through its
    // even print, where no seam is (cut there before: a 0.6 and a 1.2 piece region).
    const waisted: Drawn = { sides: ['tab', 'blank', 'tab', 'blank'], along: [0.5, 0.65, 0.5, 0.65], knob: 0.24, offset: 0.1 };
    const lower: Drawn = { sides: ['blank', 'tab', 'flat', 'tab'] };
    const singles: Drawn[] = [waisted, lower, { sides: ['tab', 'flat', 'blank', 'tab'] }, { sides: ['blank', 'blank', 'tab', 'flat'] }, { sides: ['flat', 'tab', 'tab', 'blank'] }];
    const { photo, points } = drawnScene([
      { pieces: [{ ...waisted, at: { x: -0.5, y: -1 } }, { ...lower, at: { x: -0.5, y: 0 } }], centre: { x: 650, y: 500 }, deg: 40 },
      ...singles.map((d, j) => ({ pieces: [{ ...d, at: { x: -0.5, y: -0.5 } }], centre: { x: 150 + 270 * j, y: j % 2 ? 160 : 840 }, deg: 25 * j })),
    ], 120);
    const seg = segmentPieces(photo);
    debug('waist', photo, seg, []);
    // Each piece of the pair lies whole in one region; one region for both is an assembled patch.
    // (Points clear of the blanks: above and below the upper piece's waist, all over the lower one.)
    const up = new Set(points(0, 0, [[0.3, 0.25], [0.7, 0.25], [0.5, 0.55], [0.5, 0.9]]).map((p) => regionAt(seg, p)));
    const down = new Set(points(0, 1, [[0.25, 0.3], [0.75, 0.3], [0.25, 0.75], [0.75, 0.75]]).map((p) => regionAt(seg, p)));
    expect([...up], 'upper piece in one region').toHaveLength(1);
    expect([...down], 'lower piece in one region').toHaveLength(1);
    const [u] = up, [l] = down;
    expect(u).toBeDefined();
    if (u === l) expect(seg.regions.find((r) => r.region.id === u)!.region.kind).toBe('patch');
    singles.forEach((_, j) => {
      const ids = new Set(points(j + 1, 0, [[0.5, 0.5], [0.35, 0.3], [0.65, 0.3]]).map((p) => regionAt(seg, p)));
      expect([...ids], `single ${j}`).toHaveLength(1);
      expect([...ids][0], `single ${j}`).toBeDefined();
    });
  });

  it('separates a loose piece touching an assembled pair at the contact, not at a waist of the pair', () => {
    // A yellow loose piece, turned 8°, lies with its lower right against the top knob and corner of
    // an orange assembled pair, a thin line of table between them. The upper orange piece's narrow
    // top went with the loose piece at the opening, so the narrowest neck ran through the upper
    // piece's waist (cut there before: the loose piece with the top of the upper one).
    const upper: Drawn = { sides: ['tab', 'blank', 'tab', 'blank'] };
    const lower: Drawn = { sides: ['blank', 'tab', 'flat', 'tab'] };
    const loose: Drawn = { sides: ['flat', 'blank', 'tab', 'tab'] };
    const singles: Drawn[] = [upper, lower, { sides: ['tab', 'flat', 'blank', 'tab'] }, { sides: ['blank', 'blank', 'tab', 'flat'] }, { sides: ['flat', 'tab', 'tab', 'blank'] }];
    const { photo, points } = drawnScene([
      { pieces: [{ ...upper, at: { x: -0.5, y: -1 } }, { ...lower, at: { x: -0.5, y: 0 } }], centre: { x: 700, y: 560 }, deg: 0 },
      { pieces: [{ ...loose, at: { x: -0.5, y: -0.5 } }], centre: { x: 625, y: 385 }, deg: 8, colour: [200, 178, 70], apart: 2 },
      ...singles.map((d, j) => ({ pieces: [{ ...d, at: { x: -0.5, y: -0.5 } }], centre: { x: 150 + 270 * j, y: j % 2 ? 160 : 860 }, deg: 25 * j })),
    ], 120);
    const seg = segmentPieces(photo);
    debug('loose-pair', photo, seg, []);
    const kindOf = (id: number | undefined) => seg.regions.find((r) => r.region.id === id)?.region.kind;
    const one = (pts: Point[]) => {
      const ids = new Set(pts.map((p) => regionAt(seg, p)));
      expect([...ids]).toHaveLength(1);
      return [...ids][0];
    };
    const l = one(points(1, 0, [[0.3, 0.3], [0.6, 0.3], [0.5, 0.6], [0.3, 0.75]]));
    const u = one(points(0, 0, [[0.3, 0.25], [0.7, 0.25], [0.5, 0.55], [0.3, 0.85]]));
    const d = one(points(0, 1, [[0.25, 0.3], [0.75, 0.3], [0.25, 0.75], [0.75, 0.75]]));
    expect(kindOf(l)).toBe('piece');
    expect(u).not.toBe(l);
    if (u === d) expect(kindOf(u)).toBe('patch');
  });

  it('finds a seam along a cut on the dark line between two pieces, none on a cut through one piece', () => {
    // Two pieces of one colour side by side (x < 100 and x ≥ 100) meeting along a dark line; a cut
    // along the line and one across the left piece (x = 50).
    const w = 200, h = 120;
    const img = createRGBA(w, h, [205, 140, 62, 255]);
    for (let y = 0; y < h; y++) for (let x = 98; x < 102; x++) img.data.set([70, 48, 30, 255], (y * w + x) * 4);
    const cluster = { mask: filledMask(w, h), bbox: { x: 0, y: 0, width: w, height: h } };
    const labels = (at: number) => Int32Array.from({ length: w * h }, (_, i) => (i % w < at ? 1 : 2));
    const along = cutSupport(cluster, labels(100), filledMask(w, h), img, 100).get(PAIR_KEY + 2)!;
    const across = cutSupport(cluster, labels(50), filledMask(w, h), img, 100).get(PAIR_KEY + 2)!;
    expect(along.n).toBeGreaterThan(50);
    expect(along.seam / along.n).toBeGreaterThan(0.9);
    expect(across.n).toBeGreaterThan(50);
    expect(across.seam).toBe(0);
    // Table showing between the pieces before closing is a seam as well.
    const gap = filledMask(w, h);
    for (let y = 0; y < h; y++) gap.data[y * w + 50] = 0;
    const apart = cutSupport(cluster, labels(50), gap, img, 100).get(PAIR_KEY + 2)!;
    expect(apart.seam / apart.n).toBeGreaterThan(0.9);
  });
});

describe('loose pieces turned against each other', () => {
  // Two loose pieces of one colour lying end to end, the lower one (on top where they overlap)
  // turned against the upper one: the lower piece's top knob lies in the upper's bottom blank, the
  // two meet along the dark rims (a crease), and the contact is too wide for a neck.
  const upper: Drawn = { sides: ['tab', 'blank', 'blank', 'tab'] };
  const lower: Drawn = { sides: ['tab', 'tab', 'blank', 'blank'] };
  const singles: Drawn[] = [upper, lower, { sides: ['tab', 'flat', 'blank', 'tab'] }, { sides: ['blank', 'blank', 'tab', 'flat'] }, { sides: ['flat', 'tab', 'tab', 'blank'] }];
  const body = 120;
  /** Whether photo pixel (x, y) lies in drawn piece `d` centred at `c`, turned `deg`. */
  const inAt = (d: Drawn, c: Point, deg: number, x: number, y: number) => {
    const t = (deg * Math.PI) / 180, dx = (x - c.x) / body, dy = (y - c.y) / body;
    // (Knobs reach 0.81 body sizes from the centre at most.)
    return dx * dx + dy * dy <= 0.85 && inPiece(dx * Math.cos(t) + dy * Math.sin(t) + 0.5, -dx * Math.sin(t) + dy * Math.cos(t) + 0.5, d);
  };
  /**
   * Centre of the lower piece (turned `deg2`) slid along the down axis of the upper one (centred at
   * `c1`, turned `deg1`), `side` body sizes off its centre line, until the two overlap by `depth` px.
   */
  const contact = (c1: Point, deg1: number, deg2: number, side: number, depth: number): Point => {
    const t1 = (deg1 * Math.PI) / 180;
    const at = (s: number) => ({ x: c1.x - Math.sin(t1) * s + Math.cos(t1) * side * body, y: c1.y + Math.cos(t1) * s + Math.sin(t1) * side * body });
    const overlap = (c2: Point) => {
      let n = 0;
      for (let y = Math.round(c2.y - body); y < c2.y + body; y++) for (let x = Math.round(c2.x - body); x < c2.x + body; x++) if (inAt(lower, c2, deg2, x, y) && inAt(upper, c1, deg1, x, y)) n++;
      return n;
    };
    // Coarse steps until the pieces overlap that much, then back and in single pixels.
    let s = 2.2 * body;
    while (s > 0.3 * body && overlap(at(s)) < depth) s -= 8;
    for (s += 8; s > 0.3 * body; s--) if (overlap(at(s)) >= depth) return at(s);
    throw new Error('no contact');
  };
  const c1 = { x: 650, y: 380 };
  /** The two pieces end to end (upper at `base`°, lower at `base + turn`°) among single pieces; the regions holding points of each. */
  const endToEnd = (base: number, turn: number, side: number) => {
    const { photo, points } = drawnScene([
      { pieces: [{ ...upper, at: { x: -0.5, y: -0.5 } }], centre: c1, deg: base },
      { pieces: [{ ...lower, at: { x: -0.5, y: -0.5 } }], centre: contact(c1, base, base + turn, side, 800), deg: base + turn },
      ...singles.map((d, j) => ({ pieces: [{ ...d, at: { x: -0.5, y: -0.5 } }], centre: { x: 150 + 270 * j, y: j % 2 ? 160 : 860 }, deg: 25 * j })),
    ], body);
    const seg = segmentPieces(photo);
    debug(`turned-${base}-${turn}`, photo, seg, []);
    // (Points of the upper piece clear of the lower one lying over its bottom.)
    const up = new Set(points(0, 0, [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.25, 0.65], [0.75, 0.65]]).map((p) => regionAt(seg, p)));
    const down = new Set(points(1, 0, [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.8], [0.7, 0.8]]).map((p) => regionAt(seg, p)));
    return { up: [...up], down: [...down] };
  };

  for (const base of [0, 35]) {
    it(`measures the turn between two pieces end to end, and edges that keep to their own direction (upper at ${base}°)`, () => {
      const W2 = 500, H2 = 560, c = { x: 250, y: 170 };
      const measure = (turn: number) => {
        const c2 = contact(c, base, base + turn, 0.1, 800);
        const a = createMask(W2, H2), b = createMask(W2, H2), all = createMask(W2, H2);
        for (let y = 0; y < H2; y++) {
          for (let x = 0; x < W2; x++) {
            const i = y * W2 + x, inB = inAt(lower, c2, base + turn, x, y), inA = !inB && inAt(upper, c, base, x, y);
            a.data[i] = inA ? 1 : 0;
            b.data[i] = inB ? 1 : 0;
            all.data[i] = inA || inB ? 1 : 0;
          }
        }
        const part = (m: Mask) => ({ contour: traceOuterContour(m), area: m.data.reduce((s, v) => s + v, 0) });
        return outerTurn(part(a), part(b), { mask: all, bbox: { x: 0, y: 0, width: W2, height: H2 } }, 0.15 * body)!;
      };
      for (const turn of [8, 15, 30]) {
        const m = measure(turn);
        // (Measured in whole degrees on a pixel outline: within 2°; ≥ 7° at a turn of 8° for every
        // base angle in 5° steps.)
        expect(Math.abs(m.deg - turn), `turn ${turn}`).toBeLessThanOrEqual(2);
        expect(m.deg, `turn ${turn}`).toBeGreaterThanOrEqual(7);
        expect(m.cross, `turn ${turn}`).toBeLessThan(0.33);
      }
      // 5° apart: the two directions are not told apart.
      const m = measure(5);
      expect(m.deg < 7 || m.cross > 0.33, 'turn 5').toBe(true);
      // One angle (an assembled pair cut along its seam): no turn.
      expect(measure(0).deg, 'turn 0').toBeLessThanOrEqual(1);
    });
  }

  for (const [base, turn, side] of [[0, 8, 0.1], [30, 8, -0.2], [0, 15, 0.3], [30, 15, 0.1], [0, 30, -0.2]]) {
    it(`keeps two loose pieces turned ${turn}° against each other apart (upper at ${base}°)`, () => {
      // (8° and 15° gave the cluster outline no second orientation peak: those are counted 20° or
      // more from the dominant one.)
      const { up, down } = endToEnd(base, turn, side);
      expect(up, 'upper piece in one region').toHaveLength(1);
      expect(down, 'lower piece in one region').toHaveLength(1);
      expect(up[0]).toBeDefined();
      expect(down[0]).toBeDefined();
      expect(up[0]).not.toBe(down[0]);
    });
  }

  for (const base of [0, 30]) {
    it(`cuts neither of two pieces turned 5° against each other (upper at ${base}°)`, () => {
      // Below the turn told apart: together or apart, each piece lies whole in one region.
      const { up, down } = endToEnd(base, 5, 0.1);
      expect(up, 'upper piece in one region').toHaveLength(1);
      expect(down, 'lower piece in one region').toHaveLength(1);
    });
  }

  it('keeps assembled pairs, strips and blocks turned as a whole in one region', () => {
    // Groups of pieces of one colour on one grid (dark seams between them), each turned as a whole.
    const pair: (Drawn & { at: Point })[] = [{ sides: ['tab', 'blank', 'tab', 'blank'], at: { x: -0.5, y: -1 } }, { sides: ['blank', 'tab', 'flat', 'tab'], at: { x: -0.5, y: 0 } }];
    const strip: (Drawn & { at: Point })[] = [
      { sides: ['flat', 'tab', 'blank', 'tab'], at: { x: -1.5, y: -0.5 } },
      { sides: ['tab', 'blank', 'tab', 'blank'], at: { x: -0.5, y: -0.5 } },
      { sides: ['blank', 'flat', 'tab', 'tab'], at: { x: 0.5, y: -0.5 } },
    ];
    const blk: (Drawn & { at: Point })[] = [
      { sides: ['flat', 'tab', 'blank', 'flat'], at: { x: -1, y: -1 } },
      { sides: ['flat', 'flat', 'tab', 'blank'], at: { x: 0, y: -1 } },
      { sides: ['tab', 'blank', 'flat', 'flat'], at: { x: -1, y: 0 } },
      { sides: ['blank', 'flat', 'flat', 'tab'], at: { x: 0, y: 0 } },
    ];
    const groups = [{ pieces: pair, centre: { x: 330, y: 500 }, deg: 8 }, { pieces: strip, centre: { x: 750, y: 470 }, deg: 15 }, { pieces: blk, centre: { x: 1150, y: 520 }, deg: 30 }];
    const { photo, points } = drawnScene([
      ...groups,
      ...singles.map((d, j) => ({ pieces: [{ ...d, at: { x: -0.5, y: -0.5 } }], centre: { x: 150 + 270 * j, y: j % 2 ? 130 : 890 }, deg: 25 * j })),
    ], body);
    const seg = segmentPieces(photo);
    debug('turned-groups', photo, seg, []);
    groups.forEach((g, k) => {
      const ids = new Set(g.pieces.flatMap((_, p) => points(k, p, [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7]])).map((p) => regionAt(seg, p)));
      expect([...ids], `group ${k}`).toHaveLength(1);
      expect([...ids][0], `group ${k}`).toBeDefined();
    });
  });
});
