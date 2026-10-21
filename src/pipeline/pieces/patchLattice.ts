/**
 * The cell lattice of an assembled patch in the photo, fitted to its own seams, and the cells it
 * holds.
 *
 * Why: the matcher places a patch by one similarity transform fitted to its print. Over a large
 * block a small error of that transform's angle or scale (or a photo that is not quite a similarity
 * of the picture: lens, perspective, a block that is not flat) shifts the far cells by a quarter of
 * a cell or more, so a cell test through that transform drops edge pieces and counts holes that
 * the neighbours' tabs reach into. The pieces themselves say where the cells are: the cut lines
 * between them and the straight body edges of the outline run along two perpendicular families of
 * lines, one cell apart. Fitting that lattice (angle, the pitch along each axis, the phase of each)
 * to the seams gives the patch's cells exactly, and a cell is present when the middle of its body
 * is covered by the patch (and does not show the table).
 *
 * The fit starts from a prior lattice (from the placement transform) and searches the angle
 * (±2.4°), each pitch (±6 %) and each phase around it. Seam evidence per axis: dark thin lines
 * across the axis (second derivative of the luminance) at every patch pixel, plus the outline
 * pixels facing that axis, projected onto the axis and folded by the pitch; the phase where the
 * folded profile peaks narrowly (a seam is a line; knob outlines spread around the cell middle) is
 * where the seams are. Each axis is trusted only when that peak clearly stands out and lies within
 * 0.4 cells of the prior's (measured at the patch's middle): otherwise it keeps the prior's pitch
 * and phase (blurry or low-contrast seams; along a two-piece patch the knobs at its ends are as
 * strong as its one seam). Fewer than 4 cells along an axis fix a phase but no pitch; the angle
 * changes only when both axes are trusted.
 */
import type { Point } from '../../cv/geometry';
import type { Mask, RGBAImage } from '../../cv/image';

/**
 * A cell lattice in photo (crop) coordinates. Lattice point (a, b) lies at
 * `origin + a·pa·û + b·pb·v̂` with û = (cos angle, sin angle) and v̂ = (−sin angle, cos angle) (û
 * turned 90° clockwise on screen); seams run along integer a and integer b, cell (i, j) spans
 * a ∈ [i, i + 1], b ∈ [j, j + 1].
 */
export interface PatchLattice {
  origin: Point;
  /** Direction of the a axis (radians, clockwise from +x on screen). */
  angle: number;
  /** Photo px per cell along a and along b. */
  pa: number;
  pb: number;
  /**
   * Seam evidence per axis (0 = none … 1 = every seam pixel on a seam line), or -1 when that axis
   * kept the prior's pitch and phase.
   */
  strength: [number, number];
}

/** Photo point of lattice coordinates (a, b). */
export function latticePoint(l: PatchLattice, a: number, b: number): Point {
  const c = Math.cos(l.angle), s = Math.sin(l.angle);
  return { x: l.origin.x + a * l.pa * c - b * l.pb * s, y: l.origin.y + a * l.pa * s + b * l.pb * c };
}

/** Lattice coordinates of a photo point. */
export function latticeCoords(l: PatchLattice, p: Point): { a: number; b: number } {
  const c = Math.cos(l.angle), s = Math.sin(l.angle);
  const dx = p.x - l.origin.x, dy = p.y - l.origin.y;
  return { a: (dx * c + dy * s) / l.pa, b: (-dx * s + dy * c) / l.pb };
}

/** Angle search around the prior (degrees): ±ANGLE_RANGE in ANGLE_STEP, then ±ANGLE_STEP in ANGLE_FINE. */
const ANGLE_RANGE = 2.4;
const ANGLE_STEP = 0.3;
const ANGLE_FINE = 0.05;
/** Pitch search around the prior (relative), coarse step and fine step. */
const PITCH_RANGE = 0.06;
const PITCH_STEP = 0.005;
const PITCH_FINE = 0.001;
/**
 * Cells along an axis from which its phase is fitted (one piece across shows two straight edges)
 * and from which its pitch is fitted too (fewer seams fix a phase but not a period).
 */
