import { describe, expect, it } from 'vitest';
import { createMask, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import type { QualityCode, QualityReport } from '../../model/types';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, type RGB, type RenderOptions } from '../../testing/synth';
import { assessFrame, assessPhoto } from './quality';
import { segmentPieces } from './segment';
import { addGlare, blurPhoto, cropPhoto, drawOverlay, exposePhoto, makeTouching, motionBlurPhoto, perspectivePhoto } from './testkit';

const REFS = {
  sn: resizeRGBA(loadTestAsset('starry-night'), 800, 634),
  gw: resizeRGBA(loadTestAsset('great-wave'), 800, 538),
};
type Ref = keyof typeof REFS;
const DARK: RGB = [38, 42, 50], LIGHT: RGB = [228, 226, 220], GREY: RGB = [128, 128, 128];
const GREEN: RGB = [40, 120, 70], WOOD: RGB = [150, 105, 70];

function scene(ref: Ref, background: RGB, opts: RenderOptions = {}, n = 16, seed = 3) {
  const img = REFS[ref];
  const cut = generateJigsaw(8, 10, img.width, img.height, 7 + seed);
  const items = Array.from({ length: n }, (_, i) => (i * 5 + seed) % 80);
  return renderPiecesPhoto(img, cut, items, { seed, background, noiseSigma: 2.5, illumination: 0.1, scale: 1.4, ...opts });
}

function report(photo: RGBAImage, label: string): QualityReport {
  const seg = segmentPieces(photo);
  if (DEBUG_IMAGES) savePng(`.debug/pieces/quality-${label}.png`, drawOverlay(photo, seg));
  return seg.quality;
}

const codes = (q: QualityReport) => q.issues.map((i) => i.code);
const serious = (q: QualityReport) => q.issues.filter((i) => i.severity !== 'info').map((i) => `${i.code}:${i.severity}`);

describe('assessPhoto on clean photos', () => {
  const cases: [Ref, RGB, string][] = [
    ['sn', GREY, 'sn-grey'], ['sn', LIGHT, 'sn-light'], ['sn', DARK, 'sn-dark'], ['sn', WOOD, 'sn-wood'],
    ['gw', DARK, 'gw-dark'], ['gw', GREEN, 'gw-green'], ['gw', GREY, 'gw-grey'],
  ];
  for (const [ref, bg, label] of cases) {
    it(`raises no warnings or errors (${label})`, () => {
      const q = report(scene(ref, bg, label === 'sn-wood' ? { backgroundTexture: 22 } : {}).photo, `clean-${label}`);
      expect(serious(q)).toEqual([]);
      expect(q.score).toBeGreaterThan(0.85);
      expect(q.metrics.pieces).toBe(16);
    });
  }
});

