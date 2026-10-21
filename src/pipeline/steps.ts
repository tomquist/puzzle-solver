/**
 * Work in steps: a generator that yields between parts of a long computation, so a caller can run
 * it after something more urgent (the app runs a scan's cell-size measurement after its result,
 * one step per worker call, and lets a new scan go between steps). Running all steps at once gives
 * exactly what the plain function gives.
 */
export type Steps<T> = Generator<void, T, void>;

/** Run a step generator to its end. */
export function runSteps<T>(steps: Steps<T>): T {
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}
