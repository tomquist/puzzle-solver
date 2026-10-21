import { describe, expect, it } from 'vitest';
import { GRID_EVIDENCE_VERSION, type CellSizeSource, type GridEvidence, type GridSpec, type GridState } from '../model/types';
import { Rng } from '../testing/synth';
import {
  acceptGrid,
  adoptGrid,
  assessGrid,
  declineGrid,
  decideGrid,
  gridStateOf,
  newGridState,
  sameGrid,
  syncEvidence,
  withoutScan,
  withScanEvidence,
  type GridContext,
} from './gridBelief';

const W = 4729, H = 3547;
const TRUTH: GridSpec = { rows: 34, cols: 45 };

interface ScanSpec {
  /** Patches: cells along x and y (0 = axis not measured). */
  patches?: [number, number][];
  /** Loose pieces placed confidently. */
  pieces?: number;
  /** Extra noise (ln) on every size, and a shared offset of this scan's photo. */
  noise?: number;
  /** Replace the sizes with garbage (a wrong placement, a bad photo). */
  garbage?: boolean;
  /** Truth grid of the generated evidence. */
  truth?: GridSpec;
  /** Reference size (default 4729 × 3547). */
  ref?: [number, number];
  /** Position noise of the cell centres (reference px, default 3 for patches, 5 for pieces). */
  posNoise?: number;
}

/** Evidence of one scan of a puzzle with grid `truth`, as match/cellSize.ts would measure it. */
function scan(rng: Rng, spec: ScanSpec): GridEvidence {
  const t = spec.truth ?? TRUTH;
  const [rw, rh] = spec.ref ?? [W, H];
  const cw = rw / t.cols, ch = rh / t.rows;
  const noise = spec.noise ?? 0.006;
  const photo = rng.normal() * 0.004;
  const sources: CellSizeSource[] = [];
  for (const [nx, ny] of spec.patches ?? []) {
    const se = 0.006 + 0.02 / Math.max(nx, ny, 1);
    const c0 = rng.int(Math.max(1, t.cols - nx)), r0 = rng.int(Math.max(1, t.rows - ny));
    const x: number[] = [], y: number[] = [];
    const pn = spec.posNoise ?? 3;
    const jx = rng.normal() * pn, jy = rng.normal() * pn;
    for (let i = 0; i < Math.max(nx, 1); i++) {
      for (let j = 0; j < Math.max(ny, 1); j++) {
        x.push((c0 + i + 0.5) * cw + jx + rng.normal() * 3);
        y.push((r0 + j + 0.5) * ch + jy + rng.normal() * 3);
      }
    }
    const g = () => (spec.garbage ? rng.uniform(-0.15, 0.15) : 0);
    sources.push({
      kind: 'patch',
      regionIds: [sources.length + 1],
      ...(nx >= 2 ? { w: { log: Math.log(cw) + photo + rng.normal() * noise + g(), se, n: nx } } : {}),
      ...(ny >= 2 ? { h: { log: Math.log(ch) + photo + rng.normal() * noise + g(), se, n: ny } } : {}),
      x: spec.garbage ? x.map((v) => v + rng.uniform(-60, 60)) : x,
      y: spec.garbage ? y.map((v) => v + rng.uniform(-60, 60)) : y,
    });
  }
  if (spec.pieces) {
    const x: number[] = [], y: number[] = [];
    for (let i = 0; i < spec.pieces; i++) {
      x.push((rng.int(t.cols) + 0.5) * cw + rng.normal() * (spec.posNoise ?? 5));
      y.push((rng.int(t.rows) + 0.5) * ch + rng.normal() * (spec.posNoise ?? 5));
    }
    const g = () => (spec.garbage ? rng.uniform(-0.15, 0.15) : 0);
    sources.push({
      kind: 'pieces',
      regionIds: Array.from({ length: spec.pieces }, (_, i) => 100 + i),
      w: { log: Math.log(cw) + photo + rng.normal() * 0.025 + g(), se: 0.02, n: spec.pieces },
      h: { log: Math.log(ch) + photo + rng.normal() * 0.025 + g(), se: 0.02, n: spec.pieces },
      x: spec.garbage ? x.map((v) => v + rng.uniform(-60, 60)) : x,
      y: spec.garbage ? y.map((v) => v + rng.uniform(-60, 60)) : y,
    });
  }
  return { version: GRID_EVIDENCE_VERSION, grid: t, refWidth: rw, refHeight: rh, sources };
}