describe('assessPhoto on degraded photos', () => {
  const base = { sn: scene('sn', GREY), gw: scene('gw', DARK) };
  const expectIssue = (q: QualityReport, code: QualityCode) => {
    const is = q.issues.find((i) => i.code === code);
    expect(is, `${code} in ${JSON.stringify(codes(q))}`).toBeDefined();
    expect(is!.severity).not.toBe('info');
    expect(is!.message.length).toBeGreaterThan(5);
    expect(is!.hint?.length ?? 0).toBeGreaterThan(5);
  };

  for (const ref of ['sn', 'gw'] as const) {
    it(`blurry (${ref})`, () => {
      const q = report(blurPhoto(base[ref].photo, 2.5), `blur-${ref}`);
      expectIssue(q, 'blurry');
      expect(codes(q)).not.toContain('motion_blur');
    });

    it(`motion blur (${ref})`, () => {
      const q = report(motionBlurPhoto(base[ref].photo, 9, ref === 'sn' ? 30 : 110), `motion-${ref}`);
      expectIssue(q, 'motion_blur');
    });

    it(`too dark (${ref})`, () => {
      const q = report(exposePhoto(base[ref].photo, 0.3), `dark-${ref}`);
      expectIssue(q, 'too_dark');
      expect(codes(q)).not.toContain('too_bright');
    });

    it(`too bright (${ref})`, () => {
      const q = report(exposePhoto(base[ref].photo, 1.8), `bright-${ref}`);
      expectIssue(q, 'too_bright');
      expect(codes(q)).not.toContain('too_dark');
    });

    it(`glare on pieces (${ref})`, () => {
      const glared = base[ref].truth.slice(0, 3);
      const q = report(addGlare(base[ref].photo, glared, 0.22, 7), `glare-${ref}`);
      expectIssue(q, 'glare');
      expect(q.issues.find((i) => i.code === 'glare')!.regionIds!.length).toBeGreaterThanOrEqual(2);
    });

    it(`cut-off pieces (${ref})`, () => {
      const { photo, truth } = base[ref];
      const x = Math.round(truth[0].center.x);
      const q = report(cropPhoto(photo, { x, y: 0, width: photo.width - x, height: photo.height }), `cut-${ref}`);
      expectIssue(q, 'cut_off');
    });

    it(`tiny pieces (${ref})`, () => {
      const q = report(scene(ref, ref === 'sn' ? GREY : DARK, { scale: 0.45 }, 24).photo, `tiny-${ref}`);
      expectIssue(q, 'low_resolution');
    });

    it(`strong lighting gradient (${ref})`, () => {
      const q = report(scene(ref, ref === 'sn' ? GREY : DARK, { illumination: 0.5 }).photo, `uneven-${ref}`);
      expectIssue(q, 'uneven_lighting');
    });

    it(`perspective (${ref})`, () => {
      const tilted = perspectivePhoto(scene(ref, ref === 'sn' ? GREY : DARK, { scale: 1.0 }, 30).photo, 0.7).photo;
      const q = report(tilted, `persp-${ref}`);
      expectIssue(q, 'perspective');
    });
  }

  it('touching pieces', () => {
    const { photo, truth } = scene('sn', GREY, {}, 8, 1);
    // Push piece 1 against its nearest neighbour.
    let best = 0, bestD = Infinity;
    truth.forEach((t, i) => {
      if (i === 1) return;
      const d = Math.hypot(t.center.x - truth[1].center.x, t.center.y - truth[1].center.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    const q = report(makeTouching(photo, truth[best], truth[1]), 'touching');
    expectIssue(q, 'touching_pieces');
  });

  it('low contrast background', () => {
    // Great Wave pieces (mostly cream paper) on a cream table.
    const q = report(scene('gw', [225, 220, 195]).photo, 'lowcontrast');
    expectIssue(q, 'low_contrast');
  });

  it('uncertain shapes and fragments are reported as info', () => {
    const { photo } = scene('sn', GREY);
    const img = { ...photo, data: new Uint8ClampedArray(photo.data) };
    // A round coaster-like object of piece size and a crumb.
    const m = createMask(img.width, img.height);
    const cx = 60, cy = img.height - 70, r = 52;
    fillPolygon(m, Array.from({ length: 64 }, (_, i) => ({ x: cx + r * Math.cos((i / 64) * 2 * Math.PI), y: cy + 0.9 * r * Math.sin((i / 64) * 2 * Math.PI) })), 1);
    // Crumb of ≈ 450 px (above the speck limit, far below a piece).
    fillPolygon(m, [{ x: img.width - 50, y: 20 }, { x: img.width - 22, y: 24 }, { x: img.width - 26, y: 44 }, { x: img.width - 48, y: 40 }], 1);
    for (let i = 0; i < m.data.length; i++) if (m.data[i]) img.data.set([200, 60, 50], i * 4);
    const q = report(img, 'odd');
    const su = q.issues.find((i) => i.code === 'shape_uncertain');
    const fr = q.issues.find((i) => i.code === 'fragment');
    expect(su?.severity).toBe('info');
    expect(fr?.severity).toBe('info');
    expect(serious(q)).toEqual([]);
  });

  it('aggregates region issues into one issue per code and does not modify the segmentation', () => {
    const { photo, truth } = base.sn;
    const img = addGlare(cropPhoto(photo, { x: Math.round(truth[0].center.x), y: 0, width: photo.width - Math.round(truth[0].center.x), height: photo.height }), truth.slice(2, 5).map((t) => ({ ...t, center: { x: t.center.x - Math.round(truth[0].center.x), y: t.center.y } })), 0.22, 2);
    const seg = segmentPieces(img);
    const before = JSON.stringify(seg.regions.map((r) => r.region));
    const q1 = assessPhoto(img, seg);
    const q2 = assessPhoto(img, seg);
    expect(JSON.stringify(seg.regions.map((r) => r.region))).toBe(before);
    expect(q2).toEqual(q1);
    const cs = codes(q1);
    expect(new Set(cs).size).toBe(cs.length);
    for (const is of q1.issues) {
      if (is.regionIds) expect([...is.regionIds].sort((a, b) => a - b)).toEqual(is.regionIds);
    }
    expect(q1.score).toBeLessThan(0.85);
  });
});

describe('assessFrame', () => {
  const { photo } = scene('sn', GREY);
  const frame = resizeRGBA(photo, 320, Math.round((320 * photo.height) / photo.width));

  it('accepts a clean frame and runs in well under 15 ms', () => {
    for (let i = 0; i < 5; i++) assessFrame(frame);
    const t0 = performance.now();
    const N = 40;
    let q = assessFrame(frame);
    for (let i = 1; i < N; i++) q = assessFrame(frame);
    const ms = (performance.now() - t0) / N;
    console.log(`assessFrame ${frame.width}×${frame.height}: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(15);
    expect(q.ok).toBe(true);
    expect(q.message).toBeUndefined();
    expect(q.sharpness).toBeGreaterThan(0.8);
    expect(q.brightness).toBeGreaterThan(0.3);
    expect(q.brightness).toBeLessThan(0.7);
    expect(q.clipped).toBeLessThan(0.02);
  });

  it('reports blur, darkness and overexposure', () => {
    const blurred = assessFrame(blurPhoto(frame, 2));
    expect(blurred.ok).toBe(false);
    expect(blurred.sharpness).toBeLessThan(0.45);
    expect(blurred.message).toMatch(/blurry/i);
    const dark = assessFrame(exposePhoto(frame, 0.2));
    expect(dark.ok).toBe(false);
    expect(dark.message).toMatch(/dark/i);
    const bright = assessFrame(exposePhoto(frame, 2.2));
    expect(bright.ok).toBe(false);
    expect(bright.message).toMatch(/bright/i);
    expect(bright.clipped).toBeGreaterThan(0.3);
    // Sharpness decreases monotonically with blur.
    const s = [0, 0.7, 1.2, 2].map((b) => assessFrame(b ? blurPhoto(frame, b) : frame).sharpness);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThanOrEqual(s[i - 1] + 1e-9);
  });
});
