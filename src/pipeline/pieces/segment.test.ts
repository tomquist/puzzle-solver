import { describe, expect, it } from 'vitest';
import { polygonSignedArea } from '../../cv/geometry';
import { createGray, createMask, createRGBA, maskArea, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { generateJigsaw, renderPiecesPhoto, Rng, type RGB, type RenderOptions } from '../../testing/synth';
import { dropFarWeak, segmentPieces, watershed } from './segment';
import type { SegmentDiagnostics } from './types';
import { cropPhoto, drawOverlay, evaluateScene, makeTouching, maskIoU, type SceneEval } from './testkit';

const PAINTINGS = {
  'starry-night': resizeRGBA(loadTestAsset('starry-night'), 800, 634),
  'great-wave': resizeRGBA(loadTestAsset('great-wave'), 800, 538),
} as const;
type Painting = keyof typeof PAINTINGS;

/** Background scenarios; 'close' is close to the painting's dominant colour. */
const BACKGROUNDS: Record<string, { background: (p: Painting) => RGB; texture?: number }> = {
  dark: { background: () => [38, 42, 50] },
  light: { background: () => [228, 226, 220] },
  grey: { background: () => [128, 128, 128] },
  green: { background: () => [40, 120, 70] },
  wood: { background: () => [150, 105, 70], texture: 22 },
  close: { background: (p) => (p === 'starry-night' ? [60, 85, 125] : [226, 222, 196]) },
};

function scene(painting: Painting, bg: string, seed: number, extra: RenderOptions = {}) {
  const ref = PAINTINGS[painting];
  const cut = generateJigsaw(8, 10, ref.width, ref.height, seed * 7);
  const items: (number | number[])[] = [];
  const used = new Set<number>([41, 42, 55, 56, 65, 66]);
  for (let i = 0; items.length < 14; i++) {
    const idx = (i * 11 + seed * 3) % 80;
    if (!used.has(idx)) { used.add(idx); items.push(idx); }
  }
  items.push([41, 42], [55, 56, 65, 66]);
  const b = BACKGROUNDS[bg];
  // Seed 1: small pieces (body ≈ 70 px); seed 2: larger pieces (body ≈ 110 px).
  const scale: [number, number] = seed % 2 ? [0.85, 0.95] : [1.3, 1.45];
  const { photo, truth } = renderPiecesPhoto(ref, cut, items, {
    seed, background: b.background(painting), backgroundTexture: b.texture, noiseSigma: 2.5, illumination: 0.1, scale, ...extra,
  });
  return { photo, truth, cut };
}

/** Eight single pieces on a dark table (for touching-piece tests). */
function touchingScene(ref: RGBAImage, seed: number) {
  const cut = generateJigsaw(8, 10, ref.width, ref.height, seed + 20);
  const items = Array.from({ length: 8 }, (_, i) => (i * 9 + seed * 5) % 80);
  const { photo, truth } = renderPiecesPhoto(ref, cut, items, { seed, background: [38, 42, 50], noiseSigma: 2.5, scale: 1.3 });
  return { photo, truth, cut };
}

/** Nearest pair of items whose grid orientations differ clearly (≥ 20° modulo 90°) and with no other item in between. */
function pickTouchPair(truth: { center: { x: number; y: number }; rotationDeg: number }[]): { a: number; b: number } {
  let best = { a: 0, b: 1 }, bestD = Infinity;
  for (let i = 0; i < truth.length; i++) {
    for (let j = i + 1; j < truth.length; j++) {
      let d = Math.abs(truth[i].rotationDeg - truth[j].rotationDeg) % 90;
      d = Math.min(d, 90 - d);
      if (d < 20) continue;
      const A = truth[i].center, B = truth[j].center;
      const dist = Math.hypot(A.x - B.x, A.y - B.y);
      const blocked = truth.some((t, k) => {
        if (k === i || k === j) return false;
        const u = ((t.center.x - A.x) * (B.x - A.x) + (t.center.y - A.y) * (B.y - A.y)) / (dist * dist);
        if (u < 0 || u > 1) return false;
        return Math.hypot(t.center.x - (A.x + u * (B.x - A.x)), t.center.y - (A.y + u * (B.y - A.y))) < 120;
      });
      if (!blocked && dist < bestD) { bestD = dist; best = { a: i, b: j }; }
    }
  }
  return best;
}

interface Row {
  label: string;
  items: number;
  ev: SceneEval;
  ms: number;
}

function summarize(rows: Row[]) {
  let items = 0, det = 0, regions = 0, falseR = 0, patches = 0, patchOk = 0, singles = 0, cornerOk = 0, shapes = 0, sideOk = 0, kindOk = 0;
  const angle: number[] = [], body: number[] = [];
  for (const r of rows) {
    for (const p of r.ev.pieces) {
      items++;
      if (p.detected) det++;
      if (p.isPatch) {
        patches++;
        if (p.kindOk) patchOk++;
        continue;
      }
      singles++;
      if (p.cornerErrorRel === undefined) continue;
      shapes++;
      if (p.cornerErrorRel <= 0.05) cornerOk++;
      sideOk += p.sidesCorrect!;
      if (p.pieceKindOk) kindOk++;
      angle.push(p.angleError!);
      body.push(p.bodySizeErrorRel!);
    }
    regions += r.ev.regions;
    falseR += r.ev.falseRegions;
  }
  const q = (a: number[], f: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))] : NaN);
  return {
    recall: det / items,
    precision: regions > 0 ? (regions - falseR) / regions : 1,
    patchRate: patchOk / patches,
    shapeRate: shapes / singles,
    cornerRate: cornerOk / singles,
    sideAcc: sideOk / (4 * shapes),
    kindAcc: kindOk / shapes,
    angleMedian: q(angle, 0.5),
    angleP90: q(angle, 0.9),
    bodyMedian: q(body, 0.5),
    items, singles, patches,
  };
}

