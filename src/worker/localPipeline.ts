/**
 * The real PipelineApi implementation. It is plain TypeScript, so the same object runs inside the
 * Web Worker (pipeline.worker.ts) and, for tests or as a fallback, on the calling thread.
 */
import { resizeRGBA } from '../cv/resize';
import { rectifyQuad } from '../cv/warp';
import { analyzeScan } from '../pipeline/analyzeScan';
import { detectBox, suggestRectifiedSize } from '../pipeline/box';
import { buildReferenceIndex, type ReferenceIndex } from '../pipeline/match';
import { assessFrame } from '../pipeline/pieces';
import { composeHighRes, registerCloseup } from '../pipeline/stitch';
import type { PipelineApi } from './api';

interface LoadedReference {
  key: string;
  index: ReferenceIndex;
}

export function createLocalPipeline(): PipelineApi {
  const references = new Map<string, LoadedReference>();

  return {
    async detectBox(photo) {
      return detectBox(photo);
    },

    async suggestRectifiedSize(quad, aspect, maxSide) {
      return suggestRectifiedSize(quad, aspect, maxSide);
    },

    async rectify(photo, quad, width, height) {
      return rectifyQuad(photo, quad, width, height);
    },

    async registerCloseup(reference, closeup) {
      return registerCloseup(reference, closeup);
    },

    async composeHighRes(reference, closeups, options) {
      if (closeups.length === 0) {
        const s = Math.max(1, options.scale);
        return resizeRGBA(reference, reference.width * s, reference.height * s);
      }
      return composeHighRes(reference, closeups, options);
    },

    async loadReference(puzzleId, reference, grid, cut) {
      const key = `${reference.width}x${reference.height}|${grid.rows}x${grid.cols}|${cut}`;
      const existing = references.get(puzzleId);
      if (existing && existing.key === key) return;
      // Only one puzzle is worked on at a time; keep memory bounded.
      references.clear();
      references.set(puzzleId, { key, index: buildReferenceIndex(reference, grid, cut) });
    },

    async hasReference(puzzleId) {
      return references.has(puzzleId);
    },

    async analyzeScan(puzzleId, photo, options, onProgress) {
      const ref = references.get(puzzleId);
      if (!ref) throw new Error('The puzzle picture is not loaded yet. Open the puzzle again and retry.');
      return analyzeScan(ref.index, photo, {
        placedCells: options?.placedCells,
        maxSide: options?.maxSide,
        onProgress,
      });
    },

    async assessFrame(frame) {
      return assessFrame(frame);
    },
  };
}
