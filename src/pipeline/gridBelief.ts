/**
 * The grid belief: which rows × columns the scans say the puzzle has, and when to say so.
 *
 * Why: the grid comes from the piece count, and counts are rounded ("1500" for 45 × 34 = 1530) or
 * unknown. One column too few puts the pieces of the right half a cell off. Every scan measures the
 * picture's cell size (pipeline/match/cellSize.ts), so the grid can correct itself – but a noisy
 * scan must never make the app ask, and once it has asked it must not ask again about the same
 * thing. So the evidence is accumulated per puzzle (one entry per scan id: a re-analysed scan
 * replaces its entry, a deleted one is dropped) into posterior odds between whole grids, and the
 * app only speaks past a high bar, with hysteresis.
 *
 * Model, per picture axis (columns along x, rows along y; the axes are independent):
 * - A grid of N cells along an axis of L reference px has cells of L / N px. The puzzle need not
 *   fill the reference exactly – the box picture may be cropped or scaled a little differently from
 *   the print, and the photo of the box is not perfectly flat – so the cells actually are
 *   (L / N)·e^g px, starting x0 cells from the edge; the size measurements carry a bias b of their
 *   own (seams and print measured in a few areas of a picture that is not perfectly uniform). g, b
 *   and x0 are shared by every scan of the puzzle (a systematic offset does not average away), have
 *   normal priors (σ_g 0.5 %, σ_b 1.5 %, σ_o 0.15 cells) and are integrated out numerically. That
 *   bounds what any amount of evidence can say about two grids whose cells differ by a few σ_g – the
 *   evidence saturates instead of piling up.
 * - Size: each source (a patch's seams, a scan's loose pieces) measures ln(cell size) with a
 *   standard error; its residual is Student-t (ν = 4: a wrongly placed patch is not a disaster),
 *   its scale the source's error with a floor per kind.
 * - Phase: each source lists reference coordinates of cell centres it saw; under a grid they should
 *   sit in the middle of cells. A wrapped normal plus a uniform outlier share; a source counts as at
 *   most two independent positions (its pieces share the photo, a patch is rigid). Positions far
 *   from the edge pin the cells' scale g down, which is what tells neighbouring grids apart.
 * - Prior: the stated piece count (a robust mixture: mostly within a few per cent, but a wrong
 *   count is possible) and squareness of the cells (weak; children's puzzles have long pieces).
 *
 * Decisions (see {@link decideGrid}; thresholds in {@link GRID_RULES}): ask about another grid only
 * when its posterior odds reach 20:1 over the current grid and over every other alternative, from
 * at least two independent sources in two scans, and the cell size measured from the evidence alone
 * is closer to it by more than its spread; never while the grid is confirmed or the alternative was
 * declined, unless the odds pass 1000:1 from three sources in three scans. An estimated grid (no
 * piece count) follows the measurement without asking, once, and is a measured grid from then on; a
 * grid the scans agree with strongly (100:1 over the runner-up) becomes confirmed without asking.
 */
import { GRID_EVIDENCE_VERSION, type CellSizeSource, type GridEvidence, type GridSpec, type GridState, type GridStatus, type PieceCountKind, type ScanResult } from '../model/types';
import { estimateGrid } from './grid';

/** Decision thresholds (documented in docs/ARCHITECTURE.md; tuned on scripts/grid-replay.ts and bench/grid.eval.ts). */
export const GRID_RULES = {
  /**
   * Odds of an alternative over the current grid from which the app asks (20:1, ln ≈ 3): above
   * what one patch or one scan's pieces can reach on their own between neighbouring grids (the
   * shared offsets bound it), reached by two or three agreeing sources.
   */
  suggestOdds: 20,
  /** Independent sources (patches, one scan's pieces) behind a question. */
  suggestSources: 2,
  /** Odds of the proposed grid over every other alternative (not only the current grid). */
  distinctOdds: 20,
  /**
   * Scans behind a question: sources of one photo share its geometry (a slightly oblique view, the
   * lens), so a single scan never asks, however clear it looks.
   */
  suggestScans: 2,
  /**
   * The bar for a confirmed grid or a declined alternative: 1000:1 from three sources in three
   * scans – for a declined one, three scans taken after the answer (the user saw the evidence so
   * far and said no).
   */
  highOdds: 1000,
  highSources: 3,
  highScans: 3,
  /** Odds of the current grid over every other from which it is confirmed without asking. */
  confirmOdds: 100,
  confirmSources: 3,
  /**
   * The measured cell size must be closer to the alternative than to the current grid by this
   * many measurement spreads (per axis where they differ), so a question never rests on the prior.
   */
  marginSpreads: 1,
} as const;

