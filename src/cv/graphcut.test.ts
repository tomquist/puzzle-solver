import { describe, expect, it } from 'vitest';
import { FlowGraph } from './graphcut';

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Problem {
  n: number;
  source: number[];
  sink: number[];
  edges: [number, number, number, number][];
}

/** Capacity of the cut that puts the nodes with bit i set in `labels` on the source side. */
function cutCost(p: Problem, labels: number): number {
  const s = (i: number) => (labels >> i) & 1;
  let c = 0;
  for (let i = 0; i < p.n; i++) c += s(i) ? p.sink[i] : p.source[i];
  for (const [i, j, cap, rev] of p.edges) {
    if (s(i) && !s(j)) c += cap;
    if (s(j) && !s(i)) c += rev;
  }
  return c;
}

function solve(p: Problem): { flow: number; labels: number; g: FlowGraph } {
  const g = new FlowGraph(p.n, 2);
  for (let i = 0; i < p.n; i++) g.addTerminal(i, p.source[i], p.sink[i]);
  for (const [i, j, cap, rev] of p.edges) g.addEdge(i, j, cap, rev);
  const flow = g.maxflow();
  let labels = 0;
  for (let i = 0; i < p.n; i++) if (g.isSource(i)) labels |= 1 << i;
  return { flow, labels, g };
}

/** A w×h grid with random terminal and 4-/8-neighbour capacities (some zero). */
function randomGrid(w: number, h: number, seed: number, diagonals: boolean): Problem {
  const rnd = lcg(seed);
  const cap = () => (rnd() < 0.15 ? 0 : Math.round(rnd() * 20));
  const n = w * h;
  const p: Problem = { n, source: [], sink: [], edges: [] };
  for (let i = 0; i < n; i++) {
    p.source.push(rnd() < 0.5 ? cap() : 0);
    p.sink.push(rnd() < 0.5 ? cap() : 0);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) p.edges.push([i, i + 1, cap(), cap()]);
      if (y + 1 < h) p.edges.push([i, i + w, cap(), cap()]);
      if (diagonals && x + 1 < w && y + 1 < h) p.edges.push([i, i + w + 1, cap(), cap()]);
      if (diagonals && x > 0 && y + 1 < h) p.edges.push([i, i + w - 1, cap(), cap()]);
    }
  }
  return p;
}

describe('max-flow / min-cut (Boykov–Kolmogorov)', () => {
  it('solves a textbook network', () => {
    // CLRS figure 26.1: s → v1 (16), s → v2 (13), …; max flow 23. Nodes v1..v4 = 0..3.
    const p: Problem = {
      n: 4,
      source: [16, 13, 0, 0],
      sink: [0, 0, 20, 4],
      edges: [[0, 2, 12, 0], [1, 0, 4, 0], [2, 1, 9, 0], [1, 3, 14, 0], [3, 2, 7, 0]],
    };
    const { flow, labels } = solve(p);
    expect(flow).toBe(23);
    expect(cutCost(p, labels)).toBe(23);
    // The minimum cut separates {s, v1, v2, v4} from {v3, t}.
    expect(labels).toBe(0b1011);
  });

  it('cuts a chain at its weakest link', () => {
    const caps = [9, 7, 3, 8, 5];
    const g = new FlowGraph(6);
    g.addTerminal(0, 100, 0);
    g.addTerminal(5, 0, 100);
    caps.forEach((c, i) => g.addEdge(i, i + 1, c, c));
    expect(g.maxflow()).toBe(3);
    expect([0, 1, 2, 3, 4, 5].map((i) => g.isSource(i))).toEqual([true, true, true, false, false, false]);
  });

  it('counts the shared part of both terminal links as flow', () => {
    const g = new FlowGraph(2);
    g.addTerminal(0, 5, 2);
    g.addTerminal(0, 1, 0);
    g.addTerminal(1, 0, 4);
    g.addEdge(0, 1, 10, 0);
    // Node 0: 6 from the source, 2 to the sink (2 counted directly); 4 more reach the sink via node 1.
    expect(g.maxflow()).toBe(6);
  });

  it('handles isolated and terminal-free nodes', () => {
    const g = new FlowGraph(3);
    g.addTerminal(0, 2, 0);
    g.addEdge(0, 1, 1, 1);
    expect(g.maxflow()).toBe(0);
    expect(g.isSource(0)).toBe(true);
    expect(g.isSource(1)).toBe(true);
    expect(g.isSource(2)).toBe(false);
    expect(new FlowGraph(0).maxflow()).toBe(0);
  });

  it('matches the brute-force minimum cut on random small grids', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const diag = seed % 2 === 0;
      const [w, h] = seed % 3 === 0 ? [4, 3] : seed % 3 === 1 ? [3, 3] : [5, 2];
      const p = randomGrid(w, h, seed, diag);
      let best = Infinity;
      for (let l = 0; l < 1 << p.n; l++) best = Math.min(best, cutCost(p, l));
      const { flow, labels } = solve(p);
      expect(flow).toBeCloseTo(best, 9);
      // The returned labelling is a minimum cut.
      expect(cutCost(p, labels)).toBeCloseTo(best, 9);
      checked++;
    }
    expect(checked).toBe(60);
  });

  it('keeps fractional capacities exact enough', () => {
    for (let seed = 100; seed < 120; seed++) {
      const rnd = lcg(seed);
      const p = randomGrid(4, 3, seed, true);
      p.edges = p.edges.map(([i, j, a, b]) => [i, j, a * (0.5 + rnd()), b * (0.5 + rnd())]);
      p.source = p.source.map((c) => c * Math.PI);
      let best = Infinity;
      for (let l = 0; l < 1 << p.n; l++) best = Math.min(best, cutCost(p, l));
      const { flow, labels } = solve(p);
      expect(flow).toBeCloseTo(best, 6);
      expect(cutCost(p, labels)).toBeCloseTo(best, 6);
    }
  });

  it('segments a noisy grid image into its two halves quickly', () => {
    // 300×300 pixels: left half bright, right half dark, strong noise; Potts smoothing restores the halves.
    const w = 300, h = 300, rnd = lcg(7);
    const g = new FlowGraph(w * h, 2 * w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (x < w / 2 ? 0.7 : 0.3) + (rnd() - 0.5) * 0.9;
        // Unary costs: −log-likelihood-like penalties for "bright" (source) and "dark" (sink).
        g.addTerminal(y * w + x, Math.max(0, (v - 0.5) * 4), Math.max(0, (0.5 - v) * 4));
        if (x + 1 < w) g.addEdge(y * w + x, y * w + x + 1, 1, 1);
        if (y + 1 < h) g.addEdge(y * w + x, (y + 1) * w + x, 1, 1);
      }
    }
    const t0 = performance.now();
    g.maxflow();
    const ms = performance.now() - t0;
    let wrong = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g.isSource(y * w + x) !== x < w / 2) wrong++;
    expect(wrong / (w * h)).toBeLessThan(0.01);
    expect(ms).toBeLessThan(2000);
  });
});
