/**
 * The contract between the UI (main thread) and the image-processing pipeline (Web Worker).
 *
 * The UI only ever talks to an object implementing `PipelineApi` (obtained from
 * `getPipeline()` in `./client.ts`), so heavy computation never blocks rendering. All arguments and
 * results are structured-clone friendly. Images cross the boundary as RGBAImage (ImageData-like);
 * the client transfers their buffers where possible.
 */
import type { Quad } from '../cv/geometry';
import type { RGBAImage } from '../cv/image';
import type {
  BoxDetection,
  CellRef,
  CloseupRegistration,
  CutStyle,
  FrameQuality,
  GridSpec,
  Id,
  ProgressRecord,
  ScanResult,
} from '../model/types';
import type { GridContext, GridDecision, PooledMeasure } from '../pipeline/gridBelief';

export interface ProgressEvent {
  /** Pipeline stage, e.g. 'segment', 'shape', 'match', 'fits'. */
  stage: string;
  /** 0..1 progress within the whole operation. */
  progress: number;
  message?: string;
}

export type ProgressCallback = (e: ProgressEvent) => void;

export interface AnalyzeOptions {
  /** Cells already confirmed as placed; the matcher down-weights them. */
  placedCells?: CellRef[];
  /** Longest side the photo is reduced to before analysis (default 2400). */
  maxSide?: number;
  /**
   * Measure the cell size at the scan's own scale when far from the grid's: 'near' while the grid
   * is not confirmed, 'wide' (also a ladder of scales when nothing matched) while it is a guess.
   */
  gridProbe?: 'near' | 'wide';
}

/** The grid belief's verdict (pipeline/gridBelief.ts), computed in the worker. */
export interface GridVerdict {
  decision: GridDecision;
  /** Most probable grid and its odds over the current one. */
  best: GridSpec;
  odds: number;
  /** Measured cell width / height (ln reference px), from the evidence alone. */
  w?: PooledMeasure;
  h?: PooledMeasure;
  /** Scans with evidence. */
  scans: number;
}

/** Scans and progress carried over to another grid (pipeline/remap.ts). */
export interface RemapRequest {
  scans: { id: Id; result: ScanResult }[];
  progress: ProgressRecord;
  from: GridSpec;
  to: GridSpec;
  ref: { width: number; height: number };
}

export interface RemapResponse {
  /** `exact` false: a patch had no stored lattice (older scan) – worth re-analysing. */
  scans: { id: Id; result: ScanResult; exact: boolean }[];
  progress: ProgressRecord;
  /** Placed cells that moved, and those that landed on a cell already placed (dropped). */
  moved: number;
  dropped: number;
}

export interface AnalyzeResponse {
  result: ScanResult;
  /** The exact image that was analysed (downscaled photo); store it with the scan. */
  analysedImage: RGBAImage;
}

export interface ComposeOptions {
  /** Output scale relative to the current reference (e.g. 2 = twice the resolution). */
  scale: number;
  /** Upper bound for the output's longer side in pixels (default 6000). */
  maxSide?: number;
}

export interface PipelineApi {
  /** Find the puzzle picture on a photo of the box. */
  detectBox(photo: RGBAImage): Promise<BoxDetection>;

  /**
   * Output size for rectifying `quad`. When `aspect` (width / height, e.g. from the physical size)
   * is given it is honoured exactly; otherwise it is estimated from the quad.
   */
  suggestRectifiedSize(quad: Quad, aspect?: number, maxSide?: number): Promise<{ width: number; height: number }>;

  /** Perspective-correct the quad region into a width x height image. */
  rectify(photo: RGBAImage, quad: Quad, width: number, height: number): Promise<RGBAImage>;

  /** Register a close-up photo of part of the picture against the current reference. */
  registerCloseup(reference: RGBAImage, closeup: RGBAImage): Promise<CloseupRegistration | null>;

  /** Build a higher-resolution reference from the current one plus registered close-ups. */
  composeHighRes(
    reference: RGBAImage,
    closeups: { image: RGBAImage; registration: CloseupRegistration }[],
    options: ComposeOptions,
  ): Promise<RGBAImage>;

  /**
   * Make `reference` the matching target for `puzzleId` (builds and caches the matching index in
   * the worker). Must be called before analyzeScan; cheap if already loaded.
   */
  loadReference(puzzleId: string, reference: RGBAImage, grid: GridSpec, cut: CutStyle): Promise<void>;

  /** True when loadReference was already done for this puzzle in the current worker. */
  hasReference(puzzleId: string): Promise<boolean>;

  /** Segment pieces in a photo, analyse their shapes and match them against the reference. */
  analyzeScan(puzzleId: string, photo: RGBAImage, options?: AnalyzeOptions, onProgress?: ProgressCallback): Promise<AnalyzeResponse>;

  /** Fast quality feedback for a (downscaled) live camera frame. */
  assessFrame(frame: RGBAImage): Promise<FrameQuality>;

  /** Weigh the scans' evidence about the grid and decide what to do (pure, but heavy enough for the worker). */
  assessGrid(ctx: GridContext): Promise<GridVerdict>;

  /** Carry scans' cells and the placed progress over to another grid without re-analysing photos. */
  remapGrid(req: RemapRequest): Promise<RemapResponse>;
}
