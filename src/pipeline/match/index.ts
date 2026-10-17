/**
 * Matching: locate photographed pieces / patches in the reference picture and find fits.
 */
export { buildReferenceIndex } from './referenceIndex';
export { matchRegion, cellAt, matchConfidence } from './matchRegion';
export { findFits } from './fits';
export type { MatchInput, MatchOptions, ReferenceIndex, RefLevel } from './types';
export { matchRegions, estimateColorCorrection } from './colorCorrection';
