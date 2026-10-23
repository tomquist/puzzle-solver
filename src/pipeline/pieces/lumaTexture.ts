/**
 * Luminance texture on light, neutral, plain tables, for pale low-contrast pieces.
 *
 * Pale grey print on a grey or white table differs from the table mostly in brightness, and the
 * shadow-tolerant colour score takes a darker grey for the table in shade: such pieces come out as
 * scattered fragments or not at all. Their print still has brightness structure the flat table
 * lacks, so the texture energy of the luminance finds them. On a coloured table grey print differs
 * in chroma and colour sees it; there, on dark tables (which use luminance texture anyway) and on
 * busy backgrounds (no flat table), this cue is not used ({@link lumaTextureApplies}).
 *
 * A texture window also reaches across the gaps between pieces lying close and from every outline
 * into the table beside it. Three rules keep it from bridging pieces into patches and from
 * thickening outlines:
 * - table carve: pixels that look like the table (its colour, possibly in shade: Horprasert-style
 *   brightness ratio with the table's chroma scaled alike) and are flat at a fine scale are no
 *   texture, however textured their window is (the table in wider gaps, bays and beside outlines);
 * - table peel: what the window spread beyond the print into the table and the cast shadows along
 *   outlines (table-coloured pixels within half a window radius of the outside) goes;
 * - texture never joins two objects colour found apart: its pixels are shared out geodesically
 *   among the piece-sized colour components, and where two shares meet the texture is cut (narrow
 *   gaps, where every pixel is within reach of a rim and nothing looks flat).
 *
 * The luminance and its energies are computed once per photo (box filters at half resolution);
 * per segmentation pass only the statistics, the carve and the shares are.
 */
import { labelRuns } from '../../cv/components';
import { rgbToLab } from '../../cv/color';
import { createGray, createMask, type GrayImage, type Mask, type RGBAImage } from '../../cv/image';
import { dilate, erode } from '../../cv/morphology';
import { resizeMask } from '../../cv/resize';
import { tableColoursAt, type BackgroundFit } from './background';
import { doubleMask, median } from './util';

/** Texture energy (robust table sigmas) above which a pixel counts as luminance texture. */
export const LUMA_TEXTURE_THRESHOLD = 8;
/** Table lightness (L*) from which the table counts as light (pale print shows as brightness texture). */
const LIGHT_TABLE_L = 55;
/** Table chroma (a*b* distance from neutral) up to which the table counts as neutral (grey, white). */
const NEUTRAL_TABLE_CHROMA = 4.5;
/**
 * Spread of the table's lightness (L* sigma of the background fit) up to which it is plain (a table
 * cloth or board: measured 1.3–5.1; a hand, clothes or a keyboard behind a held piece: 8–32).
 */
const PLAIN_TABLE_SIGMA_L = 6;

/**
 * Whether the luminance texture applies on table `model`: a light, neutral, plain table, where pale
 * grey print differs from the table in brightness only. (On a coloured table colour sees grey print;
 * on a dark one luminance texture is used anyway; on a busy background its premise, a flat table,
 * fails.)
 */
export function lumaTextureApplies(model: Pick<BackgroundFit, 'color' | 'sigma'>): boolean {
  return model.color[0] >= LIGHT_TABLE_L && Math.hypot(model.color[1], model.color[2]) <= NEUTRAL_TABLE_CHROMA && model.sigma[0] <= PLAIN_TABLE_SIGMA_L;
}
/** Fine-scale energy (robust table sigmas) up to which a table-coloured pixel is flat table. */
const FLAT_SIGMAS = 4;
/** Brightness ratio ((L* + 16) to a table colour's) of the table in shade or slightly brighter. */
const TABLE_RHO: [number, number] = [0.45, 1.1];
/** Chroma tolerance (a*, b* units) of table-coloured pixels (chroma scaled with the brightness). */
const TABLE_CHROMA_TOL = 4;
/**
 * Texture blobs covered by colour foreground to at least this fraction are objects colour found
 * (pieces colour found whole measure 0.7–0.9: the window's spread beyond them is the rest): only
 * blobs colour mostly missed are added, so outlines colour found are never thickened.
 */
const COVERED = 0.6;
/** Colour components of at least this share of the photo are objects texture may not join (≈ a piece). */
const OBJECT_SHARE = 1.5e-3;

