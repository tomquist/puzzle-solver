/** Items of a scan as shown with the current view options, rejections and progress. */
import { useCallback, useMemo } from 'react';
import { cellKey, type GridSpec, type ProgressRecord, type ScanResult } from '../../../model/types';
import { buildScanItems, type ItemPlacement, type ScanItem } from '../../lib/items';
import type { ViewOptions } from '../../lib/prefs';
import { isPlaced } from '../../lib/progress';

export function visibleByView(items: ScanItem[], view: ViewOptions): ScanItem[] {
  return items.filter((i) => (view.unsure || i.status === 'confident') && (!view.edgesOnly || i.edge));
}

/** Items the view options hide: by "Unsure pieces" off, by "Edge pieces only" on, and in all. */
export interface HiddenByView {
  unsure: number;
  interior: number;
  total: number;
}

export function hiddenByView(items: ScanItem[], view: ViewOptions): HiddenByView {
  const h: HiddenByView = { unsure: 0, interior: 0, total: 0 };
  for (const i of items) {
    const unsure = !view.unsure && i.status !== 'confident';
    const interior = view.edgesOnly && !i.edge;
    if (unsure) h.unsure++;
    if (interior) h.interior++;
    if (unsure || interior) h.total++;
  }
  return h;
}

/** The view options with nothing hidden (the display toggles as they are). */
export const showAllView = (view: ViewOptions): ViewOptions => ({ ...view, unsure: true, edgesOnly: false });

/**
 * What to say when the view options hide every item: name only the options that hide something
 * (a remembered "Edge pieces only" from building the frame hides a scan without edge pieces).
 */
export function hiddenMessage(items: ScanItem[], view: ViewOptions): { title: string; text: string } {
  const h = hiddenByView(items, view);
  const causes = [h.interior > 0 && '“Edge pieces only” is on', h.unsure > 0 && '“Unsure pieces” is off'].filter(Boolean);
  const title = view.edgesOnly && !items.some((i) => i.edge) ? 'No edge pieces in this scan' : 'Nothing to show with these view options';
  return { title, text: `${causes.join(' and ')} in View, which hides ${h.total === 1 ? 'the only item' : `all ${h.total} items`}.` };
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
