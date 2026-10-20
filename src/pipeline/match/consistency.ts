/**
 * Placements of one scan made consistent with the shape fits between its pieces, after Yu, Russell
 * & Agapito 2015 ("Solving Jigsaw Puzzles with Linear Programming"), who solve with the pairwise
 * constraints and then prune those the solution does not satisfy.
 *
 * Every region is matched to the picture on its own, so a piece from a plain area (sky, sea) has
 * near-tied places. A shape fit (side i of piece A fits side j of piece B, see `shapeFits`) ties B
 * to A: B lies in the cell next to A's on the puzzle side that A's side i faces, turned so that its
 * side j faces back. Confident placements are the anchors. Per round:
 * 1. Contradictions. A fit between two anchors agrees with both placements or contradicts them. One
 *    wrong placement breaks all its fits, one wrong fit breaks one pair: an anchor contradicted by
 *    at least two fits, more than agree with it, loses confidence (and may be re-placed from its
 *    partners below); every other contradicting fit is dropped. So is a fit that would put a
 *    partner off the grid.
 * 2. Propagation. A fit from an anchor A to a non-confident piece B implies B's cell and rotation,
 *    with support = A's confidence × the fit's. B's matcher score there (scored on demand when it
 *    is not among B's candidates) must be plausible next to B's best score – a fit does not
 *    override clear evidence from the picture. The implied placement's confidence is the noisy-or
 *    of the matcher's and the fit's, and B's candidates are re-ranked.
 * 3. Uniqueness. A cell holds one piece: no implied placement into a cell held by an anchor
 *    (patches hold all their covered cells) or placed by the user; two pieces implied into one
 *    cell, the better supported one wins.
 * Newly confident pieces anchor the next round (at most {@link ROUNDS}). Finally every single piece
 * whose best placement shares a cell with a more confident region moves to its best free candidate.
 *
 * Location hints are not evidence (they come from these very placements). Cost: O(rounds × fits)
 * plus one matcher score per implied placement that is not among the candidates.
 */
import { cellKey, type CellRef, type DetectedRegion, type GridSpec, type MatchStatus, type PieceShape, type Placement, type RegionMatch } from '../../model/types';
import { puzzleSideOf, type ShapeFit } from './fits';
import { CONFIDENT_THRESHOLD } from './matchRegion';