function fmtRow(label: string, s: ReturnType<typeof summarize>, ms?: number): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`.padStart(7);
  return `${label.padEnd(26)}${pct(s.recall)}${pct(s.precision)}${pct(s.patchRate)}${pct(s.shapeRate)}${pct(s.cornerRate)}${pct(s.sideAcc)}${pct(s.kindAcc)}${s.angleMedian.toFixed(2).padStart(7)}°${(100 * s.bodyMedian).toFixed(2).padStart(7)}%${ms !== undefined ? `${ms.toFixed(0).padStart(7)}ms` : ''}`;
}

describe('segmentPieces accuracy sweep', () => {
  it('segments, classifies and analyses pieces across paintings, backgrounds and seeds', () => {
    const rows: Row[] = [];
    for (const painting of Object.keys(PAINTINGS) as Painting[]) {
      for (const bg of Object.keys(BACKGROUNDS)) {
        for (const seed of [1, 2]) {
          const { photo, truth, cut } = scene(painting, bg, seed);
          const t0 = performance.now();
          const seg = segmentPieces(photo);
          const ms = performance.now() - t0;
          const ev = evaluateScene(seg, truth, cut, 0.85);
          rows.push({ label: `${painting}/${bg}/s${seed}`, items: truth.length, ev, ms });
          if (DEBUG_IMAGES) savePng(`.debug/pieces/sweep-${painting}-${bg}-${seed}.png`, drawOverlay(photo, seg, truth));
        }
      }
    }
    const header = `${'scenario'.padEnd(26)} recall  prec. patches shapes corner≤5% sides  kinds  angle  body err   time`;
    const lines = [header];
    for (const r of rows) lines.push(fmtRow(r.label, summarize([r]), r.ms));
    for (const bg of Object.keys(BACKGROUNDS)) lines.push(fmtRow(`ALL ${bg}`, summarize(rows.filter((r) => r.label.includes(`/${bg}/`)))));
    const all = summarize(rows);
    lines.push(fmtRow('ALL', all));
    console.log(`Segmentation sweep (IoU ≥ 0.85; corner error relative to body size; angle = side direction error)\n${lines.join('\n')}`);

    expect(all.recall).toBeGreaterThanOrEqual(0.97);
    expect(all.precision).toBeGreaterThanOrEqual(0.97);
    expect(all.patchRate).toBeGreaterThanOrEqual(0.9);
    expect(all.cornerRate).toBeGreaterThanOrEqual(0.9);
    expect(all.sideAcc).toBeGreaterThanOrEqual(0.95);
    expect(all.kindAcc).toBeGreaterThanOrEqual(0.95);
    expect(all.angleMedian).toBeLessThan(1.5);
    expect(all.angleP90).toBeLessThan(3);
    expect(all.bodyMedian).toBeLessThan(0.03);
    // Every background on its own is still usable.
    for (const bg of Object.keys(BACKGROUNDS)) {
      const s = summarize(rows.filter((r) => r.label.includes(`/${bg}/`)));
      expect(s.recall, bg).toBeGreaterThanOrEqual(0.9);
      expect(s.cornerRate, bg).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe('segmentPieces output contract', () => {
  const { photo, truth } = scene('starry-night', 'grey', 2);
  const seg = segmentPieces(photo);

  it('returns consistent regions in reading order', () => {
    expect(seg.regions.length).toBe(truth.length);
    expect(seg.foreground.width).toBe(photo.width);
    expect(seg.foreground.height).toBe(photo.height);
    seg.regions.forEach((sr, i) => {
      const r = sr.region;
      expect(r.id).toBe(i + 1);
      expect(sr.mask.width).toBe(r.bbox.width);
      expect(sr.mask.height).toBe(r.bbox.height);
      expect(sr.image.width).toBe(r.bbox.width);
      expect(sr.image.height).toBe(r.bbox.height);
      let a = 0;
      for (const v of sr.mask.data) a += v;
      expect(a).toBe(r.area);
      expect(polygonSignedArea(r.contour)).toBeGreaterThan(0);
      expect(r.orientationDeg).toBeGreaterThan(-45);
      expect(r.orientationDeg).toBeLessThanOrEqual(45);
      for (const p of r.contour) {
        expect(p.x).toBeGreaterThanOrEqual(r.bbox.x - 1);
        expect(p.x).toBeLessThanOrEqual(r.bbox.x + r.bbox.width);
      }
      if (r.kind === 'piece') expect(r.shape).toBeDefined();
      if (r.kind === 'patch') expect(r.shape).toBeUndefined();
    });
    // Reading order: centers are sorted by row (rows overlap less than half a region height).
    const cy = seg.regions.map((s) => s.region.bbox.y + s.region.bbox.height / 2);
    const tol = 0.5 * Math.max(...seg.regions.map((s) => s.region.bbox.height));
    for (let i = 1; i < cy.length; i++) expect(cy[i]).toBeGreaterThan(cy[i - 1] - tol);
    expect(seg.regions.filter((s) => s.region.kind === 'patch').length).toBe(2);
  });

  it('reports the median body size and a background model', () => {
    const bodies = truth.filter((t) => t.pieces.length === 1).map((t) => Math.hypot(t.corners[1].x - t.corners[0].x, t.corners[1].y - t.corners[0].y));
    const med = bodies.sort((a, b) => a - b)[bodies.length >> 1];
    expect(seg.medianBodySize).toBeDefined();
    expect(Math.abs(seg.medianBodySize! - med) / med).toBeLessThan(0.08);
    expect(seg.background.color[0]).toBeGreaterThan(45);
    expect(seg.background.color[0]).toBeLessThan(62);
    expect(seg.background.separability).toBeGreaterThan(0.75);
    expect(seg.background.coverage).toBeGreaterThan(0.5);
    expect(seg.quality.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('reports per-stage timings when asked', () => {
    const timings: Record<string, number> = {};
    segmentPieces(photo, { timings, assessQuality: false });
    for (const k of ['background', 'score', 'threshold', 'morphology', 'components', 'shapes']) expect(timings[k]).toBeGreaterThanOrEqual(0);
    expect(timings.quality).toBeUndefined();
  });
});

describe('segmentPieces special cases', () => {
  it('splits touching pieces at the contact and flags them', () => {
    const ref = PAINTINGS['great-wave'];
    let flagged = 0, splitOk = 0;
    const seeds = [1, 2, 3, 4];
    for (const seed of seeds) {
      const { photo, truth, cut } = touchingScene(ref, seed);
      const { a, b } = pickTouchPair(truth);
      const touching = makeTouching(photo, truth[a], truth[b]);
      const seg = segmentPieces(touching);
      if (DEBUG_IMAGES) savePng(`.debug/pieces/touching-${seed}.png`, drawOverlay(touching, seg));
      const issue = seg.quality.issues.find((i) => i.code === 'touching_pieces');
      if (issue) flagged++;
      // When the pair was split, both parts are pieces close to the true outlines (b moved, so
      // compare with a only); all other pieces are untouched.
      const ev = evaluateScene(seg, truth, cut, 0.85);
      expect(ev.pieces.filter((_, i) => i !== a && i !== b).every((p) => p.detected)).toBe(true);
      if (issue && issue.regionIds!.length === 2) {
        expect(ev.pieces[a].iou).toBeGreaterThan(0.8);
        splitOk++;
      }
    }
    console.log(`touching pairs: flagged ${flagged}/${seeds.length}, split ${splitOk}/${seeds.length}`);
    expect(flagged).toBe(seeds.length);
    expect(splitOk).toBeGreaterThanOrEqual(2);
  });

  it('flags pieces cut off by the photo border and does not give them a shape', () => {
    const { photo, truth } = scene('starry-night', 'light', 2);
    const t = truth[0];
    const x = Math.round(t.center.x);
    const cropped = cropPhoto(photo, { x, y: 0, width: photo.width - x, height: photo.height });
    const seg = segmentPieces(cropped);
    const cutRegions = seg.regions.filter((r) => r.region.touchesBorder);
    expect(cutRegions.length).toBeGreaterThanOrEqual(1);
    for (const r of cutRegions) {
      expect(r.region.shape).toBeUndefined();
      expect(r.region.issues.some((i) => i.code === 'cut_off')).toBe(true);
    }
    expect(seg.quality.issues.find((i) => i.code === 'cut_off')?.severity).toBe('warning');
  });

  it('marks small fragments as unknown', () => {
    const { photo } = scene('starry-night', 'green', 2);
    const img = { ...photo, data: new Uint8ClampedArray(photo.data) };
    // A crumb: a small irregular blob in a free corner of the photo.
    const blob = createMask(img.width, img.height);
    fillPolygon(blob, [{ x: 4, y: 4 }, { x: 26, y: 6 }, { x: 22, y: 24 }, { x: 8, y: 20 }].map((p) => ({ x: p.x + 20, y: p.y + img.height - 60 })), 1);
    for (let i = 0; i < blob.data.length; i++) if (blob.data[i]) img.data.set([200, 190, 60], i * 4);
    const seg = segmentPieces(img);
    const frag = seg.regions.filter((r) => r.region.issues.some((i) => i.code === 'fragment'));
    expect(frag.length).toBe(1);
    expect(frag[0].region.kind).toBe('unknown');
    expect(seg.quality.issues.find((i) => i.code === 'fragment')?.severity).toBe('info');
  });

  it('reports no pieces on an empty table', () => {
    const rng = new Rng(3);
    const img: RGBAImage = createRGBA(900, 700);
    for (let i = 0; i < img.width * img.height; i++) {
      const n = rng.normal() * 3;
      img.data[i * 4] = 140 + n; img.data[i * 4 + 1] = 110 + n; img.data[i * 4 + 2] = 80 + n; img.data[i * 4 + 3] = 255;
    }
    const seg = segmentPieces(img);
    expect(seg.regions.length).toBe(0);
    expect(seg.quality.issues.map((i) => i.code)).toContain('no_pieces');
    expect(seg.quality.issues.find((i) => i.code === 'no_pieces')!.severity).toBe('error');
  });

  it('handles a photo with a single piece', () => {
    const ref = PAINTINGS['great-wave'];
    const cut = generateJigsaw(8, 10, ref.width, ref.height, 9);
    const { photo, truth } = renderPiecesPhoto(ref, cut, [23], { seed: 5, scale: 1.3, width: 500, height: 400, background: [38, 42, 50] });
    const seg = segmentPieces(photo);
    expect(seg.regions.length).toBe(1);
    expect(seg.regions[0].region.kind).toBe('piece');
    expect(seg.regions[0].region.shape).toBeDefined();
    const tm = createMask(truth[0].bbox.width + 4, truth[0].bbox.height + 4);
    const rect = { x: truth[0].bbox.x - 2, y: truth[0].bbox.y - 2, width: tm.width, height: tm.height };
    fillPolygon(tm, truth[0].outline.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y })), 1);
    expect(maskIoU(tm, rect, seg.regions[0].mask, seg.regions[0].region.bbox)).toBeGreaterThan(0.9);
  });

  it('classifies a lone assembled patch as a patch (no single piece for reference)', () => {
    const ref = PAINTINGS['great-wave'];
    const cut = generateJigsaw(8, 10, ref.width, ref.height, 4);
    for (const item of [[11, 12, 21, 22], [33, 34, 35], [70, 71]]) {
      const { photo } = renderPiecesPhoto(ref, cut, [item], { seed: 2, scale: 1.2, background: [128, 128, 128] });
      const seg = segmentPieces(photo);
      expect(seg.regions.map((r) => r.region.kind)).toEqual(['patch']);
      expect(seg.medianBodySize).toBeUndefined();
    }
  });
});

describe('segmentPieces on hard tables', () => {
  const summary = (seg: ReturnType<typeof segmentPieces>, truth: Parameters<typeof evaluateScene>[1], cut: Parameters<typeof evaluateScene>[2]) => {
    const ev = evaluateScene(seg, truth, cut, 0.8);
    const det = ev.pieces.filter((p) => p.detected).length;
    return { recall: det / truth.length, precision: (ev.regions - ev.falseRegions) / Math.max(1, ev.regions), ev };
  };

  it('keeps dark pieces whole in a noisy, blurry photo on a dark table (adaptive pre-filter)', () => {
    const { photo, truth, cut } = scene('starry-night', 'dark', 2, { noiseSigma: 7, blurSigma: 1.4, illumination: 0.25, gain: [1.0, 1.17, 0.94] });
    const seg = segmentPieces(photo);
    if (DEBUG_IMAGES) savePng('.debug/pieces/hard-noisy.png', drawOverlay(photo, seg, truth));
    const { recall, precision } = summary(seg, truth, cut);
    console.log(`noisy dark table: noise ${seg.background.noise.toFixed(1)}, smoothing ${seg.background.smoothing}, recall ${recall.toFixed(2)}, precision ${precision.toFixed(2)}`);
    expect(seg.background.smoothing).toBeGreaterThan(0);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    // Clean photos are not smoothed.
    expect(segmentPieces(scene('starry-night', 'dark', 2).photo, { assessQuality: false }).background.smoothing).toBe(0);
  });

  it('finds black pieces on a black table by their texture', () => {
    let recall = 0, precision = 0;
    for (const seed of [1, 2]) {
      const { photo, truth, cut } = scene('starry-night', 'dark', seed, { background: [20, 24, 23] });
      const seg = segmentPieces(photo);
      if (DEBUG_IMAGES) savePng(`.debug/pieces/hard-black-${seed}.png`, drawOverlay(photo, seg, truth));
      const s = summary(seg, truth, cut);
      recall += s.recall / 2;
      precision += s.precision / 2;
      // Regions reported as hard to see carry the issue themselves.
      for (const id of seg.quality.issues.find((i) => i.code === 'low_contrast')?.regionIds ?? []) {
        expect(seg.regions[id - 1].region.issues.some((i) => i.code === 'low_contrast')).toBe(true);
      }
    }
    console.log(`black on black: recall ${recall.toFixed(2)}, precision ${precision.toFixed(2)}`);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });

  it('reports pieces it cannot separate as low contrast with region ids', () => {
    // Noise + blur + a table of the same colour as the dark paint: some pieces fall apart.
    const { photo } = scene('starry-night', 'dark', 1, { background: [22, 26, 24], noiseSigma: 9, blurSigma: 1.6 });
    const seg = segmentPieces(photo);
    if (DEBUG_IMAGES) savePng('.debug/pieces/hard-unseparable.png', drawOverlay(photo, seg));
    const lc = seg.quality.issues.find((i) => i.code === 'low_contrast');
    expect(lc).toBeDefined();
    expect(lc!.severity).toBe('warning');
    expect(lc!.regionIds!.length).toBeGreaterThan(0);
    for (const id of lc!.regionIds!) expect(seg.regions[id - 1].region.issues.some((i) => i.code === 'low_contrast')).toBe(true);
  });

  it('does not take strongly textured cloth for pieces', () => {
    const { photo, truth, cut } = scene('great-wave', 'wood', 2, { backgroundTexture: 45 });
    const seg = segmentPieces(photo);
    const { recall, precision } = summary(seg, truth, cut);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(precision).toBe(1);
  });
});

describe('segmentPieces on real-photo conditions', () => {
  const evaluate = (seg: ReturnType<typeof segmentPieces>, truth: Parameters<typeof evaluateScene>[1], cut: Parameters<typeof evaluateScene>[2]) => {
    const ev = evaluateScene(seg, truth, cut, 0.8);
    const matched = new Set<number>();
    for (const p of ev.pieces) if (p.detected) matched.add(p.truthIndex);
    // Regions offered as pieces / patches that are none (fragments and 'unknown' are not offered).
    const offeredFalse = ev.falseRegions - seg.regions.filter((r) => r.region.kind === 'unknown' && !r.region.issues.some((i) => i.code === 'fragment')).length;
    return { recall: matched.size / truth.length, offeredFalse, ev };
  };
  const debug = (name: string, photo: RGBAImage, seg: ReturnType<typeof segmentPieces>, truth: Parameters<typeof drawOverlay>[2]) => {
    if (DEBUG_IMAGES) savePng(`.debug/pieces/real-${name}.png`, drawOverlay(photo, seg, truth));
  };

  it('separates loose pieces lying 1–3 px apart or slightly overlapping', () => {
    for (const seed of [1, 2]) {
      const { photo, truth, cut } = scene('starry-night', 'dark', seed, { pairs: { count: 4, gap: [-2, 3] } });
      const seg = segmentPieces(photo);
      debug(`pairs-${seed}`, photo, seg, truth);
      const { recall } = evaluate(seg, truth, cut);
      console.log(`close pairs s${seed}: recall ${recall.toFixed(2)}`);
      expect(recall).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('does not offer the table edge or the box lid at the photo border as pieces', () => {
    const { photo, truth, cut } = scene('great-wave', 'wood', 2, { clutter: ['table-edge', 'box-edge'] });
    const seg = segmentPieces(photo);
    debug('clutter', photo, seg, truth);
    const { recall, offeredFalse } = evaluate(seg, truth, cut);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(offeredFalse).toBe(0);
    expect(seg.quality.issues.some((i) => i.code === 'cut_off' && i.regionIds?.some((id) => seg.regions[id - 1].region.kind === 'unknown'))).toBe(false);
  });

  it('learns a patterned tablecloth as table and warns about it', () => {
    for (const pattern of [{ kind: 'dots' as const }, { kind: 'check' as const }]) {
      const { photo, truth, cut } = scene('starry-night', 'dark', 2, { pattern });
      const seg = segmentPieces(photo);
      debug(`pattern-${pattern.kind}`, photo, seg, truth);
      const { recall, offeredFalse } = evaluate(seg, truth, cut);
      console.log(`pattern ${pattern.kind}: palette ${seg.background.palette.length}, recall ${recall.toFixed(2)}, false ${offeredFalse}`);
      expect(seg.background.palette.length).toBeGreaterThan(0);
      expect(recall).toBeGreaterThanOrEqual(0.75);
      expect(offeredFalse).toBeLessThanOrEqual(2);
      expect(seg.quality.issues.find((i) => i.code === 'low_contrast')?.message).toMatch(/patterned/);
    }
    // A plain table has no palette.
    expect(segmentPieces(scene('great-wave', 'wood', 1).photo, { assessQuality: false }).background.palette).toEqual([]);
  });

  it('keeps outlines on brightness edges in blocky JPEG photos', () => {
    const { photo, truth, cut } = scene('great-wave', 'dark', 2, { jpegQuality: 70 });
    const diagnostics: SegmentDiagnostics = {};
    const seg = segmentPieces(photo, { diagnostics });
    debug('jpeg', photo, seg, truth);
    const { recall, ev } = evaluate(seg, truth, cut);
    const singles = ev.pieces.filter((p) => !p.isPatch && p.detected);
    expect(diagnostics.blockiness).toBeGreaterThan(1.3);
    expect(recall).toBe(1);
    expect(singles.filter((p) => p.shapeFound).length).toBeGreaterThanOrEqual(0.8 * singles.length);
    // JPEG colour blocks are not reported as crumbs.
    expect(seg.regions.filter((r) => r.region.area < 160)).toEqual([]);
  });

  it('peels glare halos off the pieces they touch', () => {
    const { photo, truth, cut } = scene('great-wave', 'grey', 2, { illumination: 0.3, glare: { count: 4, radius: [0.04, 0.07] } });
    const seg = segmentPieces(photo);
    debug('glare', photo, seg, truth);
    const { recall } = evaluate(seg, truth, cut);
    console.log(`glare: recall ${recall.toFixed(2)}`);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });

  it('treats an over-exposed corner of a light table as table', () => {
    const { photo, truth, cut } = scene('starry-night', 'light', 2, { gain: 1.12, illumination: 0.2 });
    const seg = segmentPieces(photo);
    debug('overexposed', photo, seg, truth);
    let clipped = 0;
    for (let i = 0; i < photo.data.length; i += 4) if (photo.data[i] === 255 && photo.data[i + 1] === 255 && photo.data[i + 2] === 255) clipped++;
    const { recall, offeredFalse } = evaluate(seg, truth, cut);
    expect(clipped).toBeGreaterThan(0.01 * photo.width * photo.height);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(offeredFalse).toBe(0);
  });

  it('ignores soft cast shadows and a light cardboard rim on a dark table', () => {
    const { photo, truth, cut } = scene('starry-night', 'dark', 2, { rim: {}, edgeDarkening: 0.15, shadow: 0.45, shadowOffset: [6, 4], shadowBlur: 3.5 });
    const seg = segmentPieces(photo);
    debug('rim-shadow', photo, seg, truth);
    const { recall, ev } = evaluate(seg, truth, cut);
    const singles = ev.pieces.filter((p) => !p.isPatch && p.detected);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(singles.filter((p) => p.shapeFound).length).toBeGreaterThanOrEqual(0.8 * singles.length);
  });

  it('keeps plank gaps and tile seams crossing under and next to pieces out of the regions', () => {
    const { photo, truth, cut } = scene('great-wave', 'wood', 2, { background: [196, 172, 140], backgroundTexture: 0, pattern: { kind: 'planks', width: 320, gap: 12, tiles: true } });
    const seg = segmentPieces(photo);
    debug('planks', photo, seg, truth);
    const { recall, offeredFalse } = evaluate(seg, truth, cut);
    console.log(`plank gaps: palette ${seg.background.palette.length}, recall ${recall.toFixed(2)}, false ${offeredFalse}, regions ${seg.regions.length}`);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(offeredFalse).toBe(0);
    // No strand of a gap is a region of its own, and no gap makes a region much longer than a piece.
    const body = seg.medianBodySize ?? 100;
    expect(seg.regions.filter((r) => r.region.kind !== 'patch' && Math.max(r.region.bbox.width, r.region.bbox.height) > 2.2 * body)).toEqual([]);
    expect(seg.regions.length).toBeLessThanOrEqual(truth.length + 1);
  });

  it('models a strongly grained table along its grain (option), and only such a table', () => {
    const grained = scene('great-wave', 'wood', 2, { background: [150, 108, 70], pattern: { kind: 'wood' } });
    const dg: SegmentDiagnostics = {};
    const seg = segmentPieces(grained.photo, { diagnostics: dg, grain: true });
    expect(dg.grain).toBeDefined();
    expect(dg.grain!.coherence).toBeGreaterThan(0.6);
    // The grain explains most of the table's lightness spread.
    expect(dg.grain!.sigma[0]).toBeLessThan(0.7 * seg.background.sigma[0]);
    const { recall, offeredFalse } = evaluate(seg, grained.truth, grained.cut);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(offeredFalse).toBe(0);
    // Plank seams on a plain floor are no grain.
    const planks = scene('great-wave', 'wood', 2, { background: [196, 172, 140], backgroundTexture: 0, pattern: { kind: 'planks', width: 320, gap: 12, tiles: true } });
    const dp: SegmentDiagnostics = {};
    segmentPieces(planks.photo, { diagnostics: dp, grain: true });
    expect(dp.grain).toBeUndefined();
    // Off unless asked for.
    const doff: SegmentDiagnostics = {};
    segmentPieces(grained.photo, { diagnostics: doff });
    expect(doff.grain).toBeUndefined();
  });

  it('drops faint stains on the table that have no edge, keeping the pieces', () => {
    // Soft beige stains (a few Lab units, fading out over a third of a piece) on free table, as the
    // stains of the dense grey-table feedback photos: smooth all through, no cut edge along any outline.
    const { photo, truth, cut } = scene('starry-night', 'light', 2, { background: [198, 200, 202] });
    const occupied = createMask(photo.width, photo.height);
    for (const t of truth) fillPolygon(occupied, t.outline, 1);
    const free = (cx: number, cy: number, r: number) => {
      for (let y = Math.max(0, cy - r); y < Math.min(photo.height, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x < Math.min(photo.width, cx + r); x++) if (occupied.data[y * photo.width + x]) return false;
      }
      return cx - r > 0 && cy - r > 0 && cx + r < photo.width && cy + r < photo.height;
    };
    const rng = new Rng(4);
    const stains: { x: number; y: number }[] = [];
    for (let k = 0; k < 2000 && stains.length < 3; k++) {
      const x = Math.round(rng.random() * photo.width), y = Math.round(rng.random() * photo.height);
      if (free(x, y, 90) && stains.every((q) => Math.hypot(q.x - x, q.y - y) > 200)) stains.push({ x, y });
    }
    expect(stains.length).toBe(3);
    const stained = { ...photo, data: new Uint8ClampedArray(photo.data) };
    for (const q of stains) {
      for (let y = q.y - 100; y < q.y + 100; y++) {
        for (let x = q.x - 100; x < q.x + 100; x++) {
          // An irregular blob (two overlapping lobes), fading out smoothly.
          const d = Math.min(Math.hypot((x - q.x) / 60, (y - q.y) / 45), Math.hypot((x - q.x - 25) / 40, (y - q.y + 20) / 50));
          const g = d < 1 ? 1 : Math.exp(-((d - 1) ** 2) / 0.18);
          const o = (y * photo.width + x) * 4;
          stained.data[o] -= 7 * g;
          stained.data[o + 1] -= 10 * g;
          stained.data[o + 2] -= 20 * g;
        }
      }
    }
    const seg = segmentPieces(stained);
    debug('stains', stained, seg, truth);
    const { recall, offeredFalse } = evaluate(seg, truth, cut);
    const onStain = seg.regions.filter((r) => r.region.kind !== 'unknown' && stains.some((q) => Math.hypot(r.region.bbox.x + r.region.bbox.width / 2 - q.x, r.region.bbox.y + r.region.bbox.height / 2 - q.y) < 80));
    console.log(`stains: recall ${recall.toFixed(2)}, false ${offeredFalse}, regions on stains ${onStain.length}`);
    expect(onStain).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(offeredFalse).toBe(0);
  });

  it('takes a large soft shadow reaching in from the border for table', () => {
    const { photo, truth, cut } = scene('starry-night', 'light', 2, { background: [206, 196, 178], shadowZone: { strength: 0.5 } });
    const seg = segmentPieces(photo);
    debug('shadow-zone', photo, seg, truth);
    const { recall, offeredFalse } = evaluate(seg, truth, cut);
    console.log(`shadow zone: palette ${seg.background.palette.length}, local ${seg.background.local ? 'yes' : 'no'}, recall ${recall.toFixed(2)}, false ${offeredFalse}`);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(offeredFalse).toBe(0);
    expect(seg.regions.length).toBeLessThanOrEqual(truth.length + 1);
  });

  it('keeps pieces in dark tones of the table colour strong (no shadow tolerance for them)', () => {
    const { photo, truth, cut } = scene('great-wave', 'wood', 2, { background: [190, 166, 134], backgroundTexture: 8, darkPieces: { share: 0.5, level: 0.5 } });
    const diagnostics: SegmentDiagnostics = {};
    const seg = segmentPieces(photo, { diagnostics });
    debug('dark-pieces', photo, seg, truth);
    const { recall, offeredFalse, ev } = evaluate(seg, truth, cut);
    const singles = ev.pieces.filter((p) => !p.isPatch && p.detected);
    console.log(`dark wood pieces: recall ${recall.toFixed(2)}, false ${offeredFalse}, shapes ${singles.filter((p) => p.shapeFound).length}/${singles.length}`);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(offeredFalse).toBe(0);
    expect(singles.filter((p) => p.shapeFound).length).toBeGreaterThanOrEqual(0.8 * singles.length);
    // Their print scores well above the high threshold, not in the shadow-tolerant band.
    expect(seg.quality.issues.find((i) => i.code === 'low_contrast')).toBeUndefined();
  });

  it('measures how much table or cast shadow the outlines take in on a light table', () => {
    // Excess over the ring inside: a pale sky on a cream table is not mistaken for shadow.
    const median = (seg: ReturnType<typeof segmentPieces>) => {
      const v = seg.regions.filter((r) => r.region.kind === 'piece').map((r) => r.borderTable).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    const hard = { rim: {}, edgeDarkening: 0.15, shadow: 0.5, shadowOffset: [8, 5] as [number, number], shadowBlur: 4.5 };
    const clean = segmentPieces(scene('great-wave', 'light', 2).photo, { assessQuality: false });
    const shadowed = segmentPieces(scene('great-wave', 'light', 2, hard).photo, { assessQuality: false });
    const dark = segmentPieces(scene('great-wave', 'dark', 2, hard).photo, { assessQuality: false });
    console.log(`borderTable median: clean ${median(clean).toFixed(2)}, shadowed ${median(shadowed).toFixed(2)}`);
    expect(median(clean)).toBeLessThan(0.12);
    expect(median(shadowed)).toBeGreaterThan(0.18);
    // Only measured on plain light tables (dark painting content looks like a dark table).
    expect(dark.regions.every((r) => r.borderTable === 0)).toBe(true);
  });

  it('trims cast shadows off outlines in doubt with the graph-cut option, finding more pieces', () => {
    // Pieces with a cardboard rim and a soft cast shadow on a light table (as the bench's
    // wave-rim-shadow-light): the shadow joins most outlines and spoils their shape.
    const ref = PAINTINGS['great-wave'];
    const cut = generateJigsaw(10, 14, ref.width, ref.height, 21);
    const items = Array.from({ length: 16 }, (_, i) => (i * 9 + 4) % 140);
    const { photo, truth } = renderPiecesPhoto(ref, cut, items, {
      seed: 71, background: [226, 222, 214], noiseSigma: 3, blurSigma: 0.7, illumination: 0.15, scale: [1.3, 1.45],
      rim: {}, edgeDarkening: 0.15, shadow: 0.5, shadowOffset: [8, 5], shadowBlur: 4.5,
    });
    const runs = [false, true].map((graphCut) => evaluateScene(segmentPieces(photo, { graphCut, assessQuality: false }), truth, cut, 0.5));
    const meanIoU = (ev: SceneEval) => ev.pieces.reduce((s, p) => s + p.iou, 0) / ev.pieces.length;
    const found = (ev: SceneEval) => ev.pieces.filter((p) => p.iou >= 0.8).length;
    console.log(`graph cut, cast shadows: mean IoU ${meanIoU(runs[0]).toFixed(3)} -> ${meanIoU(runs[1]).toFixed(3)}, found ${found(runs[0])} -> ${found(runs[1])} of ${truth.length}`);
    expect(meanIoU(runs[1])).toBeGreaterThan(meanIoU(runs[0]) + 0.005);
    expect(found(runs[1])).toBeGreaterThan(found(runs[0]));
  });
});

describe('segmentPieces on a full-size photo', () => {
  it('segments 40 pieces on a 2400×1800 photo (time logged, not asserted)', () => {
    const ref = resizeRGBA(loadTestAsset('starry-night'), 1280, 1014);
    const cut = generateJigsaw(12, 16, ref.width, ref.height, 3);
    const idx = Array.from({ length: 40 }, (_, i) => i * 4 + 1);
    const { photo, truth } = renderPiecesPhoto(ref, cut, idx, { seed: 5, width: 2400, height: 1800, scale: 1.9, noiseSigma: 3, background: [200, 200, 195] });
    segmentPieces(photo); // warm-up (JIT)
    const timings: Record<string, number> = {};
    const t0 = performance.now();
    const seg = segmentPieces(photo, { timings });
    const ms = performance.now() - t0;
    console.log(`segmentPieces 2400×1800, 40 pieces: ${ms.toFixed(0)} ms (${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')})`);
    const ev = evaluateScene(seg, truth, cut, 0.85);
    expect(ev.pieces.filter((p) => p.detected).length).toBe(40);
    expect(ev.pieces.filter((p) => (p.cornerErrorRel ?? 1) <= 0.05).length).toBeGreaterThanOrEqual(38);
  });
});

