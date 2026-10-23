import { describe, expect, it } from 'vitest';
import type { ScanItem } from '../../lib/items';
import type { ViewOptions } from '../../lib/prefs';
import { hiddenByView, hiddenMessage, showAllView, visibleByView } from './useScanModel';

const item = (label: number, status: ScanItem['status'], edge: boolean) => ({ key: `r${label}`, label, status, edge }) as ScanItem;
const view = (o: Partial<ViewOptions>): ViewOptions => ({ labels: true, turnHints: true, connections: true, unsure: true, edgesOnly: false, ...o });

describe('view options hiding items', () => {
  // A scan of interior pieces only, with "Edge pieces only" left on from building the frame.
  const interior = [item(1, 'confident', false), item(2, 'ambiguous', false), item(3, 'confident', false)];

  it('counts what each option hides', () => {
    expect(hiddenByView(interior, view({ edgesOnly: true }))).toEqual({ unsure: 0, interior: 3, total: 3 });
    expect(hiddenByView(interior, view({ unsure: false }))).toEqual({ unsure: 1, interior: 0, total: 1 });
    expect(hiddenByView(interior, view({ unsure: false, edgesOnly: true }))).toEqual({ unsure: 1, interior: 3, total: 3 });
    expect(hiddenByView(interior, view({}))).toEqual({ unsure: 0, interior: 0, total: 0 });
  });

  it('names only the options that hide something', () => {
    // "Unsure pieces" is on: the message must not ask to turn it on.
    expect(hiddenMessage(interior, view({ edgesOnly: true }))).toEqual({
      title: 'No edge pieces in this scan',
      text: '“Edge pieces only” is on in View, which hides all 3 items.',
    });
    const unsureOnly = [item(1, 'ambiguous', true)];
    expect(hiddenMessage(unsureOnly, view({ unsure: false }))).toEqual({
      title: 'Nothing to show with these view options',
      text: '“Unsure pieces” is off in View, which hides the only item.',
    });
    expect(hiddenMessage([item(1, 'ambiguous', true), item(2, 'confident', false)], view({ unsure: false, edgesOnly: true })).text).toBe(
      '“Edge pieces only” is on and “Unsure pieces” is off in View, which hides all 2 items.',
    );
  });

  it('shows everything after "Show all pieces", keeping the display toggles', () => {
    const v = view({ unsure: false, edgesOnly: true, labels: false });
    expect(showAllView(v)).toEqual({ ...v, unsure: true, edgesOnly: false });
    expect(visibleByView(interior, showAllView(v))).toHaveLength(3);
  });
});
