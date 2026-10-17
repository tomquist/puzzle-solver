import { describe, expect, it } from 'vitest';
import type { Quad } from '../../cv/geometry';
import { DEBUG_IMAGES } from '../../testing/nodeImageIO';
import { detectBox } from './detectBox';
import { cropPictureSide, renderScene, saveOverlay, type Painting, type SceneSpec } from './testkit';

const SIDES = ['top', 'right', 'bottom', 'left'];

/** Distance of quad side `s` (corners s, s+1) from the photo border it should lie on. */
function sideOffBorder(q: Quad, s: number, w: number, h: number): number {
  const a = q[s], b = q[(s + 1) % 4];
  if (s === 0) return Math.max(Math.abs(a.y + 0.5), Math.abs(b.y + 0.5));
  if (s === 1) return Math.max(Math.abs(a.x - (w - 0.5)), Math.abs(b.x - (w - 0.5)));
  if (s === 2) return Math.max(Math.abs(a.y - (h - 0.5)), Math.abs(b.y - (h - 0.5)));
  return Math.max(Math.abs(a.x + 0.5), Math.abs(b.x + 0.5));
}

describe('detectBox on photos that cut off one side of the picture', () => {
  const cases: [Painting, number][] = [['starry-night', 0], ['starry-night', 0.06], ['great-wave', 0], ['great-wave', 0.06]];
  for (const [painting, frameWidth] of cases) {
    it(`${painting}, frame ${frameWidth}: snaps the cut side to the photo border and reports cut_off`, () => {
      const spec: SceneSpec = { name: `crop-${painting}-${frameWidth}`, painting, opts: { seed: 61, width: 1200, height: 900, frameWidth } };
      const sc = renderScene(spec);
      // The uncropped photo is not cut off.
      const full = detectBox(sc.photo);
      expect(full.quality.issues.map((i) => i.code)).not.toContain('cut_off');
      const rows: string[] = [];
      for (let side = 0; side < 4; side++) {
        for (const frac of [0.05, 0.15, 0.25]) {
          const c = cropPictureSide(sc.photo, sc.pictureQuad, side, frac);
          expect(c.visible.length).toBe(4);
          const det = detectBox(c.photo);
          const name = `${SIDES[side]} ${Math.round(frac * 100)}%`;
          const diag = Math.hypot(c.photo.width, c.photo.height);
          // Every corner of the visible picture region is matched by a detected corner.
          const err = Math.max(...c.visible.map((v) => Math.min(...det.quad.map((q) => Math.hypot(q.x - v.x, q.y - v.y))))) / diag;
          const cut = det.quality.issues.find((i) => i.code === 'cut_off');
          rows.push(`${name.padEnd(11)} err ${(100 * err).toFixed(2)} %  confidence ${det.confidence.toFixed(2)}  cut_off ${!!cut}`);
          if (DEBUG_IMAGES || err > 0.015 || !cut) saveOverlay(`.debug/box/crop-${painting}-${frameWidth}-${SIDES[side]}-${frac}.png`, { ...sc, photo: c.photo, pictureQuad: c.pictureQuad, lidQuad: c.pictureQuad }, det);
          expect(cut, name).toBeDefined();
          expect(cut!.severity).toBe('warning');
          expect(cut!.hint).toMatch(/step back|whole picture/i);
          expect(det.candidates[0].label, name).toBe('picture');
          expect(sideOffBorder(det.quad, side, c.photo.width, c.photo.height), name).toBeLessThan(1);
          expect(err, name).toBeLessThan(0.015);
          expect(det.confidence, name).toBeLessThan(full.confidence);
        }
      }
      console.log(`${painting}, frame ${frameWidth}:\n  ${rows.join('\n  ')}`);
    }, 120_000);
  }
});
