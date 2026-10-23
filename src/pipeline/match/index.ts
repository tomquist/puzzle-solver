/**
 * Matching: locate photographed pieces / patches in the reference picture and find fits.
 *
 * Typical use per scan: `buildReferenceIndex` once per puzzle (cache it), then
 * `matchRegions(index, inputs, opts)` for all regions of a scan (two passes with a scan-level colour
 * correction; `matchRegion` matches a single region), then `findFits(regions, matches, grid)` and
 * `buildGroups(...)` (assembled grids, loose neighbours; may place weak members of assembled grids).
 */
export { buildReferenceIndex, withCells } from './referenceIndex';
export { matchRegion, cellAt, patchCellAt, type CandidatePlacement,matchConfidence, patchBodySize, scorePlacement, CONFIDENT_THRESHOLD, type MatchDetail } from './matchRegion';
export { matchRegions, matchRegionsDetailed, estimateColorCorrection, firstMatchPass, type FirstPass } from './colorCorrection';
export { findFits, shapeFits, neighboursAgree, puzzleSideOf, profileMismatch, sideMismatch, type FitOptions, type ShapeFit, type ShapeMetric } from './fits';
export { enforceConsistency, impliedPlacement, type ConsistencyChange, type ConsistencyOptions, type ConsistencyReport } from './consistency';
export { sampleEdgeStrips, type EdgeStrips } from './edgeStrips';
export { dtwDistance, profileMismatchDtw, stripMismatch } from './sideCompare';
export { buildGroups, type GroupOptions } from './groups';
export { CLAIM_SLACK, duplicateClaims, placeByElimination, resolveCellClaims, uniqueCells, type CellClaimChange, type EliminationChange, type UniqueCellChange } from './claims';
export type { MatchInput, MatchOptions, ReferenceIndex, RefLevel } from './types';
