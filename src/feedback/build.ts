/**
 * Assemble a FeedbackBundle from what the app has stored about a puzzle and a scan. Pure (no DOM):
 * the caller reads the blobs into bytes and supplies the browser facts.
 */
import type { Quad } from '../cv/geometry';
import type { CellRef, Id, ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';
import { encodeFeedbackImage, FEEDBACK_FORMAT, FEEDBACK_VERSION, type FeedbackBundle, type FeedbackMark } from './format';

export interface ImageBytes {
  bytes: Uint8Array;
  type: string;
  width: number;
  height: number;
}

export interface FeedbackInputs {
  createdAt: number;
  app: FeedbackBundle['app'];
  /** Only technical fields are copied (never the puzzle's name). */
  puzzle: Pick<PuzzleRecord, 'pieceCount' | 'grid' | 'cut' | 'physicalSize'>;
  /** The rectified reference picture. */
  reference?: ImageBytes;
  /** The overview box photo and the picture corners the user confirmed. */
  box?: ImageBytes & { quad: Quad };
  /** The analysed scan photo and its stored record. */
  scan?: { record: ScanRecord; photo: ImageBytes };
  /** Solving progress; placements confirmed for `scan` become ground truth. */
  progress?: ProgressRecord;
  marks: FeedbackMark[];
  comment?: string;
}

/**
 * Cells the user confirmed with "Placed" for one scan, grouped by the region id stored with them
 * (for an assembled grid that is the grid's badge number, with all its cells), sorted.
 */
export function placementsForScan(progress: ProgressRecord | undefined, scanId: Id): { regionId: number; cells: CellRef[] }[] {
  if (!progress) return [];
  const byRegion = new Map<number, CellRef[]>();
  for (const [key, entry] of Object.entries(progress.placed)) {
    if (entry.scanId !== scanId || typeof entry.regionId !== 'number') continue;
    const [row, col] = key.split(',').map(Number);
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    const list = byRegion.get(entry.regionId) ?? [];
    list.push({ row, col });
    byRegion.set(entry.regionId, list);
  }
  return [...byRegion.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([regionId, cells]) => ({ regionId, cells: cells.sort((a, b) => a.row - b.row || a.col - b.col) }));
}

const image = (i: ImageBytes) => encodeFeedbackImage(i.bytes, i.type, i.width, i.height);

export function buildFeedbackBundle(input: FeedbackInputs): FeedbackBundle {
  const { puzzle } = input;
  const comment = input.comment?.trim();
  const bundle: FeedbackBundle = {
    format: FEEDBACK_FORMAT,
    version: FEEDBACK_VERSION,
    createdAt: input.createdAt,
    app: input.app,
    puzzle: {
      pieceCount: puzzle.pieceCount,
      grid: { rows: puzzle.grid.rows, cols: puzzle.grid.cols },
      cut: puzzle.cut,
      ...(puzzle.physicalSize ? { physicalSize: { ...puzzle.physicalSize } } : {}),
    },
    marks: input.marks.map((m) => ({ ...m })),
  };
  if (input.reference) bundle.reference = image(input.reference);
  if (input.box) bundle.box = { photo: image(input.box), quad: input.box.quad.map((p) => ({ x: p.x, y: p.y })) as Quad };
  if (input.scan) {
    bundle.scan = {
      photo: image(input.scan.photo),
      result: input.scan.record.result,
      placements: placementsForScan(input.progress, input.scan.record.id),
    };
  }
  if (comment) bundle.comment = comment;
  return bundle;
}

/** Approximate size of the serialized file in bytes (JSON is ASCII apart from the comment). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
