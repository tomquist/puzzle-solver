/**
 * Matching: locate photographed pieces / patches in the reference picture and find fits.
 *
 * Typical use per scan: `buildReferenceIndex` once per puzzle (cache it), then
 * `matchRegions(index, inputs, opts)` for all regions of a scan (two passes with a scan-level colour
 * correction; `matchRegion` matches a single region), then `findFits(regions, matches, grid)`.
 */
export { buildReferenceIndex } from './referenceIndex';
export { matchRegion, cellAt, matchConfidence, CONFIDENT_THRESHOLD } from './matchRegion';
export { matchRegions, estimateColorCorrection } from './colorCorrection';
export { findFits, puzzleSideOf, profileMismatch } from './fits';
export type { MatchInput, MatchOptions, ReferenceIndex, RefLevel } from './types';