describe('weak foreground far from strong pixels', () => {
  /**
   * A 60 px strong square (score 255) and weak pixels (score 100) on a 300×200 photo, the whole as
   * one region of 1.5–2 pieces of 60×60 px: `weak(x, y)` says where the weak pixels lie. Returns the
   * areas of the parts left when the far weak ones are dropped (high 200, reach 6 px), null when
   * nothing changed.
   */
  const run = (weak: (x: number, y: number) => boolean) => {
    const W = 300, H = 200;
    const score = createGray(W, H), mask = createMask(W, H), none = createMask(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const strong = x >= 40 && x < 100 && y >= 70 && y < 130;
        if (!strong && !weak(x, y)) continue;
        mask.data[y * W + x] = 1;
        score.data[y * W + x] = strong ? 255 : 100;
      }
    }
    const parts = dropFarWeak({ mask, bbox: { x: 0, y: 0, width: W, height: H }, area: maskArea(mask) }, score, 200, none, 6, 50, 3600, 20, W, H, true);
    return parts?.map((p) => p.area) ?? null;
  };

  it('drops a weak area hanging off a piece by a short stretch, with its foot', () => {
    // A weak disc (shaded table) joined to the square's right side by a 7 px strip.
    expect(run((x, y) => Math.hypot(x - 160, y - 100) <= 30 || (x >= 100 && x < 135 && Math.abs(y - 100) <= 3))).toEqual([3600]);
  });

  it('keeps a weak area lying along the strong part of a piece', () => {
    // A weak block below the square sharing its whole lower side (the piece's own pale print).
    expect(run((x, y) => x >= 40 && x < 100 && y >= 130 && y < 165)).toBeNull();
  });
});

