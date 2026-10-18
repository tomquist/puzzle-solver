import { describe, expect, it } from 'vitest';
import { flowDirections, linkId, linkLevel, selectionLevels, type GraphLink, type GraphNode } from './linkGraph';

const nodes = (...keys: string[]): GraphNode[] => keys.map((key) => ({ key, pieceCount: 1 }));
const chain = (...keys: string[]): GraphLink[] => keys.slice(1).map((b, i) => ({ a: keys[i], b }));
/** The end each link flows toward, as "a>b" strings (or "b<a" read as flowing to a). */
const flows = (ns: GraphNode[], ls: GraphLink[]) => {
  const f = flowDirections(ns, ls);
  return ls.map((l) => (f.get(linkId(l)) === 'b' ? `${l.a}>${l.b}` : `${l.b}>${l.a}`));
};

describe('flow directions', () => {
  it('gathers a cluster into its assembled group', () => {
    // p1 – p2 – G – p3, G is a group of 4 pieces: everything flows toward G.
    const ns = [...nodes('p1', 'p2', 'p3'), { key: 'G', pieceCount: 4 }];
    const ls = [...chain('p1', 'p2', 'G'), { a: 'G', b: 'p3' }];
    expect(flows(ns, ls)).toEqual(['p1>p2', 'p2>G', 'p3>G']);
  });

  it('picks the item with the most links when sizes tie', () => {
    // a – hub – b, hub – c: all flow into the hub.
    const ls = [
      { a: 'a', b: 'hub' },
      { a: 'hub', b: 'b' },
      { a: 'c', b: 'hub' },
    ];
    expect(flows(nodes('a', 'b', 'c', 'hub'), ls)).toEqual(['a>hub', 'b>hub', 'c>hub']);
  });

  it('uses the item order for a plain chain, and treats every cluster on its own', () => {
    // Two chains: x – y – z (ends have one link; y has two → anchor y) and u – v (tie → u first).
    const ls = [...chain('x', 'y', 'z'), { a: 'u', b: 'v' }];
    expect(flows(nodes('u', 'v', 'x', 'y', 'z'), ls)).toEqual(['x>y', 'z>y', 'v>u']);
  });

  it('flows toward the bigger end when both ends are equally far (a cycle)', () => {
    // Anchor G; a and b both link to G and to each other: a – b flows toward the bigger b.
    const ns = [{ key: 'G', pieceCount: 6 }, { key: 'a', pieceCount: 1 }, { key: 'b', pieceCount: 2 }];
    const ls = [
      { a: 'G', b: 'a' },
      { a: 'G', b: 'b' },
      { a: 'a', b: 'b' },
    ];
    expect(flows(ns, ls)).toEqual(['a>G', 'b>G', 'a>b']);
  });

  it('is stable for equal ends: the earlier item in the order', () => {
    const ls = [
      { a: 'h', b: 'p' },
      { a: 'h', b: 'q' },
      { a: 'q', b: 'p' },
    ];
    // h has two links … and so do p and q: all tie, h is first → anchor; p – q flows to p (earlier).
    expect(flows(nodes('h', 'p', 'q'), ls)).toEqual(['p>h', 'q>h', 'q>p']);
  });
});

describe('selection levels', () => {
  it('walks a chain by level, up to depth 3', () => {
    const ls = chain('a', 'b', 'c', 'd', 'e', 'f', 'g');
    const lv = selectionLevels('a', ls, 100);
    expect(Object.fromEntries(lv)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it('always shows all direct connections, even past the cap', () => {
    const ls = ['b', 'c', 'd', 'e', 'f'].map((k) => ({ a: 'a', b: k }));
    const lv = selectionLevels('a', [...ls, { a: 'b', b: 'x' }], 8);
    expect([...lv.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(lv.has('x')).toBe(false);
  });

  it('stops before a level that would cross the extra cap (no partial levels)', () => {
    // a – b, b links to 13 others: level 2 would add 13 > 12 extra items.
    const fan = Array.from({ length: 13 }, (_, i) => ({ a: 'b', b: `n${i}` }));
    const lv = selectionLevels('a', [{ a: 'a', b: 'b' }, ...fan], 1000);
    expect(lv.size).toBe(2);
    // With 12 it fits.
    expect(selectionLevels('a', [{ a: 'a', b: 'b' }, ...fan.slice(0, 12)], 1000).size).toBe(14);
  });

  it('never highlights more than about a quarter of the items', () => {
    const ls = chain('a', 'b', 'c', 'd', 'e', 'f', 'g');
    // 20 items → at most 5: c, its neighbours b and d, then level 2 (a, e) makes 5; level 3 (f) not.
    expect(Object.fromEntries(selectionLevels('c', ls, 20))).toEqual({ c: 0, b: 1, d: 1, a: 2, e: 2 });
    // 12 items → at least 4 allowed: c, b, d, and level 2 (a, e) would make 5 → stop before it.
    expect(Object.fromEntries(selectionLevels('c', ls, 12))).toEqual({ c: 0, b: 1, d: 1 });
    // From the chain's end one item per level: a, b, c, d → 4.
    expect(Object.fromEntries(selectionLevels('a', ls, 12))).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it('handles an item without links and cycles', () => {
    expect(Object.fromEntries(selectionLevels('z', chain('a', 'b'), 10))).toEqual({ z: 0 });
    const ring = [...chain('a', 'b', 'c', 'd'), { a: 'd', b: 'a' }];
    expect(Object.fromEntries(selectionLevels('a', ring, 100))).toEqual({ a: 0, b: 1, d: 1, c: 2 });
  });

  it('gives lines the level of their farther end, or one more between equals', () => {
    const lv = new Map([
      ['s', 0],
      ['x', 1],
      ['y', 1],
      ['z', 2],
    ]);
    expect(linkLevel(lv, { a: 's', b: 'x' })).toBe(1);
    expect(linkLevel(lv, { a: 'x', b: 'z' })).toBe(2);
    expect(linkLevel(lv, { a: 'x', b: 'y' })).toBe(2);
    expect(linkLevel(lv, { a: 'z', b: 'q' })).toBeUndefined();
    expect(linkLevel(new Map([['p', 3], ['q', 3]]), { a: 'p', b: 'q' })).toBe(3);
  });
});
