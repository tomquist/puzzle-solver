/**
 * One scan, end to end: segment the photo into pieces/patches, analyse shapes and photo quality,
 * locate every region in the reference picture (optionally made consistent with the shape fits
 * between the scan's pieces) and derive fit hints.
 */
import type { RGBAImage } from '../cv/image';
import { convexHull, polygonArea } from '../cv/polygon';
import { limitSize } from '../cv/resize';
import type { CellRef, RegionMatch, ScanResult } from '../model/types';
import type { ProgressCallback } from '../worker/api';
import {
  buildGroups,
  enforceConsistency,
  findFits,
  matchRegionsDetailed,
  patchBodySize,
  placeByElimination,
  resolveCellClaims,
  sampleEdgeStrips,
  scorePlacement,
  shapeFits,
  type ConsistencyReport,
  type EdgeStrips,
  type FitOptions,
  type MatchDetail,
  type MatchInput,
  type ReferenceIndex,
  type ShapeMetric,
} from './match';
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
  segment?: Pick<SegmentOptions, 'graphCut' | 'grain'>;
  /**
   * Make the placements consistent with the shape fits between the scan's pieces before the fit
   * hints and groups are derived (match/consistency.ts; default {@link DEFAULT_CONSISTENCY}).
   */
  consistency?: boolean;
}

/**
 * Whether the consistency pass runs unless the caller chooses: off. In the scan benchmark only 11
 * of 29 shape fits are true neighbours (most pieces of a scan have no partner in it, so a mutually
 * best side is often a coincidence), too few to move a placement; the pass changes nothing in 32
 * of 33 scenes, and its one gain (starry-grey-neighbors top-1 0.586 → 0.638) comes from its
 * one-piece-per-cell rule, not from the fits.
 */
export const DEFAULT_CONSISTENCY = false;

export interface AnalyzeScanOutput {
  result: ScanResult;
  /** The (possibly downscaled) image all coordinates in `result` refer to. */
  analysedImage: RGBAImage;
  /** What the consistency pass did, when it ran. */
  consistency?: ConsistencyReport;
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
    table: s.table,
    outline: {
      borderTable: s.borderTable,
      issues: s.region.issues.map((i) => i.code),
      solidity: s.region.contour.length >= 3 ? s.region.area / Math.max(1, polygonArea(convexHull(s.region.contour))) : undefined,
    },
  }));
  const details = inputs.length > 0 ? matchRegionsDetailed(index, inputs, { placedCells: opts.placedCells }) : [];
  timings.match = now() - t;

  const byId = new Map<number, RegionMatch>(details.map((d) => [d.match.regionId, d.match]));
  const matches: RegionMatch[] = regions.map(
    (r) => byId.get(r.id) ?? { regionId: r.id, candidates: [], status: 'unmatched' },
  );

  report({ stage: 'fits', progress: 0.94, message: 'Checking which pieces fit together' });
  t = now();
  const sides = opts.sides ?? DEFAULT_SIDE_COMPARISON;
  // One distance cache for all calls below (the sides do not change between them).
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
  let consistency: ConsistencyReport | undefined;
  if (opts.consistency ?? DEFAULT_CONSISTENCY) {
    // Placements and shape fits made to agree; the hints and groups below then follow the new placements.
    const tc = now();
    const inputById = new Map<number, MatchInput>(inputs.map((inp) => [inp.regionId, inp]));
    const detailById = new Map<number, MatchDetail>(details.map((d) => [d.match.regionId, d]));
    consistency = enforceConsistency(regions, matches, shapeFits(regions, fitOptions), index.grid, {
      placedCells: opts.placedCells,
      score: (id, cell, rotationDeg) => {
        const inp = inputById.get(id), d = detailById.get(id);
        return inp && d ? scorePlacement(index, inp, d, cell, rotationDeg, { placedCells: opts.placedCells }) : null;
      },
    });
    timings.consistency = now() - tc;
  }
  // A confident loose piece on a cell a patch covers: the weaker placement gives way; the last free
  // cells go to the pieces without a confident place (claims.ts).
  resolveCellClaims(regions, matches);
  {
    const inputById = new Map<number, MatchInput>(inputs.map((inp) => [inp.regionId, inp]));
    const detailById = new Map<number, MatchDetail>(details.map((d) => [d.match.regionId, d]));
    placeByElimination(regions, matches, index.grid, opts.placedCells ?? [], (id, cell, rotationDeg) => {
      const inp = inputById.get(id), d = detailById.get(id);
      return inp && d ? scorePlacement(index, inp, d, cell, rotationDeg, { placedCells: opts.placedCells }) : null;
    });
  }
  // Groups first (they may place weak members of assembled grids), then the fit hints.
  // Without a single piece to measure, the patches' seams give the piece size.
  const pitches = inputs.map((inp) => patchBodySize(inp, index.cellW / index.cellH)).filter((b): b is number => b !== undefined).sort((a, b) => a - b);
  const bodySize = seg.medianBodySize ?? (pitches.length > 0 ? pitches[pitches.length >> 1] : undefined);
  const groups = buildGroups(regions, matches, findFits(regions, matches, index.grid, fitOptions), index.grid, {
    cellW: index.cellW,
    cellH: index.cellH,
    bodySize,
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
    consistency,
  };
}
