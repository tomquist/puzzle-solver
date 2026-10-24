/**
 * Public types of the pieces package (segmentation of a scan photo into pieces / patches).
 * Everything is structured-clone friendly so it can cross the worker boundary.
 */
import type { GrayImage, Mask, RGBAImage } from '../../cv/image';
import type { DetectedRegion, QualityReport } from '../../model/types';

/**
 * Background colour model of a scan photo: a quadratic surface per CIE Lab channel (captures
 * lighting gradients) plus robust noise estimates. Evaluate with `backgroundAt`.
 */
export interface BackgroundModel {
  /** Median background colour (CIE L*a*b*) of the photo's border band. */
  color: [number, number, number];
  /**
   * Quadratic model per Lab channel: c(u, v) = k0 + k1·u + k2·v + k3·u² + k4·u·v + k5·v² with
   * u = 2x / (width − 1) − 1 and v = 2y / (height − 1) − 1 (photo coordinates x, y).
   */
  coefficients: [number[], number[], number[]];
  /** Robust per-channel spread of the background around the model (Lab units; noise + texture). */
  sigma: [number, number, number];
  /** Photo size the model was fitted for. */
  width: number;
  height: number;
  /** 95th / 5th percentile of the modelled table luminance where the table is visible (1 = even lighting). */
  lightingRatio: number;
  /**
   * Fraction of the photo's border band that the table model explains (within 3.5 sigmas): about
   * 0.8–1 for a plain or wood table minus pieces lying on the border, low for patterned cloth.
   */
  bandFit: number;
  /**
   * Further table colours (a patterned cloth, the floor beyond the table edge, a second table), each
   * with its spread and the main surface's lightness `refL` where it was measured: under other
   * lighting it scales with the main surface, times its own lighting `light` (a second surface lit
   * differently: L* + 16 scales by exp(light[0] + light[1]·u + light[2]·v), u, v = −1..1 across the
   * photo). Blends of two table colours count as table too. `interior` is the share of the middle
   * of the photo showing the colour (a pattern spreads over the whole table). Empty for a plain table.
   */
  palette: { color: [number, number, number]; sigma: [number, number, number]; refL: number; light: [number, number, number]; interior: number }[];
  /**
   * Local corrections of the table colour (Lab residuals on a coarse grid of cell centres,
   * interpolated bilinearly) where the smooth surface misses local shadows or lighting; absent
   * when the surface explains the table everywhere.
   */
  local?: LocalTableGrid;
  /** Fraction of the photo classified as background. */
  coverage: number;
  /** Estimated sensor noise (gray levels, measured on the photo's border bands). */
  noise: number;
  /** Box-filter radius applied before scoring (0 = none; 1–2 for noisy photos). */
  smoothing: number;
  /** Foreground score threshold (in background-sigma units) used for the segmentation. */
  threshold: number;
  /** Otsu separability (0..1) of the foreground score: low = pieces hard to tell from the background. */
  separability: number;
  /** Median foreground score of the pixels just inside the piece outlines (sigma units; outline contrast). */
  outlineContrast: number;
}

/** Coarse grid of local table-colour corrections (see {@link BackgroundModel.local}). */
export interface LocalTableGrid {
  cols: number;
  rows: number;
  /** Node spacing in photo px; node (i, j) sits at (j·cellW, i·cellH), the outer nodes on the photo border. */
  cellW: number;
  cellH: number;
  /** Lab residual per node, 3 values per node, row-major. */
  residual: Float32Array;
}

