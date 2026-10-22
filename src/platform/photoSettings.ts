/**
 * Which still size to ask ImageCapture.takePhoto for, by what the photo is for. Pure (no DOM).
 *
 * Box photos and close-ups become the reference picture: every pixel helps, so they ask for the
 * sensor's maximum. Piece scans are analysed at {@link SCAN_ANALYSIS_SIDE} px on the long side, so a
 * 48 MP still only costs time and memory (decoding, shutter lag): they ask for the smallest size of
 * at least that much.
 */

/** What a photo is taken for (CameraCapture's context). */
export type PhotoPurpose = 'box' | 'pieces' | 'closeup';

/** Longest side (px) piece scans are analysed and stored at. */
export const SCAN_ANALYSIS_SIDE = 2400;

/** A capability range as ImageCapture.getPhotoCapabilities reports it. */
export interface MediaRange {
  min?: number;
  max?: number;
  step?: number;
}

export interface PhotoCapabilitiesLike {
  imageWidth?: MediaRange;
  imageHeight?: MediaRange;
}

export interface PhotoSize {
  imageWidth: number;
  imageHeight: number;
}

/** `v` rounded up to the range's grid (min + k·step) and clamped to it. */
function snapUp(r: MediaRange & { max: number }, v: number): number {
  const min = r.min ?? 0;
  const step = r.step && r.step > 0 ? r.step : 1;
  const k = Math.ceil((v - min) / step - 1e-9);
  return Math.min(r.max, Math.max(min, min + k * step));
}

/**
 * The size to request for `purpose`, or undefined when the capabilities give no sizes (then the
 * camera's default is used). Piece scans: the sensor's aspect scaled to at least
 * SCAN_ANALYSIS_SIDE px on the long side (the camera picks the nearest size it has); others – and
 * sensors no bigger than that – the maximum.
 */
export function photoSettingsFor(caps: PhotoCapabilitiesLike | undefined, purpose: PhotoPurpose): PhotoSize | undefined {
  const w = caps?.imageWidth;
  const h = caps?.imageHeight;
  if (!w?.max || !h?.max || w.max <= 0 || h.max <= 0) return undefined;
  const max = { imageWidth: w.max, imageHeight: h.max };
  if (purpose !== 'pieces') return max;
  const long = Math.max(w.max, h.max);
  if (long <= SCAN_ANALYSIS_SIDE) return max;
  const scale = SCAN_ANALYSIS_SIDE / long;
  return {
    imageWidth: snapUp({ ...w, max: w.max }, w.max * scale),
    imageHeight: snapUp({ ...h, max: h.max }, h.max * scale),
  };
}
