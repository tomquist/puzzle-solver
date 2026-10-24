/**
 * Scan-level colour correction. Photo and box print differ in white balance / exposure, which hurts
 * the colour cue that ambiguous (low-texture) pieces depend on. Confidently matched pieces give
 * pixel-accurate photo ↔ reference colour pairs; a robust affine fit in weighted Lab maps photo
 * colours to reference colours, and the remaining regions are matched again with it.
 */
import type { RegionMatch } from '../../model/types';
import { runSteps, type Steps } from '../steps';
import { capForBorder, capForSize, matchRegionDetailed, matchRegionDetailedSteps, placedConflictOfMatch, type MatchDetail } from './matchRegion';
import { buildTemplate, DEFAULT_SCORE, type ColorCorrection, type ScoreParams } from './template';
import type { MatchInput, MatchOptions, ReferenceIndex } from './types';

/** Score parameters once colours are corrected: absolute colour becomes a much stronger cue. */
export const CORRECTED_SCORE: ScoreParams = { ...DEFAULT_SCORE };

/** Solve a 4×4 linear system (normal equations) by Gaussian elimination; null when singular. */
function solve4(A: Float64Array, b: Float64Array): number[] | null {
  const M = Array.from({ length: 4 }, (_, i) => [A[i * 4], A[i * 4 + 1], A[i * 4 + 2], A[i * 4 + 3], b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < 4; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let s = M[r][4];
    for (let k = r + 1; k < 4; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Estimate the photo → reference colour mapping from confidently matched regions. Returns null when
 * there is too little evidence (fewer than `minRegions` confident regions) or the fit is implausible.
 */
export function estimateColorCorrection(index: ReferenceIndex, details: MatchDetail[], minConfidence = 0.8, minRegions = 2): ColorCorrection | null {
  const level = index.levels[Math.min(1, index.levels.length - 1)];
  const xs: number[] = [], ys: number[] = [];
  let regions = 0;
  for (const d of details) {
    const c0 = d.match.candidates[0];
    if (!d.best || !d.src || d.match.status !== 'confident' || !c0 || c0.confidence < minConfidence) continue;
    const t = buildTemplate(d.src, d.best.map, level, 0.95);
    if (!t) continue;
    const X = Math.round((d.best.ref.x + 0.5) * level.scaleX - 0.5 + level.pad - t.cx);
    const Y = Math.round((d.best.ref.y + 0.5) * level.scaleY - 0.5 + level.pad - t.cy);
    if (X < 0 || Y < 0 || X + t.w > level.stride || Y + t.h > level.rows) continue;
    regions++;
    const step = Math.max(1, Math.floor(t.n / 300));
    const base = Y * level.stride + X;
    for (let i = 0; i < t.n; i += step) {
      const q = (base + t.off[i]) * 3;
      xs.push(t.val[i * 3] + t.mean[0], t.val[i * 3 + 1] + t.mean[1], t.val[i * 3 + 2] + t.mean[2]);
      ys.push(level.data[q], level.data[q + 1], level.data[q + 2]);
    }
  }
  const n = xs.length / 3;
  if (regions < minRegions || n < 150) return null;
  const m: number[] = [];
  const w = new Float64Array(n).fill(1);
  for (let c = 0; c < 3; c++) {
    let coef: number[] | null = null;
    w.fill(1);
    for (let iter = 0; iter < 4; iter++) {
      const A = new Float64Array(16), b = new Float64Array(4);
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        const v = [xs[i * 3], xs[i * 3 + 1], xs[i * 3 + 2], 1];
        for (let r = 0; r < 4; r++) {
          for (let k = 0; k < 4; k++) A[r * 4 + k] += v[r] * v[k];
          b[r] += v[r] * ys[i * 3 + c];
        }
      }
      // Tiny ridge towards the identity keeps poorly constrained cross terms in check.
      for (let r = 0; r < 3; r++) {
        A[r * 4 + r] += 1;
        if (r === c) b[r] += 1;
      }
      coef = solve4(A, b);
      if (!coef) return null;
      const res: number[] = [];
      for (let i = 0; i < n; i++) {
        const pred = coef[0] * xs[i * 3] + coef[1] * xs[i * 3 + 1] + coef[2] * xs[i * 3 + 2] + coef[3];
        res.push(Math.abs(ys[i * 3 + c] - pred));
      }
      const sorted = [...res].sort((a, b) => a - b);
      const mad = Math.max(1, sorted[Math.floor(sorted.length / 2)]);
      for (let i = 0; i < n; i++) w[i] = res[i] < 3 * mad ? 1 : 0;
    }
    if (!coef || coef[c] < 0.5 || coef[c] > 2) return null;
    m.push(...coef);
  }
  return { m };
}

/**
 * Match all regions of one scan: a first pass (without the placed marks), then a colour correction
 * estimated from the confident matches, then a second pass (with a stronger colour cue, and the
 * marks) for the regions that were not confidently matched. Prefer this over calling {@link matchRegionDetailed} per region.
 */
export function matchRegions(index: ReferenceIndex, inputs: MatchInput[], opts: MatchOptions = {}): RegionMatch[] {
  return matchRegionsDetailed(index, inputs, opts).map((d) => d.match);
}

/**
 * {@link matchRegions} with the per-region details (winning similarity, confidence features).
 * `first`: the first pass ({@link firstMatchPass}) of the same index, inputs and options without
 * the placed marks, to reuse (it is not changed).
 */
export function matchRegionsDetailed(index: ReferenceIndex, inputs: MatchInput[], opts: MatchOptions = {}, first?: FirstPass, onProgress?: MatchProgress): MatchDetail[] {
  return runSteps(matchRegionsDetailedSteps(index, inputs, opts, first, onProgress));
}

/**
 * Progress of {@link matchRegionsDetailed}: the share of the work done (0..1, never decreasing),
 * after each region matched. The first pass counts for most when no second one follows.
 */
export type MatchProgress = (done: number) => void;

/**
 * The first pass of {@link matchRegionsDetailed}: every region matched without the placed marks,
 * and the colour correction estimated from them. It does not depend on the marks, so analyses of
 * one scan with different marks may share it (the benchmarks).
 */
export interface FirstPass {
  details: MatchDetail[];
  correction: ColorCorrection | null;
}

/** {@link FirstPass} of `inputs` (the placed marks of `opts` are ignored). */
export function firstMatchPass(index: ReferenceIndex, inputs: MatchInput[], opts: MatchOptions = {}): FirstPass {
  return runSteps(firstMatchPassSteps(index, inputs, opts));
}

function* firstMatchPassSteps(index: ReferenceIndex, inputs: MatchInput[], opts: MatchOptions, onRegion?: (done: number) => void): Steps<FirstPass> {
  const firstOpts = (opts.placedCells?.length ?? 0) > 0 ? { ...opts, placedCells: undefined } : opts;
  const details: MatchDetail[] = [];
  for (const inp of inputs) {
    details.push(yield* matchRegionDetailedSteps(index, inp, firstOpts));
    onRegion?.(details.length);
  }
  return { details, correction: estimateColorCorrection(index, details) };
}

/** A reused first pass's details, with their matches copied (the second pass and later steps change them). */
function copyFirstPass(first: FirstPass): FirstPass {
  return { details: first.details.map((d) => ({ ...d, match: structuredClone(d.match) })), correction: first.correction };
}

/** {@link matchRegionsDetailed} in steps (pipeline/steps.ts): one region's match each. */
export function* matchRegionsDetailedSteps(index: ReferenceIndex, inputs: MatchInput[], opts: MatchOptions = {}, reuse?: FirstPass, onProgress?: MatchProgress): Steps<MatchDetail[]> {
  // The first pass ignores the placed marks: the colour correction comes from the photo alone, so
  // wrong marks cannot change it (with marks, other pieces are confident in the first pass, and a
  // different correction lost true places in the second); pieces the photo alone places surely keep
  // that place, flagged when it is a marked cell. The others are matched with the marks (and the
  // correction, when there is one).
  const marked = (opts.placedCells?.length ?? 0) > 0;
  // (With marks a second pass follows for sure: the first counts for 60 %; otherwise for 90 %.)
  const firstShare = marked ? 0.6 : 0.9;
  const n = inputs.length;
  const { details: first, correction } = reuse ? copyFirstPass(reuse) : yield* firstMatchPassSteps(index, inputs, opts, onProgress && ((k) => onProgress((firstShare * k) / n)));
  let out = first;
  if (correction || marked) {
    out = [];
    const again = first.filter((d) => !(d.match.status === 'confident' && d.match.candidates[0].confidence >= 0.9)).length;
    let done = 0;
    for (let i = 0; i < inputs.length; i++) {
      const d = first[i];
      if (d.match.status === 'confident' && d.match.candidates[0].confidence >= 0.9) {
        if (marked) {
          const conflict = placedConflictOfMatch(d.match, opts.placedCells!);
          if (conflict) d.match.placedConflict = conflict;
        }
        out.push(d);
      } else {
        out.push(yield* matchRegionDetailedSteps(index, inputs[i], opts, correction ? { correction, score: CORRECTED_SCORE } : {}));
        onProgress?.(firstShare + ((1 - firstShare) * ++done) / again);
      }
    }
  }
  onProgress?.(1);
  // Outlines that include cast shadow / table: judged against the whole scan (hard shadows affect
  // every piece of a photo, so the scan's typical border tells what is normal).
  const borders = inputs.filter((inp) => inp.kind === 'piece' && inp.outline?.borderTable !== undefined).map((inp) => inp.outline!.borderTable!).sort((a, b) => a - b);
  const scanMedian = borders.length >= 3 ? borders[borders.length >> 1] : undefined;
  out.forEach((d, i) => {
    capForBorder(d, inputs[i], scanMedian);
    capForSize(d, inputs[i]);
    if (d.match.status === 'ambiguous' && d.reason) d.match.uncertainReason = d.reason;
  });
  return out;
}
