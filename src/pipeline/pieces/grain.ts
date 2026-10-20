/**
 * Table colour along the wood grain.
 *
 * A strongly grained table (oak, ash, wood-look tiles) is a pattern of long, thin stripes of
 * lighter and darker wood, all running one way. The smooth table model (background.ts) can only
 * take them as spread: its sigma grows with the grain, pieces whose print is near the wood's
 * colour score low, and the stripes that are a little further from the mean colour than the rest
 * grow onto the pieces as ragged spikes, or join touching pieces. Pieces are not like that: they
 * are compact, and their print does not continue the stripes.
 *
 * So the table colour at a pixel is measured along the grain line through it: the robust mean of
 * the table pixels within about half a piece before or after it along the local grain direction
 * (the half nearer the pixel's own colour: light or shadow that crosses the grain does not mix),
 * leaving out the pieces found so far and compact areas whose texture does not run with the grain
 * (pieces the first pass missed). It is measured as the residual from the smooth and local table
 * model, so light that changes along a grain line stays theirs. A stripe of grain is then
 * explained by its own continuation beyond the piece, while across the grain the estimate keeps
 * the stripes' full detail. The residual spread of the table around this estimate – the grain-free
 * sigma – is a fraction of the smooth model's, so the cardboard edge and the print stand out.
 *
 * Grain direction: the structure tensor of the table's lightness on tiles of about a piece, its
 * doubled-angle vector smoothed over neighbouring tiles (so a perspective view, where the grain
 * fans out, gets the direction it has locally). It is used only when the table's texture is
 * clearly oriented (coherence; a plain table, a cloth pattern or noise is not) and when it explains
 * a fair share of the table's spread.
 *
 * Along a line the mean is a sliding window over prefix sums; each tile of about a piece is covered
 * by lines of its own direction, sampled one pixel apart with linear interpolation, on a half-size
 * grid for large photos.
 */
import { rgbaToLab } from '../../cv/color';
import { removeSmallComponents } from '../../cv/components';
import { close, dilate, open } from '../../cv/morphology';
import { resizeMask, resizeRGBA } from '../../cv/resize';
import { boxBlurGray } from '../../cv/filter';
import { createGray, createMask, type Mask, type RGBAImage } from '../../cv/image';
import { median } from './util';

/** Table colour along the grain on an analysis grid (see module documentation). */
export interface GrainTable {
  /** Photo px per grid px. */
  factor: number;
  /** Grid size. */
  width: number;
  height: number;
  /** Lab table colour per grid pixel (3 values); NaN where the grain line holds too little table. */
  lab: Float32Array;
  /** Robust spread of the table around the estimate (Lab units). */
  sigma: [number, number, number];
  /** Coherence of the table texture's orientation (0 = none, 1 = perfect stripes). */
  coherence: number;
  /** Share of the grid with an estimate. */
  coverage: number;
}

/**
 * Orientation coherence of the table texture (median over tiles of about a piece) from which the
 * grain model is used. Measured on the feedback corpus: strongly grained wood (oak, wood-look
 * floors, sunlit and shallow-focus wood) 0.51–0.73; light wood with faint grain, which the smooth
 * model explains well enough, 0.32–0.43 (with the grain model a glare blob and a plank stain came
 * out as pieces there); plain tables, stone, boards and cloth 0.06–0.23. Synthetic plank floors
 * (the scan benchmark) 0.45–0.47: their seams and texture are no grain the model would help with.
 */
export const GRAIN_MIN_COHERENCE = 0.48;
/** Least coherence (window of a few pixels) of a table sample's texture, and its largest angle to the grain (degrees). */
const GRAIN_PIXEL_COHERENCE = 0.25;
const GRAIN_PIXEL_ANGLE = 25;
/** Area (piece body sizes squared) from which a compact area of such texture is left out of the table. */
const NOT_GRAIN_AREA = 0.25;
/**
 * Least relative reduction of the table's spread (norm of the Lab sigmas) by the grain model for it
 * to be used. Grained wood: 0.26–0.5; a plain plank floor with seams: below 0.1.
 */