const FIT_PHASE_CELLS = 1;
const FIT_PITCH_CELLS = 4;
/** Phase prominence (see `AxisFit.prominence`) from which an axis's seams are trusted. */
const MIN_PROMINENCE = 0.35;
/** Largest shift (cells) of the seams from the prior's that is believed (the placement is better than that). */
const MAX_SHIFT = 0.4;
/** Phase bins of the folded profile. */
const PHASE_BINS = 96;
/** Width (cells, Gaussian sigma) of the seam kernel the folded profile is matched with. */
const SEAM_SIGMA = 0.035;
/** Outline pixels weigh this many mean seam responses (scaled by how squarely they face the axis). */
const OUTLINE_WEIGHT = 4;

interface Samples {
  x: Float32Array;
  y: Float32Array;
  /** Seam evidence across the a axis (vertical-ish seams) and across the b axis. */
  wa: Float32Array;
  wb: Float32Array;
  /** 1 for outline pixels (their weights are the outline's, not seam responses). */
  edge: Uint8Array;
  n: number;
}

/** Seam and outline evidence at every patch pixel (directions from the prior angle). */
function seamSamples(image: RGBAImage, mask: Mask, angle: number, pitch: number): Samples | null {
  const { width: w, height: h } = image;
  const L = new Float32Array(w * h);
  const D = image.data;
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * D[i * 4] + 0.587 * D[i * 4 + 1] + 0.114 * D[i * 4 + 2];
  const ca = Math.cos(angle), sa = Math.sin(angle);
  // Offset of the line detector: thin cut lines are a few px wide; wider in larger (closer) photos.
  const r = Math.max(2, Math.round(pitch / 45));
  const at = (x: number, y: number): number => {
    const ix = Math.round(x), iy = Math.round(y);
    return ix < 0 || iy < 0 || ix >= w || iy >= h || !mask.data[iy * w + ix] ? NaN : L[iy * w + ix];
  };
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i];
  if (n === 0) return null;
  const xs = new Float32Array(n), ys = new Float32Array(n), wa = new Float32Array(n), wb = new Float32Array(n);
  const edge = new Uint8Array(n);
  const ox = r * ca, oy = r * sa;
  let m = 0, sum = 0, cnt = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask.data[i]) continue;
      const c2 = 2 * L[i];
      // Dark lines only: a cut line is a shadowed groove or a dark gap (bright print highlights and
      // pale knob outlines would add a comb of their own).
      const da = Math.max(0, at(x + ox, y + oy) + at(x - ox, y - oy) - c2);
      const db = Math.max(0, at(x - oy, y + ox) + at(x + oy, y - ox) - c2);
      xs[m] = x;
      ys[m] = y;
      wa[m] = Number.isNaN(da) ? 0 : da;
      wb[m] = Number.isNaN(db) ? 0 : db;
      if (!Number.isNaN(da + db)) {
        sum += da + db;
        cnt += 2;
      }
      const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask.data[i - 1] || !mask.data[i + 1] || !mask.data[i - w] || !mask.data[i + w];
      edge[m] = onEdge ? 1 : 0;
      m++;
    }
  }
  // Outline pixels: the straight body edges of the rim lie on seam lines. Their normal (mask
  // gradient over 5×5) says which axis they face.
  const mean = cnt > 0 ? sum / cnt : 1;
  const mk = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask.data[y * w + x]);
  for (let k = 0; k < m; k++) {
    if (!edge[k]) continue;
    const x = xs[k], y = ys[k];
    let gx = 0, gy = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const v = mk(x + dx, y + dy);
        gx += v * dx;
        gy += v * dy;
      }
    }
    const g = Math.hypot(gx, gy);
    if (g === 0) continue;
    const na = (gx * ca + gy * sa) / g, nb = (-gx * sa + gy * ca) / g;
    wa[k] = OUTLINE_WEIGHT * mean * na ** 4;
    wb[k] = OUTLINE_WEIGHT * mean * nb ** 4;
  }
  return { x: xs, y: ys, wa, wb, edge, n: m };
}

