import type { Point } from '../../cv/geometry';
import type { Mask, RGBAImage } from '../../cv/image';
import type { CellRef, CutStyle, GridSpec, PieceShape, RegionKind } from '../../model/types';

/** One level of the reference pyramid (Lab, channel-weighted, padded by edge replication). */
export interface RefLevel {
  /** Level pixels per grid cell horizontally (cellWidth · scale). */
  ppc: number;
  /** Level px per reference px, per axis (equal up to rounding). */
  scaleX: number;
  scaleY: number;
  /** Unpadded level size. */
  width: number;
  height: number;
  /** Padding on every side, in level px. */
  pad: number;
  /** Padded width (row stride in pixels). */
  stride: number;
  /** Padded height. */
  rows: number;
  /** Interleaved weighted Lab, 3 floats per padded pixel. */
  data: Float32Array;
  /** Per padded pixel: sum of squares of the three weighted channels. */
  sq: Float32Array;
}

/** Precomputed matching data for one reference image (cache it per puzzle). */
export interface ReferenceIndex {
  width: number;
  height: number;
  grid: GridSpec;
  cut: CutStyle;
  /** Reference px per cell. */
  cellW: number;
  cellH: number;
  /** Weights applied to L, a, b before matching. */
  channelWeights: [number, number, number];
  /** Pyramid, coarse to fine. */
  levels: RefLevel[];
}

export interface MatchInput {
  regionId: number;
  kind: RegionKind;
  /** Crop of the analysed photo around the region (bbox, maybe padded). */
  image: RGBAImage;
  /** Same size as image; 1 = region pixels. */
  mask: Mask;
  /** Crop origin in photo coordinates (photo = crop + origin). */
  origin: Point;
  /** Photo coordinates; present for single pieces with detected corners. */
  shape?: PieceShape;
  /** Dominant outline orientation, (-45, 45]. */
  orientationDeg: number;
  /** Photo px per grid cell (e.g. median bodySize of the scan's pieces). Required for patches without shape. */
  expectedBodySize?: number;
}

export interface MatchOptions {
  /** Cells already placed by the user; candidates there are penalised. */
  placedCells?: CellRef[];
  /** Number of distinct candidates to return (default 5). */
  maxCandidates?: number;
}
