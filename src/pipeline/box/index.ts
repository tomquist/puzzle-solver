/**
 * Box package: find the puzzle picture on a photo of the box, size/rotate the rectified output and
 * judge the quality of the box photo and of the rectified reference.
 */
export { detectBox, type DetectBoxOptions } from './detectBox';
export { estimateQuadAspect, rotateQuad, suggestRectifiedSize } from './geometry';
export { assessReference, BOX_QUALITY } from './quality';