/** Seam kernel over the phase bins (zero mean) and its peak-minus-mean value. */
const KERNEL = (() => {
  const k = new Float64Array(PHASE_BINS);
  let mean = 0;
  for (let j = 0; j < PHASE_BINS; j++) {
    const d = Math.min(j, PHASE_BINS - j) / PHASE_BINS;
    k[j] = Math.exp(-(d * d) / (2 * SEAM_SIGMA * SEAM_SIGMA));
    mean += k[j];
  }
  mean /= PHASE_BINS;
  for (let j = 0; j < PHASE_BINS; j++) k[j] -= mean;
  return { k, peak: k[0] };
})();

interface AxisFit {
  pitch: number;
  /** Seam position (px along the axis, modulo pitch) relative to the projection origin. */
  phase: number;
  strength: number;
  /**
   * How clearly the seam phase stands out: the folded profile's peak over the best phase at least
   * {@link PROMINENCE_GAP} cells away, relative to the profile's range (0 = an equal second peak,
   * 1 = nothing else).
   */
  prominence: number;
}

/** Distance (cells) from the seam phase beyond which a second peak counts against it. */
const PROMINENCE_GAP = 0.15;

/**
 * Best pitch (among `pitches`) and phase of seams in a projected profile (`prof[k]` = evidence at
 * axis coordinate u0 + k·bin).
 */
function fitAxis(prof: Float64Array, u0: number, bin: number, pitches: number[]): AxisFit | null {
  let mass = 0;
  for (let k = 0; k < prof.length; k++) mass += prof[k];
  if (mass <= 0) return null;
  const hist = new Float64Array(PHASE_BINS), conv = new Float64Array(PHASE_BINS);
  let best: AxisFit | null = null;
  for (const p of pitches) {
    hist.fill(0);
    for (let k = 0; k < prof.length; k++) {
      const v = prof[k];
      if (v === 0) continue;
      let f = ((u0 + (k + 0.5) * bin) / p) % 1;
      if (f < 0) f += 1;
      hist[Math.min(PHASE_BINS - 1, Math.floor(f * PHASE_BINS))] += v;
    }
    let bj = 0, bv = -Infinity;
    for (let j = 0; j < PHASE_BINS; j++) {
      let s = 0;
      for (let t = 0; t < PHASE_BINS; t++) s += hist[t] * KERNEL.k[(t - j + PHASE_BINS) % PHASE_BINS];
      conv[j] = s;
      if (s > bv) {
        bv = s;
        bj = j;
      }
    }
    const strength = bv / (mass * KERNEL.peak);
    if (best && strength <= best.strength) continue;
    // Sub-bin peak (parabola through the neighbours); bins hold phases [j, j + 1) / PHASE_BINS.
    const l = conv[(bj + PHASE_BINS - 1) % PHASE_BINS], r = conv[(bj + 1) % PHASE_BINS];
    const den = l - 2 * bv + r;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    let second = -Infinity, lo = Infinity;
    const gap = Math.round(PROMINENCE_GAP * PHASE_BINS);
    for (let j = 0; j < PHASE_BINS; j++) {
      lo = Math.min(lo, conv[j]);
      const d = Math.abs(j - bj);
      if (Math.min(d, PHASE_BINS - d) > gap) second = Math.max(second, conv[j]);
    }
    best = { pitch: p, phase: ((bj + 0.5 + off) / PHASE_BINS) * p, strength, prominence: bv > lo ? (bv - second) / (bv - lo) : 0 };
  }
  return best;
}

