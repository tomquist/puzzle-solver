/**
 * The UI's single entry point to image processing. Components get the pipeline through
 * `usePipeline()` (src/ui/context), which calls `getPipeline()`.
 *
 * For now this returns the in-thread mock (`createMockPipeline`); the integration step swaps in
 * the Comlink-wrapped Web Worker here without any UI change.
 */
import type { PipelineApi } from './api';
import { createMockPipeline } from './mockPipeline';

let instance: PipelineApi | undefined;

export function getPipeline(): PipelineApi {
  instance ??= createMockPipeline();
  return instance;
}
