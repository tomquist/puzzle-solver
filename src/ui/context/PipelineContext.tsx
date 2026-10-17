import { createContext, use, type ReactNode } from 'react';
import type { PipelineApi } from '../../worker/api';
import { getPipeline } from '../../worker/client';

const PipelineContext = createContext<PipelineApi | null>(null);

/** Provides the image-processing pipeline (`getPipeline()`); tests may inject another one. */
export function PipelineProvider({ pipeline, children }: { pipeline?: PipelineApi; children: ReactNode }) {
  return <PipelineContext value={pipeline ?? getPipeline()}>{children}</PipelineContext>;
}

export function usePipeline(): PipelineApi {
  const p = use(PipelineContext);
  if (!p) throw new Error('usePipeline must be used inside <PipelineProvider>');
  return p;
}
