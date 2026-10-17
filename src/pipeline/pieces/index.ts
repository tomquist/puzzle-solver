/**
 * Pieces: segmentation of scan photos into pieces / patches, piece shape analysis and photo
 * quality (scan + live camera frame).
 */
export { segmentPieces } from './segment';
export { analyzePieceShape, bodyOrientation, dominantOrientation, orientationHistogram, sideProfile, type ShapeOptions } from './shape';
export { assessPhoto, assessFrame, outlineEdgeWidths, QUALITY_THRESHOLDS, resolveRegionIssues, type EdgeWidthStats } from './quality';
export { backgroundAt, fitBackground, foregroundScore, lightingRatio } from './background';
export type { BackgroundModel, SegmentOptions, Segmentation, SegmentedRegion } from './types';
