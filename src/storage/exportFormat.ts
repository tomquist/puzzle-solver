/**
 * The puzzle export file: a single JSON document holding the puzzle record, its progress, its
 * scans and every owned blob (base64). Import validates the file and re-keys everything with
 * fresh ids so a puzzle can be imported any number of times, also next to its original.
 */
import type { Id, PlacedCell, ProgressRecord, PuzzleRecord, ScanRecord } from '../model/types';
import { base64ToBytes, bytesToBase64 } from './base64';
import { emptyProgress, type StoredBlob } from './common';
import { newId } from './types';

export const EXPORT_FORMAT = 'puzzle-solver-export';
export const EXPORT_VERSION = 1;

/** Shape of an export file (version 1). */
export interface PuzzleExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** Epoch milliseconds. */
  exportedAt: number;
  puzzle: PuzzleRecord;
  progress: ProgressRecord;
  scans: ScanRecord[];
  blobs: Record<Id, { type: string; base64: string }>;
}

/** Everything belonging to one puzzle, as read from / written to a repository. */
export interface PuzzleBundle {
  puzzle: PuzzleRecord;
  progress: ProgressRecord;
  scans: ScanRecord[];
  blobs: StoredBlob[];
}

/** Thrown by `importPuzzle` when the file is not a valid export. `message` is user-presentable. */
export class PuzzleImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PuzzleImportError';
  }
}

/** Suggested download file name for an exported puzzle, e.g. `"Night Sky.puzzle.json"`. */
export function exportFileName(puzzleName: string): string {
  const base = puzzleName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'puzzle';
  return `${base.slice(0, 80)}.puzzle.json`;
}

/**
 * Serialises a bundle into an `application/json` Blob. The JSON is assembled from parts so large
 * blobs never need one giant intermediate string.
 */
export function encodePuzzleExport(bundle: PuzzleBundle, exportedAt = Date.now()): Blob {
  const head = JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    puzzle: bundle.puzzle,
    progress: bundle.progress,
    scans: bundle.scans,
  });
  const parts: string[] = [head.slice(0, -1), ',"blobs":{'];
  const seen = new Set<Id>();
  for (const blob of bundle.blobs) {
    if (seen.has(blob.id)) continue;
    parts.push(
      `${seen.size > 0 ? ',' : ''}${JSON.stringify(blob.id)}:{"type":${JSON.stringify(blob.type)},"base64":"`,
      bytesToBase64(new Uint8Array(blob.data)),
      '"}',
    );
    seen.add(blob.id);
  }
  parts.push('}}');
  return new Blob(parts, { type: 'application/json' });
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  throw new PuzzleImportError(message);
}

function requireString(o: JsonObject, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) fail(`Invalid puzzle file: ${where}.${key} is missing.`);
  return v;
}

function requireNumber(o: JsonObject, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`Invalid puzzle file: ${where}.${key} is missing.`);
  return v;
}

function requireObject(o: JsonObject, key: string, where: string): JsonObject {
  const v = o[key];
  if (!isObject(v)) fail(`Invalid puzzle file: ${where}.${key} is missing.`);
  return v;
}

/** Structural validation; afterwards the parts are treated as the typed records. */
function validate(root: unknown): PuzzleExportFile {
  if (!isObject(root) || root.format !== EXPORT_FORMAT) fail('This file is not a puzzle export.');
  const version = root.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('Invalid puzzle file: unknown format version.');
  }
  if (version > EXPORT_VERSION) {
    fail('This puzzle was exported by a newer version of the app. Please update the app and try again.');
  }

  const puzzle = requireObject(root, 'puzzle', 'file');
  requireString(puzzle, 'id', 'puzzle');
  if (typeof puzzle.name !== 'string') fail('Invalid puzzle file: puzzle.name is missing.');
  requireNumber(puzzle, 'pieceCount', 'puzzle');
  const grid = requireObject(puzzle, 'grid', 'puzzle');
  requireNumber(grid, 'rows', 'puzzle.grid');
  requireNumber(grid, 'cols', 'puzzle.grid');
  const reference = requireObject(puzzle, 'reference', 'puzzle');
  requireString(reference, 'blobId', 'puzzle.reference');
  requireString(puzzle, 'thumbnailBlobId', 'puzzle');
  if (!Array.isArray(puzzle.sources)) fail('Invalid puzzle file: puzzle.sources is missing.');
  puzzle.sources.forEach((s: unknown, i: number) => {
    if (!isObject(s)) fail(`Invalid puzzle file: puzzle.sources[${i}] is malformed.`);
    requireString(s, 'blobId', `puzzle.sources[${i}]`);
  });

  const scans = root.scans ?? [];
  if (!Array.isArray(scans)) fail('Invalid puzzle file: scans must be a list.');
  scans.forEach((s: unknown, i: number) => {
    if (!isObject(s)) fail(`Invalid puzzle file: scans[${i}] is malformed.`);
    requireString(s, 'id', `scans[${i}]`);
    requireString(s, 'photoBlobId', `scans[${i}]`);
    requireNumber(s, 'createdAt', `scans[${i}]`);
    requireObject(s, 'result', `scans[${i}]`);
  });

  const progress = root.progress ?? { placed: {}, updatedAt: 0 };
  if (!isObject(progress) || !isObject(progress.placed)) fail('Invalid puzzle file: progress is malformed.');
  for (const [key, cell] of Object.entries(progress.placed)) {
    if (!isObject(cell)) fail(`Invalid puzzle file: progress cell ${key} is malformed.`);
  }

  const blobs = requireObject(root, 'blobs', 'file');
  for (const [id, entry] of Object.entries(blobs)) {
    if (!isObject(entry) || typeof entry.type !== 'string' || typeof entry.base64 !== 'string') {
      fail(`Invalid puzzle file: image ${id} is malformed.`);
    }
  }

  return { ...root, scans, progress, blobs } as unknown as PuzzleExportFile;
}

