import { describe, expect, it } from 'vitest';
import { photoSettingsFor, SCAN_ANALYSIS_SIDE } from './photoSettings';

const caps48mp = { imageWidth: { min: 160, max: 8000, step: 16 }, imageHeight: { min: 120, max: 6000, step: 12 } };

describe('photoSettingsFor', () => {
  it('asks for the sensor maximum for box photos and close-ups', () => {
    expect(photoSettingsFor(caps48mp, 'box')).toEqual({ imageWidth: 8000, imageHeight: 6000 });
    expect(photoSettingsFor(caps48mp, 'closeup')).toEqual({ imageWidth: 8000, imageHeight: 6000 });
  });

  it('asks for the smallest size of at least the analysis size for piece scans', () => {
    const s = photoSettingsFor(caps48mp, 'pieces')!;
    expect(Math.max(s.imageWidth, s.imageHeight)).toBeGreaterThanOrEqual(SCAN_ANALYSIS_SIDE);
    expect(s.imageWidth).toBeLessThan(SCAN_ANALYSIS_SIDE + 16);
    // On the camera's size grid, with the sensor's aspect.
    expect((s.imageWidth - 160) % 16).toBe(0);
    expect((s.imageHeight - 120) % 12).toBe(0);
    expect(s.imageWidth / s.imageHeight).toBeCloseTo(8000 / 6000, 2);
  });

  it('works for portrait sensors and missing steps', () => {
    const s = photoSettingsFor({ imageWidth: { max: 3000 }, imageHeight: { max: 4000 } }, 'pieces')!;
    expect(s).toEqual({ imageWidth: 1800, imageHeight: 2400 });
  });

  it('keeps the maximum when the sensor is no bigger than the analysis size', () => {
    expect(photoSettingsFor({ imageWidth: { max: 1920 }, imageHeight: { max: 1080 } }, 'pieces')).toEqual({ imageWidth: 1920, imageHeight: 1080 });
  });

  it('leaves the size to the camera when it reports none', () => {
    expect(photoSettingsFor(undefined, 'pieces')).toBeUndefined();
    expect(photoSettingsFor({}, 'box')).toBeUndefined();
    expect(photoSettingsFor({ imageWidth: { max: 0 }, imageHeight: { max: 0 } }, 'pieces')).toBeUndefined();
  });
});