/** Model constants (see module documentation). */
const MODEL = {
  /**
   * Shared ln-scale of the cells against L / N (σ_g, per axis): how far the print may be scaled
   * against the box picture overall. Positions pin it down (a cell centre 30 cells from the edge
   * moves by a third of a cell per percent), so it is what tells neighbouring grids apart.
   */
  globalScale: 0.005,
  /**
   * Shared ln-bias of the size measurements (σ_s, per axis): seam pitch and print scale measured in
   * the same few areas of a picture that is not perfectly flat or uniform (real files: −1 … −2 % in
   * width for one box picture while its cell centres sit where 45 columns put them).
   */
  sizeBias: 0.015,
  /** Shared cell offset (cells, σ_o): the box picture's crop against the print. */
  offset: 0.15,
  /** Student-t degrees of freedom of a source's size residual. */
  nu: 4,
  /** Floors (ln) of a source's size error: a patch's seams; a scan's loose pieces (corner detection, outlines with a rim). */
  floor: { patch: 0.008, pieces: 0.03 },
  /** Phase: spread of a cell centre within its cell (cells), outlier share, positions a source counts as at most. */
  phaseSigma: { patch: 0.07, pieces: 0.1 },
  phaseOutlier: 0.3,
  phaseNeff: 2,
  /** Robust count prior: share within the stated count's spread, and that spread (ln) per kind. */
  countInlier: 0.8,
  countSigma: { exact: 0.035, about: 0.15 },
  /** Range (ln) of the uniform part of the count prior. */
  countRange: 0.8,
  /** Laplace scale (ln of the cell aspect) of the squareness prior. */
  squareness: 0.25,
  /**
   * Integration: half-width in σ (the global scale's reaches a neighbouring grid's cells, so a
   * neighbour is penalised by the prior and not by a cut-off range); phase step (cells) the global
   * scale and the offset are resolved to.
   */
  span: 2.5,
  globalSpan: 4,
  phaseStep: 0.035,
};

/** What a decision needs to know about the puzzle. */
export interface GridContext {
  refWidth: number;
  refHeight: number;
  pieceCount: number;
  countKind: PieceCountKind;
  grid: GridSpec;
  state: GridState;
}

export const sameGrid = (a: GridSpec | undefined, b: GridSpec | undefined): boolean => !!a && !!b && a.rows === b.rows && a.cols === b.cols;
const gridKey = (g: GridSpec) => `${g.rows}x${g.cols}`;

/** A fresh grid state. */
export function newGridState(status: GridStatus): GridState {
  return { status, scans: {}, declined: [], left: [] };
}

/** The puzzle's grid state, with the defaults of puzzles saved before it existed. */
export function gridStateOf(p: { gridState?: GridState }): GridState {
  const s = p.gridState;
  if (!s) return newGridState('unconfirmed');
  return { status: s.status, scans: s.scans ?? {}, declined: s.declined ?? [], left: s.left ?? [], ...(s.suggestion ? { suggestion: s.suggestion } : {}), ...(s.changedAt ? { changedAt: s.changedAt } : {}) };
}

/** Add (or replace) a scan's evidence. Evidence without sources is kept too (the scan was measured). */
export function withScanEvidence(state: GridState, scanId: string, evidence: GridEvidence | undefined): GridState {
  const scans = { ...state.scans };
  if (evidence && evidence.version === GRID_EVIDENCE_VERSION) scans[scanId] = evidence;
  else delete scans[scanId];
  return { ...state, scans };
}