/** Profiles of the samples projected onto û (a) and v̂ (b) at `angle`, around the point `c`. */
function project(s: Samples, angle: number, c: Point, bin: number) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let k = 0; k < s.n; k++) {
    const dx = s.x[k] - c.x, dy = s.y[k] - c.y;
    const a = dx * ca + dy * sa, b = -dx * sa + dy * ca;
    if (a < a0) a0 = a;
    if (a > a1) a1 = a;
    if (b < b0) b0 = b;
    if (b > b1) b1 = b;
  }
  const pa = new Float64Array(Math.floor((a1 - a0) / bin) + 1), pb = new Float64Array(Math.floor((b1 - b0) / bin) + 1);
  for (let k = 0; k < s.n; k++) {
    const dx = s.x[k] - c.x, dy = s.y[k] - c.y;
    pa[Math.floor((dx * ca + dy * sa - a0) / bin)] += s.wa[k];
    pb[Math.floor((-dx * sa + dy * ca - b0) / bin)] += s.wb[k];
  }
  return { pa, a0, pb, b0 };
}

const range = (centre: number, rel: number, step: number): number[] => {
  const out: number[] = [];
  for (let f = -rel; f <= rel + 1e-9; f += step) out.push(centre * (1 + f));
  return out;
};

/** Options of {@link fitPatchLattice}. */
export interface LatticeFitOptions {
  /** Seam samples of the patch ({@link latticeSamples}), to fit several priors without recomputing them. */
  samples?: LatticeSamples;
  /** Keep the prior's angle (fit pitches and phases only). */
  fixedAngle?: boolean;
}

/** The patch's seam and outline evidence (opaque), for repeated fits. */
export type LatticeSamples = Samples;

/** Seam samples for fits around lattice `l` ({@link LatticeFitOptions.samples}). */
export function latticeSamples(image: RGBAImage, mask: Mask, l: PatchLattice): LatticeSamples | null {
  return seamSamples(image, mask, l.angle, Math.sqrt(l.pa * l.pb));
}

/**
 * Fit the patch's cell lattice to its seams, starting from `prior` (see module documentation).
 * The result's origin is a seam crossing near the middle of the patch.
 */
