/**
 * A scan's notes for feedback and chosen spots (lib/scanNotes.ts) on a screen: shown at once, and
 * stored with the scan.
 */
import { useCallback, useState } from 'react';
import type { ScanRecord } from '../../model/types';
import type { PuzzleRepository } from '../../storage';
import { useRepo } from '../context/RepositoryContext';
import type { ScanNotes } from '../lib/scanNotes';

/** A change of the note fields (one of lib/scanNotes.ts's helpers); pure, applied to what is stored. */
export type NotesChange = <S extends ScanNotes>(scan: S) => S;

/**
 * Store a change of a scan's notes: in one read-modify-write step (repo.updateScan), so what was
 * changed meanwhile elsewhere – its cell size measured, its cells re-derived for a new grid – is
 * kept, and a grid change re-analysing the scan keeps the notes (it changes the record the same
 * way). Not in the puzzle's lane (lib/puzzleLane.ts): a note must not wait for a grid change to
 * re-analyse every scan, and nothing in it depends on the grid the pipeline matches with.
 */
export async function storeNotesChange(repo: PuzzleRepository, scanId: string, change: NotesChange): Promise<void> {
  await repo.updateScan(scanId, (cur) => {
    const next = change(cur);
    return next === cur ? undefined : next;
  });
}

export function useScanNotes(scan: ScanRecord) {
  const repo = useRepo();
  const [state, setState] = useState<ScanNotes>(() => ({ feedbackNotes: scan.feedbackNotes, spotChoices: scan.spotChoices }));
  const scanId = scan.id;
  const change = useCallback(
    (fn: NotesChange) => {
      setState((s) => fn(s));
      // The screen shows the change already; a failed write only loses it on a reload.
      storeNotesChange(repo, scanId, fn).catch((e: unknown) => console.warn('Could not store the note', e));
    },
    [repo, scanId],
  );
  return { notes: state.feedbackNotes, choices: state.spotChoices, change };
}