/** Drop a deleted scan's evidence. */
export function withoutScan(state: GridState, scanId: string): GridState {
  if (!(scanId in state.scans)) return state;
  const scans = { ...state.scans };
  delete scans[scanId];
  return { ...state, scans };
}

// ---------------------------------------------------------------------------------------------
// Likelihood
// ---------------------------------------------------------------------------------------------

interface AxisSize {
  m: number;
  s: number;
}
interface AxisPhase {
  u: number[];
  sigma: number;
  weight: number;
}
interface AxisData {
  sizes: AxisSize[];
  phases: AxisPhase[];
  /** Sources with a measurement on this axis (size or ≥ 2 positions). */
  sources: number;
  /** Scans with such a source. */
  scans: number;
}

/** A source's measurements along one axis, in the current reference's px (older evidence is rescaled). */
export function axisData(state: GridState, axis: 'x' | 'y', refLen: number): AxisData {
  const out: AxisData = { sizes: [], phases: [], sources: 0, scans: 0 };
  for (const ev of Object.values(state.scans)) {
    const before = out.sources;
    if (ev.version !== GRID_EVIDENCE_VERSION) continue;
    const len = axis === 'x' ? ev.refWidth : ev.refHeight;
    const k = len > 0 ? refLen / len : 1;
    const lk = Math.log(k);
    for (const src of ev.sources) {
      const meas = axis === 'x' ? src.w : src.h;
      let counted = false;
      if (meas) {
        out.sizes.push({ m: meas.log + lk, s: Math.hypot(meas.se, MODEL.floor[src.kind]) });
        counted = true;
      }
      // A patch's cell centres only along an axis whose seam pitch it measured: otherwise the lattice
      // spacing along it may be the analysis grid's own (a 3-column patch fitted from a 2-column
      // prior lines up with neither), and its positions would vote for that grid.
      const at = (src.kind === 'patch' && !meas ? undefined : axis === 'x' ? src.x : src.y) ?? [];
      const u: number[] = [];
      // At most PHASE_MAX positions, spread over the list (a source counts as a few positions anyway).
      const n = at.length, m = Math.min(n, PHASE_MAX);
      for (let t = 0; t < m; t++) u.push(at[Math.floor((t * n) / m)] * k);
      if (u.length >= 2) {
        out.phases.push({ u, sigma: MODEL.phaseSigma[src.kind], weight: Math.min(1, MODEL.phaseNeff / u.length) });
        counted = true;
      }
      if (counted) out.sources++;
    }
    if (out.sources > before) out.scans++;
  }
  return out;
}

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
/** Positions per source that enter the phase term. */
const PHASE_MAX = 6;
/** ln density of a cell centre's phase |ψ| ∈ [0, 0.5] (wrapped normal + outliers), tabulated per σ. */
const PHASE_BINS = 256;
const phaseTables = new Map<number, Float64Array>();
function phaseTable(sigma: number): Float64Array {
  let t = phaseTables.get(sigma);
  if (!t) {
    t = new Float64Array(PHASE_BINS + 1);
    const peak = (1 - MODEL.phaseOutlier) / (sigma * Math.sqrt(2 * Math.PI));
    for (let i = 0; i <= PHASE_BINS; i++) {
      const psi = i / (2 * PHASE_BINS);
      let dens = 0;
      for (const k of [-1, 0, 1]) dens += Math.exp(-0.5 * ((psi + k) / sigma) ** 2);
      t[i] = Math.log(peak * dens + MODEL.phaseOutlier);
    }
    phaseTables.set(sigma, t);
  }
  return t;
}

/** Integration nodes of a standard normal: `n` equally spaced over ±span σ, normalised log weights. */
const nodeCache = new Map<string, { z: number[]; lw: number[] }>();
function nodes(n: number, span = MODEL.span): { z: number[]; lw: number[] } {
  let r = nodeCache.get(`${n}|${span}`);
  if (!r) {
    const z: number[] = [], lw: number[] = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = n === 1 ? 0 : -span + (2 * span * i) / (n - 1);
      z.push(v);
      sum += Math.exp(-0.5 * v * v);
    }
    for (const v of z) lw.push(-0.5 * v * v - Math.log(sum));
    r = { z, lw };
    nodeCache.set(`${n}|${span}`, r);
  }
  return r;
}