/** The luminance texture of a photo (independent of the table model; computed once per photo). */
export interface LumaTexture {
  /** Analysed at half resolution (large photos). */
  half: boolean;
  w: number;
  h: number;
  /** Texture window radius (analysis pixels). */
  r: number;
  /** RGB at analysis resolution (for the table test). */
  rgb: Float32Array;
  /** Lab at analysis resolution, converted on first use (NaN: not yet). */
  lab: Float32Array;
  /** Texture energy: mean absolute deviation from the local mean, both over (2r+1)² windows. */
  energy: GrayImage;
  /** The same over 3×3 windows: flat table stays low right up to an outline. */
  fine: GrayImage;
}

/**
 * Box mean over a (2r+1)² window clipped at the image border (as boxBlurGray), separable with
 * running sums: two passes of O(1) per pixel.
 */
export function boxMean(img: GrayImage, r: number): GrayImage {
  const { width: w, height: h, data: src } = img;
  const tmp = new Float32Array(w * h);
  const out = createGray(w, h);
  // 1 / (pixels of the clipped window) per column.
  const invX = new Float32Array(w);
  for (let x = 0; x < w; x++) invX[x] = 1 / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * invX[x];
      if (x + r + 1 < w) acc += src[row + x + r + 1];
      if (x >= r) acc -= src[row + x - r];
    }
  }
  const col = new Float64Array(w);
  for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r), inv = 1 / (y1 - y0 + 1), row = y * w;
    for (let x = 0; x < w; x++) out.data[row + x] = col[x] * inv;
    if (y + r + 1 < h) for (let x = 0, a = (y + r + 1) * w; x < w; x++) col[x] += tmp[a + x];
    if (y - r >= 0) for (let x = 0, a = (y - r) * w; x < w; x++) col[x] -= tmp[a + x];
  }
  return out;
}

/** Mean absolute deviation from the local mean, both box windows of radius `r`. */
function textureEnergy(img: GrayImage, r: number): GrayImage {
  const local = boxMean(img, r);
  const dev = createGray(img.width, img.height);
  for (let i = 0; i < dev.data.length; i++) dev.data[i] = Math.abs(img.data[i] - local.data[i]);
  return boxMean(dev, r);
}

export function lumaTexture(photo: RGBAImage): LumaTexture | null {
  const { width: W, height: H, data: d } = photo;
  const half = W * H > 2.5e6;
  const w = half ? W >> 1 : W, h = half ? H >> 1 : H;
  const r = Math.max(2, Math.round(Math.min(w, h) / 300));
  if (w < 8 * r || h < 8 * r) return null;
  const rgb = new Float32Array(w * h * 3);
  const gray = createGray(w, h), g = gray.data;
  if (half) {
    for (let y = 0; y < h; y++) {
      let p0 = 2 * y * W * 4, p1 = p0 + W * 4, o = y * w * 3, i = y * w;
      for (let x = 0; x < w; x++, p0 += 8, p1 += 8, o += 3, i++) {
        const R = 0.25 * (d[p0] + d[p0 + 4] + d[p1] + d[p1 + 4]);
        const G = 0.25 * (d[p0 + 1] + d[p0 + 5] + d[p1 + 1] + d[p1 + 5]);
        const B = 0.25 * (d[p0 + 2] + d[p0 + 6] + d[p1 + 2] + d[p1 + 6]);
        rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
        g[i] = 0.299 * R + 0.587 * G + 0.114 * B;
      }
    }
  } else {
    for (let i = 0, p = 0, o = 0; i < w * h; i++, p += 4, o += 3) {
      rgb[o] = d[p]; rgb[o + 1] = d[p + 1]; rgb[o + 2] = d[p + 2];
      g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
  }
  // At half resolution the 2×2 average already suppresses pixel noise.
  const img = half ? gray : boxMean(gray, 1);
  return { half, w, h, r, rgb, lab: new Float32Array(w * h * 3).fill(NaN), energy: textureEnergy(img, r), fine: textureEnergy(img, 1) };
}

/** Robust median and sigma of `energy` sampled at least `r` from the border and away from `near`. */
function tableStats(energy: GrayImage, near: Mask, r: number): { m: number; sigma: number } | null {
  const { width: w, height: h } = energy;
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 40000)));
  const buf = new Float32Array(Math.ceil(w / step) * Math.ceil(h / step));
  let n = 0;
  for (let y = r; y < h - r; y += step) {
    for (let x = r; x < w - r; x += step) if (!near.data[y * w + x]) buf[n++] = energy.data[y * w + x];
  }
  if (n < 100) return null;
  const vals = buf.subarray(0, n);
  const m = median(vals);
  for (let i = 0; i < n; i++) vals[i] = Math.abs(vals[i] - m);
  return { m, sigma: Math.max(1.4826 * median(vals), 0.03 * m, 0.05) };
}

