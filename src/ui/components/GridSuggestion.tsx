/**
 * The grid question and its follow-ups, shared by the workspace and the scan result: a small card
 * when the scans measure another grid than the puzzle's ("Your pieces measure 45 × 34, not 44 × 34"),
 * a strip while scans are brought to a new grid, and a short notice after a change. Never modal:
 * the question waits (stored with the puzzle) until it is answered, and is not asked again.
 */
import { useState } from 'react';
import { usePuzzle } from '../context/PuzzleContext';
import { Snackbar } from './Feedback';
import { IconGrid } from './Icons';

const fmt = (g: { rows: number; cols: number }) => `${g.cols}\u00a0×\u00a0${g.rows}`;

export function GridSuggestionCard() {
  const { puzzle, grid } = usePuzzle();
  const [busy, setBusy] = useState<'use' | 'keep'>();
  const s = grid.state.suggestion;
  if (!s) return null;
  const answer = async (use: boolean) => {
    setBusy(use ? 'use' : 'keep');
    try {
      await grid.answer(use);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="grid-suggestion" aria-labelledby="grid-suggestion-title" data-testid="grid-suggestion">
      <span className="grid-suggestion-icon" aria-hidden="true">
        <IconGrid size={20} />
      </span>
      <div className="grid-suggestion-body">
        <h2 className="grid-suggestion-title" id="grid-suggestion-title">
          Your pieces measure {fmt(s.grid)}, not {fmt(puzzle.grid)}.
        </h2>
        <p className="grid-suggestion-text">
          Measured from {s.scans === 1 ? 'your scan' : `${s.scans} scans`}. With the right grid every piece lands in its own cell.
        </p>
        <div className="grid-suggestion-actions">
          <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void answer(true)} data-testid="grid-use">
            {busy === 'use' ? 'Changing…' : `Use ${fmt(s.grid)}`}
          </button>
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void answer(false)} data-testid="grid-keep">
            Keep {fmt(puzzle.grid)}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Progress of scans being brought to a new grid, and the notice after a change. */
export function GridJobStrip() {
  const { grid } = usePuzzle();
  const job = grid.job;
  return (
    <>
      {job && (
        <div className="job-strip" role="status" data-testid="grid-job">
          <span className="spinner small-spinner" aria-hidden="true" />
          <span className="grow">Updating your scans to the {fmt(job.grid)} grid…</span>
          <span className="tabular">
            {job.done}/{job.total}
          </span>
        </div>
      )}
      <Snackbar message={grid.notice} onClose={grid.clearNotice} />
    </>
  );
}
