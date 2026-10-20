import { describe, expect, it } from 'vitest';
import { applyMat3, composeTransforms, mat3Invert, type Mat3, type Point } from '../../cv/geometry';
import { createMask, cropRGBA, type Mask, type RGBAImage } from '../../cv/image';
import { drawLine, drawPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import type { CloseupRegistration } from '../../model/types';
import { applyPhotometric, composeHighRes, fitPhotometric, registerCloseup, registerCloseupDetailed } from '.';
import { makeSyntheticCloseup, type SyntheticCloseupOptions } from './synthetic';
import { imageCorners, localScale, mapPolygon, resizeTransform } from './util';

const PAINTINGS = { 'starry-night': loadTestAsset('starry-night'), 'great-wave': loadTestAsset('great-wave') };
type PaintingName = keyof typeof PAINTINGS;

interface Scenario {
  painting: RGBAImage;
  reference: RGBAImage;
  closeup: RGBAImage;
  /** Painting pixels -> close-up pixels. */
  paintingToCloseup: Mat3;
  /** Ground truth close-up -> reference. */
  truth: Mat3;
}

function referenceOf(name: PaintingName, width: number): RGBAImage {
  const p = PAINTINGS[name];
  return resizeRGBA(p, width, Math.round((p.height * width) / p.width));
}

function scenario(name: PaintingName, reference: RGBAImage, o: SyntheticCloseupOptions): Scenario {
  const painting = PAINTINGS[name];
  const { image, sourceToCloseup } = makeSyntheticCloseup(painting, o);
  const toRef = resizeTransform(painting.width, painting.height, reference.width, reference.height);
  return { painting, reference, closeup: image, paintingToCloseup: sourceToCloseup, truth: composeTransforms(mat3Invert(sourceToCloseup), toRef) };
}

/** Reprojection error (reference px) of `H` vs. ground truth on close-up points that land inside the reference. */
function reprojectionError(s: Scenario, H: Mat3): { max: number; mean: number; n: number } {
  let max = 0, sum = 0, n = 0;
  const { width: W, height: Hh } = s.closeup;
  for (let y = 0; y <= Hh; y += Hh / 24) {
    for (let x = 0; x <= W; x += W / 32) {
      const a = applyMat3(s.truth, { x, y });
      if (a.x < 0 || a.y < 0 || a.x > s.reference.width - 1 || a.y > s.reference.height - 1) continue;
      const b = applyMat3(H, { x, y });
      const e = Math.hypot(a.x - b.x, a.y - b.y);
      max = Math.max(max, e);
      sum += e;
      n++;
    }
  }
  return { max, mean: sum / Math.max(1, n), n };
}

function saveRegistrationDebug(name: string, s: Scenario, reg: CloseupRegistration | null, pairs: { reference: Point }[] = []): void {
  if (!DEBUG_IMAGES) return;
  const vis = resizeRGBA(s.reference, s.reference.width * 2, s.reference.height * 2);
  const up = (p: Point) => ({ x: (p.x + 0.5) * 2 - 0.5, y: (p.y + 0.5) * 2 - 0.5 });
  drawPolygon(vis, mapPolygon(s.truth, imageCorners(s.closeup.width, s.closeup.height)).map(up), [0, 255, 0, 255], 3);
  if (reg) {
    drawPolygon(vis, mapPolygon(reg.toReference, imageCorners(s.closeup.width, s.closeup.height)).map(up), [255, 0, 0, 255], 1);
    for (const p of pairs) {
      const q = up(p.reference);
      drawLine(vis, { x: q.x - 2, y: q.y }, { x: q.x + 2, y: q.y }, [255, 255, 0, 255]);
      drawLine(vis, { x: q.x, y: q.y - 2 }, { x: q.x, y: q.y + 2 }, [255, 255, 0, 255]);
    }
  }
  savePng(`.debug/stitch/register-${name}.png`, vis);
  savePng(`.debug/stitch/register-${name}-closeup.png`, s.closeup);
}

const deg = Math.PI / 180;

describe('registerCloseup', () => {
  const cases: { name: string; painting: PaintingName; refWidth: number; o: SyntheticCloseupOptions }[] = [
    {
      name: 'rotated-20-perspective-warm',
      painting: 'starry-night',
      refWidth: 640,
      o: { center: { x: 700, y: 450 }, angle: 20 * deg, zoom: 1.2, width: 800, height: 600, perspective: [2e-4, -1e-4], gain: [1.2, 1.1, 0.9], offset: [10, 5, -5], vignette: 0.2, blur: 0.8, noise: 4, seed: 3 },
    },
    {
      name: 'upside-down-dark',
      painting: 'starry-night',
      refWidth: 400,
      o: { center: { x: 420, y: 620 }, angle: 188 * deg, zoom: 1.0, width: 800, height: 600, perspective: [-1e-4, 2e-4], gain: [0.75, 0.8, 0.85], blur: 1.0, noise: 5, seed: 4 },
    },
    {
      name: 'picture-edge-with-table',
      painting: 'great-wave',
      refWidth: 512,
      o: { center: { x: 130, y: 690 }, angle: -25 * deg, zoom: 1.1, width: 800, height: 600, perspective: [0, 1.5e-4], gain: [1.1, 1.05, 1], vignette: 0.3, blur: 0.8, noise: 4, seed: 5 },
    },
    {
      name: 'glare',
      painting: 'great-wave',
      refWidth: 512,
      o: { center: { x: 700, y: 450 }, angle: 12 * deg, zoom: 1.3, width: 800, height: 600, perspective: [1e-4, 1e-4], blur: 0.8, noise: 4, seed: 6, glare: { x: 450, y: 250, radius: 70, strength: 170 } },
    },
    {
      name: 'gain-6-1600px',
      painting: 'starry-night',
      refWidth: 400,
      o: { center: { x: 640, y: 480 }, angle: -10 * deg, zoom: 1.9, width: 1600, height: 1200, perspective: [5e-5, -5e-5], gain: [1.1, 1.1, 1.1], vignette: 0.2, blur: 1.5, noise: 4, seed: 7 },
    },
  ];

  for (const c of cases) {
    it(`registers a synthetic close-up: ${c.name}`, () => {
      const s = scenario(c.painting, referenceOf(c.painting, c.refWidth), c.o);
      const { registration: reg, diagnostics } = registerCloseupDetailed(s.reference, s.closeup);
      saveRegistrationDebug(c.name, s, reg, diagnostics.pairs);
      expect(reg, diagnostics.failure).not.toBeNull();
      const r = reg!;
      const err = reprojectionError(s, r.toReference);
      console.log(`${c.name}: max ${err.max.toFixed(3)} / mean ${err.mean.toFixed(3)} ref px, ${r.inliers} inliers, gain ${r.scaleGain.toFixed(2)}, confidence ${r.confidence.toFixed(2)}`);
      expect(err.n).toBeGreaterThan(100);
      expect(err.max).toBeLessThan(1.5);
      expect(err.mean).toBeLessThan(0.5);
      expect(r.inliers).toBeGreaterThanOrEqual(40);
      expect(r.confidence).toBeGreaterThan(0.5);
      // Resolution gain and coverage agree with the ground truth.
      const center = { x: r.coverage.x + r.coverage.width / 2 - 0.5, y: r.coverage.y + r.coverage.height / 2 - 0.5 };
      const trueGain = localScale(mat3Invert(s.truth), center);
      expect(Math.abs(r.scaleGain / trueGain - 1)).toBeLessThan(0.05);
      const truthOutline = mapPolygon(s.truth, imageCorners(s.closeup.width, s.closeup.height));
      const tx0 = Math.max(0, Math.min(...truthOutline.map((p) => p.x)) + 0.5);
      const tx1 = Math.min(s.reference.width, Math.max(...truthOutline.map((p) => p.x)) + 0.5);
      expect(Math.abs(r.coverage.x - tx0)).toBeLessThanOrEqual(2);
      expect(Math.abs(r.coverage.x + r.coverage.width - tx1)).toBeLessThanOrEqual(2);
    });
  }

  it('rejects a close-up of a different picture and random noise', () => {
    const reference = referenceOf('starry-night', 640);
    const other = makeSyntheticCloseup(PAINTINGS['great-wave'], { center: { x: 600, y: 400 }, angle: 0.2, zoom: 1.2, width: 800, height: 600, blur: 0.8, noise: 4 });
    const a = registerCloseupDetailed(reference, other.image);
    expect(a.registration, `unexpected match with ${a.diagnostics.inliers} inliers`).toBeNull();
    const noise = makeSyntheticCloseup(PAINTINGS['starry-night'], { center: { x: -5000, y: -5000 }, angle: 0, zoom: 1, width: 640, height: 480, noise: 40 });
    expect(registerCloseup(reference, noise.image)).toBeNull();
    // A close-up of the same picture still registers against the same reference afterwards.
    const same = scenario('starry-night', reference, { center: { x: 500, y: 500 }, angle: 0.3, zoom: 1.1, width: 800, height: 600, blur: 0.8, noise: 4 });
    expect(registerCloseup(reference, same.closeup)).not.toBeNull();
  });

  it('registers a 1600-px close-up against a 2000-px reference (time logged, not asserted)', () => {
    const reference = resizeRGBA(PAINTINGS['starry-night'], 2000, 1584);
    const s = scenario('starry-night', reference, { center: { x: 760, y: 420 }, angle: 15 * deg, zoom: 3.2, width: 1600, height: 1200, perspective: [5e-5, -3e-5], gain: [1.1, 1, 0.9], blur: 1, noise: 4, seed: 9 });
    const t0 = performance.now();
    const { registration: reg, diagnostics } = registerCloseupDetailed(s.reference, s.closeup);
    const ms = performance.now() - t0;
    console.log(`registerCloseup 1600px vs 2000px: ${ms.toFixed(0)} ms`, Object.fromEntries(Object.entries(diagnostics.timings).map(([k, v]) => [k, Math.round(v)])));
    expect(reg).not.toBeNull();
    expect(reprojectionError(s, reg!.toReference).max).toBeLessThan(1.5);
  });
});

/** Mask of output pixels (= painting pixels here) whose close-up position is inside the close-up by >= margin. */
function closeupMask(s: Scenario, width: number, height: number, margin: number): Mask {
  const m = createMask(width, height);
  const G = s.paintingToCloseup;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyMat3(G, { x, y });
      if (p.x >= margin - 0.5 && p.y >= margin - 0.5 && p.x <= s.closeup.width - 0.5 - margin && p.y <= s.closeup.height - 0.5 - margin) m.data[y * width + x] = 1;
    }
  }
  return m;
}

