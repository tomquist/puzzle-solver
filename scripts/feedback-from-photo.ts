/**
 * Wrap a table photo that was not taken with the app (e.g. a freely licensed third-party photo, see
 * test-corpus/CREDITS.md) into a scan-only feedback file, so the feedback tooling (replay,
 * inspector, answer keys in `<name>.review.json`, bench/feedback.eval.ts) works on it.
 *
 *   npm run feedback:from-photo -- <photo.jpg> <out.json> [--pieces <n>] [--comment <text>]
 *
 * The photo is reduced to the app's analysis size (longest side 2400 px, as analyzeScan does) and
 * then stored as the analysed scan photo: unchanged bytes when it is already small enough, else the
 * reduced image re-encoded as JPEG (quality 92). The stored result is the current segmentation
 * (there is no reference picture, so nothing is matched); the file has no marks, only the answer
 * key in the review counts. The user agent says the photo is third-party, so it is decoded with
 * jpeg-js (not Chromium) everywhere.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { limitSize } from '../src/cv/resize';
import { encodeFeedbackImage, FEEDBACK_FORMAT, FEEDBACK_VERSION, serializeFeedback, type FeedbackBundle } from '../src/feedback/format';
import { segmentPieces } from '../src/pipeline/pieces';
import { SEGMENT_OPTIONS } from '../src/testing/nodeImageIO';

/** Longest side the app analyses (AnalyzeScanOptions.maxSide default). */
const MAX_SIDE = 2400;
const THIRD_PARTY_USER_AGENT = 'third-party photo (not taken with the app)';

function gitVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main(argv: string[]): number {
  const args = argv.filter((a) => a !== '--');
  const positional: string[] = [];
  let pieces = 0;
  let comment: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pieces') pieces = Number(args[++i]);
    else if (args[i] === '--comment') comment = args[++i];
    else positional.push(args[i]);
  }
  const [input, output] = positional;
  if (!input || !output || !/\.jpe?g$/i.test(input) || !(pieces >= 0)) {
    console.error('usage: npm run feedback:from-photo -- <photo.jpg> <out.json> [--pieces <n>] [--comment <text>]');
    return 1;
  }
  const bytes = readFileSync(input);
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  const full = { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length) };
  const { image, scale } = limitSize(full, MAX_SIDE);
  const stored = scale === 1 ? new Uint8Array(bytes) : jpeg.encode({ width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length) }, 92).data;
  const photo = encodeFeedbackImage(stored, 'image/jpeg', image.width, image.height);
  // The stored photo is analysed as decoded from the file (as the replay will).
  const decoded = scale === 1 ? image : (() => {
    const d = jpeg.decode(stored, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
    return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length) };
  })();
  const timings: Record<string, number> = {};
  const seg = segmentPieces(decoded, { ...SEGMENT_OPTIONS, timings });
  const version = gitVersion();
  const now = Date.now();
  const side = Math.max(1, Math.round(Math.sqrt(pieces || 1)));
  const bundle: FeedbackBundle = {
    format: FEEDBACK_FORMAT,
    version: FEEDBACK_VERSION,
    createdAt: now,
    app: { version, userAgent: THIRD_PARTY_USER_AGENT, viewport: { width: 0, height: 0, dpr: 1 } },
    // Unknown puzzle: the grid only matters for matching, which needs a reference picture.
    puzzle: { pieceCount: pieces, grid: { rows: side, cols: Math.max(1, Math.round((pieces || 1) / side)) }, cut: 'grid' },
    scan: {
      photo,
      result: {
        width: decoded.width, height: decoded.height,
        regions: seg.regions.map((r) => r.region),
        matches: seg.regions.map((r) => ({ regionId: r.region.id, candidates: [], status: 'unmatched' as const })),
        fits: [], groups: [], quality: seg.quality, timings,
      },
      appVersion: version,
      analysedAt: now,
      placements: [],
    },
    marks: [],
    comment,
  };
  const text = serializeFeedback(bundle);
  writeFileSync(output, text);
  const how = scale === 1 ? 'original bytes' : `reduced from ${full.width}x${full.height}, JPEG q92`;
  console.log(`${output}: ${(text.length / 1e6).toFixed(1)} MB; photo ${image.width}x${image.height} (${how}); ${seg.regions.length} regions`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