export interface SegmentOptions {
  /** Ignore components smaller than this many pixels (default: 5e-5 · photo area, at least 48). */
  minArea?: number;
  /** Regions larger than this multiple of the median single-piece area are patches (default 1.8). */
  patchAreaRatio?: number;
  /** Regions smaller than this multiple of the median single-piece area are fragments (default 0.35). */
  fragmentAreaRatio?: number;
  /** Split touching pieces at narrow necks into separate regions (default true). */
  splitTouching?: boolean;
  /**
   * Refine outlines in doubt by graph cut (GrabCut-style colour models and contrast-sensitive
   * smoothness, see refine.ts) after splitting and snapping, trimming halos the colour models
   * clearly take for table; not on dark tables (default false).
   */
  graphCut?: boolean;
  /**
   * Model a grained wood table along its grain (grain.ts) when its texture is clearly oriented
   * (default false: see segment.ts GRAIN_DEFAULT).
   */
  grain?: boolean;
  /**
   * Give the deep cast shadows single pieces took in back to the table (castShadow.ts; pieces on a
   * board in low side light). Default false: see segment.ts CAST_SHADOW_DEFAULT.
   */
  castShadow?: boolean;
  /**
   * Give the pixels around neck cuts out again with the table in shade (narrow gaps between pieces
   * lying close) carved out, so a knob pressed against a neighbour stays with its own piece
   * (default true).
   */
  shadeGaps?: boolean;
  /**
   * On light neutral (grey, white) tables, also find pale pieces by the texture of their brightness
   * (lumaTexture.ts; default true).
   */
  luminanceTexture?: boolean;
  /** Run the photo-quality assessment (default true). */
  assessQuality?: boolean;
  /** When given, milliseconds per stage are added to it (e.g. `background`, `threshold`, `shapes`). */
  timings?: Record<string, number>;
  /** When given, filled with intermediate results (debugging tools; costs a few mask copies). */
  diagnostics?: SegmentDiagnostics;
}

/** Per-region measurements behind the classification and the region issues. */
export interface RegionDiagnostics {
  id: number;
  /** Median foreground score just inside the outline (background sigmas). */
  contrast: number;
  /** Fraction of the region found by the texture cue only. */
  textureFraction: number;
  /** Number of fragments the region was reassembled from (1 = none). */
  merged: number;
  /** Area relative to the expected single-piece area at its position. */
  areaRatio: number;
  /** Shape confidence of the outline (0 when no four corners were found). */
  shapeConfidence: number;
  /** Split from a cluster of touching pieces. */
  split: boolean;
}

/**
 * Intermediate results of {@link segmentPieces}, for debugging tools such as the feedback
 * inspector. All images are full photo size.
 */
export interface SegmentDiagnostics {
  /** Per-pixel foreground score: distance to the background model in background sigmas. */
  score?: GrayImage;
  /** Hysteresis thresholds on the score (pixels above `low` connected to a pixel above `high`). */
  high?: number;
  low?: number;
  /** Pixels found by colour (score hysteresis). */
  colour?: Mask;
  /** Pixels only the texture cue added. */
  texture?: Mask;
  /** Foreground components dropped as specks (smaller than `minArea`). */
  removed?: Mask;
  minArea?: number;
  /** Colour blockiness (JPEG at its original pixel grid when ≥ 1.3; outlines are then snapped to brightness edges). */
  blockiness?: number;
  /** Expected single-piece area (px) and body size used for classification (0 = no reference). */
  refArea?: number;
  refBody?: number;
  regions?: RegionDiagnostics[];
  /** The grain model, when used: orientation coherence, grain-free sigma (Lab) and coverage. */
  grain?: { coherence: number; sigma: [number, number, number]; coverage: number };
}

/** One detected region with its masks and pixels, ready for matching. */
export interface SegmentedRegion {
  /** Region description (ids 1..n in reading order). */
  region: DetectedRegion;
  /** Region mask, `region.bbox`-sized (pixel (0, 0) = photo pixel (bbox.x, bbox.y)). */
  mask: Mask;
  /** Photo crop of `region.bbox`. */
  image: RGBAImage;
  /**
   * How much more of the region's outer band (≈ 0.12 piece sizes wide) than of the ring inside it
   * is explained by the table, also when darkened by a cast shadow: high values mean the outline
   * probably includes shadow or table. Measured on plain light tables only (L* ≥ 60, where shadows
   * are visible); 0 otherwise. Outline-reliability evidence for matching.
   */
  borderTable: number;
  /**
   * Patches only: the pixels of `mask` that show the table (holes and notches of missing pieces
   * that closing and hole filling took into the patch), when there are any.
   */
  table?: Mask;
}

/** Result of {@link segmentPieces}. */
export interface Segmentation {
  regions: SegmentedRegion[];
  /** Full-size foreground mask (1 = piece pixel). */
  foreground: Mask;
  background: BackgroundModel;
  quality: QualityReport;
  /** Median body size (photo px per grid cell) of the single pieces with a detected shape. */
  medianBodySize?: number;
}
