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

/**
 * How sure the user is of the piece count: printed on the box ('exact'; boxes still round, "1500"
 * for 45 × 34 = 1530), a guess ('about'), or not known at all ('unknown': `pieceCount` is then the
 * estimated grid's rows × cols).
 */
export type PieceCountKind = 'exact' | 'about' | 'unknown';

/**
 * Where the grid comes from: 'estimated' (no piece count: a guess from the picture, replaced by
 * what the scans measure without asking), 'unconfirmed' (from the piece count or the user's
 * choice; scans may still disagree, and then the app asks once), 'confirmed' (the user accepted a
 * measured grid, or the scans agreed strongly; only overwhelming evidence raises it again).
 */
export type GridStatus = 'estimated' | 'unconfirmed' | 'confirmed';

/** A grid the user turned down, and how many scans had measured the grid by then. */
export interface DeclinedGrid extends GridSpec {
  scans?: number;
}

/** A grid change the app proposes, waiting for the user's answer. */
export interface GridSuggestion {
  grid: GridSpec;
  /** Posterior odds of `grid` over the current grid when it was proposed. */
  odds: number;
  /** Independent sources (patches, the scans' loose pieces) behind it. */
  sources: number;
  /** Scans the measurement comes from. */
  scans: number;
  at: number;
}

/**
 * What the scans say about the grid (pipeline/gridBelief.ts): every scan's cell-size evidence,
 * keyed by scan id (a re-analysed scan replaces its entry, a deleted one is removed, so nothing is
 * counted twice), and the user's answers.
 */
export interface GridState {
  status: GridStatus;
  /** Evidence per scan id. */
  scans: Record<Id, GridEvidence>;
  /**
   * Grids the user turned down ("Keep"), with the number of measured scans at the time; raised
   * again only past the high bar, from scans taken after the answer.
   */
  declined: DeclinedGrid[];
  /** Grids an estimated grid moved away from without asking; not returned to without the high bar. */
  left: GridSpec[];
  /** A proposal on screen, until the user answers it. */
  suggestion?: GridSuggestion;
  /** When the grid last changed through this mechanism (or was confirmed). */
  changedAt?: number;
}