export function fitPatchLattice(image: RGBAImage, mask: Mask, prior: PatchLattice, opts: LatticeFitOptions = {}): PatchLattice {
  const samples = opts.samples ?? seamSamples(image, mask, prior.angle, Math.sqrt(prior.pa * prior.pb));
  if (!samples) return { ...prior, strength: [-1, -1] };
  // Phases are measured from the prior's seam crossing nearest the patch's middle (an angle error
  // turns the lattice about it; shifts far from the patch say nothing).
  let mx = 0, my = 0;
  for (let k = 0; k < samples.n; k++) {
    mx += samples.x[k];
    my += samples.y[k];
  }
  const q = latticeCoords(prior, { x: mx / samples.n, y: my / samples.n });
  const c = latticePoint(prior, Math.round(q.a), Math.round(q.b));
  const keep: PatchLattice = { ...prior, origin: c, strength: [-1, -1] };
  const bin = Math.max(0.5, Math.min(prior.pa, prior.pb) / 200);
  const D = Math.PI / 180;
  const p0 = project(samples, prior.angle, c, bin);
  const cellsA = (p0.pa.length * bin) / prior.pa, cellsB = (p0.pb.length * bin) / prior.pb;
  const fitA = cellsA >= FIT_PHASE_CELLS, fitB = cellsB >= FIT_PHASE_CELLS;
  if (!fitA && !fitB) return keep;
  const freeA = cellsA >= FIT_PITCH_CELLS, freeB = cellsB >= FIT_PITCH_CELLS;
  const at = (angle: number, rel: number, step: number, pa0: number, pb0: number) => {
    const p = project(samples, angle, c, bin);
    const fa = fitA ? fitAxis(p.pa, p.a0, bin, freeA ? range(pa0, rel, step) : [prior.pa]) : null;
    const fb = fitB ? fitAxis(p.pb, p.b0, bin, freeB ? range(pb0, rel, step) : [prior.pb]) : null;
    return { angle, fa, fb, score: (fa?.strength ?? 0) + (fb?.strength ?? 0) };
  };
  // Seam offset along an axis from the prior's (at c), and whether that axis is trusted.
  const near = (f: AxisFit) => f.phase - Math.round(f.phase / f.pitch) * f.pitch;
  const trusted = (f: AxisFit | null, p: number): f is AxisFit => !!f && f.prominence >= MIN_PROMINENCE && Math.abs(near(f)) <= MAX_SHIFT * p;
  let best = at(prior.angle, PITCH_RANGE, PITCH_STEP, prior.pa, prior.pb);
  const atPrior = best;
  if (fitA && fitB && !opts.fixedAngle) {
    for (let d = -ANGLE_RANGE; d <= ANGLE_RANGE + 1e-9; d += ANGLE_STEP) {
      if (Math.abs(d) < 1e-9) continue;
      const r = at(prior.angle + d * D, PITCH_RANGE, PITCH_STEP, prior.pa, prior.pb);
      if (r.score > best.score) best = r;
    }
  }
  const coarse = best;
  for (let d = -ANGLE_STEP; d <= ANGLE_STEP + 1e-9; d += ANGLE_FINE) {
    if ((!(fitA && fitB) || opts.fixedAngle) && Math.abs(d) > 1e-9) continue;
    const r = at(coarse.angle + d * D, PITCH_STEP * 2, PITCH_FINE, coarse.fa?.pitch ?? prior.pa, coarse.fb?.pitch ?? prior.pb);
    if (r.score > best.score) best = r;
  }
  // A new angle needs both families of seams; otherwise the trusted axis is fitted at the prior's.
  if (!(trusted(best.fa, prior.pa) && trusted(best.fb, prior.pb))) best = atPrior;
  const okA = trusted(best.fa, prior.pa), okB = trusted(best.fb, prior.pb);
  if (!okA && !okB) return keep;
  const angle = best.angle;
  const pa = okA ? best.fa!.pitch : prior.pa, pb = okB ? best.fb!.pitch : prior.pb;
  const da = okA ? near(best.fa!) : 0, db = okB ? near(best.fb!) : 0;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return {
    origin: { x: c.x + da * ca - db * sa, y: c.y + da * sa + db * ca },
    angle,
    pa,
    pb,
    strength: [okA ? best.fa!.strength : -1, okB ? best.fb!.strength : -1],
  };
}

/** Body middle of a cell, as a share of its size, whose coverage decides it (tabs of neighbours reach ~0.3 into a hole). */
const CORE = 0.5;
/** Samples per side of the core. */
const CORE_SAMPLES = 8;
/** Share of the core that must be patch (and not table) for a cell to count. */
const CORE_COVERED = 0.5;

/** A lattice cell of the patch and how much of its body middle the patch covers. */
export interface LatticeCell {
  i: number;
  j: number;
  coverage: number;
}

/**
 * The lattice cells whose body middle the patch covers (`table`, optional, crop-sized: patch pixels
 * that show the table, e.g. a hole the segmentation filled; they count as not covered). Tools pass
 * `minCoverage` 0 to see every cell under the patch with its coverage.
 */
export function latticeCells(l: PatchLattice, mask: Mask, table?: Mask, minCoverage = CORE_COVERED): LatticeCell[] {
  const { width: w, height: h } = mask;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const q = latticeCoords(l, { x, y });
    a0 = Math.min(a0, q.a);
    a1 = Math.max(a1, q.a);
    b0 = Math.min(b0, q.b);
    b1 = Math.max(b1, q.b);
  }
  const out: LatticeCell[] = [];
  const lo = (1 - CORE) / 2;
  for (let j = Math.floor(b0); j < Math.ceil(b1); j++) {
    for (let i = Math.floor(a0); i < Math.ceil(a1); i++) {
      let hit = 0;
      for (let t = 0; t < CORE_SAMPLES; t++) {
        for (let s = 0; s < CORE_SAMPLES; s++) {
          const p = latticePoint(l, i + lo + (CORE * (s + 0.5)) / CORE_SAMPLES, j + lo + (CORE * (t + 0.5)) / CORE_SAMPLES);
          const ix = Math.round(p.x), iy = Math.round(p.y);
          if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
          const k = iy * w + ix;
          if (mask.data[k] && !(table && table.data[k])) hit++;
        }
      }
      const coverage = hit / (CORE_SAMPLES * CORE_SAMPLES);
      if (coverage >= minCoverage) out.push({ i, j, coverage });
    }
  }
  return out;
}

