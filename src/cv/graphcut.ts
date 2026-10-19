/**
 * Minimum s-t cut / maximum flow on sparse graphs (Boykov–Kolmogorov, "An Experimental Comparison
 * of Min-Cut/Max-Flow Algorithms for Energy Minimization in Vision", PAMI 2004).
 *
 * Two search trees grow from the source and the sink over arcs with residual capacity; where they
 * meet, flow is pushed along the path, saturated tree arcs orphan their subtrees and orphans are
 * adopted again (or freed) without restarting the search. On the grid graphs of image segmentation
 * this is far faster than augmenting-path or push-relabel methods in practice.
 *
 * Nodes are 0..n−1. Terminal links are given as one capacity each to the source and the sink
 * (`addTerminal`, accumulating); edges as a pair of arcs with their own capacities (`addEdge`).
 * After `maxflow()` the nodes still reachable from the source over residual arcs form the source
 * side of a minimum cut (`isSource`). Everything lives in typed arrays: no per-node objects.
 */

/** Parent markers (arc indices are ≥ 0). */
const NONE = -1;
const TERMINAL = -2;
const ORPHAN = -3;
const INF_D = 0x3fffffff;

export class FlowGraph {
  readonly nodeCount: number;
  private arcCount = 0;
  private flow = 0;
  /** Per node: first outgoing arc, residual terminal capacity (> 0 to the source, < 0 to the sink). */
  private readonly first: Int32Array;
  private readonly trCap: Float64Array;
  /** Per arc (arcs come in pairs a, a ^ 1): head node, next arc of the same tail, residual capacity. */
  private head: Int32Array;
  private next: Int32Array;
  private rCap: Float64Array;
  /** Solver state per node: tree parent arc (or a marker), active-list link, time stamp, distance, tree. */
  private readonly parent: Int32Array;
  private readonly nextActive: Int32Array;
  private readonly ts: Int32Array;
  private readonly dist: Int32Array;
  private readonly sinkTree: Uint8Array;

  /** A graph of `nodes` nodes; `edgeHint` edges are allocated up front (more grow the arrays). */
  constructor(nodes: number, edgeHint = 4 * nodes) {
    this.nodeCount = nodes;
    this.first = new Int32Array(nodes).fill(NONE);
    this.trCap = new Float64Array(nodes);
    const arcs = Math.max(16, 2 * edgeHint);
    this.head = new Int32Array(arcs);
    this.next = new Int32Array(arcs);
    this.rCap = new Float64Array(arcs);
    this.parent = new Int32Array(nodes);
    this.nextActive = new Int32Array(nodes);
    this.ts = new Int32Array(nodes);
    this.dist = new Int32Array(nodes);
    this.sinkTree = new Uint8Array(nodes);
  }

  /**
   * Add capacities from the source to node `i` and from `i` to the sink (accumulating with earlier
   * calls). Only the difference matters for the cut; the common part is counted as flow directly.
   */
  addTerminal(i: number, source: number, sink: number): void {
    const d = this.trCap[i];
    if (d > 0) source += d;
    else sink -= d;
    this.flow += Math.min(source, sink);
    this.trCap[i] = source - sink;
  }

  /** Add an edge i → j with capacity `cap` and j → i with capacity `rev`. */
  addEdge(i: number, j: number, cap: number, rev: number): void {
    if (this.arcCount + 2 > this.head.length) this.growArcs();
    const a = this.arcCount;
    this.arcCount += 2;
    this.head[a] = j;
    this.next[a] = this.first[i];
    this.first[i] = a;
    this.rCap[a] = cap;
    this.head[a + 1] = i;
    this.next[a + 1] = this.first[j];
    this.first[j] = a + 1;
    this.rCap[a + 1] = rev;
  }

  private growArcs(): void {
    const n = this.head.length * 2;
    const head = new Int32Array(n), next = new Int32Array(n), rCap = new Float64Array(n);
    head.set(this.head);
    next.set(this.next);
    rCap.set(this.rCap);
    this.head = head;
    this.next = next;
    this.rCap = rCap;
  }

