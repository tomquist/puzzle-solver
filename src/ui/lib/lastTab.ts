/**
 * The workspace tab a puzzle was last shown on, so "back" from a scan result returns there (a scan
 * opened from History goes back to History, not to Scan). Kept for the browser session; storage
 * that is blocked or missing falls back to memory.
 */
import type { PuzzleTab } from './routes';

const KEY = 'puzzle-solver:last-tab';
const memory = new Map<string, PuzzleTab>();

function read(): Record<string, PuzzleTab> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, PuzzleTab>;
  } catch {
    return {};
  }
}

export function rememberTab(puzzleId: string, tab: PuzzleTab): void {
  memory.set(puzzleId, tab);
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...read(), [puzzleId]: tab }));
  } catch {
    // Memory only.
  }
}

/** The tab to go back to from a puzzle's scan screens (Scan unless another tab was open last). */
export function lastTab(puzzleId: string): PuzzleTab {
  return memory.get(puzzleId) ?? read()[puzzleId] ?? 'scan';
}
