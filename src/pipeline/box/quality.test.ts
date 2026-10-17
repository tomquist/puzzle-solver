import { describe, expect, it } from 'vitest';
import { applyMat3, type Point } from '../../cv/geometry';
import { cloneRGBA } from '../../cv/image';
import { resizeRGBA } from '../../cv/resize';
import type { QualityCode } from '../../model/types';
import { DEBUG_IMAGES } from '../../testing/nodeImageIO';
import { detectBox } from './detectBox';
import { unitSquareToQuad } from './geometry';
import { assessReference } from './quality';
import { addGlare, blurRGBA, painting, renderScene, saveOverlay, scaleExposure, type SceneSpec } from './testkit';

/** Codes that must stay quiet on clean photos ('low_resolution' info depends on the photo size). */
const DEGRADATION_CODES: QualityCode[] = ['blurry', 'glare', 'too_dark', 'too_bright', 'box_not_found', 'perspective', 'cut_off'];

const clean: SceneSpec[] = [
  { name: 'q-sn-frame', painting: 'starry-night', opts: { seed: 51, width: 1200, height: 900, frameWidth: 0.06 } },
  { name: 'q-sn-plain', painting: 'starry-night', opts: { seed: 52, width: 1200, height: 900, frameWidth: 0, background: 'plain', illumination: 0.2 } },
  { name: 'q-gw-frame', painting: 'great-wave', opts: { seed: 53, width: 1200, height: 900, frameWidth: 0.05, background: [40, 40, 45] } },
  { name: 'q-gw-wood', painting: 'great-wave', opts: { seed: 54, width: 1200, height: 900, frameWidth: 0, perspective: 0.1 } },
];

const codes = (d: { quality: { issues: { code: QualityCode }[] } }) => d.quality.issues.map((i) => i.code);

/** Photo position of picture unit coordinates (u, v). */
function picturePoint(spec: SceneSpec, u: number, v: number): Point {
  const H = unitSquareToQuad(renderScene(spec).pictureQuad)!;
  return applyMat3(H, { x: u, y: v });
}

describe('box photo quality', () => {
  it('raises no degradation issues on clean photos', () => {
    for (const spec of clean) {
      const det = detectBox(renderScene(spec).photo);
      const found = codes(det).filter((c) => DEGRADATION_CODES.includes(c));
      expect(found, spec.name).toEqual([]);
      expect(det.quality.score).toBeGreaterThan(0.9);
    }
  });

  it('flags strong blur', () => {
    for (const spec of [clean[0], clean[2]]) {
      const det = detectBox(blurRGBA(renderScene(spec).photo, 3));
      expect(codes(det), spec.name).toContain('blurry');
      expect(det.quality.metrics.blur).toBeGreaterThan(0.6);
    }
  });

  it('flags under- and overexposure', () => {
    for (const spec of [clean[0], clean[3]]) {
      expect(codes(detectBox(scaleExposure(renderScene(spec).photo, 0.3))), spec.name).toContain('too_dark');
    }
    expect(codes(detectBox(scaleExposure(renderScene(clean[0]).photo, 2.2)))).toContain('too_bright');
    expect(codes(detectBox(scaleExposure(renderScene(clean[3]).photo, 1.6)))).toContain('too_bright');
  });

  it('flags a glare blob on the picture and locates it', () => {
    // Glare merged into large, already clipped white areas of a picture cannot be told apart from
    // white paint; these positions are on coloured content.
    for (const [spec, u, v] of [[clean[0], 0.6, 0.35], [clean[1], 0.3, 0.7], [clean[2], 0.6, 0.6], [clean[2], 0.45, 0.35], [clean[3], 0.15, 0.3]] as const) {
      const sc = renderScene(spec);
      const photo = cloneRGBA(sc.photo);
      const c = picturePoint(spec, u, v);
      const diag = Math.hypot(sc.pictureQuad[2].x - sc.pictureQuad[0].x, sc.pictureQuad[2].y - sc.pictureQuad[0].y);
      addGlare(photo, c, 0.035 * diag);
      const det = detectBox(photo);
      if (DEBUG_IMAGES) saveOverlay(`.debug/box/glare-${spec.name}.png`, { ...sc, photo }, det);
      const glare = det.quality.issues.find((i) => i.code === 'glare');
      expect(glare, spec.name).toBeDefined();
      expect(glare!.hint).toMatch(/tilt|light/i);
      const a = glare!.area!;
      expect(c.x).toBeGreaterThan(a.x);
      expect(c.x).toBeLessThan(a.x + a.width);
      expect(c.y).toBeGreaterThan(a.y);
      expect(c.y).toBeLessThan(a.y + a.height);
    }
  });

  it('flags a steep viewing angle and a picture too small in the photo', () => {
    const steep = renderScene({ name: 'q-steep', painting: 'great-wave', opts: { seed: 43, width: 1200, height: 900, frameWidth: 0.05, perspective: 0.25 } });
    const d1 = detectBox(steep.photo);
    expect(codes(d1)).toContain('perspective');
    expect(d1.quality.issues.find((i) => i.code === 'perspective')!.hint).toMatch(/above/i);
    const small = resizeRGBA(renderScene(clean[0]).photo, 560, 420);
    const d2 = detectBox(small);
    const low = d2.quality.issues.find((i) => i.code === 'low_resolution');
    expect(low?.severity).toBe('warning');
    // A large photo of the same scene has no resolution issue.
    const big = resizeRGBA(renderScene(clean[0]).photo, 2400, 1800);
    expect(codes(detectBox(big))).not.toContain('low_resolution');
  });
});

describe('assessReference', () => {
  const ref = painting('starry-night', 1280);
  const grid1000 = { rows: 27, cols: 38 };

  it('warns about a low-resolution reference and suggests close-ups', () => {
    const r = assessReference(resizeRGBA(ref, 600, 475), grid1000);
    const issue = r.issues.find((i) => i.code === 'reference_low_resolution');
    expect(issue?.severity).toBe('warning');
    expect(issue!.hint).toMatch(/close-up/i);
    expect(r.metrics.pxPerCell).toBeCloseTo(600 / 38, 1);
    // ~34 px per cell: informational only.
    expect(assessReference(ref, grid1000).issues.find((i) => i.code === 'reference_low_resolution')?.severity).toBe('info');
  });

  it('passes a 3000 px reference for 1000 pieces', () => {
    const r = assessReference(resizeRGBA(ref, 3000, 2377), grid1000);
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(1);
    expect(r.metrics.pxPerCell).toBeGreaterThan(70);
  });

  it('flags blur and glare on the reference', () => {
    const small = { rows: 10, cols: 13 };
    expect(assessReference(ref, small).issues).toEqual([]);
    expect(assessReference(blurRGBA(ref, 3), small).issues.map((i) => i.code)).toContain('blurry');
    const g = cloneRGBA(ref);
    addGlare(g, { x: 800, y: 300 }, 60);
    const glare = assessReference(g, small).issues.find((i) => i.code === 'glare');
    expect(glare).toBeDefined();
    expect(glare!.area!.x).toBeLessThan(800);
    expect(glare!.area!.x + glare!.area!.width).toBeGreaterThan(800);
    expect(assessReference(scaleExposure(ref, 0.3), small).issues.map((i) => i.code)).toContain('too_dark');
  });
});
