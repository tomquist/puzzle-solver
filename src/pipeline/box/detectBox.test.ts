import { describe, expect, it } from 'vitest';
import { polygonSignedArea, type Point, type Quad } from '../../cv/geometry';
import { createRGBA, type RGBAImage } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';
import { rectifyQuad } from '../../cv/warp';
import { DEBUG_IMAGES } from '../../testing/nodeImageIO';
import { Rng } from '../../testing/synth';
import { detectBox, detectBoxDebug } from './detectBox';
import { cornerErrorPct, renderScene, saveOverlay, type SceneSpec } from './testkit';

function meanAbsDiff(a: RGBAImage, b: RGBAImage, inset = 4): number {
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

/** The part of `q` inside the photo, as a quad (valid when the photo border cuts off whole sides). */
function clipToPhoto(q: Quad, w: number, h: number): Point[] {
  let poly: Point[] = [...q];
  const planes: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [(p) => p.x >= -0.5, (a, b) => ({ x: -0.5, y: a.y + ((b.y - a.y) * (-0.5 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= w - 0.5, (a, b) => ({ x: w - 0.5, y: a.y + ((b.y - a.y) * (w - 0.5 - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= -0.5, (a, b) => ({ x: a.x + ((b.x - a.x) * (-0.5 - a.y)) / (b.y - a.y), y: -0.5 })],
    [(p) => p.y <= h - 0.5, (a, b) => ({ x: a.x + ((b.x - a.x) * (h - 0.5 - a.y)) / (b.y - a.y), y: h - 0.5 })],
  ];
  for (const [inside, cut] of planes) {
    const out: Point[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    poly = out;
  }
  return poly;
}

const frameScene: SceneSpec = { name: 'unit-frame', painting: 'starry-night', opts: { seed: 41, width: 1200, height: 900, frameWidth: 0.06 } };
const plainScene: SceneSpec = { name: 'unit-noframe', painting: 'great-wave', opts: { seed: 42, width: 1200, height: 900, frameWidth: 0, background: 'plain' } };

describe('detectBox', () => {
  it('returns an ordered quad, labelled candidates (picture before lid) and a high confidence', () => {
    const sc = renderScene(frameScene);
    const det = detectBox(sc.photo);
    if (DEBUG_IMAGES) saveOverlay('.debug/box/unit-frame.png', sc, det);
    expect(cornerErrorPct(det.quad, sc.pictureQuad)).toBeLessThan(1);
    // TL, TR, BR, BL: clockwise on screen, TL has the smallest x + y.
    expect(polygonSignedArea(det.quad)).toBeGreaterThan(0);
    for (let i = 1; i < 4; i++) expect(det.quad[0].x + det.quad[0].y).toBeLessThan(det.quad[i].x + det.quad[i].y);
    expect(det.confidence).toBeGreaterThan(0.8);
    expect(det.candidates[0]).toMatchObject({ label: 'picture', quad: det.quad });
    const labels = det.candidates.map((c) => c.label);
    expect(labels).toContain('lid');
    expect(labels[labels.length - 1]).toBe('whole-photo');
    const lid = det.candidates.find((c) => c.label === 'lid')!;
    expect(cornerErrorPct(lid.quad, sc.lidQuad)).toBeLessThan(1);
    for (let i = 1; i < det.candidates.length; i++) expect(det.candidates[i].score).toBeLessThanOrEqual(det.candidates[i - 1].score);
    for (const c of det.candidates) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
    expect(det.quality.issues.map((i) => i.code)).not.toContain('box_not_found');
  });

  it('rectifies to the same image as the ground-truth quad (round trip)', () => {
    for (const spec of [frameScene, plainScene]) {
      const sc = renderScene(spec);
      const det = detectBox(sc.photo);
      const { width: W, height: H } = sc.reference;
      const fromDetected = rectifyQuad(sc.photo, det.quad, W, H);
      const fromTruth = rectifyQuad(sc.photo, sc.pictureQuad, W, H);
      const shifted = rectifyQuad(sc.photo, sc.pictureQuad.map((p) => ({ x: p.x + 2, y: p.y + 2 })) as Quad, W, H);
      const d = meanAbsDiff(fromDetected, fromTruth);
      const dShift = meanAbsDiff(shifted, fromTruth);
      console.log(`${spec.name}: rectified mean abs diff ${d.toFixed(2)} (a 2 px shift gives ${dShift.toFixed(2)})`);
      expect(d).toBeLessThan(3);
      expect(d).toBeLessThan(0.25 * dShift);
    }
  });

  it('puts sides on the photo border when the picture is cut off', () => {
    const cases: SceneSpec[] = [
      { name: 'cut-left', painting: 'starry-night', opts: { seed: 31, width: 1200, height: 900, frameWidth: 0 }, degrade: { cropAroundPicture: [-0.12, 0.05, 0.05, 0.05] } },
      { name: 'cut-bottom', painting: 'great-wave', opts: { seed: 31, width: 1200, height: 900, frameWidth: 0.06 }, degrade: { cropAroundPicture: [0.05, 0.05, 0.05, -0.15] } },
    ];
    for (const spec of cases) {
      const sc = renderScene(spec);
      const visible = clipToPhoto(sc.pictureQuad, sc.photo.width, sc.photo.height);
      expect(visible.length).toBe(4);
      const det = detectBox(sc.photo);
      if (DEBUG_IMAGES) saveOverlay(`.debug/box/unit-${spec.name}.png`, sc, det);
      // Compare corner sets (order-independent: the clipped polygon starts anywhere).
      const diag = Math.hypot(sc.photo.width, sc.photo.height);
      for (const v of visible) {
        const d = Math.min(...det.quad.map((q) => Math.hypot(q.x - v.x, q.y - v.y)));
        expect(d / diag, spec.name).toBeLessThan(0.015);
      }
      expect(det.confidence).toBeGreaterThan(0.3);
      expect(det.confidence).toBeLessThan(0.85);
    }
  });

  it('falls back to the whole photo when the picture fills it or nothing is found', () => {
    const inside = renderScene({ name: 'inside', painting: 'starry-night', opts: { seed: 31, width: 1200, height: 900, frameWidth: 0 }, degrade: { cropAroundPicture: [-0.2, -0.2, -0.2, -0.2] } });
    const a = detectBox(inside.photo);
    expect(a.candidates[0].label).toBe('whole-photo');
    expect(cornerErrorPct(a.quad, [{ x: -0.5, y: -0.5 }, { x: inside.photo.width - 0.5, y: -0.5 }, { x: inside.photo.width - 0.5, y: inside.photo.height - 0.5 }, { x: -0.5, y: inside.photo.height - 0.5 }])).toBeLessThan(0.5);
    expect(a.confidence).toBeLessThan(0.45);
    expect(a.quality.issues.map((i) => i.code)).toContain('box_not_found');

    const flat = createRGBA(1000, 750, [128, 128, 128, 255]);
    const b = detectBox(flat);
    expect(b.candidates[0].label).toBe('whole-photo');
    expect(b.confidence).toBeLessThan(0.2);
    expect(b.quality.issues.map((i) => i.code)).toContain('box_not_found');

    // Pure texture: every line has "edges", none of them is a boundary.
    const noise = createRGBA(400, 300);
    const rng = new Rng(9);
    for (let i = 0; i < noise.data.length; i += 4) {
      noise.data[i] = rng.int(256);
      noise.data[i + 1] = rng.int(256);
      noise.data[i + 2] = rng.int(256);
      noise.data[i + 3] = 255;
    }
    const c = detectBox(noise);
    expect(c.confidence).toBeLessThan(0.45);
    expect(c.quality.issues.map((i) => i.code)).toContain('box_not_found');
  });

  it('never throws on degenerate photos', () => {
    for (const [w, h] of [[1, 1], [2, 2], [5, 3], [30, 20], [100, 1], [1, 100], [3000, 40]]) {
      const img = createRGBA(w, h, [120, 80, 60, 255]);
      const d = detectBox(img);
      expect(d.candidates.length).toBeGreaterThan(0);
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.quad.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    }
  });

  it('handles a 4000×3000 photo in well under a second', () => {
    const sc = renderScene({ name: 'big', painting: 'starry-night', opts: { seed: 42, width: 1600, height: 1200, frameWidth: 0.05 } });
    const big = resizeRGBA(sc.photo, 4000, 3000);
    const truth = sc.pictureQuad.map((q) => ({ x: (q.x + 0.5) * 2.5 - 0.5, y: (q.y + 0.5) * 2.5 - 0.5 })) as Quad;
    detectBox(big); // warm-up (JIT)
    let best = Infinity;
    let timings: Record<string, number> = {};
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const { result, debug } = detectBoxDebug(big);
      const ms = performance.now() - t;
      if (ms < best) { best = ms; timings = debug.timings; }
      expect(cornerErrorPct(result.quad, truth)).toBeLessThan(0.5);
    }
    console.log(`detectBox 4000×3000: ${best.toFixed(0)} ms`, Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
    expect(best).toBeLessThan(600);
  }, 60_000);
});