const GRAIN_MIN_GAIN = 0.2;
/** Half-length of the window along the grain (piece body sizes). */
const GRAIN_REACH = 0.6;
/** Reach multiples tried in turn where a window holds too little table. */
const LONGER_REACH = [1, 2];
/** Table samples a window needs (share of its length). */
const GRAIN_MIN_SHARE = 0.3;
/** Samples further than this (robust sigmas) from the first-pass mean are left out of the second. */
const GRAIN_OUTLIER = 3;
/** Quantisation of the grain direction (degrees; one direction per tile of about a piece). */
const ANGLE_STEP = 2;
/** Floors of the grain-free sigma (Lab units; as the smooth model's floors). */
const SIGMA_FLOOR: [number, number, number] = [1.2, 1, 1];

/**
 * Orientation of a texture from structure-tensor sums: the direction of the stripes in degrees
 * [0, 180) (perpendicular to the dominant gradient) and the coherence (0..1).
 */
export function stripeOrientation(jxx: number, jyy: number, jxy: number): { angle: number; coherence: number } {
  const tr = jxx + jyy;
  if (!(tr > 0)) return { angle: 0, coherence: 0 };
  const coherence = Math.hypot(jxx - jyy, 2 * jxy) / tr;
  const grad = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
  let angle = (grad * 180) / Math.PI + 90;
  angle = ((angle % 180) + 180) % 180;
  return { angle, coherence };
}

/**
 * Sliding robust table colour along one line (into `out`, NaN where too few table samples are in
 * reach): `vals` holds the samples in order along the line, `ok` which of them are table. First
 * the plain mean of the window (± `reach` samples, at least `minCount` table samples) marks the
 * samples within GRAIN_OUTLIER·`spread` of it (per channel) as inliers; then the inlier means of
 * the two half-windows before and after the sample (not the sample itself) are taken, and the one
 * closer to the sample's own colour wins (one alone when the other half has fewer than half of
 * `minCount`). Where a shadow or a change of light crosses the grain the estimate thus comes from
 * the side the sample is on, not from a mix of both; a piece pixel the exclusion missed does not
 * explain itself. Only samples `from`..`to` get an estimate (all samples serve as table).
 */
