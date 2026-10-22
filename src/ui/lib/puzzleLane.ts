/**
 * One lane per puzzle for work that depends on the grid the pipeline matches with: a scan's
 * analysis (from loading the matcher to saving the scan) and a grid change (remapping the scans,
 * saving the puzzle, loading the matcher with the new grid, re-analysing scans). Without it a grid
 * change could load the new grid into the worker while a scan is analysed with the old one, or list
 * the scans just before that scan is saved and leave it on the old grid. Work in the lane runs one
 * after the other, in the order it was asked for; a failure does not block what follows.
 */
const lanes = new Map<string, Promise<void>>();

export function inPuzzleLane<T>(puzzleId: string, work: () => Promise<T>): Promise<T> {
  const before = lanes.get(puzzleId) ?? Promise.resolve();
  const run = before.then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(puzzleId, tail);
  void tail.then(() => {
    if (lanes.get(puzzleId) === tail) lanes.delete(puzzleId);
  });
  return run;
}
