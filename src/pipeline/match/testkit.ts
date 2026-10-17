/**
 * Test helpers for the matcher (Node/Vitest only): turn synthetic ground truth into MatchInputs and
 * score results. Not part of the app bundle.
 */
import { applyMat3, rotation } from '../../cv/geometry';
import { createMask, cropRGBA, type RGBAImage } from '../../cv/image';
import { fillPolygon } from '../../cv/raster';
import type { CellRef, RegionKind, RegionMatch } from '../../model/types';
import { renderPiecesPhoto, Rng, truthPieceShape, type JigsawCut, type JigsawPiece, type PieceTruth } from '../../testing/synth';
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
  /** Random corner displacement (fraction of the body size) simulating imperfect corner detection. */
  cornerNoise?: number;
  /** Probability that a tab/blank side is reported as 'unknown'. */
  sideDropout?: number;
  /** Grow (> 0) or shrink (< 0) the mask by this many px (imperfect segmentation). */
  maskOffset?: number;
  /** Seed for the simulated imperfections. */
  noiseSeed?: number;
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
  const rng = new Rng((opts.noiseSeed ?? 0) * 1009 + regionId);
  if (shape && opts.cornerNoise) {
    const e = opts.cornerNoise * shape.bodySize;
    shape.corners = shape.corners.map((p) => ({ x: p.x + rng.uniform(-e, e), y: p.y + rng.uniform(-e, e) })) as typeof shape.corners;
    shape.center = {
      x: shape.corners.reduce((a, p) => a + p.x, 0) / 4,
      y: shape.corners.reduce((a, p) => a + p.y, 0) / 4,
    };
  }
  if (shape && opts.sideDropout) {
    for (const side of shape.sides) if (side.kind !== 'flat' && rng.random() < opts.sideDropout) side.kind = 'unknown';
  }
  if (opts.maskOffset) {
    const r = Math.abs(opts.maskOffset);
    const src = new Uint8Array(mask.data);
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        let any = 0, all = 1;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            const v = xx >= 0 && yy >= 0 && xx < mask.width && yy < mask.height ? src[yy * mask.width + xx] : 0;
            any |= v;
            all &= v;
          }
        }
        mask.data[y * mask.width + x] = opts.maskOffset > 0 ? any : all;
      }
    }
  }
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

export interface ScenarioOptions {
  seed: number;
  /** Number of random single pieces (ignored when `items` is given). */
  n?: number;
  /** Explicit items (piece index or patch). */
  items?: (number | number[])[];
  /** Restrict random pieces to this predicate. */
  filter?: (p: JigsawPiece) => boolean;
  scale: [number, number];
}

/** Render a scan with the standard test degradations (noise σ 4, blur σ 0.8, per-channel gain 0.85–1.15, illumination gradient). */
export function renderScenario(reference: RGBAImage, cut: JigsawCut, opts: ScenarioOptions): { photo: RGBAImage; truth: PieceTruth[] } {
  const rng = new Rng(opts.seed * 7 + 1);
  const pool = cut.pieces.filter(opts.filter ?? (() => true)).map((p) => p.index);
  const items = opts.items ?? rng.shuffle(pool).slice(0, opts.n ?? 30);
  const g = () => rng.uniform(0.85, 1.15);
  return renderPiecesPhoto(reference, cut, items, {
    seed: opts.seed + 100,
    scale: opts.scale,
    noiseSigma: 4,
    blurSigma: 0.8,
    gain: [g(), g(), g()],
    illumination: 0.1,
  });
}

export interface Accuracy {
  n: number;
  top1: number;
  top3: number;
  /** Fraction of top-1-correct placements whose rotation is within 10°. */
  rotation: number;
}

/** Top-1 / top-3 cell accuracy and rotation accuracy; `expected` overrides the truth cell. */
export function accuracy(matches: RegionMatch[], truth: PieceTruth[], expected?: (t: PieceTruth) => CellRef): Accuracy {
  let top1 = 0, top3 = 0, rot = 0;
  matches.forEach((m, i) => {
    const t = truth[i];
    const e = expected ? expected(t) : { row: t.row, col: t.col };
    const k = m.candidates.slice(0, 3).findIndex((c) => c.row === e.row && c.col === e.col);
    if (k === 0) {
      top1++;
      if (angleError(m.candidates[0].rotationDeg, t.rotationDeg) <= 10) rot++;
    }
    if (k >= 0) top3++;
  });
  const n = matches.length;
  return { n, top1: top1 / n, top3: top3 / n, rotation: top1 ? rot / top1 : 0 };
}
