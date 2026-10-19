/**
 * Scoring a result against a review's answer key (scripts/feedback/replay.ts scoreObjects): one
 * point per real piece or assembled group, checked by eye.
 */
import { describe, expect, it } from 'vitest';
import type { DetectedRegion, RegionKind } from '../model/types';
import { rasterizeRegions } from '../../scripts/feedback/regions';
import { scoreObjects } from '../../scripts/feedback/replay';

const square = (id: number, x: number, y: number, w: number, kind: RegionKind = 'piece'): DetectedRegion => ({
  id,
  kind,
  bbox: { x, y, width: w, height: w },
  contour: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }],
  area: w * w,
  touchesBorder: false,
  orientationDeg: 0,
  issues: [],
});

describe('scoreObjects', () => {
  it('counts found, alone and false regions', () => {
    const regions = rasterizeRegions([
      square(1, 0, 0, 40), // one piece
      square(2, 100, 0, 80), // two pieces merged
      square(3, 300, 0, 40), // table taken for a piece
      square(4, 400, 0, 40, 'unknown'), // a fragment the app doesn't show: no detection
    ]);
    const key = [
      { x: 20, y: 20 },
      { x: 120, y: 20 },
      { x: 160, y: 60 },
      { x: 420, y: 20 }, // only inside the fragment: missed
      { x: 600, y: 20 }, // nowhere: missed
    ];
    expect(scoreObjects(key, regions)).toEqual({ objects: 5, found: 3, clean: 1, regions: 3, real: 2 });
  });

  it('scores only regions centred inside the key\'s area', () => {
    const regions = rasterizeRegions([square(1, 0, 0, 40), square(2, 100, 0, 40), square(3, 300, 0, 40)]);
    // The key covers x < 200: region 3 lies outside, so it is not a false region.
    expect(scoreObjects([{ x: 20, y: 20 }], regions, { x: 0, y: 0, width: 200, height: 100 })).toEqual({ objects: 1, found: 1, clean: 1, regions: 2, real: 1 });
  });

  it('finds an object in the area through a region centred outside it', () => {
    // A patch from x 150 to 350 is centred at x 250, outside the key's area (x < 200).
    const regions = rasterizeRegions([square(1, 150, 0, 200)]);
    expect(scoreObjects([{ x: 170, y: 20 }], regions, { x: 0, y: 0, width: 200, height: 400 })).toEqual({ objects: 1, found: 1, clean: 1, regions: 0, real: 0 });
  });

  it('leaves unsure objects out of the counts but lets them justify a region', () => {
    const regions = rasterizeRegions([square(1, 0, 0, 40), square(2, 100, 0, 40)]);
    const key = [{ x: 20, y: 20 }, { x: 120, y: 20, unsure: true }];
    expect(scoreObjects(key, regions)).toEqual({ objects: 1, found: 1, clean: 1, regions: 2, real: 2 });
  });
});