/** Analysis pixels between the nodes of the table colour grid (the table model is smooth). */
const TABLE_GRID_STEP = 8;

/**
 * Test whether analysis pixel i looks like the table (one of its colours, in shade or light), with
 * the table colours sampled on a coarse grid once per pass and the pixel's Lab converted once per
 * photo.
 */
function tableTest(lt: LumaTexture, model: BackgroundFit): (i: number) => boolean {
  const { half, w, h, rgb, lab } = lt;
  const s = half ? 2 : 1, o = 0.5 * (s - 1);
  const gw = Math.ceil(w / TABLE_GRID_STEP) + 1, gh = Math.ceil(h / TABLE_GRID_STEP) + 1;
  const k = 1 + model.palette.length;
  const grid = new Float32Array(gw * gh * k * 3);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cols = tableColoursAt(model, s * Math.min(w - 1, gx * TABLE_GRID_STEP) + o, s * Math.min(h - 1, gy * TABLE_GRID_STEP) + o);
      for (let c = 0; c < k; c++) grid.set(cols[c], ((gy * gw + gx) * k + c) * 3);
    }
  }
  return (i: number) => {
    if (lab[i * 3] !== lab[i * 3]) lab.set(rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]), i * 3);
    const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
    const x = i % w, y = (i - x) / w;
    const g = ((Math.round(y / TABLE_GRID_STEP) * gw + Math.round(x / TABLE_GRID_STEP)) * k) * 3;
    for (let c = 0; c < k; c++) {
      const cL = grid[g + 3 * c], ca = grid[g + 3 * c + 1], cb = grid[g + 3 * c + 2];
      const rho = (L + 16) / (cL + 16);
      if (rho > TABLE_RHO[0] && rho < TABLE_RHO[1] && Math.abs(A - rho * ca) < TABLE_CHROMA_TOL && Math.abs(B - rho * cb) < TABLE_CHROMA_TOL) return true;
    }
    return false;
  };
}

/**
 * Pixels (full photo size) the luminance texture adds to the colour foreground `colourFg`, with
 * `model` the table: texture energy above the table's (robust statistics away from the colour
 * foreground), eroded by the window radius (the window spreads texture into the table), minus the
 * table carve widened by a pixel; blobs colour mostly missed are added, table and cast shadows at
 * their outlines peeled off ({@link peelFromOutside}) and objects kept apart ({@link separateObjects}).
 */
export function lumaTextureForeground(lt: LumaTexture | null, colourFg: Mask, model: BackgroundFit, thresholdSigmas = LUMA_TEXTURE_THRESHOLD): Mask | null {
  if (!lt) return null;
  const { half, w, h, r, energy, fine } = lt;
  const W = colourFg.width, H = colourFg.height;
  const fgS = half ? resizeMask(colourFg, w, h) : colourFg;
  const near = dilate(fgS, r + 3);
  const se = tableStats(energy, near, r), sf = tableStats(fine, near, r);
  if (!se || !sf) return null;
  const t = se.m + thresholdSigmas * se.sigma, tf = sf.m + FLAT_SIGMAS * sf.sigma;
  const table = tableTest(lt, model);
  const mask = createMask(w, h), carve = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (energy.data[i] <= t) continue;
      mask.data[i] = 1;
      if (fgS.data[i] || fine.data[i] > tf) continue;
      if (table(i)) carve.data[i] = 1;
    }
  }
  const core = erode(mask, r + 1);
  const cut = dilate(carve, 1);
  for (let i = 0; i < core.data.length; i++) if (cut.data[i] && !fgS.data[i]) core.data[i] = 0;
  // Texture blobs colour already covers well are objects colour found (texture would only blur
  // their outlines): skipped. Those colour mostly missed (pale pieces with the fragments colour
  // found of them) are added.
  const { count, y: ry, x0: rx0, x1: rx1, root } = labelRuns(core, 1, 8);
  const area = new Float64Array(count), covered = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const row = ry[i] * w;
    let c = 0;
    for (let x = rx0[i]; x <= rx1[i]; x++) c += fgS.data[row + x];
    area[root[i]] += rx1[i] - rx0[i] + 1;
    covered[root[i]] += c;
  }
  const add = createMask(w, h);
  for (let i = 0; i < count; i++) {
    // (Whole runs: at half resolution the colour foreground's edge pixels are only partly colour.)
    if (covered[root[i]] < COVERED * area[root[i]]) add.data.fill(1, ry[i] * w + rx0[i], ry[i] * w + rx1[i] + 1);
  }
  // The window still spreads texture beyond the print, into the table and the cast shadows along
  // the outlines: table-coloured pixels there go (half a window deep: pale print at an outline is
  // table-coloured too).
  peelFromOutside(add, fgS, Math.max(1, Math.round(r / 2)), table);
  separateObjects(add, fgS, OBJECT_SHARE * w * h, 1);
  return half ? doubleMask(add, W, H) : add;
}

