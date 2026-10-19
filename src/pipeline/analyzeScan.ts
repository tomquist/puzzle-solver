/**
 * One scan, end to end: segment the photo into pieces/patches, analyse shapes and photo quality,
 * locate every region in the reference picture and derive fit hints.
 */
import type { RGBAImage } from '../cv/image';
import { convexHull, polygonArea } from '../cv/polygon';
import { limitSize } from '../cv/resize';
import type { CellRef, RegionMatch, ScanResult } from '../model/types';
import type { ProgressCallback } from '../worker/api';
import { buildGroups, findFits, matchRegions, sampleEdgeStrips, type EdgeStrips, type FitOptions, type MatchInput, type ReferenceIndex, type ShapeMetric } from './match';
import { resolveRegionIssues, segmentPieces, type SegmentOptions } from './pieces';

/** How the fit hints compare piece sides (see `FitOptions`). */
export interface SideComparison {
  /** Side shape comparison. */
  shape?: ShapeMetric;
  /** DTW band in profile samples. */
  band?: number;
  /** Compare the colours just inside the sides too (samples each piece's edge strips). */
  colour?: boolean;
  /** Share of colour in the side distance. */
  colourShare?: number;
}

/**
 * Side comparison of the fit hints unless the caller chooses one: DTW of the profiles with the tilt
 * of a misplaced corner removed. In bench/sides.eval.ts the true partner is among the five closest
 * sides more often than point by point (0.49 vs 0.40; first as often), and with corners a few
 * pixels off it holds up better (top-1 0.11 vs 0.05, top-5 0.33 vs 0.19); the scan benchmark keeps
 * no wrong shape hint. Colour strips stay off: they find partners well on synthetic scans but add
 * no correct hint there, and real photos are untested.
 */
export const DEFAULT_SIDE_COMPARISON: SideComparison = { shape: 'dtw-levelled', colour: false };

export interface AnalyzeScanOptions {
  placedCells?: CellRef[];
  /** Longest side the photo is reduced to before analysis (default 2400). */
  maxSide?: number;
  onProgress?: ProgressCallback;
  /** Side comparison for the fit hints (default {@link DEFAULT_SIDE_COMPARISON}). */
  sides?: SideComparison;
  /** Segmentation switches (A/B runs of the benchmark). */
  segment?: Pick<SegmentOptions, 'graphCut'>;
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
  const seg = segmentPieces(image, { ...opts.segment, timings });
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
  const sides = opts.sides ?? DEFAULT_SIDE_COMPARISON;
  // One distance cache for both calls below (the sides do not change between them).
  const fitOptions: FitOptions = { shape: sides.shape, band: sides.band, colourShare: sides.colourShare, cache: new WeakMap() };
  if (sides.colour) {
    // Colour strips just inside the sides of single pieces (a few hundred Lab samples per piece).
    const ts = now();
    const strips = new Map<number, EdgeStrips>();
    for (const s of seg.regions) {
      const shape = s.region.kind === 'piece' ? s.region.shape : undefined;
      if (!shape) continue;
      const st = sampleEdgeStrips(s.image, s.mask, { x: s.region.bbox.x, y: s.region.bbox.y }, s.region.contour, shape);
      if (st) strips.set(s.region.id, st);
    }
    fitOptions.strips = strips;
    timings.strips = now() - ts;
  }
  // Groups first (they may place weak members of assembled grids), then the fit hints.
  const groups = buildGroups(regions, matches, findFits(regions, matches, index.grid, fitOptions), index.grid, {
    cellW: index.cellW,
    cellH: index.cellH,
    bodySize: seg.medianBodySize,
  });
  const fits = findFits(regions, matches, index.grid, fitOptions);
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