const DIRS: [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // (dRow, dCol) per puzzle side
/** Rounds of contradiction checks and propagation (newly confident pieces anchor the next one). */
const ROUNDS = 3;
/** Fits weaker than this are no evidence (as for shape hints). */
const MIN_FIT = 0.2;
/** A fit is never certain (side shapes of different pieces can be alike). */
const MAX_FIT = 0.9;
/**
 * Plausibility of an implied placement from the region's own matcher score there, relative to its
 * best score: 0.5 at {@link SCORE_SLACK} below it, falling off over {@link SCORE_SOFTNESS}. Near
 * ties in plain areas are a few hundredths apart; a wrong place of a textured piece scores ≥ 0.2
 * lower.
 */
const SCORE_SLACK = 0.1;
const SCORE_SOFTNESS = 0.025;
/** Implied placements with less support (fit × plausibility) are left alone. */
const MIN_SUPPORT = 0.2;
/** An anchor needs this many contradicting fits (and more than agreeing ones) to lose confidence… */
const MIN_CONTRADICTIONS = 2;
/** …by this factor. */
const DEMOTE_FACTOR = 0.5;

export interface ConsistencyOptions {
  /** Cells already placed by the user: no piece of the scan goes there. */
  placedCells?: CellRef[];
  /**
   * The matcher's placement of a region at a cell and rotation it did not list among its candidates
   * (e.g. `scorePlacement`); null when it cannot be scored. Without it, only listed candidates can
   * be promoted.
   */
  score?: (regionId: number, cell: CellRef, rotationDeg: number) => Placement | null;
}

/** Best placement and status of a region before and after the pass. */
export interface ConsistencyChange {
  regionId: number;
  before: { placement?: Placement; status: MatchStatus };
  after: { placement?: Placement; status: MatchStatus };
  /** What changed it last: an implied placement, a demotion, or a move out of a taken cell. */
  reason: 'fit' | 'demoted' | 'unique';
}

export interface ConsistencyReport {
  /** Shape fits used as evidence (at least {@link MIN_FIT}). */
  fits: number;
  /** Fits dropped as contradicting (two anchors, or a partner off the grid). */
  pruned: number;
  /** Matcher scores computed for implied placements that were not among the candidates. */
  scored: number;
  rounds: number;
  /** Regions whose best placement or status changed. */
  changes: ConsistencyChange[];
}

function norm360(d: number): number {
  const v = d % 360;
  return v < 0 ? v + 360 : v;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
}

/** Where a fit puts piece B (local side `j`) when piece A is at `pa` with its local side `i` towards B. */
export function impliedPlacement(shapeA: PieceShape, pa: Pick<Placement, 'row' | 'col' | 'rotationDeg'>, i: number, shapeB: PieceShape, j: number): { row: number; col: number; rotationDeg: number } {
  const side = puzzleSideOf(shapeA, pa.rotationDeg, i);
  // B's side j must face back: puzzleSideOf(shapeB, rot, j) = side + 2 (mod 4).
  return { row: pa.row + DIRS[side][0], col: pa.col + DIRS[side][1], rotationDeg: norm360(90 * (side + 2 - j) - shapeB.angleDeg) };
}

const sameQuarter = (a: number, b: number) => angleDiff(a, b) < 45;

/**
 * Make the placements of one scan consistent with its shape fits (see module documentation).
 * Mutates `matches` (candidates re-ranked, confidences and status updated) and reports what
 * changed. `fits` come from `shapeFits` over the scan's regions; fits between regions that are not
 * single pieces with a shape are ignored.
 */
export function enforceConsistency(regions: readonly DetectedRegion[], matches: RegionMatch[], fits: readonly ShapeFit[], grid: GridSpec, opts: ConsistencyOptions = {}): ConsistencyReport {
  const byId = new Map(matches.map((m) => [m.regionId, m]));
  const shapes = new Map<number, PieceShape>();
  for (const r of regions) if (r.kind === 'piece' && r.shape) shapes.set(r.id, r.shape);
  const before = new Map(matches.map((m) => [m.regionId, { placement: m.candidates[0] ? { ...m.candidates[0] } : undefined, status: m.status }]));
  /** Each region's candidates and best matcher score before the pass (the plausibility reference). */
  const original = new Map(matches.map((m) => [m.regionId, m.candidates.map((c) => ({ ...c }))]));
  const bestScore = new Map(matches.map((m) => [m.regionId, Math.max(...m.candidates.map((c) => c.score), -Infinity)]));
  const reasons = new Map<number, ConsistencyChange['reason']>();
  const report: ConsistencyReport = { fits: 0, pruned: 0, scored: 0, rounds: 0, changes: [] };

  const active = fits.filter((f) => f.confidence >= MIN_FIT && byId.has(f.a) && byId.has(f.b) && shapes.has(f.a) && shapes.has(f.b));
  report.fits = active.length;
  const pruned = new Set<ShapeFit>();
  /** Matcher scores of implied placements, by region, cell and quarter turn (computed once). */
  const scores = new Map<string, Placement | null>();
  const demoted = new Set<number>();
  const inGrid = (c: CellRef) => c.row >= 0 && c.col >= 0 && c.row < grid.rows && c.col < grid.cols;
  const isAnchor = (id: number) => byId.get(id)!.status === 'confident' && byId.get(id)!.candidates.length > 0;
  const cellsOf = (m: RegionMatch): CellRef[] => {
    const c = m.candidates[0];
    if (!c || m.status === 'unmatched') return [];
    return m.coveredCells && m.coveredCells.length > 0 ? m.coveredCells : [{ row: c.row, col: c.col }];
  };
  /** Fit seen from either end: side of `from` towards `to`, and back. */
  const ends = (f: ShapeFit, from: number) => (from === f.a ? { to: f.b, i: f.sideA, j: f.sideB } : { to: f.a, i: f.sideB, j: f.sideA });
  const implied = (f: ShapeFit, from: number) => {
    const e = ends(f, from);
    return { to: e.to, ...impliedPlacement(shapes.get(from)!, byId.get(from)!.candidates[0], e.i, shapes.get(e.to)!, e.j) };
  };
  const strength = (f: ShapeFit) => Math.min(MAX_FIT, f.confidence);

  for (let round = 0; round < ROUNDS; round++) {
    report.rounds = round + 1;
    let changed = false;

    // 1. Contradictions between anchors (and fits that leave the grid).
    const support = new Map<number, number>(), contra = new Map<number, ShapeFit[]>();
    const inc = (id: number) => support.set(id, (support.get(id) ?? 0) + 1);
    const against = (id: number, f: ShapeFit) => contra.set(id, [...(contra.get(id) ?? []), f]);
    for (const f of active) {
      if (pruned.has(f)) continue;
      const aA = isAnchor(f.a), aB = isAnchor(f.b);
      for (const [from, anchored] of [[f.a, aA], [f.b, aB]] as const) {
        if (anchored && !inGrid(implied(f, from))) {
          pruned.add(f);
          against(from, f);
        }
      }
      if (pruned.has(f) || !aA || !aB) continue;
      const p = implied(f, f.a), pb = byId.get(f.b)!.candidates[0];
      if (p.row === pb.row && p.col === pb.col && sameQuarter(p.rotationDeg, pb.rotationDeg)) {
        inc(f.a);
        inc(f.b);
      } else {
        against(f.a, f);
        against(f.b, f);
      }
    }
    const blamed = new Set<number>();
    for (const [id, list] of contra) {
      if (demoted.has(id) || list.length < MIN_CONTRADICTIONS || list.length <= (support.get(id) ?? 0)) continue;
      const m = byId.get(id)!;
      m.candidates[0].confidence *= DEMOTE_FACTOR;
      if (m.candidates[0].confidence < CONFIDENT_THRESHOLD) m.status = 'ambiguous';
      demoted.add(id);
      blamed.add(id);
      reasons.set(id, 'demoted');
      changed = true;
    }
    // Both placements stand: the fit is wrong (residual pruning). A fit with a blamed end stays, to
    // re-place that end from the other.
    for (const list of contra.values()) for (const f of list) if (!blamed.has(f.a) && !blamed.has(f.b)) pruned.add(f);

    // 2. Implied placements of non-confident pieces, from the anchors.
    const taken = new Map<string, number>();
    for (const c of opts.placedCells ?? []) taken.set(cellKey(c), -1);
    for (const m of matches) if (m.status === 'confident') for (const c of cellsOf(m)) taken.set(cellKey(c), m.regionId);
    interface Option { row: number; col: number; rotationDeg: number; p: number }
    const options = new Map<number, Option[]>();
    for (const f of active) {
      if (pruned.has(f)) continue;
      for (const from of [f.a, f.b]) {
        const to = ends(f, from).to;
        if (!isAnchor(from) || isAnchor(to) || byId.get(to)!.status === 'unmatched') continue;
        const q = implied(f, from);
        const p = byId.get(from)!.candidates[0].confidence * strength(f);
        const list = options.get(to) ?? [];
        const same = list.find((o) => o.row === q.row && o.col === q.col && sameQuarter(o.rotationDeg, q.rotationDeg));
        // Agreeing fits (from several anchors) add up as independent evidence.
        if (same) same.p = 1 - (1 - same.p) * (1 - p);
        else list.push({ row: q.row, col: q.col, rotationDeg: q.rotationDeg, p });
        options.set(to, list);
      }
    }
    interface Proposal { id: number; placement: Placement; index: number; confidence: number }
    const proposals: Proposal[] = [];
    for (const [id, list] of options) {
      list.sort((x, y) => y.p - x.p);
      const o = list[0];
      // Fits that disagree about this piece weaken each other.
      const p = o.p * (list.length > 1 ? 1 - list[1].p : 1);
      const holder = taken.get(cellKey(o));
      if (holder !== undefined && holder !== id) continue;
      const m = byId.get(id)!;
      let index = m.candidates.findIndex((c) => c.row === o.row && c.col === o.col && sameQuarter(c.rotationDeg, o.rotationDeg));
      let placement: Placement | null = index >= 0 ? m.candidates[index] : null;
      if (!placement && opts.score) {
        const key = `${id}|${cellKey(o)}|${Math.round(o.rotationDeg / 90) % 4}`;
        if (!scores.has(key)) {
          scores.set(key, opts.score(id, o, o.rotationDeg));
          report.scored++;
        }
        placement = scores.get(key)!;
      }
      if (!placement) continue;
      const plausible = 1 / (1 + Math.exp(-(placement.score - bestScore.get(id)! + SCORE_SLACK) / SCORE_SOFTNESS));
      const s = p * plausible;
      if (s < MIN_SUPPORT) continue;
      // Noisy-or with the matcher's own confidence there (as matched, so later rounds do not count a fit twice).
      const own = original.get(id)!.find((c) => c.row === o.row && c.col === o.col && sameQuarter(c.rotationDeg, o.rotationDeg))?.confidence ?? 0;
      const confidence = 1 - (1 - own) * (1 - s);
      if (index >= 0 && confidence <= placement.confidence + 1e-9) continue;
      proposals.push({ id, placement: { ...placement, row: o.row, col: o.col }, index, confidence });
    }
    proposals.sort((x, y) => y.confidence - x.confidence);
    for (const pr of proposals) {
      const k = cellKey(pr.placement);
      const holder = taken.get(k);
      if (holder !== undefined && holder !== pr.id) continue;
      const m = byId.get(pr.id)!;
      const rest = m.candidates.filter((_, i) => i !== pr.index);
      // The alternatives share what the implied placement leaves.
      const total = rest.reduce((a, c) => a + c.confidence, 0);
      const scale = total > 1 - pr.confidence ? (1 - pr.confidence) / total : 1;
      const list = [{ ...pr.placement, confidence: pr.confidence }, ...rest.map((c) => ({ ...c, confidence: c.confidence * scale }))];
      list.sort((x, y) => y.confidence - x.confidence);
      m.candidates = list.slice(0, Math.max(5, m.candidates.length));
      if (m.candidates[0].confidence >= CONFIDENT_THRESHOLD) {
        m.status = 'confident';
        taken.set(k, pr.id);
      } else m.status = 'ambiguous';
      reasons.set(pr.id, 'fit');
      changed = true;
    }
    if (!changed) break;
  }

  // 3. One region per cell: single pieces in a cell held by a more confident region move to their best free candidate.
  const held = new Map<string, number>();
  for (const c of opts.placedCells ?? []) held.set(cellKey(c), -1);
  const conf = (m: RegionMatch) => (m.status === 'unmatched' || !m.candidates[0] ? -1 : m.candidates[0].confidence + (m.status === 'confident' ? 1 : 0));
  const order = matches.filter((m) => m.status !== 'unmatched' && m.candidates.length > 0).sort((x, y) => conf(y) - conf(x));
  for (const m of order) {
    const isPatch = !!m.coveredCells && m.coveredCells.length > 0;
    const free = (c: CellRef) => !held.has(cellKey(c));
    if (!isPatch && !free(m.candidates[0])) {
      const k = m.candidates.findIndex(free);
      if (k > 0) {
        const [c] = m.candidates.splice(k, 1);
        m.candidates.unshift(c);
        if (m.status === 'confident' && c.confidence < CONFIDENT_THRESHOLD) m.status = 'ambiguous';
        reasons.set(m.regionId, 'unique');
      }
    }
    for (const c of cellsOf(m)) if (!held.has(cellKey(c))) held.set(cellKey(c), m.regionId);
  }

  report.pruned = pruned.size;
  for (const m of matches) {
    const b = before.get(m.regionId)!;
    const a = m.candidates[0];
    const moved = !!a !== !!b.placement || (a && b.placement && (a.row !== b.placement.row || a.col !== b.placement.col || !sameQuarter(a.rotationDeg, b.placement.rotationDeg)));
    if (!moved && b.status === m.status) continue;
    report.changes.push({ regionId: m.regionId, before: b, after: { placement: a ? { ...a } : undefined, status: m.status }, reason: reasons.get(m.regionId) ?? 'fit' });
  }
  return report;
}
