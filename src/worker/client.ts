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
    assessGrid: (ctx) => remote.assessGrid(ctx),
    remapGrid: (req) => remote.remapGrid(req),
  };
}

/**
 * A PipelineApi whose implementation module is loaded on first use, so the mock and the
 * main-thread pipeline stay out of the main bundle (the default worker build has its own chunk).
 */
function lazyPipeline(load: () => Promise<PipelineApi>): PipelineApi {
  let loaded: Promise<PipelineApi> | undefined;
  return new Proxy({} as PipelineApi, {
    get(_target, key: keyof PipelineApi) {
      return async (...args: unknown[]) => {
        loaded ??= load();
        const api = await loaded;
        return (api[key] as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}

function selectedMode(): 'worker' | 'mock' | 'local' {
  if (typeof location === 'undefined') return 'local';
  const mode = new URLSearchParams(location.search).get('pipeline');
  if (mode === 'mock' || mode === 'local') return mode;
  return typeof Worker === 'undefined' ? 'local' : 'worker';
}

/** `?mockGrid=34x45` (rows × columns): the grid the mock pipeline's scans measure (e2e of the grid suggestion). */
function mockGrid(): { rows: number; cols: number } | undefined {
  const m = /^(\d+)x(\d+)$/.exec(new URLSearchParams(location.search).get('mockGrid') ?? '');
  return m ? { rows: Number(m[1]), cols: Number(m[2]) } : undefined;
}

export function getPipeline(): PipelineApi {
  if (!instance) {
    const mode = selectedMode();
    instance =
      mode === 'mock' ? lazyPipeline(async () => (await import('./mockPipeline')).createMockPipeline({ measuredGrid: mockGrid() }))
      : mode === 'local' ? lazyPipeline(async () => (await import('./localPipeline')).createLocalPipeline())
      : createWorkerPipeline();
  }
  return instance;
}
