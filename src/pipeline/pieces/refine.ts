/**
 * Graph-cut refinement of a region outline (GrabCut-style, Rother et al. 2004). Within a window
 * around the region, pixels deep inside it stay piece, pixels far outside it (and pixels of other
 * regions) stay table, and the band in between is labelled by a minimum cut of
 *
 *   E(L) = Σ_p D_p(L_p) + Σ_{p~q, L_p≠L_q} λ · exp(−β‖c_p − c_q‖²) / dist(p, q)
 *
 * D_p is the negative log-likelihood of the pixel's colour under a Gaussian mixture (its likeliest
 * component, as in GrabCut) of the piece (fitted to the region's interior) or of the table (fitted
 * to the window outside the region); the
 * smoothness term (contrast-sensitive Potts on 8-neighbours, β from the mean colour difference in
 * the window) puts the boundary on strong colour edges: a piece ends at its cut edge, while glare
 * halos and soft shadows are smooth ramps of table colour. The colour models are refitted to the
 * new labelling and the cut repeated (`iterations`).
 *
 * Large pieces are cut at a reduced scale first (block averages), then once more at full
 * resolution in a narrow band around the coarse outline. Max-flow: src/cv/graphcut.ts.
 */
import { FlowGraph } from '../../cv/graphcut';
import { fitColourGmm, gmmNegLogLikBest, type ColourGmm } from '../../cv/gmm';
import { distanceTransform } from '../../cv/distance';
import { createMask, type Mask, type Rect, type RGBAImage } from '../../cv/image';

export interface GraphCutOptions {
  /** Depth (px) from which region pixels are fixed as piece. */
  inner: number;
  /** Distance (px) outside the region beyond which pixels are fixed as table. */
  outer: number;
  /** Width (px) of the window beyond `outer` that only feeds the table colour model. */
  ring: number;
  /** Smoothness weight λ (GrabCut: 50). */
  smoothness?: number;
  /** Rounds of model fit + cut (default 2). */
  iterations?: number;
  /** Mixture components per colour model (default 5). */
  components?: number;
  /** Integer reduction of the first cut (default 1: full resolution only). */
  scale?: number;
}

/**
 * Result of {@link refineByGraphCut}: the refined region in its window, and colour models of the
 * region's interior and of the table around it fitted before any cut (the cut's own models drift:
 * what one round cuts off joins the table model of the next), to judge what the cut removed.
 */
export interface GraphCutResult {
  mask: Mask;
  rect: Rect;
  piece: ColourGmm;
  table: ColourGmm;
}

type CutParams = { lambda: number; k: number; rounds: number };
type CutResult = { label: Uint8Array };

/** Most colour samples per model (evenly subsampled). */
const MAX_SAMPLES = 2000;
/** Fewest samples per model for a refinement. */
const MIN_SAMPLES = 60;

/** Colours (0..255) of a pixel grid, one plane per channel. */
interface Planes {
  w: number;
  h: number;
  R: Float32Array;
  G: Float32Array;
  B: Float32Array;
}

/**
 * Refine the outline of the region `mask` (bbox-local, at `bbox` in the photo). `blocked` holds
 * other regions (bbox-local masks): their pixels stay table. Returns the refined region in its
 * window (`rect`), or null when the window has too little of either side.
 */