export function lineMeans(
  vals: Float32Array,
  ok: Uint8Array,
  n: number,
  reach: number,
  minCount: number,
  spread: readonly number[],
  out: Float32Array,
  prefix: Float64Array,
  keep: Uint8Array,
  from = 0,
  to = n - 1,
): void {
  const sums = (use: Uint8Array) => {
    // prefix[(i + 1) * 4 + c]: sums of the first i + 1 samples (c = 3: count).
    for (let c = 0; c < 4; c++) prefix[c] = 0;
    for (let i = 0; i < n; i++) {
      const o = (i + 1) * 4, p = i * 4, u = use[i];
      prefix[o] = prefix[p] + (u ? vals[i * 3] : 0);
      prefix[o + 1] = prefix[p + 1] + (u ? vals[i * 3 + 1] : 0);
      prefix[o + 2] = prefix[p + 2] + (u ? vals[i * 3 + 2] : 0);
      prefix[o + 3] = prefix[p + 3] + u;
    }
  };
  // First pass: window means, inliers.
  sums(ok);
  for (let i = 0; i < n; i++) {
    keep[i] = 0;
    if (!ok[i]) continue;
    const a = Math.max(0, i - reach) * 4, b = (Math.min(n - 1, i + reach) + 1) * 4;
    const cnt = prefix[b + 3] - prefix[a + 3];
    if (cnt < minCount) continue;
    const d0 = Math.abs(vals[i * 3] - (prefix[b] - prefix[a]) / cnt) / spread[0];
    const d1 = Math.abs(vals[i * 3 + 1] - (prefix[b + 1] - prefix[a + 1]) / cnt) / spread[1];
    const d2 = Math.abs(vals[i * 3 + 2] - (prefix[b + 2] - prefix[a + 2]) / cnt) / spread[2];
    if (d0 <= GRAIN_OUTLIER && d1 <= GRAIN_OUTLIER && d2 <= GRAIN_OUTLIER) keep[i] = 1;
  }
  // Second pass: inlier means of the two halves; the closer one. Where the line runs through pieces
  // (a narrow gap between two of them), the halves reach further (LONGER_REACH).
  sums(keep);
  const half = Math.max(2, Math.ceil(minCount / 2));
  for (let i = from; i <= to; i++) {
    let a = 0, b = i * 4, c = (i + 1) * 4, d = 0, nl = 0, nr = 0;
    for (const f of LONGER_REACH) {
      a = Math.max(0, i - f * reach) * 4;
      d = (Math.min(n - 1, i + f * reach) + 1) * 4;
      nl = prefix[b + 3] - prefix[a + 3];
      nr = prefix[d + 3] - prefix[c + 3];
      if (nl >= half || nr >= half) break;
    }
    const okL = nl >= half, okR = nr >= half;
    if (!okL && !okR) {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = NaN;
      continue;
    }
    let useL = okL;
    if (okL && okR) {
      let dl = 0, dr = 0;
      for (let ch = 0; ch < 3; ch++) {
        const ml = (prefix[b + ch] - prefix[a + ch]) / nl, mr = (prefix[d + ch] - prefix[c + ch]) / nr;
        dl += ((vals[i * 3 + ch] - ml) / spread[ch]) ** 2;
        dr += ((vals[i * 3 + ch] - mr) / spread[ch]) ** 2;
      }
      useL = dl <= dr;
    }
    const [p, q, cnt] = useL ? [a, b, nl] : [c, d, nr];
    out[i * 3] = (prefix[q] - prefix[p]) / cnt;
    out[i * 3 + 1] = (prefix[q + 1] - prefix[p + 1]) / cnt;
    out[i * 3 + 2] = (prefix[q + 2] - prefix[p + 2]) / cnt;
  }
}

/**
 * Coherence of the table's texture (see {@link GRAIN_MIN_COHERENCE}): the median over tiles of about
 * a piece (`body`, photo px) that show enough table (outside `exclude`) of the orientation
 * coherence of the lightness (Scharr structure tensor, half resolution for large photos). Each tile
 * counts on its own: a single strong edge (a table edge, a plank gap) makes one tile coherent, not
 * the table. 0 when too few tiles show table.
 */
export function grainCoherence(photo: RGBAImage, exclude: Mask, body: number): number {
  const W = photo.width, H = photo.height;
  const factor = W * H > 1.5e6 ? 2 : 1;
  const w = Math.max(1, Math.round(W / factor)), h = Math.max(1, Math.round(H / factor));
  if (w < 32 || h < 32 || !(body > 0)) return 0;
  const small = factor > 1 ? resizeRGBA(photo, w, h) : photo;
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * small.data[i * 4] + 0.587 * small.data[i * 4 + 1] + 0.114 * small.data[i * 4 + 2];
  const ex = dilate(factor > 1 ? resizeMask(exclude, w, h) : exclude, 2).data;
  const tile = Math.max(12, Math.round(body / factor));
  const tc = Math.ceil(w / tile), tr = Math.ceil(h / tile);
  const J = new Float64Array(tc * tr * 3), cnt = new Float64Array(tc * tr);
  for (let y = 1; y < h - 1; y++) {
    const trow = ((y / tile) | 0) * tc;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (ex[i] || ex[i - 1] || ex[i + 1] || ex[i - w] || ex[i + w]) continue;
      const gx = (3 * (L[i - w + 1] - L[i - w - 1]) + 10 * (L[i + 1] - L[i - 1]) + 3 * (L[i + w + 1] - L[i + w - 1])) / 32;
      const gy = (3 * (L[i + w - 1] - L[i - w - 1]) + 10 * (L[i + w] - L[i - w]) + 3 * (L[i + w + 1] - L[i - w + 1])) / 32;
      const t = trow + ((x / tile) | 0);
      J[t * 3] += gx * gx;
      J[t * 3 + 1] += gy * gy;
      J[t * 3 + 2] += gx * gy;
      cnt[t]++;
    }
  }
  const tileCoh: number[] = [];
  for (let t = 0; t < tc * tr; t++) if (cnt[t] >= 0.25 * tile * tile) tileCoh.push(stripeOrientation(J[t * 3], J[t * 3 + 1], J[t * 3 + 2]).coherence);
  return tileCoh.length < 4 ? 0 : median(tileCoh);
}

