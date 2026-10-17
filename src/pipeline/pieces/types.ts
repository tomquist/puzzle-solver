/**
 * Public types of the pieces package (segmentation of a scan photo into pieces / patches).
 * Everything is structured-clone friendly so it can cross the worker boundary.
 */
import type { Mask, RGBAImage } from '../../cv/image';
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

export interface SegmentOptions {
  /** Ignore components smaller than this many pixels (default: 5e-5 · photo area, at least 48). */
  minArea?: number;
  /** Regions larger than this multiple of the median single-piece area are patches (default 1.8). */
  patchAreaRatio?: number;
  /** Regions smaller than this multiple of the median single-piece area are fragments (default 0.35). */
  fragmentAreaRatio?: number;
  /** Split touching pieces at narrow necks into separate regions (default true). */
  splitTouching?: boolean;
  /** Run the photo-quality assessment (default true). */
  assessQuality?: boolean;
  /** When given, milliseconds per stage are added to it (e.g. `background`, `threshold`, `shapes`). */
  timings?: Record<string, number>;
}

/** One detected region with its masks and pixels, ready for matching. */
export interface SegmentedRegion {
  /** Region description (ids 1..n in reading order). */
  region: DetectedRegion;
  /** Region mask, `region.bbox`-sized (pixel (0, 0) = photo pixel (bbox.x, bbox.y)). */
  mask: Mask;
  /** Photo crop of `region.bbox`. */
  image: RGBAImage;
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