function logSumExp(v: number[]): number {
  let m = -Infinity;
  for (const x of v) if (x > m) m = x;
  if (m === -Infinity) return m;
  let s = 0;
  for (const x of v) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** Odd node count resolving `range` (the full span) in steps of at most `step`, within [lo, hi]. */
const nodeCount = (range: number, step: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, 2 * Math.ceil(range / step / 2) + 1));

/**
 * ln p(axis data | N cells along an axis of L px), up to a constant shared by all N: the size and
 * phase terms integrated over the shared global scale, size bias and offset (module documentation).
 * The global scale is resolved finely enough that the farthest cell centre moves by less than the
 * phase step between nodes (a coarse grid would favour whichever N happens to fall on a node).
 */
export function axisLogLik(N: number, L: number, d: AxisData): number {
  return axisPosterior(N, L, d).ll;
}

/** {@link axisLogLik} with the posterior mean and second moment of ln(cell size) given N. */
export function axisPosterior(N: number, L: number, d: AxisData): { ll: number; mean: number; m2: number } {
  const c0 = L / N;
  const { nu } = MODEL;
  let uMax = 1;
  for (const p of d.phases) for (const u of p.u) uMax = Math.max(uMax, u / c0);
  const gNodes = nodes(d.phases.length > 0 ? nodeCount(2 * MODEL.globalSpan * MODEL.globalScale * uMax, MODEL.phaseStep, 9, 101) : 9, MODEL.globalSpan);
  const sNodes = nodes(d.sizes.length > 0 ? 15 : 1);
  const oNodes = nodes(d.phases.length > 0 ? nodeCount(2 * MODEL.span * MODEL.offset, MODEL.phaseStep, 9, 31) : 1);
  const outer: number[] = [];
  const inner: number[] = [];
  for (let ig = 0; ig < gNodes.z.length; ig++) {
    const g = gNodes.z[ig] * MODEL.globalScale;
    const lc = Math.log(c0) + g;
    // Size term, integrated over the size bias.
    let size = 0;
    if (d.sizes.length > 0) {
      inner.length = 0;
      for (let is = 0; is < sNodes.z.length; is++) {
        const b = lc + sNodes.z[is] * MODEL.sizeBias;
        let t = sNodes.lw[is];
        for (const s of d.sizes) {
          const z = (s.m - b) / s.s;
          t += -0.5 * (nu + 1) * Math.log(1 + (z * z) / nu);
        }
        inner.push(t);
      }
      size = logSumExp(inner);
    }
    // Phase term, integrated over the offset.
    let phase = 0;
    if (d.phases.length > 0) {
      const c = c0 * Math.exp(g);
      inner.length = 0;
      for (let io = 0; io < oNodes.z.length; io++) {
        const x0 = oNodes.z[io] * MODEL.offset * c;
        let t = oNodes.lw[io];
        const ic = 1 / c, shift = (0.5 - x0) * ic - 0.5;
        for (const p of d.phases) {
          const table = phaseTable(p.sigma);
          let sum = 0;
          for (const u of p.u) {
            let psi = u * ic + shift;
            psi = Math.abs(psi - Math.round(psi)) * PHASE_BINS * 2;
            const i = psi | 0;
            sum += i >= PHASE_BINS ? table[PHASE_BINS] : table[i] + (psi - i) * (table[i + 1] - table[i]);
          }
          t += p.weight * sum;
        }
        inner.push(t);
      }
      phase = logSumExp(inner);
    }
    outer.push(gNodes.lw[ig] + size + phase);
  }
  const ll = logSumExp(outer);
  let mean = 0, m2 = 0;
  for (let ig = 0; ig < gNodes.z.length; ig++) {
    const w = Math.exp(outer[ig] - ll), lc = Math.log(c0) + gNodes.z[ig] * MODEL.globalScale;
    mean += w * lc;
    m2 += w * lc * lc;
  }
  return { ll, mean, m2 };
}

