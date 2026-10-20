/**
 * Pieces: segmentation of scan photos into pieces / patches, piece shape analysis and photo
 * quality (scan + live camera frame).
 */
export { segmentPieces } from './segment';
export { estimatePatchPitch, type PatchPitch } from './patchPitch';
export { analyzePieceShape, bodyOrientation, dominantOrientation, orientationHistogram, sideProfile, sideProfilesAt, type ShapeOptions } from './shape';
export { assessPhoto, assessFrame, outlineEdgeWidths, QUALITY_THRESHOLDS, resolveRegionIssues, type EdgeWidthStats } from './quality';
export { backgroundAt, fitBackground, foregroundScore, lightingRatio } from './background';
export type { BackgroundModel, RegionDiagnostics, SegmentDiagnostics, SegmentOptions, Segmentation, SegmentedRegion } from './types';