/** Pitch of one lattice axis measured from its individual seams (see {@link measureLatticePitch}). */
export interface AxisPitch {
  /** Photo px per cell. */
  pitch: number;
  /** Standard error of ln(pitch). */
  se: number;
  /** Internal seams located. */
  seams: number;
  /** Seam index span (last − first located seam). */
  span: number;
}

/** Bin width (cells) of the per-seam profiles, and the Gaussian smoothing applied to them. */
const SEAM_BIN = 0.01;
const SEAM_SMOOTH = 1.5;
/** Half-width (cells) of the window around an expected seam in which its line is looked for. */
const SEAM_WINDOW = 0.22;
/** A seam counts when its peak stands this far (share of the peak) above the window's median. */
const SEAM_CONTRAST = 0.35;
/** Seams need this share of the median seam's support (pixels along it) to count. */
const SEAM_SUPPORT = 0.35;
/** Floor of a located seam's position error (cells): line width, pixel grid. */
const SEAM_POS_FLOOR = 0.012;
/** Position error (cells) assumed per seam when two seams leave no residual to measure it by. */
const SEAM_POS_TWO = 0.03;

/**
 * The pitch along each axis of a fitted lattice, measured for the cell-size evidence
 * (match/cellSize.ts) rather than for the cells: the lattice fit maximises one folded comb over a
 * search grid, which places the cells well but leaves its pitch a few per cent off on faint seams
 * (a pitch error over a few cells shifts the comb less than the seams' width). Here every internal
 * seam is located on its own – the peak of the dark-line response projected across the axis,
 * within ±0.22 cells of where the lattice puts it – and a weighted line through seam position over
 * seam index gives the pitch, with a standard error from the residuals (two seams: an assumed
 * position error). Outline pixels are left out (the rim's knobs blur its body edge). Axes the
 * lattice fit did not trust (`strength` −1) are not measured.
 */
