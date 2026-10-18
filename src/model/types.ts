/**
 * Domain model shared by storage, the image-processing pipeline and the UI.
 *
 * Every type in this file must stay structured-clone friendly (plain objects, arrays, numbers,
 * strings, typed arrays) so it can cross the Web Worker boundary and be stored in IndexedDB.
 */
import type { Mat3, Point, Quad } from '../cv/geometry';
import type { Rect } from '../cv/image';

export type Id = string;

// ---------------------------------------------------------------------------------------------
// Puzzle setup (persisted)
// ---------------------------------------------------------------------------------------------

export interface GridSpec {
  rows: number;
  cols: number;
}

export interface PhysicalSize {
  width: number;
  height: number;
  unit: 'cm' | 'in';
}

/**
 * How the puzzle is cut. 'grid' = classic rows/columns of pieces (the vast majority of puzzles);
 * 'irregular' = random/whimsy cut, so matching must not assume grid cells.
 */
export type CutStyle = 'grid' | 'irregular';

export interface SourcePhoto {
  /** Blob id of the stored photo (JPEG, already EXIF-rotated and limited to <= 4096 px). */
  blobId: Id;
  width: number;
  height: number;
  role: 'overview' | 'closeup';
  /** For the overview photo: the puzzle-image region within this photo (TL, TR, BR, BL). */
  quad?: Quad;
  /** For close-ups: homography mapping photo coordinates to reference-image coordinates. */
  toReference?: Mat3;
}

export interface PuzzleRecord {
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Number of pieces as printed on the box. */
  pieceCount: number;
  physicalSize?: PhysicalSize;
  /** Grid used for locating pieces (rows * cols ≈ pieceCount). */
  grid: GridSpec;
  cut: CutStyle;
  /** The rectified (and possibly super-resolved) puzzle image used as matching reference. */
  reference: { blobId: Id; width: number; height: number };
  /** Small JPEG for lists (<= 320 px). */
  thumbnailBlobId: Id;
  sources: SourcePhoto[];
}

export interface CellRef {
  row: number;
  col: number;
}

export function cellKey(c: CellRef): string {
  return `${c.row},${c.col}`;
}

export interface PlacedCell {
  at: number;
  scanId?: Id;
  regionId?: number;
}

/** Solving progress: which grid cells the user has confirmed as placed. */
export interface ProgressRecord {
  puzzleId: Id;
  /** Keyed by {@link cellKey}. */
  placed: Record<string, PlacedCell>;
  updatedAt: number;
}

/** A photo of loose pieces / patches and its analysis. */
export interface ScanRecord {
  id: Id;
  puzzleId: Id;
  createdAt: number;
  /** The analysis image (JPEG) — the photo exactly as analysed, so coordinates in `result` apply. */
  photoBlobId: Id;
  width: number;
  height: number;
  result: ScanResult;
  label?: string;
  /** Build (git commit) of the app that analysed the photo; missing for scans saved before it was recorded. */
  appVersion?: string;
}

// ---------------------------------------------------------------------------------------------
// Analysis results (produced by the pipeline, persisted inside ScanRecord)
// ---------------------------------------------------------------------------------------------

export type SideKind = 'flat' | 'tab' | 'blank' | 'unknown';
export type PieceKind = 'corner' | 'edge' | 'interior' | 'unknown';
export type PuzzleSide = 'top' | 'right' | 'bottom' | 'left';

/** Number of samples in {@link SideShape.profile}. */
export const SIDE_PROFILE_SAMPLES = 32;

export interface SideShape {
  kind: SideKind;
  /** Corner-to-corner distance in photo pixels. */
  length: number;
  /**
   * Perpendicular deviation of the side contour from the straight corner-to-corner baseline,
   * sampled at SIDE_PROFILE_SAMPLES evenly spaced positions from the side's start corner to its end
   * corner, divided by `length`. Positive = outward (away from the piece center), so a tab has a
   * positive bump and a blank a negative dent.
   */
  profile: number[];
}

export interface PieceShape {
  /**
   * The four body corners in photo coordinates, clockwise on screen. corners[0] is the top-left
   * corner in the piece's local frame, i.e. after rotating the photo by -angleDeg.
   */
  corners: [Point, Point, Point, Point];
  /** sides[i] runs corners[i] -> corners[(i + 1) % 4]; local frame: 0 = top, 1 = right, 2 = bottom, 3 = left. */
  sides: [SideShape, SideShape, SideShape, SideShape];
  /** Direction of side 0 (corners[0] -> corners[1]) in degrees clockwise from +x, in (-45, 45]. */
  angleDeg: number;
  /** Mean corner-to-corner side length in photo pixels (≈ one grid cell as seen in the photo). */
  bodySize: number;
  /** Mean of the four corners. */
  center: Point;
  kind: PieceKind;
  /** 0..1 confidence of the corner/side detection. */
  confidence: number;
}

export type RegionKind = 'piece' | 'patch' | 'unknown';

export interface DetectedRegion {
  /** 1-based index within the scan; shown to the user as the piece number. */
  id: number;
  kind: RegionKind;
  /** Bounding box in photo (analysis image) coordinates. */
  bbox: Rect;
  /** Simplified outer contour in photo coordinates, clockwise on screen. */
  contour: Point[];
  /** Area in pixels. */
  area: number;
  /** True when the region touches the photo border (probably cut off). */
  touchesBorder: boolean;
  /** Present for single pieces when corner detection succeeded. */
  shape?: PieceShape;
  /** Dominant grid orientation of the outline in degrees, (-45, 45]. Always present. */
  orientationDeg: number;
  /** Region-specific quality problems (e.g. blurry outline, glare on this piece). */
  issues: QualityIssue[];
}

