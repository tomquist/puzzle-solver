/**
 * The reference picture's cell size, measured from one scan.
 *
 * Why: the grid (rows × columns) comes from the piece count on the box, and boxes round ("1500"
 * for 45 × 34 = 1530) or the user guesses. A grid one column off puts every piece of the right
 * half a cell off. The photo itself says how big a cell is: the print of a placed region matches
 * the picture at some scale (reference px per photo px), and the region shows how big one piece is
 * in the photo – the seams of an assembled patch, or the body of a single piece. Their product is
 * the cell size in reference px, along each axis of the picture, whatever grid the scan was
 * analysed with. `pipeline/gridBelief.ts` turns these measurements into odds between grids.
 *
 * - Patch (one source each, axes separately): the print scale finer than the matcher's own 2.5 %
 *   steps (`measureScale`, with the x / y stretch of a slightly oblique photo) times the pitch of
 *   its seams (`measureLatticePitch`: every internal seam located, a line through them; the lattice
 *   refitted from 0.8–1.25× priors first, so a grid far off along one axis is not echoed).
 * - The scan's single pieces together (one source, weak): body sides × print scale; corner
 *   detection and outlines that include the cardboard's rim scatter them by several per cent.
 * - Positions: every source also lists the reference coordinates of the cell centres it saw (piece
 *   centres; a patch's lattice cells along fitted axes; the belief uses a patch's only along axes
 *   whose pitch it measured) – where they sit in a grid's cells.
 * Left out: regions whose size says they are not one piece (merged, fragments; the matcher's size
 * cap), ambiguous and unmatched regions, pieces with uncertain corners (positions only), and scales
 * at the end of the searched range. When the measured cell is far from the grid's, the probe
 * ({@link probeGridEvidence}) measures again at the scan's own scale.
 */
import { GRID_EVIDENCE_VERSION, type CellSizeSource, type GridEvidence, type LogMeasure } from '../../model/types';
import { fitPatchLattice, latticeCells, latticePoint, latticeSamples, measureLatticePitch, type AxisPitch, type PatchLattice } from '../pieces/patchLattice';
import { matchRegionsDetailed } from './colorCorrection';
import { NOT_ONE_PIECE_CAP, onePieceArea } from './groups';
import { withCells } from './referenceIndex';
import { measureScale, type MatchDetail } from './matchRegion';
import type { MatchInput, ReferenceIndex } from './types';

/**
 * Corner-to-corner body side of a single piece over its cell size, both in photo px: 1 (synthetic
 * scans: the pieces' mean within ±1 % of the true cell; real outlines with the cardboard's rim
 * measure a few per cent large, which the pieces' error floor in the belief absorbs).
 */
export const BODY_TO_CELL = 1;

/** Shape confidence from which a piece's corners are trusted for its size. */
const MIN_SHAPE_CONFIDENCE = 0.6;
/** Match confidence from which a region's scale is trusted. */
const MIN_CONFIDENCE = 0.7;
/** Cells along a lattice axis from which its pitch counts (fewer fix a phase, not a period). */
const MIN_AXIS_CELLS = 2;
/** Scale curvature (score per ln²) below which a region's scale is flat noise. */
const MIN_CURVATURE = 20;
/** Standard error (ln) of a patch's print scale (synthetic patches: within ±0.2 % of the truth). */
const SCALE_SE = 0.004;

/** One region's raw measurement (also used by the calibration tools). */
export interface CellSizeSample {
  regionId: number;
  kind: 'patch' | 'piece';
  /** Reference px per photo px. */
  s: number;
  curvature: number;
  /** ln of the cell width / height in reference px (absent: not measured). */
  w?: number;
  h?: number;
  /** Cells the measurement spans along each axis (patches) or 1 (pieces). */
  nw?: number;
  nh?: number;
  /** Standard error (ln) of `w` / `h` (patches). */
  sew?: number;
  seh?: number;
  /** Reference coordinates of the cell centres it covers (see `CellSizeSource.x`). */
  x?: number[];
  y?: number[];
}

/** Pitch factors tried per lattice axis beyond the fit's own ±6 % (a grid far off along one axis). */
const WIDEN = [0.8, 0.89, 1.12, 1.25];
/** A widened axis must show this much more seam evidence than the placement's lattice to replace it. */
const WIDEN_GAIN = 1.25;