  /**
   * Compute the maximum flow (= the minimum cut's capacity, including the flow `addTerminal`
   * counted directly). Call once, after all nodes and edges are added.
   */
  maxflow(): number {
    const n = this.nodeCount;
    if (n === 0) return this.flow;
    const { first, trCap, head, next, rCap, parent, nextActive, ts, dist, sinkTree } = this;
    // Active nodes: two FIFO lists linked through nextActive (a node's link points to itself at the
    // end of a list; NONE = not listed). New nodes join list 1, list 0 is being processed.
    let q0First = NONE, q1First = NONE, q1Last = NONE;
    const setActive = (i: number): void => {
      if (nextActive[i] !== NONE) return;
      if (q1Last !== NONE) nextActive[q1Last] = i;
      else q1First = i;
      q1Last = i;
      nextActive[i] = i;
    };
    const nextActiveNode = (): number => {
      for (;;) {
        let i = q0First;
        if (i === NONE) {
          q0First = i = q1First;
          q1First = q1Last = NONE;
          if (i === NONE) return NONE;
        }
        q0First = nextActive[i] === i ? NONE : nextActive[i];
        nextActive[i] = NONE;
        // A listed node is active only while it is in a tree.
        if (parent[i] !== NONE) return i;
      }
    };
    // Orphans: a ring buffer (a node is listed at most once: its parent is ORPHAN meanwhile).
    const orphans = new Int32Array(Math.max(1, n));
    let oHead = 0, oCount = 0;
    const orphanFront = (i: number): void => {
      parent[i] = ORPHAN;
      oHead = oHead === 0 ? n - 1 : oHead - 1;
      orphans[oHead] = i;
      oCount++;
    };
    const orphanRear = (i: number): void => {
      parent[i] = ORPHAN;
      orphans[(oHead + oCount) % n] = i;
      oCount++;
    };

    let time = 0;
    for (let i = 0; i < n; i++) {
      nextActive[i] = NONE;
      ts[i] = 0;
      if (trCap[i] > 0) {
        sinkTree[i] = 0;
        parent[i] = TERMINAL;
        setActive(i);
        dist[i] = 1;
      } else if (trCap[i] < 0) {
        sinkTree[i] = 1;
        parent[i] = TERMINAL;
        setActive(i);
        dist[i] = 1;
      } else parent[i] = NONE;
    }

    /** Push the bottleneck flow along source → tail(mid) → head(mid) → sink; saturated tree links orphan. */
    const augment = (mid: number): void => {
      let b = rCap[mid];
      let i = head[mid ^ 1];
      for (let p = parent[i]; p !== TERMINAL; i = head[p], p = parent[i]) if (rCap[p ^ 1] < b) b = rCap[p ^ 1];
      if (trCap[i] < b) b = trCap[i];
      i = head[mid];
      for (let p = parent[i]; p !== TERMINAL; i = head[p], p = parent[i]) if (rCap[p] < b) b = rCap[p];
      if (-trCap[i] < b) b = -trCap[i];
      rCap[mid ^ 1] += b;
      rCap[mid] -= b;
      // Source tree: flow runs from the parent to the child (arc p ^ 1).
      for (i = head[mid ^ 1]; ; ) {
        const p = parent[i];
        if (p === TERMINAL) {
          trCap[i] -= b;
          if (trCap[i] <= 0) orphanFront(i);
          break;
        }
        rCap[p] += b;
        rCap[p ^ 1] -= b;
        const up = head[p];
        if (rCap[p ^ 1] <= 0) orphanFront(i);
        i = up;
      }
      // Sink tree: flow runs from the child to the parent (arc p).
      for (i = head[mid]; ; ) {
        const p = parent[i];
        if (p === TERMINAL) {
          trCap[i] += b;
          if (trCap[i] >= 0) orphanFront(i);
          break;
        }
        rCap[p ^ 1] += b;
        rCap[p] -= b;
        const up = head[p];
        if (rCap[p] <= 0) orphanFront(i);
        i = up;
      }
      this.flow += b;
    };

    /** Find a new parent for orphan `i` in its tree (shortest origin), or free it and orphan its children. */
    const adopt = (i: number): void => {
      const sink = sinkTree[i];
      let dMin = INF_D, best = NONE;
      for (let a0 = first[i]; a0 !== NONE; a0 = next[a0]) {
        // Capacity toward i (source tree) or away from i (sink tree).
        if ((sink ? rCap[a0] : rCap[a0 ^ 1]) <= 0) continue;
        let j = head[a0];
        if (sinkTree[j] !== sink || parent[j] === NONE) continue;
        // Does j still originate from the terminal? Walk up until a node checked at this time.
        let d = 0;
        for (;;) {
          if (ts[j] === time) {
            d += dist[j];
            break;
          }
          const a = parent[j];
          d++;
          if (a === TERMINAL) {
            ts[j] = time;
            dist[j] = 1;
            break;
          }
          if (a === ORPHAN) {
            d = INF_D;
            break;
          }
          j = head[a];
        }
        if (d >= INF_D) continue;
        if (d < dMin) {
          best = a0;
          dMin = d;
        }
        // Stamp the path so later searches stop early.
        for (j = head[a0]; ts[j] !== time; j = head[parent[j]]) {
          ts[j] = time;
          dist[j] = d--;
        }
      }
      parent[i] = best;
      if (best !== NONE) {
        ts[i] = time;
        dist[i] = dMin + 1;
        return;
      }
      // No parent: i becomes free; neighbours that could reach it become active, its children orphans.
      for (let a0 = first[i]; a0 !== NONE; a0 = next[a0]) {
        const j = head[a0];
        const a = parent[j];
        if (sinkTree[j] !== sink || a === NONE) continue;
        if ((sink ? rCap[a0] : rCap[a0 ^ 1]) > 0) setActive(j);
        if (a !== TERMINAL && a !== ORPHAN && head[a] === i) orphanRear(j);
      }
    };

    let current = NONE;
    for (;;) {
      let i = current;
      if (i !== NONE) {
        nextActive[i] = NONE;
        if (parent[i] === NONE) i = NONE;
      }
      if (i === NONE) {
        i = nextActiveNode();
        if (i === NONE) break;
      }
      // Growth: claim free neighbours; stop at the first arc into the other tree.
      let mid = NONE;
      if (!sinkTree[i]) {
        for (let a = first[i]; a !== NONE; a = next[a]) {
          if (rCap[a] <= 0) continue;
          const j = head[a];
          if (parent[j] === NONE) {
            sinkTree[j] = 0;
            parent[j] = a ^ 1;
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
            setActive(j);
          } else if (sinkTree[j]) {
            mid = a;
            break;
          } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            // Shorter path to the source through i.
            parent[j] = a ^ 1;
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
          }
        }
      } else {
        for (let a = first[i]; a !== NONE; a = next[a]) {
          if (rCap[a ^ 1] <= 0) continue;
          const j = head[a];
          if (parent[j] === NONE) {
            sinkTree[j] = 1;
            parent[j] = a ^ 1;
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
            setActive(j);
          } else if (!sinkTree[j]) {
            mid = a ^ 1;
            break;
          } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = a ^ 1;
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
          }
        }
      }
      time++;
      if (mid === NONE) {
        current = NONE;
        continue;
      }
      // i stays the current node (it may have more arcs into the other tree).
      nextActive[i] = i;
      current = i;
      augment(mid);
      while (oCount > 0) {
        const o = orphans[oHead];
        oHead = oHead + 1 === n ? 0 : oHead + 1;
        oCount--;
        adopt(o);
      }
    }
    return this.flow;
  }

  /** After `maxflow()`: true when node `i` is on the source side of the minimum cut. */
  isSource(i: number): boolean {
    return this.parent[i] !== NONE && !this.sinkTree[i];
  }
}
