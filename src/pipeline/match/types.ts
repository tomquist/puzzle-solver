import type { Point } from '../../cv/geometry';
import type { Mask, RGBAImage } from '../../cv/image';
import type { CellRef, CutStyle, GridSpec, PieceShape, QualityCode, RegionKind } from '../../model/types';

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
  /**
   * Coarse level only: row-wise prefix sums (rows × (stride + 1) × 4, Float64) of the channels
   * minus `center` and of their squared norm, for O(runs) masked sums in the dense search.
   */
  prefix?: Float64Array;
  /** Channel means subtracted before computing `prefix`. */
  center: [number, number, number];
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
  /** How trustworthy the region's outline is (from segmentation); unreliable outlines cap the confidence. */
  outline?: OutlineEvidence;
  /**
   * Same size as mask: region pixels that show the table (a hole between a patch's pieces that the
   * segmentation filled). They count as not covered when a patch's cells are decided.
   */
  table?: Mask;
}

/** Segmentation evidence about a region's outline (all optional). */
export interface OutlineEvidence {
  /**
   * Fraction of the region's outer band whose colour is the (possibly shadowed) table — the outline
   * probably includes cast shadow or table (see the pieces package's `SegmentedRegion.borderTable`).
   */
  borderTable?: number;
  /** Codes of the region's quality issues ('low_contrast', 'shape_uncertain', 'touching_pieces', …). */
  issues?: QualityCode[];
  /** Region area / area of the convex hull of its outline (single pieces ≈ 0.75–0.9). */
  solidity?: number;
}

export interface MatchOptions {
  /**
   * Cells the user has marked as placed: candidates there score `placedPenalty` less (soft, never
   * excluded: the marks may be wrong; see matchRegion.ts).
   */
  placedCells?: CellRef[];
  /** Score penalty of a candidate in a placed cell (default `PLACED_PENALTY`; benchmark sweeps). */
  placedPenalty?: number;
  /** Most the marks may lift a confidence over the photo's own (default `PLACED_GAIN`; benchmark sweeps). */
  placedGain?: number;
  /** Number of distinct candidates to return (default 5). */
  maxCandidates?: number;
}