function psnr(a: RGBAImage, b: RGBAImage, mask: (i: number) => boolean): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (!mask(i)) continue;
    for (let c = 0; c < 3; c++) {
      const d = a.data[i * 4 + c] - b.data[i * 4 + c];
      se += d * d;
    }
    n += 3;
  }
  return 10 * Math.log10((255 * 255) / Math.max(1e-9, se / n));
}

describe('composeHighRes', () => {
  const painting = PAINTINGS['starry-night'];
  const reference = referenceOf('starry-night', 640); // 640 x 507: x2 gives exactly the painting size
  const s1 = scenario('starry-night', reference, { center: { x: 430, y: 380 }, angle: 15 * deg, zoom: 1.5, width: 960, height: 720, perspective: [2e-4, -1e-4], gain: [1.2, 1.1, 0.9], offset: [8, 4, -4], vignette: 0.25, blur: 0.8, noise: 3, seed: 21 });
  const s2 = scenario('starry-night', reference, { center: { x: 820, y: 560 }, angle: 190 * deg, zoom: 1.4, width: 960, height: 720, perspective: [-1e-4, 1e-4], gain: [0.8, 0.85, 0.9], offset: [0, 0, 8], vignette: 0.15, blur: 0.8, noise: 3, seed: 22 });

  it('adds detail where close-ups cover the picture and leaves the rest untouched', () => {
    const r1 = registerCloseup(reference, s1.closeup)!;
    const r2 = registerCloseup(reference, s2.closeup)!;
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    const t0 = performance.now();
    const out = composeHighRes(reference, [{ image: s1.closeup, registration: r1 }, { image: s2.closeup, registration: r2 }], { scale: 2 });
    console.log(`composeHighRes ${out.width}x${out.height}: ${(performance.now() - t0).toFixed(0)} ms`);
    expect([out.width, out.height]).toEqual([painting.width, painting.height]);
    const base = resizeRGBA(reference, out.width, out.height);

    const core1 = closeupMask(s1, out.width, out.height, 0.15 * 720);
    const core2 = closeupMask(s2, out.width, out.height, 0.15 * 720);
    const any1 = closeupMask(s1, out.width, out.height, -3);
    const any2 = closeupMask(s2, out.width, out.height, -3);
    const inCore = (i: number) => core1.data[i] === 1 || core2.data[i] === 1;
    const inAny = (i: number) => any1.data[i] === 1 || any2.data[i] === 1;
    const psnrOut = psnr(out, painting, inCore), psnrBase = psnr(base, painting, inCore);
    const psnrOutAll = psnr(out, painting, inAny), psnrBaseAll = psnr(base, painting, inAny);
    console.log(`PSNR core: composite ${psnrOut.toFixed(2)} dB vs upscaled ${psnrBase.toFixed(2)} dB; covered area incl. seams: ${psnrOutAll.toFixed(2)} vs ${psnrBaseAll.toFixed(2)}`);
    // The synthetic close-ups are themselves blurred/noisy renderings, so the gain is bounded.
    expect(psnrOut).toBeGreaterThan(psnrBase + 1.5);
    expect(psnrOutAll).toBeGreaterThan(psnrBaseAll + 1);

    // Outside every close-up the result is the plain upscaled reference.
    let maxDiff = 0, outside = 0;
    for (let i = 0; i < out.width * out.height; i++) {
      if (inAny(i)) continue;
      outside++;
      for (let c = 0; c < 4; c++) maxDiff = Math.max(maxDiff, Math.abs(out.data[i * 4 + c] - base.data[i * 4 + c]));
    }
    expect(outside).toBeGreaterThan(0.2 * out.width * out.height);
    expect(maxDiff).toBeLessThanOrEqual(1);

    // Seams: in a band along each close-up border the composite must not be worse than the base.
    const band1 = (i: number) => any1.data[i] === 1 && core1.data[i] === 0 && any2.data[i] === 0;
    expect(psnr(out, painting, band1)).toBeGreaterThan(psnr(base, painting, band1));

    if (DEBUG_IMAGES) {
      savePng('.debug/stitch/compose-out.png', out);
      savePng('.debug/stitch/compose-base.png', base);
      const crop = { x: 200, y: 150, width: 700, height: 560 };
      savePng('.debug/stitch/compose-out-crop.png', cropRGBA(out, crop));
      savePng('.debug/stitch/compose-base-crop.png', cropRGBA(base, crop));
      savePng('.debug/stitch/compose-truth-crop.png', cropRGBA(painting, crop));
    }
  });

  it('does not paste glare into the reference', () => {
    const s = scenario('starry-night', reference, { center: { x: 600, y: 330 }, angle: -8 * deg, zoom: 1.0, width: 640, height: 480, blur: 0.6, noise: 3, seed: 23, glare: { x: 300, y: 220, radius: 50, strength: 180 } });
    const reg = registerCloseup(reference, s.closeup);
    expect(reg).not.toBeNull();
    const out = composeHighRes(reference, [{ image: s.closeup, registration: reg! }], { scale: 2 });
    const base = resizeRGBA(reference, out.width, out.height);
    // Painting pixels around the glare spot (close-up (300, 220), radius ~2.5 sigma).
    const Ginv = mat3Invert(s.paintingToCloseup);
    const c = applyMat3(Ginv, { x: 300, y: 220 });
    const inGlare = (i: number) => Math.hypot((i % out.width) - c.x, Math.floor(i / out.width) - c.y) < 120;
    const mae = (img: RGBAImage) => {
      let e = 0, n = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        if (!inGlare(i)) continue;
        for (let k = 0; k < 3; k++) e += Math.abs(img.data[i * 4 + k] - painting.data[i * 4 + k]);
        n += 3;
      }
      return e / n;
    };
    const naive = composeHighRes(reference, [{ image: s.closeup, registration: reg! }], { scale: 2, photometric: false });
    console.log(`glare MAE: composite ${mae(out).toFixed(1)}, upscaled ${mae(base).toFixed(1)}, without photometric/consistency ${mae(naive).toFixed(1)}`);
    expect(mae(out)).toBeLessThan(mae(base) + 2);
    expect(mae(naive)).toBeGreaterThan(mae(base) + 10);
    if (DEBUG_IMAGES) {
      const crop = { x: Math.round(c.x) - 200, y: Math.round(c.y) - 150, width: 400, height: 300 };
      savePng('.debug/stitch/glare-out.png', cropRGBA(out, crop));
      savePng('.debug/stitch/glare-naive.png', cropRGBA(naive, crop));
    }
  });

  it('caps the output size and equals the upscaled reference without close-ups', () => {
    const out = composeHighRes(reference, [], { scale: 10, maxSide: 1000 });
    expect([out.width, out.height]).toEqual([1000, 792]);
    const base = resizeRGBA(reference, 1000, 792);
    let maxDiff = 0;
    for (let i = 0; i < out.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out.data[i] - base.data[i]));
    expect(maxDiff).toBeLessThanOrEqual(1);
    const down = composeHighRes(reference, [], { scale: 0.5 });
    expect([down.width, down.height]).toEqual([320, 254]);
  });
});

describe('fitPhotometric', () => {
  it('recovers exposure and white-balance changes', () => {
    const reference = referenceOf('great-wave', 512);
    const gain: [number, number, number] = [1.25, 1.0, 0.8];
    const offset: [number, number, number] = [-10, 5, 20];
    const s = scenario('great-wave', reference, { center: { x: 640, y: 430 }, angle: 0.3, zoom: 1.2, width: 640, height: 480, gain, offset, blur: 0.5, noise: 2 });
    const model = fitPhotometric(reference, s.closeup, s.truth);
    for (let ch = 0; ch < 3; ch++) {
      for (const v of [40, 120, 200]) {
        const observed = gain[ch] * v + offset[ch];
        if (observed > 250) continue;
        for (const [u, w] of [[0, 0], [-0.8, 0.5], [0.7, -0.6]]) expect(Math.abs(applyPhotometric(model, ch, observed, u, w) - v)).toBeLessThan(4);
      }
    }
  });
});
