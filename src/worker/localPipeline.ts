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
import type { GridEvidence } from '../model/types';
import type { PipelineApi } from './api';
import { gridVerdict, remapGrid } from './gridOps';

interface LoadedReference {
  key: string;
  index: ReferenceIndex;
}

/** Deferred cell-size measurements kept at once (a scan taken while three wait drops the oldest). */
const MAX_FOLLOW_UPS = 3;

export function createLocalPipeline(): PipelineApi {
  const references = new Map<string, LoadedReference>();
  // Deferred cell-size measurements (analyzeScan `gridFollowUp`), by token, oldest first; a few at
  // most (each holds its scan's regions).
  const followUps = new Map<string, Generator<void, GridEvidence, void>>();
  let followUpSeq = 0;

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
      const out = analyzeScan(ref.index, photo, {
        placedCells: options?.placedCells,
        maxSide: options?.maxSide,
        gridProbe: options?.gridProbe,
        // The result first; the cell-size measurement and probe after it, in steps.
        deferGridEvidence: true,
        onProgress,
      });
      let gridFollowUp: string | undefined;
      if (out.gridFollowUp) {
        gridFollowUp = `grid-${++followUpSeq}`;
        followUps.set(gridFollowUp, out.gridFollowUp);
        for (const key of followUps.keys()) if (followUps.size > MAX_FOLLOW_UPS) followUps.delete(key);
      }
      return { result: out.result, analysedImage: out.analysedImage, gridFollowUp };
    },

    async assessFrame(frame) {
      return assessFrame(frame);
    },

    async assessGrid(ctx) {
      return gridVerdict(ctx);
    },

    async remapGrid(req) {
      return remapGrid(req);
    },

    async gridFollowUpStep(token) {
      const steps = followUps.get(token);
      if (!steps) return { done: true };
      const r = steps.next();
      if (!r.done) return { done: false };
      followUps.delete(token);
      return { done: true, evidence: r.value };
    },
  };
}