/** ln prior of a grid: the stated piece count (robust) and squareness of the cells. */
function logPrior(g: GridSpec, ctx: Pick<GridContext, 'refWidth' | 'refHeight' | 'pieceCount' | 'countKind'>): number {
  let lp = 0;
  if (ctx.countKind !== 'unknown' && ctx.pieceCount > 0) {
    const sigma = MODEL.countSigma[ctx.countKind];
    const d = Math.log((g.rows * g.cols) / ctx.pieceCount);
    const inlier = MODEL.countInlier * Math.exp(-0.5 * (d / sigma) ** 2 - Math.log(sigma) - LOG_SQRT_2PI);
    const outlier = Math.abs(d) <= MODEL.countRange ? (1 - MODEL.countInlier) / (2 * MODEL.countRange) : 1e-6;
    lp += Math.log(inlier + outlier);
  }
  const aspect = ctx.refWidth / g.cols / (ctx.refHeight / g.rows);
  lp -= Math.abs(Math.log(aspect)) / MODEL.squareness;
  return lp;
}

/** The cell size the scans measure along an axis (ln reference px), from the evidence alone. */
export interface PooledMeasure {
  log: number;
  /** Its spread (posterior standard deviation over the candidate cell counts and the global scale). */
  spread: number;
  sources: number;
}

/**
 * The measured cell size along an axis: the posterior of ln(cell) under a flat prior over the cell
 * count – sizes and positions only, neither the piece count nor squareness – so a question never
 * rests on the prior.
 */
function measuredCell(post: Map<number, { ll: number; mean: number; m2: number }>, sources: number): PooledMeasure | undefined {
  if (sources === 0) return undefined;
  const lls = [...post.values()].map((p) => p.ll);
  const z = logSumExp(lls);
  let mean = 0, m2 = 0;
  for (const p of post.values()) {
    const w = Math.exp(p.ll - z);
    mean += w * p.mean;
    m2 += w * p.m2;
  }
  return { log: mean, spread: Math.sqrt(Math.max(0, m2 - mean * mean)), sources };
}

export interface RankedGrid {
  grid: GridSpec;
  /** ln posterior (unnormalised). */
  logPost: number;
}

export interface GridAssessment {
  current: GridSpec;
  /** Candidates, most probable first. */
  ranked: RankedGrid[];
  best: GridSpec;
  /** ln posterior of the current grid (it is always among the candidates). */
  currentLogPost: number;
  /** Measured cell width / height (ln reference px; evidence only). */
  w?: PooledMeasure;
  h?: PooledMeasure;
  /** Sources with evidence along x / y, and the scans they come from. */
  sourcesX: number;
  sourcesY: number;
  scansX: number;
  scansY: number;
  /** Scans with any evidence. */
  scans: number;
}

/**
 * Size-only log-likelihood below which (relative to the best candidate) a cell count is not worth
 * its phase term: positions can add at most a few nats per source on top, never this much.
 */
const PRUNE = 40;

/** {@link axisPosterior} for every candidate count; counts the sizes rule out keep their size-only value. */
function axisPosteriors(ns: number[], L: number, d: AxisData): Map<number, { ll: number; mean: number; m2: number }> {
  const out = new Map<number, { ll: number; mean: number; m2: number }>();
  if (d.phases.length === 0 || d.sizes.length === 0) {
    for (const n of ns) out.set(n, axisPosterior(n, L, d));
    return out;
  }
  const sizeOnly = { ...d, phases: [] };
  const pre = ns.map((n) => ({ n, p: axisPosterior(n, L, sizeOnly) }));
  const top = Math.max(...pre.map((x) => x.p.ll));
  for (const { n, p } of pre) out.set(n, p.ll < top - PRUNE ? { ...p, ll: p.ll - PRUNE } : axisPosterior(n, L, d));
  return out;
}

