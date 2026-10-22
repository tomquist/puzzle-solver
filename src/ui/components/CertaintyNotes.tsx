/**
 * Notes about how sure a place is, shared by the selection bar, the details and the placing mode:
 * - UncertainNote: why a piece is not sure and what to do (lib/certainty.ts uncertaintyText)
 * - PlacedConflictNote: a spot the user marked as placed that this piece seems to belong in –
 *   small and non-blocking, with "Unmark the spot" and "Keep the mark".
 */
import type { CellRef } from '../../model/types';
import { cellWords, type ReasonText } from '../lib/certainty';
import { IconAlert, IconInfo } from './Icons';

export function UncertainNote({ reason, compact = false }: { reason: ReasonText; compact?: boolean }) {
  return (
    <p className={`why-note${compact ? ' compact' : ''}`} data-testid="uncertain-reason">
      <IconInfo size={compact ? 15 : 18} />
      <span>{compact ? reason.card : reason.long}</span>
    </p>
  );
}

export function PlacedConflictNote({ cell, compact = false, onUnmark, onKeep }: { cell: CellRef; compact?: boolean; onUnmark: () => void; onKeep: () => void }) {
  return (
    <div className={`conflict-note${compact ? ' compact' : ''}`} role="note" data-testid="placed-conflict">
      <div className="conflict-text">
        <IconAlert size={18} />
        <span>
          {compact ? `You marked ${cellWords(cell)} as placed, but this piece looks like it belongs there.` : `You marked this spot (${cellWords(cell)}) as placed, but this piece looks like it belongs there.`}
        </span>
      </div>
      <div className="conflict-actions">
        <button
          className="btn btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onUnmark();
          }}
          data-testid="conflict-unmark"
        >
          Unmark the spot
        </button>
        <button
          className="btn btn-sm btn-quiet"
          onClick={(e) => {
            e.stopPropagation();
            onKeep();
          }}
          data-testid="conflict-keep"
        >
          Keep the mark
        </button>
      </div>
    </div>
  );
}
