/**
 * Test helpers for the matcher (Node/Vitest only): turn synthetic ground truth into MatchInputs and
 * score results. Not part of the app bundle.
 */
import { applyMat3, rotation } from '../../cv/geometry';
import { createMask, cropRGBA, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import type { RegionKind } from '../../model/types';
import { truthPieceShape, type JigsawCut, type PieceTruth } from '../../testing/synth';
import type { MatchInput } from './types';

export interface InputOptions {
  /** Provide a ground-truth PieceShape (single pieces only). */
  withShape?: boolean;
  /** Provide expectedBodySize (default true). */
  withBodySize?: boolean;
  /** Extra padding of the crop around the bbox. */
  pad?: number;
  kind?: RegionKind;
  /** Error added to orientationDeg (simulates the outline orientation estimate). */
  orientationError?: number;
}

/** Build a MatchInput for one rendered item from its ground truth (mask = rasterised outline). */
export function inputFromTruth(photo: RGBAImage, cut: JigsawCut, truth: PieceTruth, regionId: number, opts: InputOptions = {}): MatchInput {
  const pad = opts.pad ?? 4;
  const x0 = Math.max(0, truth.bbox.x - pad), y0 = Math.max(0, truth.bbox.y - pad);
  const x1 = Math.min(photo.width, truth.bbox.x + truth.bbox.width + pad), y1 = Math.min(photo.height, truth.bbox.y + truth.bbox.height + pad);
  const image = cropRGBA(photo, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  const mask = createMask(image.width, image.height);
  fillPolygon(mask, truth.outline.map((p) => ({ x: p.x - x0, y: p.y - y0 })), 1);
  const isPatch = truth.pieces.length > 1;
  const shape = !isPatch && opts.withShape ? truthPieceShape(cut, truth) : undefined;
  // Orientation of the true grid in the photo, reduced to (-45, 45].
  const R = rotation((-truth.rotationDeg * Math.PI) / 180);
  const d = applyMat3(R, { x: 1, y: 0 });
  let o = (Math.atan2(d.y, d.x) * 180) / Math.PI + (opts.orientationError ?? 0);
  while (o <= -45) o += 90;
  while (o > 45) o -= 90;
  const scale = truth.scale;
  const body = Math.sqrt((cut.width / cut.cols) * (cut.height / cut.rows)) * scale;
  return {
    regionId,
    kind: opts.kind ?? (isPatch ? 'patch' : 'piece'),
    image,
    mask,
    origin: { x: x0, y: y0 },
    shape,
    orientationDeg: o,
    expectedBodySize: opts.withBodySize === false ? undefined : body,
  };
}

/** Smallest absolute difference between two angles in degrees. */
export function angleError(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}
