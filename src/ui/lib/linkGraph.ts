/**
 * The link graph of a scan (items that go next to each other) – pure helpers for drawing it:
 * which way each connection line flows, and how far a selection's highlight reaches.
 */

/** An item as a node of the link graph: its key and how many pieces it is (a group > 1). */
export interface GraphNode {
  key: string;
  pieceCount: number;
}

export interface GraphLink {
  a: string;
  b: string;
}

/** Stable id of a link (also the React key of its line). */
export function linkId(l: GraphLink): string {
  return `${l.a}-${l.b}`;
}

/** Neighbours of every item (in link order, no duplicates). */
function adjacency(links: GraphLink[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (x: string, y: string) => {
    const l = adj.get(x) ?? [];
    if (!l.includes(y)) l.push(y);
    adj.set(x, l);
  };
  for (const l of links) {
    if (l.a === l.b) continue;
    add(l.a, l.b);
    add(l.b, l.a);
  }
  return adj;
}

/** Breadth-first distances from `start` (over the whole connected part). */
function distances(start: string, adj: Map<string, string[]>): Map<string, number> {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const d = dist.get(queue[i])!;
    for (const n of adj.get(queue[i]) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

/**
 * Which end each connection line flows toward, so every connected cluster visibly gathers into
 * its biggest unit (the anchor): the item with the most pieces (an assembled group beats a loose
 * piece), ties broken by the most links, then by the item order. A line flows toward its end that
 * is closer to the anchor (breadth-first distance); when both ends are equally far (a cycle),
 * toward the bigger end, then the one with more links, then the earlier one in the item order.
 * Returns linkId → 'a' | 'b'.
 */
export function flowDirections(nodes: GraphNode[], links: GraphLink[]): Map<string, 'a' | 'b'> {
  const adj = adjacency(links);
  const order = new Map(nodes.map((n, i) => [n.key, i]));
  const size = new Map(nodes.map((n) => [n.key, n.pieceCount]));
  const rank = (k: string) => order.get(k) ?? Number.MAX_SAFE_INTEGER;
  const pieces = (k: string) => size.get(k) ?? 1;
  const degree = (k: string) => adj.get(k)?.length ?? 0;
  /** Negative when x should win over y (bigger, more links, earlier). */
  const better = (x: string, y: string) => pieces(y) - pieces(x) || degree(y) - degree(x) || rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0);

  // Anchor and distances per connected cluster.
  const dist = new Map<string, number>();
  const keys = [...adj.keys()].sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : 1));
  for (const k of keys) {
    if (dist.has(k)) continue;
    const cluster = [...distances(k, adj).keys()];
    const anchor = cluster.reduce((best, x) => (better(x, best) < 0 ? x : best));
    for (const [x, d] of distances(anchor, adj)) dist.set(x, d);
  }

  const out = new Map<string, 'a' | 'b'>();
  for (const l of links) {
    const da = dist.get(l.a) ?? 0;
    const db = dist.get(l.b) ?? 0;
    out.set(linkId(l), da < db ? 'a' : db < da ? 'b' : better(l.a, l.b) <= 0 ? 'a' : 'b');
  }
  return out;
}

/** How far a selection's highlight reaches (see selectionLevels). */
export const SELECTION_REACH = {
  /** Levels beyond the selection: 1 = its direct connections, 2 = theirs, 3. */
  maxDepth: 3,
  /** At most this many items beyond the direct connections. */
  maxExtra: 12,
  /** At most about this share of all items highlighted in total … */
  maxShare: 0.25,
  /** … but always allow this many (so a small scan still shows a short chain). */
  minTotal: 4,
};

/**
 * The items a selection highlights, by level: 0 the selected item, 1 its direct connections
 * (always all of them), 2 and 3 their connections in turn – walked breadth-first, a whole level at
 * a time, stopping before the level that would cross the cap: at most `maxExtra` items beyond
 * level 1 and at most `maxShare` of `total` items in all (never below `minTotal`), so a big
 * cluster does not light up half the photo. Returns key → level.
 */
export function selectionLevels(selected: string, links: GraphLink[], total: number, reach = SELECTION_REACH): Map<string, number> {
  const adj = adjacency(links);
  const levels = new Map([[selected, 0]]);
  let frontier = [selected];
  const cap = Math.max(reach.minTotal, Math.floor(total * reach.maxShare));
  let extra = 0;
  for (let depth = 1; depth <= reach.maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const k of frontier) for (const n of adj.get(k) ?? []) if (!levels.has(n) && !next.includes(n)) next.push(n);
    if (depth > 1 && (extra + next.length > reach.maxExtra || levels.size + next.length > cap)) break;
    for (const n of next) levels.set(n, depth);
    if (depth > 1) extra += next.length;
    frontier = next;
  }
  return levels;
}

/**
 * The highlight level of a line between two highlighted items: the farther end's level, or one
 * more for a line between two items of the same level (a connection of theirs); undefined when an
 * end is not highlighted.
 */
export function linkLevel(levels: Map<string, number>, l: GraphLink, maxDepth = SELECTION_REACH.maxDepth): number | undefined {
  const la = levels.get(l.a);
  const lb = levels.get(l.b);
  if (la === undefined || lb === undefined) return undefined;
  return la === lb ? Math.min(la + 1, maxDepth) : Math.max(la, lb);
}
