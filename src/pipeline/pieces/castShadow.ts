/**
 * Deep cast shadows of loose pieces. Pieces lying on a board or on top of a partly built puzzle
 * stand a cardboard's thickness above the surface; in low light from one side each casts a dark
 * shadow along its far edges and into its blanks, much deeper than the shading the shadow-tolerant
 * score accepts (L* + 16 down to ≈ 0.55 of the table's), so the score calls it foreground: the
 * outlines take it in, and the shadow fills the narrow gaps between pieces lying close and ties them
 * to each other and to the assembled puzzle beside them. The shadow is the table, darkened, in its
 * own hue (on warm surfaces a shadow deepens the colour), reached from the table around the region
 * and no deeper than a band along its outline. Next to a piece that is light there (most of the
 * region just inside the band lighter than the table) any such darkening is shadow; next to a dark
 * piece only what is lighter than halfway to the piece's own brightness can be (as in
 * peelShadowHalo, segment.ts, which does this for close-ups): its dark print looks like shadow.
 */
import { rgbToLab } from '../../cv/color';
import { createMask, type Mask, type RGBAImage } from '../../cv/image';
import { open } from '../../cv/morphology';
import { backgroundAt, tableChromaDistance, tableChromasAt, type BackgroundFit } from './background';

/** Width of the outer band searched for cast shadow (piece body sizes). */
export const CAST_BAND = 0.15;
/** Narrowest band (px) worth searching (pieces of ≥ 40 px): below it a shadow is a pixel or two of the rim and the JPEG's half-resolution chroma. */
export const CAST_BAND_MIN = 6;
/** Deepest shadow, as an (L* + 16) ratio to the table's. */
const CAST_RHO_MIN = 0.4;
/** Lightest pixel (lightness sigmas above the table's) passed on the way in: the penumbra at the outline is about table-light. */
const CAST_MAX_LIGHTER = 2.5;
/** Deepest shadow colour as a multiple of the table's chroma (soft shadow on warm surfaces deepens it). */
const CAST_CHROMA_SCALE = 2.5;
/** Largest chroma distance (table sigmas) of a shadow from the table's colour under any darkening. */
const CAST_CHROMA = 4;
/**
 * Largest distance (Lab units) of a shadow's chroma from the table's chroma line (its chroma scaled
 * by CAST_MIN_CHROMA_SCALE up to CAST_CHROMA_SCALE): a shadow keeps the table's hue however much the table
 * colour varies (a noisy or sunlit table's spread would let any hue pass).
 */
const CAST_HUE = 4;
/**
 * Least chroma of a shadow as a multiple of the table's: a shadow keeps the table's colour (on a warm
 * board the shadows measure as colourful as the board), while dark grey and black print is neutral
 * (or of the opposite hue). On a neutral table this asks nothing.
 */
const CAST_MIN_CHROMA_SCALE = 0.5;
/** (L* + 16) ratio to the table's below which a shadow is deep (the score tolerates shade down to 0.8 at a cost). */
const CAST_DEEP = 0.75;
/** Share of a shadow that must be deep. */
const CAST_DEEP_SHARE = 0.5;
/** Half-width (fraction of the band) a shadow must have somewhere to count. */
const CAST_MIN_WIDTH = 0.25;
/** Share of the region just inside the band lighter than the table from which the piece counts as light there. */
const LIGHT_SHARE = 0.5;

/** CIE L* of an sRGB pixel. */
function lightness(r: number, g: number, b: number): number {
  const y = 0.2126729 * LIN[r] + 0.7151522 * LIN[g] + 0.072175 * LIN[b];
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}
/** Distance (Lab units) of chroma (a, b) from the nearest table colour's chroma scaled by CAST_MIN_CHROMA_SCALE…CAST_CHROMA_SCALE. */
function hueOffset(colours: readonly { a: number; b: number }[], a: number, b: number): number {
  let best = Infinity;
  for (const c of colours) {
    const len2 = c.a * c.a + c.b * c.b;
    const t = len2 > 1e-9 ? Math.max(CAST_MIN_CHROMA_SCALE, Math.min(CAST_CHROMA_SCALE, (a * c.a + b * c.b) / len2)) : 0;
    best = Math.min(best, Math.hypot(a - t * c.a, b - t * c.b));
  }
  return best;
}
/** sRGB 8-bit value → linear light. */
const LIN = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/**
 * Cast-shadow pixels of a region (`region`: a frame of the photo at offset ox, oy; outside it the
 * table or other regions), within `band` px of its outline, reached from the table outside through
 * shadow (beyond the photo's border there is no table). Returns the shadow pixels (frame-sized) and
 * how many, or null when there are none.
 */