/**
 * The patch's lattice, refitted along each axis from priors 0.8–1.25× its pitch. The placement's
 * lattice starts from the grid's cells, so with cells far off along one axis (a 3 × 5 grid for a
 * 3 × 6 puzzle: 20 % in height) its fit (±6 %) finds no seams there, or seams of the wrong period,
 * and the measurement would echo the grid; the cells it reports are not touched by this.
 */
function widenedLattice(input: MatchInput, lat: PatchLattice): PatchLattice {
  const samples = latticeSamples(input.image, input.mask, lat);
  if (!samples) return lat;
  let best = lat;
  for (const axis of [0, 1] as const) {
    let pick = best;
    for (const f of WIDEN) {
      const prior: PatchLattice = { ...best, pa: axis === 0 ? best.pa * f : best.pa, pb: axis === 1 ? best.pb * f : best.pb, strength: [-1, -1] };
      // Same angle (the placement's lattice fitted it), so the seam samples are computed once.
      const fit = fitPatchLattice(input.image, input.mask, prior, { samples, fixedAngle: true });
      if (fit.strength[axis] < 0) continue;
      if (fit.strength[axis] > Math.max(0, pick.strength[axis]) * (pick === best && best.strength[axis] >= 0 ? WIDEN_GAIN : 1)) pick = fit;
    }
    best = pick;
  }
  return best;
}

/** Cell centres listed per patch at most (the lattice is rigid: more add nothing). */
const MAX_CENTRES = 64;

/**
 * Reference coordinates of a placed patch's lattice cells through its placement at scale `s`, along
 * the picture axes whose lattice axis was fitted to seams (an axis that kept the placement's prior
 * sits exactly on the analysis grid and would only vote for it).
 */
function latticeCentres(d: MatchDetail, input: MatchInput, lat: PatchLattice, s: number, aOnX: boolean): { x?: number[]; y?: number[] } {
  const best = d.best!;
  const { pivot, phi } = best.map;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const fittedX = lat.strength[aOnX ? 0 : 1] >= 0, fittedY = lat.strength[aOnX ? 1 : 0] >= 0;
  const xs: number[] = [], ys: number[] = [];
  const cells = latticeCells(lat, input.mask, input.table);
  const step = Math.max(1, Math.ceil(cells.length / MAX_CENTRES));
  for (let k = 0; k < cells.length; k += step) {
    const p = latticePoint(lat, cells[k].i + 0.5, cells[k].j + 0.5);
    const dx = (p.x + input.origin.x - pivot.x) * s, dy = (p.y + input.origin.y - pivot.y) * s;
    xs.push(best.ref.x + cos * dx - sin * dy);
    ys.push(best.ref.y + sin * dx + cos * dy);
  }
  return { ...(fittedX ? { x: xs } : {}), ...(fittedY ? { y: ys } : {}) };
}