function ctxOf(grid: GridSpec, state: GridState, count = 1500, countKind: GridContext['countKind'] = 'exact', ref: [number, number] = [W, H]): GridContext {
  return { refWidth: ref[0], refHeight: ref[1], pieceCount: count, countKind, grid, state };
}

/** Replay scans through the decisions, answering every question with "Use it". */
function run(start: GridSpec, scans: GridEvidence[], status: GridState['status'] = 'unconfirmed', count = 1500, countKind: GridContext['countKind'] = 'exact', ref: [number, number] = [W, H]) {
  let grid = start;
  let state = newGridState(status);
  const questions: { at: number; grid: GridSpec }[] = [];
  let adoptions = 0;
  scans.forEach((ev, i) => {
    state = withScanEvidence(state, `s${i}`, ev);
    const d = decideGrid(ctxOf(grid, state, count, countKind, ref));
    if (d.kind === 'suggest') {
      questions.push({ at: i, grid: d.grid });
      state = acceptGrid(state, grid);
      grid = d.grid;
    } else if (d.kind === 'adopt') {
      adoptions++;
      state = adoptGrid(state, grid);
      grid = d.grid;
    } else if (d.kind === 'confirm') state = { ...state, status: 'confirmed' };
  });
  return { grid, state, questions, adoptions };
}