describe('watershed (edge split floods)', () => {
  // Two 100 × 100 squares side by side, a marker in each. B's marker sits inside a ring of weak
  // print edges (level 6); a strong wall (level 200) separates the squares except for a gap at the
  // top: plain floods from A run through the gap over B's flat outer part before B's flood leaves
  // its ring; compact floods (cost growing with the distance from the marker) leave B its square.
  const W = 200, H = 100;
  const mask = createMask(W, H);
  mask.data.fill(1);
  const grad = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= 99 && x <= 100 && y >= 12) grad[y * W + x] = 200;
      const r = Math.hypot(x - 150, y - 50);
      if (r >= 12 && r < 15) grad[y * W + x] = 6;
    }
  }
  const markers = () => {
    const l = new Int32Array(W * H);
    for (let y = 45; y < 55; y++) for (let x = 45; x < 55; x++) { l[y * W + x] = 1; l[y * W + x + 100] = 2; }
    return l;
  };
  const shareOfB = (l: Int32Array) => {
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 100; x < W; x++) if (l[y * W + x] === 2) n++;
    return n / (100 * H);
  };

  it('lets a marker take over its neighbour through a gap in plain floods', () => {
    const l = markers();
    watershed(mask, grad, l);
    expect(shareOfB(l)).toBeLessThan(0.2);
  });

  it('keeps each marker its own square in compact floods', () => {
    const l = markers();
    watershed(mask, grad, l, 20 / 100, [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 150, y: 50 }]);
    expect(shareOfB(l)).toBeGreaterThan(0.9);
  });
});