export function refineByGraphCut(img: RGBAImage, mask: Mask, bbox: Rect, blocked: readonly { mask: Mask; bbox: Rect }[], opts: GraphCutOptions): GraphCutResult | null {
  const { width: W, height: H, data } = img;
  const inner = Math.max(1, opts.inner), outer = Math.max(1, opts.outer);
  const m = Math.ceil(outer + opts.ring) + 1;
  const x0 = Math.max(0, bbox.x - m), y0 = Math.max(0, bbox.y - m);
  const x1 = Math.min(W, bbox.x + bbox.width + m), y1 = Math.min(H, bbox.y + bbox.height + m);
  const w = x1 - x0, h = y1 - y0, n = w * h;
  // Region and other regions in the window.
  const region = createMask(w, h), other = createMask(w, h);
  for (let y = 0; y < bbox.height; y++) {
    const row = (y + bbox.y - y0) * w + bbox.x - x0;
    for (let x = 0; x < bbox.width; x++) region.data[row + x] = mask.data[y * bbox.width + x];
  }
  for (const b of blocked) {
    const bx0 = Math.max(x0, b.bbox.x), by0 = Math.max(y0, b.bbox.y);
    const bx1 = Math.min(x1, b.bbox.x + b.bbox.width), by1 = Math.min(y1, b.bbox.y + b.bbox.height);
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = (y - y0) * w + x - x0;
        if (b.mask.data[(y - b.bbox.y) * b.bbox.width + x - b.bbox.x] && !region.data[i]) other.data[i] = 1;
      }
    }
  }
  const full: Planes = { w, h, R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + y0) * W + x + x0) * 4, i = y * w + x;
      full.R[i] = data[o];
      full.G[i] = data[o + 1];
      full.B[i] = data[o + 2];
    }
  }
  const cut: CutParams = { lambda: opts.smoothness ?? 50, k: opts.components ?? 5, rounds: Math.max(1, opts.iterations ?? 2) };
  // The judges: the region deeper than `inner`, the table around it.
  const dIn = distanceTransform(region).data;
  const pieceSamples = sampleColours(full, (i) => dIn[i] > inner);
  const tableSamples = sampleColours(full, (i) => !region.data[i] && !other.data[i]);
  if (pieceSamples.n < MIN_SAMPLES || tableSamples.n < MIN_SAMPLES) return null;
  const piece = fitColourGmm(pieceSamples.data, pieceSamples.n, { k: cut.k }), table = fitColourGmm(tableSamples.data, tableSamples.n, { k: cut.k });
  if (!piece || !table) return null;
  const f = Math.max(1, Math.round(opts.scale ?? 1));
  let start = region, fineInner = inner, fineOuter = outer;
  if (f > 1) {
    // Coarse cut on f×f block averages (a block is region / other where most of it is).
    const cw = Math.ceil(w / f), ch = Math.ceil(h / f);
    const coarse: Planes = { w: cw, h: ch, R: new Float32Array(cw * ch), G: new Float32Array(cw * ch), B: new Float32Array(cw * ch) };
    const cr = createMask(cw, ch), co = createMask(cw, ch);
    const cnt = new Float32Array(cw * ch), inR = new Float32Array(cw * ch), inO = new Float32Array(cw * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, c = ((y / f) | 0) * cw + ((x / f) | 0);
        coarse.R[c] += full.R[i];
        coarse.G[c] += full.G[i];
        coarse.B[c] += full.B[i];
        cnt[c]++;
        inR[c] += region.data[i];
        inO[c] += other.data[i];
      }
    }
    for (let c = 0; c < cw * ch; c++) {
      coarse.R[c] /= cnt[c];
      coarse.G[c] /= cnt[c];
      coarse.B[c] /= cnt[c];
      cr.data[c] = inR[c] >= 0.5 * cnt[c] ? 1 : 0;
      co.data[c] = !cr.data[c] && inO[c] >= 0.5 * cnt[c] ? 1 : 0;
    }
    // (A coarse pixel stands for f² pixels, a coarse edge for f: the smoothness weight scales by 1/f.)
    const cc = cutRegion(coarse, cr, co, inner / f, outer / f, { ...cut, lambda: cut.lambda / f });
    if (!cc) return null;
    const lab = cc.label;
    // Back to full resolution: bilinear interpolation of the coarse labels, thresholded at ½.
    start = createMask(w, h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / f - 0.5)), ya = Math.floor(fy), yb = Math.min(ch - 1, ya + 1), ty = fy - ya;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / f - 0.5)), xa = Math.floor(fx), xb = Math.min(cw - 1, xa + 1), tx = fx - xa;
        const v = (lab[ya * cw + xa] * (1 - tx) + lab[ya * cw + xb] * tx) * (1 - ty) + (lab[yb * cw + xa] * (1 - tx) + lab[yb * cw + xb] * tx) * ty;
        const i = y * w + x;
        start.data[i] = v >= 0.5 && !other.data[i] ? 1 : 0;
      }
    }
    // The full-resolution cut only moves the outline within the coarse blocks around it.
    fineInner = fineOuter = f + 1;
  }
  // (After a coarse cut the colour models are good already: one round.)
  const fine = cutRegion(full, start, other, fineInner, fineOuter, f > 1 ? { ...cut, rounds: 1 } : cut);
  if (!fine) return null;
  const out = createMask(w, h);
  out.data.set(fine.label);
  return { mask: out, rect: { x: x0, y: y0, width: w, height: h }, piece, table };
}

/**
 * GrabCut rounds on one pixel grid: labels (1 = piece) of every pixel, starting from `region`,
 * with pixels deeper than `inner` inside it fixed as piece, pixels farther than `outer` outside it
 * and `other` pixels fixed as table. Null when either colour model lacks samples.
 */