/**
 * Fit the table colour along the grain (see module documentation). `exclude` (photo size) marks
 * the pieces found so far; `body` is the piece body size (photo px); `sigma` the smooth model's
 * spread (outlier scale of the first pass); `tableAt` the smooth model's colour at a photo position
 * (lighting): the grain is measured as the residual from it, so light that changes along a grain
 * line stays the smooth model's part. Null when the table shows no clear grain or too little of it.
 */
export function fitGrainTable(
  photo: RGBAImage,
  exclude: Mask,
  body: number,
  sigma: readonly number[],
  tableAt?: (x: number, y: number) => readonly number[],
  minCoherence = GRAIN_MIN_COHERENCE,
): GrainTable | null {
  const W = photo.width, H = photo.height;
  const factor = W * H > 1.5e6 ? 2 : 1;
  const w = Math.max(1, Math.round(W / factor)), h = Math.max(1, Math.round(H / factor));
  if (w < 32 || h < 32 || !(body > 0)) return null;
  const n = w * h;
  // Residuals from the smooth table model (lighting), whose stripes are the grain.
  const lab = rgbaToLab(factor > 1 ? resizeRGBA(photo, w, h) : photo).data;
  const base = new Float32Array(n * 3);
  if (tableAt) {
    // (The smooth model on a coarse lattice, interpolated: it varies slowly.)
    const step = 8, lw = Math.ceil((w - 1) / step) + 1, lh = Math.ceil((h - 1) / step) + 1;
    const lat = new Float32Array(lw * lh * 3);
    for (let j = 0; j < lh; j++) {
      for (let i = 0; i < lw; i++) {
        const t = tableAt((Math.min(w - 1, i * step) + 0.5) * factor - 0.5, (Math.min(h - 1, j * step) + 0.5) * factor - 0.5);
        lat[(j * lw + i) * 3] = t[0]; lat[(j * lw + i) * 3 + 1] = t[1]; lat[(j * lw + i) * 3 + 2] = t[2];
      }
    }
    for (let y = 0; y < h; y++) {
      const fy = y / step, j0 = Math.min(lh - 2, Math.floor(fy)), ty = fy - j0;
      for (let x = 0; x < w; x++) {
        const fx = x / step, i0 = Math.min(lw - 2, Math.floor(fx)), tx = fx - i0;
        const a = (j0 * lw + i0) * 3, b = a + 3, c = a + lw * 3, d = c + 3, i = (y * w + x) * 3;
        for (let ch = 0; ch < 3; ch++) {
          const v = (lat[a + ch] * (1 - tx) + lat[b + ch] * tx) * (1 - ty) + (lat[c + ch] * (1 - tx) + lat[d + ch] * tx) * ty;
          base[i + ch] = v;
          lab[i + ch] -= v;
        }
      }
    }
  }
  const ex = dilate(factor > 1 ? resizeMask(exclude, w, h) : exclude, 2).data;

  // Structure tensor of the lightness per pixel (Scharr derivatives: central differences pull thin
  // stripes' direction towards the diagonals), summed per tile over the table.
  const tile = Math.max(12, Math.round(body / factor));
  const tc = Math.ceil(w / tile), tr = Math.ceil(h / tile);
  const pxx = createGray(w, h), pyy = createGray(w, h), pxy = createGray(w, h);
  const J = new Float64Array(tc * tr * 3);
  const cnt = new Float64Array(tc * tr);
  for (let y = 1; y < h - 1; y++) {
    const trow = ((y / tile) | 0) * tc;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = lab[(i - w - 1) * 3], b = lab[(i - w) * 3], c = lab[(i - w + 1) * 3];
      const d = lab[(i - 1) * 3], f = lab[(i + 1) * 3];
      const g = lab[(i + w - 1) * 3], hh = lab[(i + w) * 3], k = lab[(i + w + 1) * 3];
      const gx = (3 * (c - a) + 10 * (f - d) + 3 * (k - g)) / 32;
      const gy = (3 * (g - a) + 10 * (hh - b) + 3 * (k - c)) / 32;
      pxx.data[i] = gx * gx;
      pyy.data[i] = gy * gy;
      pxy.data[i] = gx * gy;
      if (ex[i] || ex[i - 1] || ex[i + 1] || ex[i - w] || ex[i + w]) continue;
      const t = trow + ((x / tile) | 0);
      J[t * 3] += gx * gx;
      J[t * 3 + 1] += gy * gy;
      J[t * 3 + 2] += gx * gy;
      cnt[t]++;
    }
  }
  // Coherence of the table's texture: the median over the tiles that show enough table, each
  // tile on its own (a single strong edge – a table edge, a plank gap – makes one tile coherent,
  // not the table).
  const tileCoh: number[] = [];
  for (let t = 0; t < tc * tr; t++) if (cnt[t] >= 0.25 * tile * tile) tileCoh.push(stripeOrientation(J[t * 3], J[t * 3 + 1], J[t * 3 + 2]).coherence);
  if (tileCoh.length < 4) return null;
  const coherence = median(tileCoh);
  if (coherence < minCoherence) return null;
  // Tile directions as doubled-angle vectors, smoothed over the 3×3 neighbourhood (tiles with
  // little table borrow from their neighbours).
  const vx = new Float64Array(tc * tr), vy = new Float64Array(tc * tr);
  for (let t = 0; t < tc * tr; t++) {
    vx[t] = J[t * 3] - J[t * 3 + 1];
    vy[t] = 2 * J[t * 3 + 2];
  }
  const sx = new Float64Array(tc * tr), sy = new Float64Array(tc * tr);
  let allX = 0, allY = 0;
  for (let t = 0; t < tc * tr; t++) {
    allX += vx[t];
    allY += vy[t];
  }
  for (let r = 0; r < tr; r++) {
    for (let c = 0; c < tc; c++) {
      let ax = 0, ay = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= tr || cc >= tc) continue;
          const wgt = dr === 0 && dc === 0 ? 2 : 1;
          ax += wgt * vx[rr * tc + cc];
          ay += wgt * vy[rr * tc + cc];
        }
      }
      // No table anywhere near: the photo's overall direction.
      if (ax === 0 && ay === 0) {
        ax = allX;
        ay = allY;
      }
      sx[r * tc + c] = ax;
      sy[r * tc + c] = ay;
    }
  }
  // Table samples must look like grain: texture coherent along their tile's grain direction
  // (structure tensor over a small window). Piece print the first pass missed – a plain area, or
  // detail running every which way – is left out of the table estimate, so it cannot explain
  // itself.
  const rc = Math.max(2, Math.round(tile / 24));
  const bxx = boxBlurGray(pxx, rc).data, byy = boxBlurGray(pyy, rc).data, bxy = boxBlurGray(pxy, rc).data;
  const grainLike = new Uint8Array(n);
  // Doubled-angle unit vectors of the tiles: a pixel's direction is within GRAIN_PIXEL_ANGLE of its
  // tile's when the cosine of the doubled angle between them is at least cos(2·GRAIN_PIXEL_ANGLE).
  const ux = new Float32Array(tc * tr), uy = new Float32Array(tc * tr);
  for (let t = 0; t < tc * tr; t++) {
    const len = Math.hypot(sx[t], sy[t]) || 1;
    ux[t] = sx[t] / len;
    uy[t] = sy[t] / len;
  }
  const minCos = Math.cos((2 * GRAIN_PIXEL_ANGLE * Math.PI) / 180);
  for (let y = 0; y < h; y++) {
    const trow = ((y / tile) | 0) * tc;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ex[i]) continue;
      const vx2 = bxx[i] - byy[i], vy2 = 2 * bxy[i], len = Math.hypot(vx2, vy2), tr2 = bxx[i] + byy[i];
      if (!(tr2 > 0) || len < GRAIN_PIXEL_COHERENCE * tr2) continue;
      const t = trow + ((x / tile) | 0);
      if (vx2 * ux[t] + vy2 * uy[t] >= minCos * len) grainLike[i] = 1;
    }
  }

  // Only compact areas the size of a piece part count as not table (a missed piece); small
  // stretches of faint or cut grain between pieces stay table.
  const notGrain = createMask(w, h);
  for (let i = 0; i < n; i++) notGrain.data[i] = ex[i] || grainLike[i] ? 0 : 1;
  const blobs = removeSmallComponents(open(close(notGrain, 2), 2), Math.round(NOT_GRAIN_AREA * tile * tile));
  for (let i = 0; i < n; i++) if (!ex[i] && !blobs.data[i]) grainLike[i] = 1;
  // Robust means along the grain lines, tile by tile (each tile with its own smoothed direction).
  // Lines are spaced one pixel apart across the direction and sampled with linear interpolation
  // over the tile's extent plus the longest reach on both sides; a pixel takes the means of the two
  // lines around it, weighted by distance (no jitter of nearest-pixel lines across thin stripes).
  const reach = Math.max(6, Math.round((GRAIN_REACH * body) / factor));
  const spread = [Math.max(sigma[0], SIGMA_FLOOR[0]), Math.max(sigma[1], SIGMA_FLOOR[1]), Math.max(sigma[2], SIGMA_FLOOR[2])];
  const est = new Float32Array(n * 3).fill(NaN);
  const far = reach * LONGER_REACH[LONGER_REACH.length - 1];
  const L = Math.max(w, h);
  const vals = new Float32Array(L * 3), ok = new Uint8Array(L), keep = new Uint8Array(L);
  let prev = new Float32Array(L * 3), cur = new Float32Array(L * 3);
  const prefix = new Float64Array((L + 1) * 4);
  for (let tRow = 0; tRow < tr; tRow++) {
    for (let tCol = 0; tCol < tc; tCol++) {
      const t = tRow * tc + tCol;
      const { angle } = stripeOrientation((Math.hypot(sx[t], sy[t]) + sx[t]) / 2, (Math.hypot(sx[t], sy[t]) - sx[t]) / 2, sy[t] / 2);
      const rad = (Math.round(angle / ANGLE_STEP) * ANGLE_STEP * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      // Lines parametrised by the axis the direction is closer to: q = l + slope·s.
      const horiz = Math.abs(cos) >= Math.abs(sin);
      const slope = horiz ? sin / cos : cos / sin;
      const len = horiz ? w : h, across = horiz ? h : w;
      const step = 1 / Math.max(Math.abs(cos), Math.abs(sin));
      const r = Math.max(3, Math.round(reach / step));
      const minCount = Math.max(4, Math.round(GRAIN_MIN_SHARE * (2 * r + 1)));
      // The tile in line coordinates.
      const x0 = tCol * tile, x1 = Math.min(w, x0 + tile) - 1, y0 = tRow * tile, y1 = Math.min(h, y0 + tile) - 1;
      const [sa, sb, qa, qb] = horiz ? [x0, x1, y0, y1] : [y0, y1, x0, x1];
      const lmin = Math.floor(Math.min(qa - slope * sa, qa - slope * sb)) - 1, lmax = Math.ceil(Math.max(qb - slope * sa, qb - slope * sb)) + 1;
      const s0 = Math.max(0, sa - Math.round(far / step)), s1 = Math.min(len - 1, sb + Math.round(far / step));
      const m = s1 - s0 + 1;
      for (let l = lmin; l <= lmax; l++) {
        // Samples of line l (`ok` = table on both interpolated pixels).
        let first = -1, last = -1;
        for (let j = 0; j < m; j++) {
          const qf = l + slope * (s0 + j);
          const q0 = Math.floor(qf), f = qf - q0;
          if (!(q0 >= 0 && q0 < across && (f < 1e-6 || q0 + 1 < across))) {
            ok[j] = 0;
            vals[j * 3] = vals[j * 3 + 1] = vals[j * 3 + 2] = 0;
            continue;
          }
          if (first < 0) first = j;
          last = j;
          const sp = s0 + j;
          const i0 = horiz ? q0 * w + sp : sp * w + q0;
          if (f < 1e-6) {
            vals[j * 3] = lab[i0 * 3];
            vals[j * 3 + 1] = lab[i0 * 3 + 1];
            vals[j * 3 + 2] = lab[i0 * 3 + 2];
            ok[j] = grainLike[i0];
          } else {
            const i1 = horiz ? i0 + w : i0 + 1;
            vals[j * 3] = (1 - f) * lab[i0 * 3] + f * lab[i1 * 3];
            vals[j * 3 + 1] = (1 - f) * lab[i0 * 3 + 1] + f * lab[i1 * 3 + 1];
            vals[j * 3 + 2] = (1 - f) * lab[i0 * 3 + 2] + f * lab[i1 * 3 + 2];
            ok[j] = grainLike[i0] & grainLike[i1];
          }
        }
        // (Estimates are needed for the tile's own positions only.)
        const from = Math.max(first, sa - s0), to = Math.min(last, sb - s0);
        cur.fill(NaN, (sa - s0) * 3, (sb - s0 + 1) * 3);
        if (first >= 0 && from <= to) lineMeans(vals, ok, m, r, minCount, spread, cur, prefix, keep, from, to);
        // The tile's pixels between line l − 1 (prev) and line l (cur).
        if (l > lmin) {
          for (let sp = sa; sp <= sb; sp++) {
            const j = sp - s0;
            const qf = l - 1 + slope * sp;
            const q = Math.ceil(qf - 1e-9);
            if (q < qa || q > qb) continue;
            const i = horiz ? q * w + sp : sp * w + q;
            const tt = q - qf;
            const a = prev[j * 3], b = cur[j * 3];
            const na = a !== a, nb = b !== b;
            if (na && nb) continue;
            const wa = na ? 0 : nb ? 1 : 1 - tt, wb = 1 - wa;
            est[i * 3] = wa * (na ? 0 : a) + wb * (nb ? 0 : b);
            est[i * 3 + 1] = wa * (na ? 0 : prev[j * 3 + 1]) + wb * (nb ? 0 : cur[j * 3 + 1]);
            est[i * 3 + 2] = wa * (na ? 0 : prev[j * 3 + 2]) + wb * (nb ? 0 : cur[j * 3 + 2]);
          }
        }
        const tmp = prev;
        prev = cur;
        cur = tmp;
      }
    }
  }

  // Grain-free spread: residuals of the table pixels (a sparse sample).
  const res: number[][] = [[], [], []];
  let covered = 0;
  const sStep = Math.max(1, Math.round(Math.sqrt(n / 60000)));
  for (let y = 0; y < h; y += sStep) {
    for (let x = 0; x < w; x += sStep) {
      const i = y * w + x;
      if (Number.isNaN(est[i * 3])) continue;
      covered++;
      if (ex[i]) continue;
      for (let c = 0; c < 3; c++) res[c].push(lab[i * 3 + c] - est[i * 3 + c]);
    }
  }
  const total = Math.ceil(h / sStep) * Math.ceil(w / sStep);
  if (res[0].length < 200) return null;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const m = median(res[c]);
    out[c] = Math.max(SIGMA_FLOOR[c], 1.4826 * median(res[c].map((v) => Math.abs(v - m))));
  }
  // Used only where it explains a fair share of the table's spread: otherwise the smooth model
  // already explains the table, and the grain model would only sharpen the threshold.
  const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
  const gain = 1 - norm(out) / norm(spread);
  if (gain < GRAIN_MIN_GAIN) return null;
  for (let i = 0; i < n * 3; i++) est[i] += base[i];
  return { factor, width: w, height: h, lab: est, sigma: out, coherence, coverage: covered / total };
}
