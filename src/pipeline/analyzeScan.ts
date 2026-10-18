/**
 * One scan, end to end: segment the photo into pieces/patches, analyse shapes and photo quality,
 * locate every region in the reference picture and derive fit hints.
 */
import type { RGBAImage } from '../cv/image';
import { convexHull, polygonArea } from '../cv/polygon';
import { limitSize } from '../cv/resize';
import type { CellRef, RegionMatch, ScanResult } from '../model/types';
import type { ProgressCallback } from '../worker/api';
import { buildGroups, findFits, matchRegions, type MatchInput, type ReferenceIndex } from './match';
import { resolveRegionIssues, segmentPieces } from './pieces';

export interface AnalyzeScanOptions {
  placedCells?: CellRef[];
  /** Longest side the photo is reduced to before analysis (default 2400). */
  maxSide?: number;
  onProgress?: ProgressCallback;
}

export interface AnalyzeScanOutput {
  result: ScanResult;
  /** The (possibly downscaled) image all coordinates in `result` refer to. */
  analysedImage: RGBAImage;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function analyzeScan(index: ReferenceIndex, photo: RGBAImage, opts: AnalyzeScanOptions = {}): AnalyzeScanOutput {
  const report = opts.onProgress ?? (() => {});
  const timings: Record<string, number> = {};
  const tStart = now();

  report({ stage: 'prepare', progress: 0.02, message: 'Preparing photo' });
  const { image } = limitSize(photo, opts.maxSide ?? 2400);

  report({ stage: 'segment', progress: 0.08, message: 'Finding pieces' });
  let t = now();
  const seg = segmentPieces(image, { timings });
  timings.segment = now() - t;

  const regions = seg.regions.map((s) => s.region);
  const matchable = seg.regions.filter((s) => s.region.kind !== 'unknown');
  report({
    stage: 'match',
    progress: 0.4,
    message: matchable.length === 1 ? 'Locating 1 piece' : `Locating ${matchable.length} pieces`,
  });
  t = now();
  const inputs: MatchInput[] = matchable.map((s) => ({
    regionId: s.region.id,
    kind: s.region.kind,
    image: s.image,
    mask: s.mask,
    origin: { x: s.region.bbox.x, y: s.region.bbox.y },
    shape: s.region.shape,
    orientationDeg: s.region.orientationDeg,
    expectedBodySize: seg.medianBodySize,
    outline: {
      borderTable: s.borderTable,
      issues: s.region.issues.map((i) => i.code),
      solidity: s.region.contour.length >= 3 ? s.region.area / Math.max(1, polygonArea(convexHull(s.region.contour))) : undefined,
    },
  }));
  const matched = inputs.length > 0 ? matchRegions(index, inputs, { placedCells: opts.placedCells }) : [];
  timings.match = now() - t;

  const byId = new Map<number, RegionMatch>(matched.map((m) => [m.regionId, m]));
  const matches: RegionMatch[] = regions.map(
    (r) => byId.get(r.id) ?? { regionId: r.id, candidates: [], status: 'unmatched' },
  );

  report({ stage: 'fits', progress: 0.94, message: 'Checking which pieces fit together' });
  t = now();
  // Groups first (they may place weak members of assembled grids), then the fit hints.
  const groups = buildGroups(regions, matches, findFits(regions, matches, index.grid), index.grid, {
    cellW: index.cellW,
    cellH: index.cellH,
    bodySize: seg.medianBodySize,
  });
  const fits = findFits(regions, matches, index.grid);
  timings.fits = now() - t;
  // A region placed confidently was evidently segmented well enough: no low-contrast warning for it.
  resolveRegionIssues(seg, new Set(matches.filter((m) => m.status === 'confident').map((m) => m.regionId)), ['low_contrast']);
  timings.total = now() - tStart;

  report({ stage: 'done', progress: 1 });
  return {
    result: {
      width: image.width,
      height: image.height,
      regions,
      matches,
      fits,
      groups,
      quality: seg.quality,
      timings,
    },
    analysedImage: image,
  };
}