function cutRegion(p: Planes, region: Mask, other: Mask, inner: number, outer: number, cut: CutParams): CutResult | null {
  const { w, h, R, G, B } = p;
  const n = w * h;
  const dIn = distanceTransform(region).data;
  const outside = createMask(w, h);
  for (let i = 0; i < n; i++) outside.data[i] = region.data[i] ? 0 : 1;
  const dOut = distanceTransform(outside).data;
  // State per pixel: 2 = fixed piece, 0 = fixed table, 1 = free (graph node `node[i]`).
  const state = new Uint8Array(n);
  const node = new Int32Array(n).fill(-1);
  const freeList: number[] = [];
  for (let i = 0; i < n; i++) {
    if (other.data[i]) continue;
    if (region.data[i] ? dIn[i] > inner : dOut[i] > outer) state[i] = region.data[i] ? 2 : 0;
    else {
      state[i] = 1;
      node[i] = freeList.length;
      freeList.push(i);
    }
  }
  const label = new Uint8Array(n);
  for (let i = 0; i < n; i++) label[i] = region.data[i] && !other.data[i] ? 1 : 0;
  const nf = freeList.length;
  if (nf === 0) return { label };
  // β from the mean squared colour difference of neighbours (right and down) in the band.
  let sum = 0, cnt = 0;
  for (const i of freeList) {
    const x = i % w;
    if (x + 1 < w) { sum += sq(R, G, B, i, i + 1); cnt++; }
    if (i + w < n) { sum += sq(R, G, B, i, i + w); cnt++; }
  }
  const beta = sum > 0 ? cnt / (2 * sum) : 0;
  // Smoothness weights of each free pixel's 8 neighbours (0 where there is none).
  const DX = [1, -1, 0, 1, -1, 1, 0, -1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const nbW = new Float32Array(8 * nf);
  for (let q = 0; q < nf; q++) {
    const i = freeList[q], x = i % w, y = (i - x) / w;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const len = DX[d] !== 0 && DY[d] !== 0 ? Math.SQRT1_2 : 1;
      nbW[8 * q + d] = cut.lambda * len * Math.exp(-beta * sq(R, G, B, i, yy * w + xx));
    }
  }
  for (let round = 0; round < cut.rounds; round++) {
    // Piece model: the fixed interior in the first round (a halo inside the outline must not
    // describe the piece), all piece pixels later. Table model: every table pixel of the window.
    const piece = sampleColours(p, (i) => (round === 0 ? state[i] === 2 : label[i] === 1));
    const table = sampleColours(p, (i) => label[i] === 0 && !other.data[i]);
    if (piece.n < MIN_SAMPLES || table.n < MIN_SAMPLES) return round === 0 ? null : { label };
    const pm = fitColourGmm(piece.data, piece.n, { k: cut.k });
    const tm = fitColourGmm(table.data, table.n, { k: cut.k });
    if (!pm || !tm) return null;
    const g = new FlowGraph(nf, 4 * nf);
    for (let q = 0; q < nf; q++) {
      const i = freeList[q], x = i % w, y = (i - x) / w;
      // Labelling a pixel piece cuts its sink link (cost −log p(c | piece)), table its source link.
      const dp = gmmNegLogLikBest(pm, R[i], G[i], B[i]), dt = gmmNegLogLikBest(tm, R[i], G[i], B[i]);
      let src = dt - Math.min(dp, dt), snk = dp - Math.min(dp, dt);
      for (let d = 0; d < 8; d++) {
        const wt = nbW[8 * q + d];
        if (wt === 0) continue;
        const j = (y + DY[d]) * w + x + DX[d];
        const s = state[j];
        if (s === 1) {
          // Each pair of free pixels once (from the first of the two).
          if (j > i) g.addEdge(q, node[j], wt, wt);
        } else if (s === 2) src += wt;
        else snk += wt;
      }
      g.addTerminal(q, src, snk);
    }
    g.maxflow();
    let changed = 0;
    for (let q = 0; q < nf; q++) {
      const i = freeList[q], l = g.isSource(q) ? 1 : 0;
      if (l !== label[i]) changed++;
      label[i] = l;
    }
    if (changed === 0) break;
  }
  return { label };
}

function sq(R: Float32Array, G: Float32Array, B: Float32Array, i: number, j: number): number {
  const dr = R[i] - R[j], dg = G[i] - G[j], db = B[i] - B[j];
  return dr * dr + dg * dg + db * db;
}

/** Up to MAX_SAMPLES colours (evenly strided) of the pixels that pass `take`. */
function sampleColours(p: Planes, take: (i: number) => boolean): { data: Float32Array; n: number } {
  const { R, G, B } = p;
  let total = 0;
  for (let i = 0; i < R.length; i++) if (take(i)) total++;
  const stride = Math.max(1, total / MAX_SAMPLES);
  const out = new Float32Array(3 * Math.min(total, MAX_SAMPLES));
  let n = 0, seen = 0, nextAt = 0;
  for (let i = 0; i < R.length && 3 * n < out.length; i++) {
    if (!take(i)) continue;
    if (seen++ < nextAt) continue;
    nextAt += stride;
    out[3 * n] = R[i];
    out[3 * n + 1] = G[i];
    out[3 * n + 2] = B[i];
    n++;
  }
  return { data: out, n };
}