const DEG = Math.PI / 180;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Raw per-region measurements of the cell size (see module documentation). */
export function measureCellSizes(index: ReferenceIndex, inputs: MatchInput[], details: MatchDetail[]): CellSizeSample[] {
  const out: CellSizeSample[] = [];
  details.forEach((d, i) => {
    const input = inputs[i];
    const top = d.match.candidates[0];
    if (!top || !d.best || d.match.status !== 'confident' || top.confidence < MIN_CONFIDENCE || top.confidence <= NOT_ONE_PIECE_CAP) return;
    if (input.kind === 'patch') {
      if (!d.lattice) return;
      const lat = widenedLattice(input, d.lattice);
      if (lat.strength[0] < 0 && lat.strength[1] < 0) return;
      const m = measureScale(index, d, { aspect: true });
      if (!m || m.clipped || m.curvature < MIN_CURVATURE) return;
      const pitch = measureLatticePitch(input.image, input.mask, lat);
      // Lattice axis a runs along the picture's x axis when it stays (anti)parallel to it once turned by the placement.
      const ang = lat.angle + d.best.map.phi;
      const aOnX = Math.abs(Math.cos(ang)) >= Math.abs(Math.sin(ang));
      const sample: CellSizeSample = { regionId: input.regionId, kind: 'patch', s: m.s, curvature: m.curvature, ...latticeCentres(d, input, lat, m.s, aOnX) };
      const put = (p: AxisPitch | undefined, onX: boolean) => {
        if (!p || p.span + 1 < MIN_AXIS_CELLS) return;
        const v = Math.log(p.pitch * (onX ? m.sx : m.sy)), se = Math.hypot(p.se, SCALE_SE);
        if (onX) Object.assign(sample, { w: v, nw: p.span + 1, sew: se });
        else Object.assign(sample, { h: v, nh: p.span + 1, seh: se });
      };
      put(pitch.a, aOnX);
      put(pitch.b, !aOnX);
      if (sample.w !== undefined || sample.h !== undefined) out.push(sample);
      return;
    }
    const shape = input.shape;
    if (input.kind !== 'piece') return;
    const body = input.expectedBodySize ?? shape?.bodySize;
    if (!body) return;
    let area = 0;
    for (let k = 0; k < input.mask.data.length; k++) area += input.mask.data[k];
    if (!onePieceArea(area / (body * body))) return;
    // A confidently placed piece tells where a cell centre is, also without trustworthy corners.
    const positionOnly: CellSizeSample = { regionId: input.regionId, kind: 'piece', s: NaN, curvature: 0, x: [top.x], y: [top.y] };
    if (!shape || shape.confidence < MIN_SHAPE_CONFIDENCE) {
      out.push(positionOnly);
      return;
    }
    const m = measureScale(index, d);
    if (!m || m.clipped) {
      out.push(positionOnly);
      return;
    }
    const across = 0.5 * (shape.sides[0].length + shape.sides[2].length);
    const along = 0.5 * (shape.sides[1].length + shape.sides[3].length);
    // Side 0 points along angleDeg in the photo; turned by the placement it is horizontal or vertical.
    const ang = (shape.angleDeg + top.rotationDeg) * DEG;
    const side0OnX = Math.abs(Math.cos(ang)) >= Math.abs(Math.sin(ang));
    const k = m.s / BODY_TO_CELL;
    out.push({
      regionId: input.regionId,
      kind: 'piece',
      s: m.s,
      curvature: m.curvature,
      w: Math.log((side0OnX ? across : along) * k),
      h: Math.log((side0OnX ? along : across) * k),
      nw: 1,
      nh: 1,
      x: [top.x],
      y: [top.y],
    });
  });
  return out;
}

/**
 * Standard error (ln) of a patch's pitch measurement along an axis spanning `n` cells: the scale is
 * read off the print over the whole patch and the pitch off its seams, both better the more cells
 * they span; a floor covers what neither sees (lens, a photo not quite square to the table).
 */
export function patchAxisError(n: number): number {
  return Math.hypot(PATCH_FLOOR, PATCH_PER_CELL / Math.max(1, n));
}
const PATCH_FLOOR = 0.008;
const PATCH_PER_CELL = 0.03;
/** Spread (ln) of one single piece's measurement; the scan's pieces together count as one source. */
export const PIECE_SPREAD = 0.06;
/** Floor (ln) of the pieces source's standard error, whatever their number (shared photo geometry). */
const PIECES_FLOOR = 0.012;
/** Pieces from which a scan's single pieces form a source. */
const MIN_PIECES = 3;

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Summarise the raw samples into the scan's sources (see module documentation). */
export function summariseCellSizes(samples: CellSizeSample[]): CellSizeSource[] {
  const sources: CellSizeSource[] = [];
  for (const p of samples) {
    if (p.kind !== 'patch') continue;
    const src: CellSizeSource = { kind: 'patch', regionIds: [p.regionId], ...(p.x?.length ? { x: p.x.map(round1) } : {}), ...(p.y?.length ? { y: p.y.map(round1) } : {}) };
    if (p.w !== undefined) src.w = { log: p.w, se: Math.max(PATCH_FLOOR, p.sew ?? patchAxisError(p.nw ?? 1)), n: p.nw ?? 1 };
    if (p.h !== undefined) src.h = { log: p.h, se: Math.max(PATCH_FLOOR, p.seh ?? patchAxisError(p.nh ?? 1)), n: p.nh ?? 1 };
    sources.push(src);
  }
  const pieces = samples.filter((p) => p.kind === 'piece');
  if (pieces.length >= MIN_PIECES) {
    const axis = (vals: number[]): LogMeasure | undefined => {
      if (vals.length < MIN_PIECES) return undefined;
      // Median, then the mean of those within 2.5 spreads (a wrongly placed piece's scale is anything).
      const med = median(vals);
      const kept = vals.filter((v) => Math.abs(v - med) <= 2.5 * PIECE_SPREAD);
      const mean = kept.reduce((a, v) => a + v, 0) / kept.length;
      return { log: mean, se: Math.hypot(PIECES_FLOOR, PIECE_SPREAD / Math.sqrt(kept.length)), n: kept.length };
    };
    const w = axis(pieces.filter((p) => p.w !== undefined).map((p) => p.w!));
    const h = axis(pieces.filter((p) => p.h !== undefined).map((p) => p.h!));
    sources.push({
      kind: 'pieces',
      regionIds: pieces.map((p) => p.regionId),
      ...(w ? { w } : {}),
      ...(h ? { h } : {}),
      x: pieces.flatMap((p) => (p.x ?? []).map(round1)),
      y: pieces.flatMap((p) => (p.y ?? []).map(round1)),
    });
  }
  return sources;
}

