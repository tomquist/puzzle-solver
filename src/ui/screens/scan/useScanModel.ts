/** Items of a scan as shown with the current view options, rejections and progress. */
import { useCallback, useMemo } from 'react';
import { cellKey, type GridSpec, type ProgressRecord, type ScanResult } from '../../../model/types';
import { buildScanItems, type ItemPlacement, type ScanItem } from '../../lib/items';
import type { ViewOptions } from '../../lib/prefs';
import { isPlaced } from '../../lib/progress';

export function visibleByView(items: ScanItem[], view: ViewOptions): ScanItem[] {
  return items.filter((i) => (view.unsure || i.status === 'confident') && (!view.edgesOnly || i.edge));
}

/**
 * Index of the candidate this scan recorded as placed for `item` (it may not be the best one when
 * the user said "Not here"), or -1.
 */
export function placedCandidateIndex(item: ScanItem, progress: ProgressRecord, scanId: string): number {
  return item.candidates.findIndex(
    (p) =>
      p.cells.length > 0 &&
      p.cells.every((c) => {
        const e = progress.placed[cellKey(c)];
        return !!e && e.scanId === scanId && e.regionId === item.label;
      }),
  );
}

export function useScanModel(
  result: ScanResult,
  grid: GridSpec,
  view: ViewOptions,
  rejected: Record<string, number>,
  progress: ProgressRecord,
  scanId: string,
) {
  const all = useMemo(() => buildScanItems(result, grid), [result, grid]);
  const visible = useMemo(() => visibleByView(all.items, view), [all, view]);
  const links = useMemo(() => {
    const keys = new Set(visible.map((i) => i.key));
    return all.links.filter((l) => keys.has(l.a) && keys.has(l.b));
  }, [all, visible]);
  const byKey = useMemo(() => new Map(all.items.map((i) => [i.key, i])), [all]);
  const placementOf = useCallback(
    (item: ScanItem): ItemPlacement | undefined => {
      if (rejected[item.key] !== undefined) return item.candidates[rejected[item.key]];
      const placed = placedCandidateIndex(item, progress, scanId);
      return item.candidates[placed >= 0 ? placed : 0];
    },
    [rejected, progress, scanId],
  );
  const isPlacedItem = useCallback(
    (item: ScanItem) => {
      const p = placementOf(item);
      return !!p && p.cells.length > 0 && p.cells.every((c) => isPlaced(progress, c));
    },
    [placementOf, progress],
  );
  return { all, visible, links, byKey, placementOf, isPlacedItem };
}
