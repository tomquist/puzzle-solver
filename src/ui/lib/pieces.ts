/** Helpers that interpret scan results for display (pure). */
import type {
  CellRef,
  DetectedRegion,
  FitHint,
  Placement,
  PuzzleSide,
  RegionMatch,
  ScanResult,
} from '../../model/types';

export type DisplayStatus = 'confident' | 'ambiguous' | 'unmatched' | 'patch';

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  confident: 'Confident',
  ambiguous: 'Unsure',
  unmatched: 'No match',
  patch: 'Patch',
};

export function matchFor(result: ScanResult, regionId: number): RegionMatch | undefined {
  return result.matches.find((m) => m.regionId === regionId);
}

/** Colour category: patches are always blue; pieces by match status. */
export function displayStatus(region: DetectedRegion, match: RegionMatch | undefined): DisplayStatus {
  if (region.kind === 'patch') return 'patch';
  if (!match || match.candidates.length === 0) return 'unmatched';
  return match.status;
}

/**
 * Candidates in display order after the user rejected the first `rejected` ones with
 * "Not this one" (rejected candidates are moved to the end, so nothing is lost).
 */
export function orderedCandidates(match: RegionMatch | undefined, rejected = 0): Placement[] {
  if (!match) return [];
  const n = match.candidates.length;
  if (n === 0) return [];
  const k = Math.min(Math.max(0, rejected), n);
  return [...match.candidates.slice(k), ...match.candidates.slice(0, k)];
}

/** The placement currently shown for a region (first non-rejected candidate). */
export function currentPlacement(match: RegionMatch | undefined, rejected = 0): Placement | undefined {
  if (!match) return undefined;
  if (rejected >= match.candidates.length) return undefined;
  return match.candidates[rejected];
}

/** Cells a region would occupy if placed with `placement` (patches: their covered cells). */
export function cellsForPlacement(match: RegionMatch, placement: Placement): CellRef[] {
  const best = match.candidates[0];
  if (match.coveredCells && match.coveredCells.length && best) {
    // Covered cells belong to the best placement; shift them for an alternative candidate.
    const dr = placement.row - best.row;
    const dc = placement.col - best.col;
    return match.coveredCells.map((c) => ({ row: c.row + dr, col: c.col + dc }));
  }
  return [{ row: placement.row, col: placement.col }];
}

export type RegionFilter = 'all' | 'edges' | 'unmatched';

export function regionPassesFilter(region: DetectedRegion, match: RegionMatch | undefined, filter: RegionFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'edges':
      return region.shape?.kind === 'edge' || region.shape?.kind === 'corner';
    case 'unmatched':
      return displayStatus(region, match) === 'unmatched';
  }
}

export interface ScanStats {
  regions: number;
  pieces: number;
  patches: number;
  confident: number;
  ambiguous: number;
  unmatched: number;
  edges: number;
}

export function scanStats(result: ScanResult): ScanStats {
  const s: ScanStats = { regions: result.regions.length, pieces: 0, patches: 0, confident: 0, ambiguous: 0, unmatched: 0, edges: 0 };
  for (const r of result.regions) {
    if (r.kind === 'patch') s.patches++;
    else s.pieces++;
    if (r.shape?.kind === 'edge' || r.shape?.kind === 'corner') s.edges++;
    const st = displayStatus(r, matchFor(result, r.id));
    if (st === 'patch') {
      const m = matchFor(result, r.id);
      if (m?.status === 'confident' && m.candidates.length) s.confident++;
      continue;
    }
    s[st]++;
  }
  return s;
}

/** Plain-language fit hints for one region ("Fits #7 on its right side", ...). */
export function fitHintTexts(regionId: number, result: ScanResult): string[] {
  const kindOf = (id: number) => result.regions.find((r) => r.id === id)?.kind;
  const out: string[] = [];
  const describe = (other: number, side: PuzzleSide, hint: FitHint) => {
    const sure = hint.confidence < 0.5 ? ' (maybe)' : '';
    if (kindOf(other) === 'patch') return `Attaches to patch #${other} at its ${side}${sure}`;
    return `Fits #${other} on its ${side} side${sure}`;
  };
  const sorted = [...result.fits].sort((p, q) => q.confidence - p.confidence);
  for (const f of sorted) {
    if (f.a === regionId) out.push(describe(f.b, f.sideA, f));
    else if (f.b === regionId) out.push(describe(f.a, f.sideB, f));
  }
  return out;
}

export function confidencePercent(c: number): number {
  return Math.round(Math.max(0, Math.min(1, c)) * 100);
}

export function pieceKindLabel(region: DetectedRegion): string {
  if (region.kind === 'patch') return 'Patch of joined pieces';
  switch (region.shape?.kind) {
    case 'corner':
      return 'Corner piece';
    case 'edge':
      return 'Edge piece';
    case 'interior':
      return 'Interior piece';
    default:
      return 'Piece (shape unclear)';
  }
}