/** The scan's cell-size evidence for the grid belief. */
export function measureGridEvidence(index: ReferenceIndex, inputs: MatchInput[], details: MatchDetail[]): { evidence: GridEvidence; samples: CellSizeSample[] } {
  const samples = measureCellSizes(index, inputs, details);
  return {
    evidence: { version: GRID_EVIDENCE_VERSION, grid: { ...index.grid }, refWidth: index.width, refHeight: index.height, sources: summariseCellSizes(samples) },
    samples,
  };
}

/** Implied cell size of the evidence (ln px per axis), from its pooled sources; undefined without sizes. */
function impliedCells(sources: CellSizeSource[]): { w?: number; h?: number } {
  const pool = (ms: LogMeasure[]) => {
    if (ms.length === 0) return undefined;
    let sw = 0, sm = 0;
    for (const m of ms) {
      const w = 1 / (m.se * m.se);
      sw += w;
      sm += w * m.log;
    }
    return sm / sw;
  };
  return { w: pool(sources.flatMap((s) => (s.w ? [s.w] : []))), h: pool(sources.flatMap((s) => (s.h ? [s.h] : []))) };
}

/**
 * Whether {@link probeGridEvidence} would re-measure: 'far' when the measured cell is more than
 * 6 % off the grid's, 'lost' when nothing was measured and fewer than two regions were placed
 * confidently.
 */
export function probeWanted(cellW: number, cellH: number, evidence: GridEvidence, matched: number, mode: GridProbe): 'far' | 'lost' | undefined {
  const implied = impliedCells(evidence.sources);
  const off = (v: number | undefined, l0: number) => (v === undefined ? 0 : v - l0);
  if (Math.max(Math.abs(off(implied.w, Math.log(cellW))), Math.abs(off(implied.h, Math.log(cellH)))) > PROBE_FROM) return 'far';
  if (mode === 'wide' && implied.w === undefined && implied.h === undefined && matched < 2) return 'lost';
  return undefined;
}

/**
 * How far a scan's measurement may reach beyond the grid (analyzeScan's `gridProbe`): 'near'
 * re-measures at the scale the scan itself shows when that is far from the grid's; 'wide' also
 * tries a ladder of scales when nothing was measured at all (a grid that is only a guess).
 */
export type GridProbe = 'near' | 'wide';

/** Cell-size change (ln) from which the probe re-measures at the scale the scan itself implies. */
const PROBE_FROM = 0.06;
/** Regions the probe re-matches (largest patches first, then the largest pieces). */
const PROBE_REGIONS = 6;
/** Regions matched per rung of the ladder (the chosen rung is then measured with all of PROBE_REGIONS). */
const PROBE_LADDER_REGIONS = 4;
/** Cell sizes tried, relative to the grid's, when the scan says nothing at the grid's scale. */
const PROBE_LADDER = [0.8, 1.25, 0.64, 1.6, 2, 2.6, 3.4, 4.4, 5.8, 7.5, 10];

