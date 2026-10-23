/**
 * Feedback files: everything needed to reproduce and improve detection on a user's real photo,
 * packaged by the app ("Send feedback") and replayed by the developer tooling
 * (`npm run feedback:inspect`, bench/feedback.eval.ts). Plain JSON with base64 images, like the
 * puzzle export. Pure TypeScript (no DOM): used in the browser and in Node.
 */
import type { Quad } from '../cv/geometry';
import type { CaptureInfo, CellRef, CutStyle, GridSpec, PhysicalSize, PuzzleSide, ScanResult } from '../model/types';
import { base64ToBytes, bytesToBase64 } from '../storage/base64';

export const FEEDBACK_FORMAT = 'puzzle-solver-feedback';
/**
 * 2: 'wrong_fit' marks and the rejected spots of 'wrong_place' marks (noted while placing).
 * Version 1 files read as they are.
 */
export const FEEDBACK_VERSION = 2;

export interface FeedbackImage {
  /** MIME type, e.g. image/jpeg. */
  type: string;
  width: number;
  height: number;
  base64: string;
}

/**
 * A correction the user made on the scan photo. Coordinates and region ids refer to
 * `scan.photo` / `scan.result` (the image exactly as analysed).
 */
export type FeedbackMark =
  /** A piece at this point was not detected at all. */
  | { kind: 'missed'; x: number; y: number }
  /** This detected region is not a piece (background, shadow, glare, …). */
  | { kind: 'not_a_piece'; regionId: number }
  /** This region contains several pieces that were detected as one. */
  | { kind: 'merged'; regionId: number }
  /** The outline or corners of this piece are visibly wrong. */
  | { kind: 'bad_outline'; regionId: number }
  /**
   * The suggested place is wrong; `correct` when the user knows the right cell, `rejected` the
   * spots the user said it does not go in ("Not here"; missing in version 1 files).
   */
  | { kind: 'wrong_place'; regionId: number; correct?: CellRef; rejected?: RejectedSpot[] }
  /**
   * Two items the app said join do not fit together ("Doesn't fit"): their labels (region ids; an
   * assembled group's smallest one) and the sides of each that were said to touch, when known.
   */
  | { kind: 'wrong_fit'; a: number; b: number; sideA?: PuzzleSide; sideB?: PuzzleSide };

/** A cell (an assembled group's top-left cell) an item was shown at, with its turn. */
export interface RejectedSpot {
  row: number;
  col: number;
  rotationDeg?: number;
}

export type FeedbackMarkKind = FeedbackMark['kind'];

export interface FeedbackBundle {
  format: typeof FEEDBACK_FORMAT;
  version: number;
  /** Epoch milliseconds. */
  createdAt: number;
  app: {
    /** Build identifier (git commit) of the app that produced the file (see `scan.appVersion` for the analysis). */
    version: string;
    userAgent: string;
    viewport: { width: number; height: number; dpr: number };
    language?: string;
  };
  puzzle: {
    pieceCount: number;
    grid: GridSpec;
    cut: CutStyle;
    physicalSize?: PhysicalSize;
  };
  /** The rectified puzzle picture used for matching. */
  reference?: FeedbackImage;
  /** The box photo and the picture corners the user confirmed (ground truth for box detection). */
  box?: { photo: FeedbackImage; quad: Quad };
  scan?: {
    /** The analysed image; all coordinates in `result` and `marks` refer to it. */
    photo: FeedbackImage;
    /** What the app computed for this photo. */
    result: ScanResult;
    /**
     * Build (git commit) of the app that computed `result`. It can be older than `app.version` when
     * the app updated between the scan and the feedback; missing in files from before it was recorded.
     */
    appVersion?: string;
    /** When the photo was analysed (epoch milliseconds). */
    analysedAt?: number;
    /**
     * How the photo was captured (camera still / video frame because the still failed / a file) and
     * its size before it was scaled for analysis; missing in files from before it was recorded.
     */
    capture?: CaptureInfo;
    /** Placements the user confirmed with "Placed" (ground truth for matching). */
    placements: { regionId: number; cells: CellRef[] }[];
  };
  marks: FeedbackMark[];
  comment?: string;
}

/** Suggested file name, e.g. "puzzle-feedback-2026-10-17-1842.json". */
export function feedbackFileName(createdAt: number): string {
  const d = new Date(createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `puzzle-feedback-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

export function encodeFeedbackImage(bytes: Uint8Array, type: string, width: number, height: number): FeedbackImage {
  return { type, width, height, base64: bytesToBase64(bytes) };
}

export function decodeFeedbackImageBytes(img: FeedbackImage): Uint8Array {
  return base64ToBytes(img.base64);
}

export function serializeFeedback(bundle: FeedbackBundle): string {
  return JSON.stringify(bundle);
}

export class FeedbackFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackFormatError';
  }
}

/** Parse and validate a feedback file. Throws FeedbackFormatError for anything unexpected. */
export function parseFeedback(text: string): FeedbackBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FeedbackFormatError('Not a JSON file.');
  }
  const b = data as Partial<FeedbackBundle>;
  if (!b || typeof b !== 'object' || b.format !== FEEDBACK_FORMAT) throw new FeedbackFormatError('Not a puzzle-solver feedback file.');
  if (typeof b.version !== 'number' || b.version > FEEDBACK_VERSION) throw new FeedbackFormatError(`Unsupported feedback version ${String(b.version)}.`);
  if (!b.puzzle || !b.puzzle.grid || !Array.isArray(b.marks)) throw new FeedbackFormatError('Feedback file is incomplete.');
  const checkImage = (img: FeedbackImage | undefined, what: string) => {
    if (img && (typeof img.base64 !== 'string' || !(img.width > 0) || !(img.height > 0))) throw new FeedbackFormatError(`Invalid ${what} image.`);
  };
  checkImage(b.reference, 'reference');
  checkImage(b.box?.photo, 'box');
  checkImage(b.scan?.photo, 'scan');
  if (b.scan && (!b.scan.result || !Array.isArray(b.scan.result.regions))) throw new FeedbackFormatError('Invalid scan result.');
  for (const m of b.marks as unknown[]) {
    const mark = m as Record<string, unknown> | null;
    if (!mark || typeof mark !== 'object' || typeof mark.kind !== 'string') throw new FeedbackFormatError('Invalid mark.');
    if (mark.kind === 'wrong_fit' && (typeof mark.a !== 'number' || typeof mark.b !== 'number')) throw new FeedbackFormatError('Invalid “doesn’t fit” mark.');
    if (mark.kind === 'wrong_place' && mark.rejected !== undefined && !Array.isArray(mark.rejected)) throw new FeedbackFormatError('Invalid “wrong place” mark.');
  }
  return b as FeedbackBundle;
}