export interface PuzzleRecord {
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Number of pieces as printed on the box (or the estimated grid's cells when unknown). */
  pieceCount: number;
  /** How sure that count is (missing: 'exact', as in puzzles saved before it was recorded). */
  pieceCountKind?: PieceCountKind;
  physicalSize?: PhysicalSize;
  /** Grid used for locating pieces (rows * cols ≈ pieceCount). */
  grid: GridSpec;
  /** Measured evidence about the grid and its status (missing: unconfirmed, no evidence yet). */
  gridState?: GridState;
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

/**
 * How a photo was taken: the camera's still capture (ImageCapture.takePhoto), a frame of the live
 * preview (no ImageCapture, or takePhoto failed), or a file (upload, or the phone's camera app).
 */
export type CaptureMethod = 'takePhoto' | 'video-frame' | 'file';

/** How a scan's photo was captured. */
export interface CaptureInfo {
  method: CaptureMethod;
  /** True when takePhoto was tried and failed, so the photo is a frame of the live preview. */
  fallback?: boolean;
  /** Why takePhoto failed (the error's name), when it fell back. */
  fallbackReason?: string;
  /** Size asked of takePhoto (piece scans: about the analysis size; box photos: the sensor maximum). */
  requested?: { width: number; height: number };
  /** Size of the photo as captured (upright), before it was scaled down for analysis. */
  width?: number;
  height?: number;
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
  /** How the photo was captured; missing for scans saved before it was recorded. */
  capture?: CaptureInfo;
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
  /**
   * 0..1 confidence that this placement is correct: a heuristic score (logistic in score and
   * margin, fitted on synthetic scans, then capped and discounted), NOT a calibrated probability –
   * nothing has fitted it to real photos. Use it to rank and to tell sure from unsure; the UI
   * shows words (ui/lib/certainty.ts), never a percentage.
   */
  confidence: number;
}

export type MatchStatus = 'confident' | 'ambiguous' | 'unmatched';

/**
 * Why a match is not sure (set by the matcher for 'ambiguous' matches when it can tell):
 * - 'plain': little texture (sky, water, a plain colour) – many spots look alike
 * - 'repeating': a repeating pattern – the same content occurs in several spots
 * - 'similar-spots': a few distinct spots score about the same
 * - 'shape': the outline (and so the template) is doubtful – merged pieces, table attached, …
 * - 'small': the region is small in the photo (few pixels) for a reliable match
 */
export type UncertainReason = 'plain' | 'repeating' | 'similar-spots' | 'shape' | 'small';

/**
 * A cell the user marked as placed whose picture matches this region better than the candidates
 * it was given (the matcher down-weights placed cells): the piece may belong there, and the spot
 * may have been marked placed by mistake.
 */
export interface PlacedConflict {
  row: number;
  col: number;
  /** Turn from the photo to upright at that cell, when known. */
  rotationDeg?: number;
}

/**
 * A patch's seam-fitted cell lattice in reference px at its best placement: where its pieces are in
 * the picture, whatever the grid – so its cells can be re-derived when the grid changes
 * (pipeline/remap.ts).
 */
export interface RefLattice {
  /** The placement it was taken at: the patch's reference position (= its candidate's x, y) and turn. */
  at: Point;
  rotationDeg: number;
  /** Reference position of lattice point (0, 0). */
  origin: Point;
  /** Reference vector of one lattice step along its a and b axes. */
  a: Point;
  b: Point;
  /** The lattice cells the patch covers, flattened i, j, coverage (0..1), … */
  cells: number[];
}

export interface RegionMatch {
  regionId: number;
  /** Best first; typically up to 5 distinct locations. */
  candidates: Placement[];
  /** For patches: grid cells covered by the patch at the best placement. */
  coveredCells?: CellRef[];
  status: MatchStatus;
  /** For patches: their lattice at the best placement (absent in scans saved by older versions). */
  lattice?: RefLattice;
  /** Why the match is not sure (ambiguous matches; absent when unknown, or in older scans). */
  uncertainReason?: UncertainReason;
  /** A placed cell this region seems to belong in (absent when none, or in older scans). */
  placedConflict?: PlacedConflict;
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
 * - 'neighbors': loose pieces (not touching in the photo) and whole assembled groups whose
 *   placements are adjacent cells, i.e. they will connect once placed (an assembled group's member
 *   regions are listed with it).
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

/** A measurement in natural-log units with its standard error. */
export interface LogMeasure {
  /** ln of the measured value. */
  log: number;
  /** Standard error of `log`. */
  se: number;
  /** Cells (patches) or pieces the measurement rests on. */
  n: number;
}

/**
 * One independent measurement of the reference picture's cell size from a scan
 * (pipeline/match/cellSize.ts): an assembled patch (its seams), or the scan's single pieces
 * together. Width = along the picture's x axis, height = along y, in reference px.
 */
export interface CellSizeSource {
  kind: 'patch' | 'pieces';
  regionIds: number[];
  w?: LogMeasure;
  h?: LogMeasure;
  /**
   * Reference coordinates (px) of cell centres the source saw, along x and along y (single pieces:
   * their body centres; patches: their lattice cells, only along axes whose seams were fitted – an
   * axis that kept the placement's grid would only echo it). Where they sit in the cells of a grid
   * tells how well that grid fits (phase).
   */
  x?: number[];
  y?: number[];
}

/** Version of {@link GridEvidence}'s measurement; evidence of another version is ignored by the belief. */
export const GRID_EVIDENCE_VERSION = 1;

/** What a scan says about the grid: measured cell sizes, independent of the grid it was analysed with. */
export interface GridEvidence {
  /** Measurement version (evidence of another version is ignored). */
  version: number;
  /** Grid the scan was analysed with. */
  grid: GridSpec;
  /** Reference size the measurements refer to. */
  refWidth: number;
  refHeight: number;
  sources: CellSizeSource[];
  /**
   * A placeholder while the scan's cell size is still being measured, after its result was shown
   * (AnalyzeResponse.gridFollowUp); the grid belief leaves it out. Removed (the scan then counts by
   * its placements' positions, as a scan from before the measurement) when the measurement cannot
   * finish – the app was closed meanwhile.
   */
  pending?: boolean;
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
  /** Cell-size measurements for the grid belief (absent in scans saved by older versions). */
  gridEvidence?: GridEvidence;
}

/** What is wrong with a live frame (FrameQuality.problem). */
export type FrameProblem = 'too_dark' | 'too_bright' | 'glare' | 'blurry';

/** Quick live-camera feedback (computed on a downscaled video frame). */
export interface FrameQuality {
  /** 0..1, higher = sharper. */
  sharpness: number;
  /** Mean luminance 0..1. */
  brightness: number;
  /** Fraction of clipped (over- or under-exposed) pixels. */
  clipped: number;
  /** Fraction of the frame covered by specular glare (reflections of a lamp or the torch). */
  glare?: number;
  ok: boolean;
  /** What is wrong when not ok. */
  problem?: FrameProblem;
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