/**
 * Peels pixels of `add` (not of `fg`) that satisfy `peel` off from the outside (pixels in neither
 * mask), 4-connected, at most `depth` deep.
 */
export function peelFromOutside(add: Mask, fg: Mask, depth: number, peel: (i: number) => boolean): void {
  const { width: w, height: h } = add;
  const n = w * h;
  // 0: not judged yet, 1: peelable, 2: not.
  const judged = new Uint8Array(n);
  const ok = (i: number) => {
    if (judged[i] === 0) judged[i] = peel(i) ? 1 : 2;
    return judged[i] === 1;
  };
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const outside = (j: number) => !add.data[j] && !fg.data[j];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!add.data[i] || fg.data[i]) continue;
      if (!((x > 0 && outside(i - 1)) || (x < w - 1 && outside(i + 1)) || (y > 0 && outside(i - w)) || (y < h - 1 && outside(i + w)))) continue;
      if (!ok(i)) continue;
      dist[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    if (dist[i] >= depth) continue;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= n || dist[j] > 0 || !add.data[j] || fg.data[j] || !ok(j)) continue;
      dist[j] = dist[i] + 1;
      queue[tail++] = j;
    }
  }
  for (let k = 0; k < tail; k++) add.data[queue[k]] = 0;
}

/**
 * Texture may extend what colour found and find what it missed, but never join two objects colour
 * found apart. The pixels of `add` (texture only) are shared out among the colour components of `fg`
 * of at least `minArea` px, each going to the component that reaches it first through texture and
 * colour pixels (8-connected breadth-first growth); where two components' shares meet, `add` is cut,
 * the cut widened by `widen` px so that the closing after it does not bridge it again. Smaller colour
 * components (fragments of a pale piece) are joined freely.
 */
export function separateObjects(add: Mask, fg: Mask, minArea: number, widen: number): void {
  const { width: w, height: h } = fg;
  const n = w * h;
  const { count, y: ry, x0: rx0, x1: rx1, root } = labelRuns(fg, 1, 8);
  const area = new Float64Array(count);
  for (let i = 0; i < count; i++) area[root[i]] += rx1[i] - rx0[i] + 1;
  const owner = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < count; i++) {
    const k = root[i];
    if (area[k] < minArea) continue;
    for (let x = rx0[i]; x <= rx1[i]; x++) {
      const p = ry[i] * w + x;
      owner[p] = k;
      queue[tail++] = p;
    }
  }
  if (tail === 0) return;
  const cut = createMask(w, h);
  let cuts = 0;
  while (head < tail) {
    const p = queue[head++];
    const x = p % w, y = (p - x) / w, k = owner[p];
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx === 0 && dy === 0) || xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (!add.data[q] && !fg.data[q]) continue;
        if (owner[q] < 0) {
          owner[q] = k;
          queue[tail++] = q;
        } else if (owner[q] !== k) {
          // Two objects meet: the texture between them goes.
          for (const v of [p, q]) {
            if (add.data[v] && !fg.data[v]) {
              cut.data[v] = 1;
              cuts++;
            }
          }
        }
      }
    }
  }
  if (cuts === 0) return;
  const c = widen > 0 ? dilate(cut, widen) : cut;
  for (let i = 0; i < n; i++) if (c.data[i]) add.data[i] = 0;
}
