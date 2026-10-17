/**
 * The UI's single entry point to image processing. Components get the pipeline through
 * `usePipeline()` (src/ui/context), which calls `getPipeline()`.
 *
 * By default the real pipeline runs in a Web Worker (Comlink). Add `?pipeline=mock` to the page URL
 * to use the deterministic in-thread mock (UI development and UI-only e2e tests), or
 * `?pipeline=local` to run the real pipeline on the main thread (debugging).
 */
import * as Comlink from 'comlink';
import type { RGBAImage } from '../cv/image';
import type { PipelineApi } from './api';
import { createLocalPipeline } from './localPipeline';
import { createMockPipeline } from './mockPipeline';

let instance: PipelineApi | undefined;

function transfer<T extends RGBAImage>(img: T): T {
  // Callers clone images they still need, so the buffer can be moved instead of copied.
  return Comlink.transfer(img, [img.data.buffer]);
}

function createWorkerPipeline(): PipelineApi {
  const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module', name: 'pipeline' });
  const remote = Comlink.wrap<PipelineApi>(worker);
  return {
    detectBox: (photo) => remote.detectBox(photo),
    suggestRectifiedSize: (quad, aspect, maxSide) => remote.suggestRectifiedSize(quad, aspect, maxSide),
    rectify: (photo, quad, width, height) => remote.rectify(photo, quad, width, height),
    registerCloseup: (reference, closeup) => remote.registerCloseup(reference, closeup),
    composeHighRes: (reference, closeups, options) => remote.composeHighRes(reference, closeups, options),
    loadReference: (puzzleId, reference, grid, cut) => remote.loadReference(puzzleId, reference, grid, cut),
    hasReference: (puzzleId) => remote.hasReference(puzzleId),
    analyzeScan: (puzzleId, photo, options, onProgress) =>
      remote.analyzeScan(puzzleId, transfer(photo), options, onProgress ? Comlink.proxy(onProgress) : undefined),
    assessFrame: (frame) => remote.assessFrame(transfer(frame)),
  };
}

function selectedMode(): 'worker' | 'mock' | 'local' {
  if (typeof location === 'undefined') return 'local';
  const mode = new URLSearchParams(location.search).get('pipeline');
  if (mode === 'mock' || mode === 'local') return mode;
  return typeof Worker === 'undefined' ? 'local' : 'worker';
}

export function getPipeline(): PipelineApi {
  if (!instance) {
    const mode = selectedMode();
    instance = mode === 'mock' ? createMockPipeline() : mode === 'local' ? createLocalPipeline() : createWorkerPipeline();
  }
  return instance;
}