describe('grid belief', () => {
  it('never asks on a single noisy scan, whatever the grid', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(seed);
      for (const start of [TRUTH, { rows: 34, cols: 44 }, { rows: 33, cols: 45 }, { rows: 34, cols: 46 }]) {
        // One patch (or none) with loose pieces, sizes noisy (up to 2 %), or outright garbage.
        const spec: ScanSpec = seed % 3 === 0 ? { patches: [[3, 2]], pieces: 6, noise: 0.02 } : seed % 3 === 1 ? { pieces: 12, garbage: true } : { patches: [[2, 3]], garbage: true };
        const ev = scan(rng, spec);
        const state = withScanEvidence(newGridState('unconfirmed'), 'only', ev);
        expect(decideGrid(ctxOf(start, state)).kind, `seed ${seed} from ${start.cols}×${start.rows}`).not.toBe('suggest');
      }
    }
  });

  it('never asks while the grid is right, however many scans agree (0 questions)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rng = new Rng(100 + seed);
      const scans = Array.from({ length: 15 }, (_, i) => scan(rng, i % 4 === 3 ? { pieces: 20, garbage: true } : { patches: [[rng.int(6) + 2, rng.int(8) + 2]], pieces: 15 }));
      const r = run(TRUTH, scans);
      expect(r.questions, `seed ${seed}`).toEqual([]);
      expect(r.grid).toEqual(TRUTH);
    }
  });

  it('asks once, for the right grid, when consistent evidence contradicts a neighbouring grid', () => {
    for (const start of [{ rows: 34, cols: 44 }, { rows: 33, cols: 45 }, { rows: 34, cols: 46 }]) {
      for (let seed = 1; seed <= 6; seed++) {
        const rng = new Rng(200 + seed);
        const scans = Array.from({ length: 12 }, () => scan(rng, { patches: [[rng.int(5) + 4, rng.int(6) + 4]], pieces: 15 }));
        const r = run(start, scans);
        expect(r.questions.length, `from ${start.cols}×${start.rows} seed ${seed}`).toBe(1);
        expect(r.questions[0].grid).toEqual(TRUTH);
        expect(r.grid).toEqual(TRUTH);
      }
    }
  });

  it('does not ask again once confirmed, nor about a declined grid, below the high bar', () => {
    const rng = new Rng(7);
    // Evidence for 45 columns builds up, scan by scan, while the grid is 44: unconfirmed, confirmed,
    // and unconfirmed with 45 declined.
    const start = { rows: 34, cols: 44 };
    let open = newGridState('unconfirmed');
    let asked = -1, askedConfirmed = -1, askedDeclined = -1;
    for (let i = 0; i < 30; i++) {
      // Weak scans: one small patch placed a little loosely (12 px), sizes within 1.5 %.
      open = withScanEvidence(open, `s${i}`, scan(rng, { patches: [[3, 2]], noise: 0.015, posNoise: 12 }));
      const plain = decideGrid(ctxOf(start, open));
      const confirmed = decideGrid(ctxOf(start, { ...open, status: 'confirmed' }));
      const declined = decideGrid(ctxOf(start, declineGrid(open, TRUTH)));
      if (plain.kind === 'suggest' && asked < 0) {
        asked = i;
        expect(plain.grid).toEqual(TRUTH);
        expect(plain.odds).toBeGreaterThanOrEqual(20);
      }
      for (const [d, at] of [[confirmed, 'confirmed'], [declined, 'declined']] as const) {
        if (d.kind !== 'suggest') continue;
        expect(d.odds, at).toBeGreaterThanOrEqual(1000);
        expect(d.sources, at).toBeGreaterThanOrEqual(3);
        if (at === 'confirmed' && askedConfirmed < 0) askedConfirmed = i;
        if (at === 'declined' && askedDeclined < 0) askedDeclined = i;
      }
    }
    // Hysteresis: the open grid is questioned (not on the first scan); a confirmed grid or a declined
    // alternative never before it, and only past 1000:1 from three scans.
    const when = `asked at ${asked}, confirmed at ${askedConfirmed}, declined at ${askedDeclined}`;
    expect(asked, when).toBeGreaterThanOrEqual(1);
    expect(askedConfirmed === -1 || askedConfirmed >= Math.max(asked, 2), when).toBe(true);
    expect(askedDeclined === -1 || askedDeclined >= Math.max(asked, 2), when).toBe(true);
  });

  it('raises a confirmed grid again when it is far off, past the high bar', () => {
    const rng = new Rng(8);
    const start = { rows: 30, cols: 40 };
    let state = newGridState('confirmed');
    let asked = -1;
    for (let i = 0; i < 6 && asked < 0; i++) {
      state = withScanEvidence(state, `s${i}`, scan(rng, { patches: [[4, 4]], pieces: 10 }));
      const d = decideGrid(ctxOf(start, state));
      if (d.kind === 'suggest') {
        asked = i;
        expect(d.grid).toEqual(TRUTH);
        expect(d.odds).toBeGreaterThanOrEqual(1000);
      }
    }
    expect(asked).toBeGreaterThanOrEqual(1);
  });

  it('confirms the grid without asking once the scans agree strongly', () => {
    const rng = new Rng(9);
    const scans = Array.from({ length: 10 }, () => scan(rng, { patches: [[6, 6]], pieces: 20 }));
    const r = run(TRUTH, scans);
    expect(r.questions).toEqual([]);
    expect(r.state.status).toBe('confirmed');
  });

  it('an estimated grid follows the measurement without asking, from far away', () => {
    const rng = new Rng(11);
    const scans = Array.from({ length: 6 }, () => scan(rng, { patches: [[5, 6]], pieces: 15 }));
    const r = run({ rows: 27, cols: 37 }, scans, 'estimated', 0, 'unknown');
    expect(r.questions).toEqual([]);
    expect(r.adoptions).toBeGreaterThanOrEqual(1);
    expect(r.grid).toEqual(TRUTH);
  });

  it('a wrong piece count is overruled by the scans, with one question', () => {
    const rng = new Rng(12);
    const scans = Array.from({ length: 8 }, () => scan(rng, { patches: [[5, 6]], pieces: 15 }));
    const r = run({ rows: 27, cols: 37 }, scans, 'unconfirmed', 1000);
    expect(r.questions.length).toBe(1);
    expect(r.questions[0].grid).toEqual(TRUTH);
  });

  it('measures long cells of a small puzzle (3 × 6, cells 1.6× wider than tall)', () => {
    const truth = { rows: 6, cols: 3 };
    const ref: [number, number] = [2378, 3000];
    const rng = new Rng(13);
    const evs = Array.from({ length: 4 }, () => scan(rng, { patches: [[3, 5]], pieces: 4, truth, ref }));
    for (const start of [{ rows: 5, cols: 3 }, { rows: 6, cols: 4 }]) {
      const r = run(start, evs, 'unconfirmed', 18, 'exact', ref);
      expect(r.grid, `from ${start.cols}×${start.rows}`).toEqual(truth);
      expect(r.questions.length).toBe(1);
    }
  });

  it('keeps one entry per scan: replacing and deleting scans', () => {
    const rng = new Rng(14);
    let state = newGridState('unconfirmed');
    const ev = scan(rng, { patches: [[5, 5]] });
    state = withScanEvidence(state, 'a', ev);
    state = withScanEvidence(state, 'a', ev);
    expect(Object.keys(state.scans)).toEqual(['a']);
    expect(assessGrid(ctxOf(TRUTH, state)).scans).toBe(1);
    state = withoutScan(state, 'a');
    expect(Object.keys(state.scans)).toEqual([]);
    // Evidence of another version is not kept.
    state = withScanEvidence(state, 'b', { ...ev, version: GRID_EVIDENCE_VERSION + 1 });
    expect(Object.keys(state.scans)).toEqual([]);
  });

  it('syncs the evidence with the scans: measured, positions of older scans, deleted dropped', () => {
    const rng = new Rng(15);
    const measured = scan(rng, { patches: [[4, 4]] });
    const piece = (id: number, x: number, y: number) => ({
      region: { id, kind: 'piece' as const },
      match: { regionId: id, status: 'confident' as const, candidates: [{ row: 0, col: 0, x, y, rotationDeg: 0, score: 0.8, confidence: 0.9 }] },
    });
    const old = [piece(1, 52, 50), piece(2, 158, 260), piece(3, 1000, 700)];
    const base = { width: 100, height: 80, fits: [], quality: { score: 1, issues: [], metrics: {} }, timings: {} };
    const resultNew = { ...base, regions: [], matches: [], gridEvidence: measured };
    const resultOld = { ...base, regions: old.map((o) => ({ ...o.region, bbox: { x: 0, y: 0, width: 1, height: 1 }, contour: [], area: 1, touchesBorder: false, orientationDeg: 0, issues: [] })), matches: old.map((o) => o.match) };
    let state = withScanEvidence(newGridState('unconfirmed'), 'gone', measured);
    state = syncEvidence(state, [{ id: 'a', result: resultNew }, { id: 'b', result: resultOld }], TRUTH, { width: W, height: H });
    expect(Object.keys(state.scans).sort()).toEqual(['a', 'b']);
    expect(state.scans.a).toBe(measured);
    expect(state.scans.b.sources).toEqual([{ kind: 'pieces', regionIds: [1, 2, 3], x: [52, 158, 1000], y: [50, 260, 700] }]);
  });

  it('reads puzzles saved before the grid state existed as unconfirmed without evidence', () => {
    const s = gridStateOf({});
    expect(s.status).toBe('unconfirmed');
    expect(s.scans).toEqual({});
    expect(sameGrid({ rows: 1, cols: 2 }, { rows: 1, cols: 2 })).toBe(true);
  });
});