/** `name`, or `name (imported)` / `name (imported 2)` … when that name is already taken. */
function uniqueName(name: string, existing: ReadonlySet<string>): string {
  if (!existing.has(name)) return name;
  let candidate = `${name} (imported)`;
  for (let i = 2; existing.has(candidate); i++) candidate = `${name} (imported ${i})`;
  return candidate;
}

/**
 * Parses and validates an export file and returns its contents re-keyed with fresh ids for the
 * puzzle, every scan and every blob (all cross references rewritten). Blobs in the file that
 * nothing references are dropped. `updatedAt` of the puzzle is set to `now`.
 *
 * @throws PuzzleImportError when the file is not a valid export.
 */
export async function decodePuzzleExport(
  file: Blob,
  existingNames: Iterable<string> = [],
  now = Date.now(),
): Promise<PuzzleBundle> {
  let root: unknown;
  try {
    root = JSON.parse(await file.text());
  } catch {
    fail('This file is not a puzzle export (it could not be read as JSON).');
  }
  const data = validate(root);

  const blobIdMap = new Map<Id, Id>();
  const mapBlob = (oldId: Id): Id => {
    let id = blobIdMap.get(oldId);
    if (id === undefined) {
      id = newId();
      blobIdMap.set(oldId, id);
    }
    return id;
  };

  const puzzleId = newId();
  const src = data.puzzle;
  const puzzle: PuzzleRecord = {
    ...src,
    id: puzzleId,
    name: uniqueName(src.name, new Set(existingNames)),
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : now,
    updatedAt: now,
    reference: { ...src.reference, blobId: mapBlob(src.reference.blobId) },
    thumbnailBlobId: mapBlob(src.thumbnailBlobId),
    sources: src.sources.map((s) => ({ ...s, blobId: mapBlob(s.blobId) })),
  };

  const scanIdMap = new Map<Id, Id>();
  const scans: ScanRecord[] = data.scans.map((s) => {
    const id = newId();
    scanIdMap.set(s.id, id);
    return { ...s, id, puzzleId, photoBlobId: mapBlob(s.photoBlobId) };
  });

  const placed: Record<string, PlacedCell> = {};
  for (const [key, cell] of Object.entries(data.progress.placed)) {
    const { scanId, ...rest } = cell;
    const mapped = scanId === undefined ? undefined : scanIdMap.get(scanId);
    // A reference to a scan that is not in the file cannot be kept: drop it.
    placed[key] = mapped === undefined ? rest : { ...rest, scanId: mapped };
  }
  const progress: ProgressRecord = {
    ...emptyProgress(puzzleId),
    updatedAt: typeof data.progress.updatedAt === 'number' ? data.progress.updatedAt : 0,
    placed,
  };

  const blobs: StoredBlob[] = [];
  for (const [oldId, entry] of Object.entries(data.blobs)) {
    const id = blobIdMap.get(oldId);
    if (id === undefined) continue;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = base64ToBytes(entry.base64);
    } catch {
      fail(`Invalid puzzle file: image ${oldId} is corrupted.`);
    }
    blobs.push({ id, type: entry.type, data: bytes.buffer, size: bytes.byteLength, createdAt: now });
  }

  return { puzzle, progress, scans, blobs };
}