/** Robust centre (ln) of the size measurements along an axis, to place the candidates. */
function roughSize(sizes: AxisSize[]): number | undefined {
  if (sizes.length === 0) return undefined;
  return [...sizes].sort((a, b) => a.m - b.m)[sizes.length >> 1].m;
}

/** Candidate cell counts along an axis: around the stated count, the measurement and the current grid. */
function axisCandidates(L: number, current: number, ideal: number | undefined, measured: number | undefined, wide: boolean): number[] {
  const set = new Set<number>();
  const add = (lo: number, hi: number) => {
    for (let n = Math.max(1, Math.floor(lo)); n <= Math.ceil(hi); n++) set.add(n);
  };
  add(current - 3, current + 3);
  if (ideal) add(ideal / (wide ? 1.35 : 1.3), ideal * (wide ? 1.35 : 1.3));
  if (measured !== undefined) {
    const n = L / Math.exp(measured);
    add(n / 1.15, n * 1.15);
  }
  return [...set].sort((a, b) => a - b);
}

/** Score every plausible grid against the evidence (see module documentation). */
export function assessGrid(ctx: GridContext): GridAssessment {
  const { refWidth: W, refHeight: H } = ctx;
  const dx = axisData(ctx.state, 'x', W), dy = axisData(ctx.state, 'y', H);
  const w0 = roughSize(dx.sizes), h0 = roughSize(dy.sizes);
  const aspect = W / H;
  const count = ctx.countKind === 'unknown' ? undefined : ctx.pieceCount;
  const idealCols = count ? Math.sqrt(count * aspect) : undefined, idealRows = count ? Math.sqrt(count / aspect) : undefined;
  const cols = axisCandidates(W, ctx.grid.cols, idealCols, w0, ctx.countKind !== 'exact');
  const rows = axisCandidates(H, ctx.grid.rows, idealRows, h0, ctx.countKind !== 'exact');
  const px = axisPosteriors(cols, W, dx);
  const py = axisPosteriors(rows, H, dy);
  const lx = new Map([...px].map(([n, p]) => [n, p.ll]));
  const ly = new Map([...py].map(([n, p]) => [n, p.ll]));
  const w = measuredCell(px, dx.sources), h = measuredCell(py, dy.sources);
  const ranked: RankedGrid[] = [];
  for (const r of rows) {
    for (const c of cols) {
      const a = W / c / (H / r);
      if (a < 0.4 || a > 2.5) continue;
      const g = { rows: r, cols: c };
      ranked.push({ grid: g, logPost: lx.get(c)! + ly.get(r)! + logPrior(g, ctx) });
    }
  }
  // The current grid always takes part (also with cells outside the plausible shapes).
  if (!ranked.some((x) => sameGrid(x.grid, ctx.grid))) {
    ranked.push({ grid: { ...ctx.grid }, logPost: lx.get(ctx.grid.cols)! + ly.get(ctx.grid.rows)! + logPrior(ctx.grid, ctx) });
  }
  ranked.sort((a, b) => b.logPost - a.logPost || a.grid.rows * a.grid.cols - b.grid.rows * b.grid.cols);
  const cur = ranked.find((x) => sameGrid(x.grid, ctx.grid))!;
  const scans = Object.values(ctx.state.scans).filter((e) => e.version === GRID_EVIDENCE_VERSION && e.sources.length > 0).length;
  return { current: ctx.grid, ranked, best: ranked[0].grid, currentLogPost: cur.logPost, w, h, sourcesX: dx.sources, sourcesY: dy.sources, scansX: dx.scans, scansY: dy.scans, scans };
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

export type GridDecision =
  | { kind: 'none'; reason: string }
  /** Ask the user (a card): switch to `grid`? */
  | { kind: 'suggest'; grid: GridSpec; odds: number; sources: number; scans: number }
  /** Estimated grid: switch to the measured `grid` without asking. */
  | { kind: 'adopt'; grid: GridSpec; odds: number; sources: number; scans: number }
  /** The scans agree with the current grid: mark it confirmed without asking. */
  | { kind: 'confirm'; odds: number; sources: number };

/**
 * Whether the measured cell size is closer to `alt` than to `cur` by more than its spread, on every
 * axis where the two differ and a size was measured (at least one).
 */
function clearMargin(a: GridAssessment, ctx: GridContext, alt: GridSpec): boolean {
  let checked = 0;
  for (const [n0, n1, m, L] of [
    [ctx.grid.cols, alt.cols, a.w, ctx.refWidth],
    [ctx.grid.rows, alt.rows, a.h, ctx.refHeight],
  ] as const) {
    if (n0 === n1) continue;
    if (!m) continue;
    const dCur = Math.abs(m.log - Math.log(L / n0)), dAlt = Math.abs(m.log - Math.log(L / n1));
    if (dCur - dAlt < GRID_RULES.marginSpreads * m.spread) return false;
    checked++;
  }
  return checked > 0;
}

/** Sources and scans with evidence on an axis where the grids differ (the larger of the two axes). */
function supportFor(a: GridAssessment, cur: GridSpec, alt: GridSpec): { sources: number; scans: number } {
  const x = cur.cols !== alt.cols, y = cur.rows !== alt.rows;
  return { sources: Math.max(x ? a.sourcesX : 0, y ? a.sourcesY : 0), scans: Math.max(x ? a.scansX : 0, y ? a.scansY : 0) };
}

/** What to do about the grid given the accumulated evidence (see module documentation). */
export function decideGrid(ctx: GridContext, a: GridAssessment = assessGrid(ctx)): GridDecision {
  const { state } = ctx;
  if (state.suggestion) return { kind: 'none', reason: 'a question is waiting for an answer' };
  if (a.scans === 0) return { kind: 'none', reason: 'no measurement yet' };
  const best = a.ranked[0];
  if (sameGrid(best.grid, ctx.grid)) {
    if (state.status === 'confirmed') return { kind: 'none', reason: 'confirmed and measured alike' };
    const runnerUp = a.ranked[1];
    const odds = runnerUp ? Math.exp(best.logPost - runnerUp.logPost) : Infinity;
    const sources = Math.max(a.sourcesX, a.sourcesY);
    if (odds >= GRID_RULES.confirmOdds && sources >= GRID_RULES.confirmSources && Math.max(a.scansX, a.scansY) >= GRID_RULES.suggestScans) return { kind: 'confirm', odds, sources };
    return { kind: 'none', reason: 'the current grid is the most probable' };
  }
  const odds = Math.exp(best.logPost - a.currentLogPost);
  const { sources, scans } = supportFor(a, ctx.grid, best.grid);
  // The evidence must point at one grid, not just away from the current one: two scans may say
  // "not 46" while 44 and 45 are still close – ask once it is clear which.
  const runnerUp = a.ranked.find((r) => !sameGrid(r.grid, best.grid) && !sameGrid(r.grid, ctx.grid));
  const distinct = !runnerUp || best.logPost - runnerUp.logPost >= Math.log(GRID_RULES.distinctOdds);
  const margin = clearMargin(a, ctx, best.grid) && distinct;
  const declinedAt = state.declined.find((g) => sameGrid(g, best.grid));
  const declined = !!declinedAt;
  const left = state.left.some((g) => sameGrid(g, best.grid));
  const high = odds >= GRID_RULES.highOdds && sources >= GRID_RULES.highSources && scans >= GRID_RULES.highScans && margin;
  const base = odds >= GRID_RULES.suggestOdds && sources >= GRID_RULES.suggestSources && scans >= GRID_RULES.suggestScans && margin;
  if (state.status === 'estimated') {
    // No count to go by: follow the measurement (one source is enough), but never back to a grid
    // already left unless overwhelmingly.
    const ok = left ? high : odds >= GRID_RULES.suggestOdds && sources >= 1 && margin;
    return ok ? { kind: 'adopt', grid: best.grid, odds, sources, scans: a.scans } : { kind: 'none', reason: 'not decisive yet' };
  }
  const needHigh = state.status === 'confirmed' || declined;
  const fresh = !declinedAt || a.scans - (declinedAt.scans ?? 0) >= GRID_RULES.highScans;
  if (needHigh ? high && fresh : base) return { kind: 'suggest', grid: best.grid, odds, sources, scans: a.scans };
  return { kind: 'none', reason: needHigh ? 'below the high bar' : 'below the bar' };
}

/** State after the user accepted `grid`: confirmed, the question answered. */
export function acceptGrid(state: GridState, previous: GridSpec, at = Date.now()): GridState {
  const { suggestion: _answered, ...rest } = state;
  void _answered;
  return { ...rest, status: 'confirmed', left: [...state.left.filter((g) => !sameGrid(g, previous)), { ...previous }], changedAt: at };
}

/**
 * State after the user kept the current grid: the alternative is remembered as declined, with the
 * number of measured scans so far (`scans`).
 */
export function declineGrid(state: GridState, alt: GridSpec): GridState {
  const { suggestion: _answered, ...rest } = state;
  void _answered;
  const scans = Object.values(state.scans).filter((e) => e.version === GRID_EVIDENCE_VERSION && e.sources.length > 0).length;
  return { ...rest, declined: [...state.declined.filter((g) => !sameGrid(g, alt)), { rows: alt.rows, cols: alt.cols, scans }] };
}

/**
 * State after an estimated grid followed the measurement without asking: no longer a guess but a
 * measured grid ('unconfirmed'): further changes are asked about, like any other grid's.
 */
export function adoptGrid(state: GridState, previous: GridSpec, at = Date.now()): GridState {
  return { ...state, status: 'unconfirmed', left: [...state.left.filter((g) => !sameGrid(g, previous)), { ...previous }], changedAt: at };
}

/**
 * A provisional grid for a puzzle whose piece count is unknown: the picture's aspect with a typical
 * count (1000 pieces), to be measured by the first scans.
 */
export const TYPICAL_PIECE_COUNT = 1000;
export function provisionalGrid(aspect: number, count = TYPICAL_PIECE_COUNT): GridSpec {
  return estimateGrid(count, aspect).best;
}

export { gridKey };
export type { CellSizeSource };

// ---------------------------------------------------------------------------------------------
// Scans → evidence
// ---------------------------------------------------------------------------------------------

/**
 * Evidence of a scan saved before scans measured the cell size: its confidently placed single
 * pieces still say where cell centres are (their reference positions do not depend on the grid),
 * so they count as one positions-only source. Sizes need the photo, i.e. a re-analysis.
 */
export function legacyEvidence(result: ScanResult, grid: GridSpec, ref: { width: number; height: number }): GridEvidence {
  const kinds = new Map(result.regions.map((r) => [r.id, r.kind]));
  const x: number[] = [], y: number[] = [];
  const ids: number[] = [];
  for (const m of result.matches) {
    const c = m.candidates[0];
    if (!c || m.status !== 'confident' || c.confidence < 0.7 || kinds.get(m.regionId) !== 'piece') continue;
    x.push(Math.round(c.x * 10) / 10);
    y.push(Math.round(c.y * 10) / 10);
    ids.push(m.regionId);
  }
  return {
    version: GRID_EVIDENCE_VERSION,
    grid: { ...grid },
    refWidth: ref.width,
    refHeight: ref.height,
    sources: ids.length >= 3 ? [{ kind: 'pieces', regionIds: ids, x, y }] : [],
  };
}

/**
 * The state with exactly one evidence entry per existing scan: measured evidence from the scan's
 * result (or positions-only evidence of an older scan), entries of deleted scans dropped.
 */
export function syncEvidence(state: GridState, scans: { id: string; result: ScanResult }[], grid: GridSpec, ref: { width: number; height: number }): GridState {
  const next: Record<string, GridEvidence> = {};
  for (const s of scans) {
    const ev = s.result.gridEvidence?.version === GRID_EVIDENCE_VERSION ? s.result.gridEvidence : legacyEvidence(s.result, grid, ref);
    next[s.id] = ev;
  }
  return { ...state, scans: next };
}