/**
 * Measure the scan at the scale it shows rather than the grid's (`gridProbe` of analyzeScan; the
 * app asks for it while the grid is not confirmed). Matching assumes one cell of the grid per
 * piece and refines the scale by ±10 % only: with a grid far off (a wrong or unknown piece count:
 * 1000 pieces for a 1530-piece puzzle is 22 % in cell size) few regions match and those that do
 * measure a size pulled towards the grid, so a belief built on them would move there in steps,
 * asking each time. So when the measured cell is more than 6 % off the grid's, a few regions (the
 * largest patches, then the largest pieces) are matched again with cells of the measured size
 * (the same pyramid, `withCells`) and measured there, until the size holds; when nothing was
 * measured at all, a ladder of cell sizes (0.64× … 10×) is tried and the one that places most
 * regions confidently is measured. Returns undefined when the evidence at the grid's scale stands.
 */
export function probeGridEvidence(
  index: ReferenceIndex,
  inputs: MatchInput[],
  evidence: GridEvidence,
  matched: number,
  mode: GridProbe = 'wide',
): { evidence: GridEvidence; samples: CellSizeSample[]; tried: number } | undefined {
  const lw0 = Math.log(index.cellW), lh0 = Math.log(index.cellH);
  const implied = impliedCells(evidence.sources);
  const off = (v: number | undefined, l0: number) => (v === undefined ? 0 : v - l0);
  const want = probeWanted(index.cellW, index.cellH, evidence, matched, mode);
  if (!want) return undefined;
  const far = want === 'far';
  const picked = [...inputs]
    .map((inp) => {
      let area = 0;
      for (let i = 0; i < inp.mask.data.length; i++) area += inp.mask.data[i];
      return { inp, area };
    })
    .filter((x) => x.inp.kind === 'patch' || (x.inp.kind === 'piece' && x.inp.shape))
    .sort((a, b) => Number(b.inp.kind === 'patch') - Number(a.inp.kind === 'patch') || b.area - a.area)
    .slice(0, PROBE_REGIONS)
    .map((x) => x.inp);
  if (picked.length === 0) return undefined;
  let tried = 0;
  const run = (lw: number, lh: number, regions = picked) => {
    tried++;
    const view = withCells(index, Math.exp(lw), Math.exp(lh));
    const details = matchRegionsDetailed(view, regions);
    const confident = details.filter((d) => d.match.status === 'confident').length;
    const score = details.reduce((a, d) => a + Math.max(0, d.match.candidates[0]?.score ?? 0), 0);
    return { view, details, confident, score };
  };
  let lw = implied.w ?? (implied.h !== undefined ? lw0 + off(implied.h, lh0) : lw0);
  let lh = implied.h ?? (implied.w !== undefined ? lh0 + off(implied.w, lw0) : lh0);
  let best: ReturnType<typeof run> | undefined;
  if (!far) {
    // Nothing measured: the ladder (the grid's own size was just tried).
    const regions = picked.slice(0, PROBE_LADDER_REGIONS);
    for (const f of PROBE_LADDER) {
      const r = run(lw0 + Math.log(f), lh0 + Math.log(f), regions);
      if (!best || r.confident > best.confident || (r.confident === best.confident && r.score > best.score)) {
        best = r;
        lw = lw0 + Math.log(f);
        lh = lh0 + Math.log(f);
      }
      // Most of them placed confidently: near enough (the rounds below refine it); spare the rest
      // of the ladder (a phone needs seconds per rung).
      if (r.confident >= Math.ceil(0.75 * regions.length)) break;
    }
    if (!best || best.confident === 0) return undefined;
  }
  // Re-measure at the implied size until it holds (at most three rounds).
  let result: { evidence: GridEvidence; samples: CellSizeSample[] } | undefined;
  for (let round = 0; round < 3; round++) {
    const r = round === 0 && best && best.details.length === picked.length ? best : run(lw, lh);
    result = measureGridEvidence(r.view, picked, r.details);
    const next = impliedCells(result.evidence.sources);
    if (next.w === undefined && next.h === undefined) break;
    const dw = off(next.w, lw), dh = off(next.h, lh);
    if (next.w !== undefined) lw = next.w;
    else lw += dh;
    if (next.h !== undefined) lh = next.h;
    else lh += dw;
    if (Math.max(Math.abs(dw), Math.abs(dh)) <= PROBE_FROM / 2) break;
  }
  if (!result || result.evidence.sources.length === 0) return undefined;
  return { ...result, tried };
}
