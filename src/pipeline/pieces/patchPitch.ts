/**
 * Piece size of an assembled patch from its own seams, for scans without a single-piece size
 * reference (e.g. a photo of one large block). The cut lines between the pieces (dark lines, or
 * gaps that show the table) run along the patch's grid orientation, one piece apart: thin-line
 * responses projected onto each grid direction form a comb whose period is the piece body size.
 * The knob necks add lines about a third of a piece from the seams, so the comb is strongest at
 * a third of the body size; the estimate sums the first three harmonics to find the fundamental.
 */
import type { Mask, RGBAImage } from '../../cv/image';

export interface PatchPitch {
  /** Body size (photo px per grid cell) of the patch's pieces. */
  pitch: number;
  /** Mean periodicity of the seams over the first three harmonics of `pitch` (0 = none … 1 = perfect comb). */
  strength: number;
  /** The same for the best pitch more than 15 % away from `pitch` (its half and double included). */
  runnerUp: number;
}

/** Offset (px) of the second-derivative line detector. */
const LINE_R = 2;
/** Relative step of the pitch scan. */
const PITCH_STEP = 1.01;
/** Harmonics summed per candidate pitch. */
const HARMONICS = 3;

/**
 * Periodicity of a projected profile at period `p`: fundamental Fourier magnitude over the
 * profile's absolute mass (a comb of lines scores 1, noise ≈ 1/√bins).
 */
function combStrength(prof: Float64Array, p: number): number {
  let re = 0, im = 0, mass = 0;
  const w = (2 * Math.PI) / p;
  for (let k = 0; k < prof.length; k++) {
    const v = prof[k];
    if (v === 0) continue;
    re += v * Math.cos(w * k);
    im += v * Math.sin(w * k);
    mass += Math.abs(v);
  }
  return mass > 0 ? Math.hypot(re, im) / mass : 0;
}

/**
 * Estimate the body size of an assembled patch from the periodicity of its seams (see module
 * documentation). `angleDeg` is the patch's grid orientation in the photo (clockwise from +x; any
 * multiple of 90° gives the same result). Returns null for patches too small to show a few seams
 * in both directions.
 */
export function estimatePatchPitch(image: RGBAImage, mask: Mask, angleDeg: number): PatchPitch | null {
  const { width: w, height: h } = image;
  const a = (angleDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask.data[y * w + x]) continue;
      const u = x * ca + y * sa, v = -x * sa + y * ca;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
      area++;
    }
  }
  if (area === 0) return null;
  const nu = Math.floor(u1 - u0) + 1, nv = Math.floor(v1 - v0) + 1;
  // Plausible pitches: at least 2.5 periods across the shorter extent, at most ~400 pieces.
  const pMin = Math.max(8, Math.sqrt(area / 400));
  const pMax = Math.min(Math.min(nu, nv) / 2.5, Math.sqrt(area / 2));
  if (!(pMax > pMin * 1.2)) return null;
  const L = new Float32Array(w * h);
  const D = image.data;
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * D[i * 4] + 0.587 * D[i * 4 + 1] + 0.114 * D[i * 4 + 2];
  const at = (x: number, y: number): number => {
    const ix = Math.round(x), iy = Math.round(y);
    return ix < 0 || iy < 0 || ix >= w || iy >= h || !mask.data[iy * w + ix] ? NaN : L[iy * w + ix];
  };
  // |second derivative| across each grid direction (dark cut lines and light gaps alike), minus
  // its mean (so the mask's extent adds no comb of its own), summed per projected coordinate.
  const n = area;
  const ru = new Float32Array(n), rv = new Float32Array(n);
  const bu = new Int32Array(n), bv = new Int32Array(n);
  let m = 0, su = 0, sv = 0;
  const ox = LINE_R * ca, oy = LINE_R * sa;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask.data[y * w + x]) continue;
      const c2 = 2 * L[y * w + x];
      const du = Math.abs(at(x + ox, y + oy) + at(x - ox, y - oy) - c2);
      const dv = Math.abs(at(x - oy, y + ox) + at(x + oy, y - ox) - c2);
      if (Number.isNaN(du + dv)) continue;
      ru[m] = du;
      rv[m] = dv;
      bu[m] = Math.min(nu - 1, Math.floor(x * ca + y * sa - u0));
      bv[m] = Math.min(nv - 1, Math.floor(-x * sa + y * ca - v0));
      su += du;
      sv += dv;
      m++;
    }
  }
  if (m === 0) return null;
  const pu = new Float64Array(nu), pv = new Float64Array(nv);
  const mu = su / m, mv = sv / m;
  for (let i = 0; i < m; i++) {
    pu[bu[i]] += ru[i] - mu;
    pv[bv[i]] += rv[i] - mv;
  }
  // Comb strength of both directions together at period p (memoised on the scan grid).
  const memo = new Map<number, number>();
  const comb = (p: number): number => {
    const key = Math.round(p * 1000);
    let s = memo.get(key);
    if (s === undefined) {
      s = Math.sqrt(combStrength(pu, p) * combStrength(pv, p));
      memo.set(key, s);
    }
    return s;
  };
  const pitches: number[] = [], score: number[] = [];
  for (let p = pMin; p <= pMax; p *= PITCH_STEP) {
    let s = 0;
    for (let k = 1; k <= HARMONICS; k++) s += comb(p / k);
    pitches.push(p);
    score.push(s / HARMONICS);
  }
  let best = 0;
  for (let i = 1; i < score.length; i++) if (score[i] > score[best]) best = i;
  const P = pitches[best];
  let runnerUp = 0;
  for (let i = 0; i < pitches.length; i++) {
    if (Math.abs(Math.log(pitches[i] / P)) > Math.log(1.15) && score[i] > runnerUp) runnerUp = score[i];
  }
  return { pitch: P, strength: score[best], runnerUp };
}
