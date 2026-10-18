/**
 * Turn a feedback file into a puzzle export the app can import (Home → Import), to look at a user's
 * scan in the app exactly as they saw it: the stored result is shown as is, nothing re-analysed.
 * Needs the puzzle picture (files stripped with feedback:strip lack it).
 *
 *   npm run feedback:to-puzzle -- <feedback.json> <out.puzzle.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseFeedback, type FeedbackImage } from '../src/feedback/format';
import type { ScanRecord } from '../src/model/types';
import { EXPORT_FORMAT, EXPORT_VERSION, type PuzzleExportFile } from '../src/storage/exportFormat';

function main(argv: string[]): number {
  const [input, output] = argv.filter((a) => a !== '--');
  if (!input || !output) {
    console.error('usage: npm run feedback:to-puzzle -- <feedback.json> <out.puzzle.json>');
    return 1;
  }
  const b = parseFeedback(readFileSync(input, 'utf8'));
  if (!b.reference) {
    console.error(`${input}: no puzzle picture in the file (stripped?) – the app needs it`);
    return 1;
  }
  const blobs: PuzzleExportFile['blobs'] = {};
  const blob = (id: string, img: FeedbackImage) => {
    blobs[id] = { type: img.type, base64: img.base64 };
    return id;
  };
  const now = Date.now();
  const scans: ScanRecord[] = [];
  if (b.scan) {
    scans.push({
      id: 'scan1',
      puzzleId: 'p1',
      createdAt: b.scan.analysedAt ?? b.createdAt,
      photoBlobId: blob('scan-photo', b.scan.photo),
      width: b.scan.photo.width,
      height: b.scan.photo.height,
      result: b.scan.result,
      ...(b.scan.appVersion ? { appVersion: b.scan.appVersion } : {}),
    });
  }
  const file: PuzzleExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    puzzle: {
      id: 'p1',
      name: `Feedback ${new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`,
      createdAt: b.createdAt,
      updatedAt: now,
      pieceCount: b.puzzle.pieceCount,
      ...(b.puzzle.physicalSize ? { physicalSize: b.puzzle.physicalSize } : {}),
      grid: b.puzzle.grid,
      cut: b.puzzle.cut,
      reference: { blobId: blob('reference', b.reference), width: b.reference.width, height: b.reference.height },
      // The reference doubles as the list thumbnail (the app shows it scaled down).
      thumbnailBlobId: 'reference',
      sources: [],
    },
    progress: { puzzleId: 'p1', placed: {}, updatedAt: 0 },
    scans,
    blobs,
  };
  writeFileSync(output, JSON.stringify(file));
  console.log(`${output}: ${scans.length} scan(s), ${b.scan?.result.regions.length ?? 0} regions, grid ${b.puzzle.grid.rows}x${b.puzzle.grid.cols}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
