/** Close-up registration and high-resolution reference compositing. */
export { registerCloseup, registerCloseupDetailed, type RegisterDiagnostics, type RegisterOptions } from './register';
export { composeHighRes, composeOutputSize, type CloseupInput, type ComposeHighResOptions } from './compose';
export { refineHomographyDirect, type DirectRefineOptions, type DirectRefineResult } from './refine';
export {
  analyzePhotometry,
  applyPhotometric,
  fitPhotometric,
  identityPhotometric,
  sampleConsistency,
  type ConsistencyMap,
  type PhotometricModel,
  type PhotometryResult,
} from './photometric';