export function castShadow(region: Mask, ox: number, oy: number, img: RGBAImage, fit: BackgroundFit, band: number): { shadow: Uint8Array; count: number } | null {
  const w = region.width, h = region.height, W = img.width, H = img.height;
  const K = Math.max(1, Math.round(band));
  const D = 2 * K;
  // Distance (4-connected steps) from the outline, up to 2K, by BFS from the region's outer pixels.
  const dist = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  /** Pixel (x, y) of the frame (or beyond it) is table: outside the region, not beyond the photo. */
  const table = (x: number, y: number): boolean => {
    if (x < 0) return ox > 0;
    if (y < 0) return oy > 0;
    if (x >= w) return ox + w < W;
    if (y >= h) return oy + h < H;
    return !region.data[y * w + x];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!region.data[i]) continue;
      if (table(x - 1, y) || table(x + 1, y) || table(x, y - 1) || table(x, y + 1)) {
        dist[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  if (tail === 0) return null;
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= D) continue;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || !region.data[j] || dist[j]) continue;
      dist[j] = d + 1;
      queue[tail++] = j;
    }
  }
  // Table lightness per 8×8 block (filled on first use) and table colours of the blocks shadow
  // candidates lie in.
  const bw = Math.ceil(W / 8);
  const tableL = new Map<number, number>();
  const tableLAt = (X: number, Y: number): number => {
    const key = (Y >> 3) * bw + (X >> 3);
    let v = tableL.get(key);
    if (v === undefined) tableL.set(key, (v = backgroundAt(fit, Math.min(W - 1, (X & ~7) + 4), Math.min(H - 1, (Y & ~7) + 4))[0]));
    return v;
  };
  const colours = new Map<number, ReturnType<typeof tableChromasAt>>();
  const coloursAt = (X: number, Y: number) => {
    const key = (Y >> 3) * bw + (X >> 3);
    let v = colours.get(key);
    if (!v) colours.set(key, (v = tableChromasAt(fit, Math.min(W - 1, (X & ~7) + 4), Math.min(H - 1, (Y & ~7) + 4))));
    return v;
  };
  // Lightness of the band pixels; the region's own lightness K–2K px in (and how much of it is
  // lighter than the table), averaged over blocks of K px and their neighbours (≈ 2K around).
  const Lp = new Float32Array(w * h);
  const gw = Math.ceil(w / K), gh = Math.ceil(h / K);
  const sumL = new Float64Array(gw * gh), nIn = new Float64Array(gw * gh), nLight = new Float64Array(gw * gh);
  const d = img.data;
  for (let k = 0; k < tail; k++) {
    const i = queue[k];
    const x = i % w, y = (i - x) / w;
    const o = ((y + oy) * W + x + ox) * 4;
    const L = lightness(d[o], d[o + 1], d[o + 2]);
    Lp[i] = L;
    if (dist[i] > K) {
      const g = ((y / K) | 0) * gw + ((x / K) | 0);
      sumL[g] += L;
      nIn[g]++;
      if (L > tableLAt(x + ox, y + oy)) nLight[g]++;
    }
  }
  // Shadow pixels of the band.
  const isShadow = new Uint8Array(w * h);
  const sL = fit.sigma[0];
  for (let k = 0; k < tail; k++) {
    const i = queue[k];
    if (dist[i] > K) continue;
    const x = i % w, y = (i - x) / w;
    const X = x + ox, Y = y + oy;
    const tL = tableLAt(X, Y);
    const L = Lp[i];
    if (L > tL + CAST_MAX_LIGHTER * sL || L + 16 < CAST_RHO_MIN * (tL + 16)) continue;
    // Next to a piece darker than the table, nothing within half the step from it to the table of
    // its own brightness: that is its print (a shadow far deeper than the piece is still shadow).
    if (L < tL) {
      const gx = (x / K) | 0, gy = (y / K) | 0;
      let s = 0, n = 0, l = 0;
      for (let v = Math.max(0, gy - 1); v <= Math.min(gh - 1, gy + 1); v++) {
        for (let u = Math.max(0, gx - 1); u <= Math.min(gw - 1, gx + 1); u++) {
          const g = v * gw + u;
          s += sumL[g];
          n += nIn[g];
          l += nLight[g];
        }
      }
      if (n > 0 && l < LIGHT_SHARE * n) {
        const pL = s / n;
        if (pL < tL && Math.abs(L - pL) < 0.5 * (tL - pL)) continue;
      }
    }
    const o = (Y * W + X) * 4;
    const lab = rgbToLab(d[o], d[o + 1], d[o + 2]);
    const cs = coloursAt(X, Y);
    if (tableChromaDistance(cs, lab[1], lab[2], CAST_CHROMA_SCALE) <= CAST_CHROMA && hueOffset(cs, lab[1], lab[2]) <= CAST_HUE) isShadow[i] = 1;
  }
  // Reached from the table through shadow pixels (4-connected).
  const shadow = new Uint8Array(w * h);
  let n = 0;
  for (let k = 0; k < tail; k++) {
    const i = queue[k];
    if (dist[i] !== 1 || !isShadow[i]) continue;
    const x = i % w, y = (i - x) / w;
    if (table(x - 1, y) || table(x + 1, y) || table(x, y - 1) || table(x, y + 1)) {
      shadow[i] = 1;
      // (The queue is reused for the flood: entries up to k are read already.)
      queue[n++] = i;
    }
  }
  head = 0;
  tail = n;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || shadow[j] || !isShadow[j]) continue;
      shadow[j] = 1;
      queue[tail++] = j;
    }
  }
  if (tail === 0) return null;
  // Only a shadow wide enough to be one: thin dark lines (creases, seams of assembled pieces, rims
  // and narrow gaps) that reach in from the outline stay.
  const r = Math.max(2, Math.round(CAST_MIN_WIDTH * K));
  const sm = createMask(w, h);
  sm.data.set(shadow);
  const wide = open(sm, r);
  // Only a shadow beyond what the score already calls table in shade: most of it deeper than
  // CAST_DEEP (a soft shadow is the outline snapping's and peelShadowHalo's).
  let count = 0, deep = 0;
  for (let i = 0; i < w * h; i++) {
    if (!wide.data[i]) continue;
    count++;
    const x = i % w, y = (i - x) / w;
    if (Lp[i] + 16 < CAST_DEEP * (tableLAt(x + ox, y + oy) + 16)) deep++;
  }
  return count > 0 && deep >= CAST_DEEP_SHARE * count ? { shadow: wide.data, count } : null;
}
