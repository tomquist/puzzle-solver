import { describe, expect, it } from 'vitest';
import { DEBUG_IMAGES } from '../../testing/nodeImageIO';
import { detectBox } from './detectBox';
import { estimateQuadAspect } from './geometry';
import { runSweep, sweepScenes } from './testkit';

// The 38-scene accuracy sweep is split over three files so Vitest can render them in parallel.
const PART = 1, PARTS = 3;

describe(`detectBox accuracy sweep (part ${PART}/${PARTS})`, () => {
  it('finds the picture within 1.5 % of its diagonal on ≥ 90 % of the scenes, with the lid among the candidates', () => {
    const all = sweepScenes();
    const specs = all.filter((_, i) => i % PARTS === PART - 1);
    const rows = runSweep(`Box detection sweep, part ${PART}/${PARTS}`, specs, (p) => detectBox(p), estimateQuadAspect, DEBUG_IMAGES);
    const ok = rows.filter((r) => r.error <= 1.5).length;
    expect(ok / rows.length).toBeGreaterThanOrEqual(0.9);
    // Lid candidate whenever a frame exists and the lid edges are visible (not cut off by the
    // photo border, table not lid-coloured).
    for (const [i, r] of rows.entries()) {
      const s = specs[i];
      const lidVisible = (s.opts.frameWidth ?? 0.06) > 0 && !s.degrade?.cropAroundPicture && !s.name.includes('lidlike');
      if (lidVisible) expect(r.lidError, s.name).toBeLessThan(2);
    }
  }, 180_000);
});