export function measureLatticePitch(image: RGBAImage, mask: Mask, l: PatchLattice): { a?: AxisPitch; b?: AxisPitch } {
  const samples = seamSamples(image, mask, l.angle, Math.sqrt(l.pa * l.pb));
  if (!samples) return {};
  const ca = Math.cos(l.angle), sa = Math.sin(l.angle);
  const axis = (onA: boolean): AxisPitch | undefined => {
    if (l.strength[onA ? 0 : 1] < 0) return undefined;
    const p = onA ? l.pa : l.pb;
    const w = onA ? samples.wa : samples.wb;
    let t0 = Infinity, t1 = -Infinity;
    const ts = new Float32Array(samples.n);
    for (let k = 0; k < samples.n; k++) {
      const dx = samples.x[k] - l.origin.x, dy = samples.y[k] - l.origin.y;
      const t = (onA ? dx * ca + dy * sa : -dx * sa + dy * ca) / p;
      ts[k] = t;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    const lo = Math.floor(t0) - 1;
    const nb = Math.ceil((t1 - lo + 1) / SEAM_BIN) + 1;
    const prof = new Float64Array(nb), support = new Float64Array(nb);
    for (let k = 0; k < samples.n; k++) {
      const b = Math.floor((ts[k] - lo) / SEAM_BIN);
      support[b]++;
      if (!samples.edge[k]) prof[b] += w[k];
    }
    // Smooth (Gaussian, SEAM_SMOOTH bins).
    const rad = Math.ceil(3 * SEAM_SMOOTH);
    const ker: number[] = [];
    for (let j = -rad; j <= rad; j++) ker.push(Math.exp(-(j * j) / (2 * SEAM_SMOOTH * SEAM_SMOOTH)));
    const sm = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      let s = 0, ws = 0;
      for (let j = -rad; j <= rad; j++) {
        const q = i + j;
        if (q < 0 || q >= nb) continue;
        s += ker[j + rad] * prof[q];
        ws += ker[j + rad];
      }
      sm[i] = s / ws;
    }
    // Support of a seam: patch pixels within a tenth of a cell of it (its length across the patch).
    const seamSupport = (k: number) => {
      const c = Math.round((k - lo) / SEAM_BIN), r = Math.round(0.1 / SEAM_BIN);
      let s = 0;
      for (let i = Math.max(0, c - r); i <= Math.min(nb - 1, c + r); i++) s += support[i];
      return s;
    };
    const ks: number[] = [];
    for (let k = Math.ceil(t0 + 0.5); k <= Math.floor(t1 - 0.5); k++) ks.push(k);
    if (ks.length < 2) return undefined;
    const sup = ks.map(seamSupport);
    const medSup = [...sup].sort((x, y) => x - y)[sup.length >> 1];
    const found: { k: number; pos: number; wt: number }[] = [];
    ks.forEach((k, idx) => {
      if (sup[idx] < SEAM_SUPPORT * medSup) return;
      const c = Math.round((k - lo) / SEAM_BIN), r = Math.round(SEAM_WINDOW / SEAM_BIN);
      const i0 = Math.max(1, c - r), i1 = Math.min(nb - 2, c + r);
      let bi = i0;
      const vals: number[] = [];
      for (let i = i0; i <= i1; i++) {
        vals.push(sm[i]);
        if (sm[i] > sm[bi]) bi = i;
      }
      vals.sort((x, y) => x - y);
      const med = vals[vals.length >> 1];
      if (!(sm[bi] > 0) || (sm[bi] - med) / sm[bi] < SEAM_CONTRAST || bi === i0 || bi === i1) return;
      const den = sm[bi - 1] - 2 * sm[bi] + sm[bi + 1];
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (sm[bi - 1] - sm[bi + 1])) / den)) : 0;
      found.push({ k, pos: lo + (bi + 0.5 + off) * SEAM_BIN, wt: Math.sqrt(sup[idx]) });
    });
    if (found.length < 2) return undefined;
    // Weighted line pos = c + (1 + δ)·k (cells of the lattice's pitch).
    let sw = 0, sk = 0, sp = 0;
    for (const f of found) {
      sw += f.wt;
      sk += f.wt * f.k;
      sp += f.wt * f.pos;
    }
    const km = sk / sw, pm = sp / sw;
    let skk = 0, skp = 0, ukk = 0;
    for (const f of found) {
      skk += f.wt * (f.k - km) ** 2;
      skp += f.wt * (f.k - km) * (f.pos - pm);
    }
    const slope = skp / skk;
    const kMean = found.reduce((a, f) => a + f.k, 0) / found.length;
    for (const f of found) ukk += (f.k - kMean) ** 2;
    let sigma: number;
    if (found.length >= 3) {
      let rss = 0;
      for (const f of found) rss += f.wt * (f.pos - pm - slope * (f.k - km)) ** 2;
      sigma = Math.max(SEAM_POS_FLOOR, Math.sqrt((rss / sw) * (found.length / (found.length - 2))));
    } else sigma = SEAM_POS_TWO;
    const span = found[found.length - 1].k - found[0].k;
    return { pitch: p * slope, se: sigma / Math.sqrt(ukk) / slope, seams: found.length, span };
  };
  const a = axis(true), b = axis(false);
  return { ...(a ? { a } : {}), ...(b ? { b } : {}) };
}