export interface Placement {
  /** Grid cell of the piece body (for patches: the cell under the patch's top-left-most piece). */
  row: number;
  col: number;
  /** Body center (patches: region center) in reference-image pixels. */
  x: number;
  y: number;
  /**
   * Clockwise rotation in degrees [0, 360) that turns the region from how it lies in the photo into
   * its upright orientation in the finished puzzle.
   */
  rotationDeg: number;
  /** Raw similarity (higher is better, roughly -1..1 for NCC-based scores). */
  score: number;
  /** Calibrated 0..1 confidence that this placement is correct. */
  confidence: number;
}

export type MatchStatus = 'confident' | 'ambiguous' | 'unmatched';

export interface RegionMatch {
  regionId: number;
  /** Best first; typically up to 5 distinct locations. */
  candidates: Placement[];
  /** For patches: grid cells covered by the patch at the best placement. */
  coveredCells?: CellRef[];
  status: MatchStatus;
}

export interface FitHint {
  a: number;
  b: number;
  /** Side of region `a`, in finished-puzzle orientation, that touches region `b`. */
  sideA: PuzzleSide;
  sideB: PuzzleSide;
  confidence: number;
  reason: 'location' | 'shape' | 'location+shape';
}

/**
 * Regions that belong together in the finished puzzle.
 * - 'assembled': physically joined in the photo (an assembled grid/patch). Either one 'patch'
 *   region or several touching piece regions whose placements are mutually consistent. The user
 *   places it as one unit.
 * - 'neighbors': loose pieces (not touching in the photo) whose placements are adjacent cells, i.e.
 *   they will connect once placed.
 */
export type GroupKind = 'assembled' | 'neighbors';

export interface RegionGroup {
  /** 1-based, stable within the scan. */
  id: number;
  kind: GroupKind;
  /** Member regions (an assembled patch may be a single 'patch' region). */
  regionIds: number[];
  /** Grid cells the group occupies in the finished puzzle. */
  cells: CellRef[];
  /** Cell bounding box of `cells`. */
  bounds: { row0: number; col0: number; row1: number; col1: number };
  /**
   * Clockwise rotation in degrees [0, 360) that turns the group from how it lies in the photo into
   * its upright orientation (assembled groups move as one rigid unit). Omitted when the members'
   * rotations disagree (only possible for 'neighbors').
   */
  rotationDeg?: number;
  /** Center of the group in reference-image pixels. */
  x: number;
  y: number;
  /** 0..1 confidence that the whole group placement is right. */
  confidence: number;
}

export type QualityCode =
  | 'blurry'
  | 'motion_blur'
  | 'too_dark'
  | 'too_bright'
  | 'glare'
  | 'low_contrast'
  | 'uneven_lighting'
  | 'low_resolution'
  | 'perspective'
  | 'touching_pieces'
  | 'cut_off'
  | 'fragment'
  | 'shape_uncertain'
  | 'no_pieces'
  | 'box_not_found'
  | 'reference_low_resolution';

export type Severity = 'info' | 'warning' | 'error';

export interface QualityIssue {
  code: QualityCode;
  severity: Severity;
  /** Short human-readable description of the problem. */
  message: string;
  /** Actionable suggestion ("Move closer", "Use a darker background", ...). */
  hint?: string;
  regionIds?: number[];
  /** Area of the photo the issue refers to (photo coordinates). */
  area?: Rect;
}

export interface QualityReport {
  /** 0..1 overall usability (1 = perfect). */
  score: number;
  issues: QualityIssue[];
  /** Raw measurements for display/debugging (sharpness, clippedFraction, medianPieceSize, ...). */
  metrics: Record<string, number>;
}

export interface ScanResult {
  /** Size of the analysed image; all coordinates above refer to it. */
  width: number;
  height: number;
  regions: DetectedRegion[];
  matches: RegionMatch[];
  fits: FitHint[];
  /** Assembled grids and neighbouring loose pieces (absent in scans saved by older versions). */
  groups?: RegionGroup[];
  quality: QualityReport;
  /** Milliseconds per pipeline stage. */
  timings: Record<string, number>;
}

/** Quick live-camera feedback (computed on a downscaled video frame). */
export interface FrameQuality {
  /** 0..1, higher = sharper. */
  sharpness: number;
  /** Mean luminance 0..1. */
  brightness: number;
  /** Fraction of clipped (over- or under-exposed) pixels. */
  clipped: number;
  ok: boolean;
  /** Short message when not ok ("Too dark", "Hold still", ...). */
  message?: string;
}

/** Result of automatic detection of the puzzle image on a box photo. */
export interface BoxDetection {
  /** Best guess (TL, TR, BR, BL) in photo coordinates. */
  quad: Quad;
  /** 0..1; low values mean the UI should ask the user to adjust the corners. */
  confidence: number;
  /** Alternative candidates (e.g. whole box lid vs. picture inside its printed frame), best first. */
  candidates: { quad: Quad; score: number; label: string }[];
  quality: QualityReport;
}

export interface CloseupRegistration {
  /** Maps close-up photo coordinates to reference-image coordinates. */
  toReference: Mat3;
  inliers: number;
  /** 0..1. */
  confidence: number;
  /** Reference-image area covered by the close-up. */
  coverage: Rect;
  /** Approximate resolution gain: close-up pixels per reference pixel. */
  scaleGain: number;
}

export type { Mat3, Point, Quad, Rect };
