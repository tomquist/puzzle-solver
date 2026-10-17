import { createFloat, createGray, createRGBA, type FloatImage, type GrayImage, type RGBAImage } from './image';

/** Rec.601 luma in 0..255. */
export function rgbaToGray(img: RGBAImage): GrayImage {
  const out = createGray(img.width, img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) {
    out.data[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return out;
}

/** RGB as a 3-channel float image (0..255), alpha dropped. */
export function rgbaToFloatRGB(img: RGBAImage): FloatImage {
  const out = createFloat(img.width, img.height, 3);
  const d = img.data;
  for (let i = 0, p = 0, q = 0; i < img.width * img.height; i++, p += 4, q += 3) {
    out.data[q] = d[p];
    out.data[q + 1] = d[p + 1];
    out.data[q + 2] = d[p + 2];
  }
  return out;
}

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

function labF(t: number): number {
  return t > 0.008856451679035631 ? Math.cbrt(t) : t * 7.787037037037037 + 16 / 116;
}

// Lookup table for labF over [0, LAB_F_MAX] (XYZ components of sRGB colours stay below ~1.0001).
// Linear interpolation keeps the error below 1e-5 while avoiding millions of Math.cbrt calls.
const LAB_F_STEPS = 8192;
const LAB_F_MAX = 1.01;
const LAB_F_TABLE = (() => {
  const t = new Float32Array(LAB_F_STEPS + 2);
  for (let i = 0; i <= LAB_F_STEPS + 1; i++) t[i] = labF((i / LAB_F_STEPS) * LAB_F_MAX);
  return t;
})();

function labFFast(v: number): number {
  if (v <= 0.008856451679035631 || v >= LAB_F_MAX) return labF(v);
  const x = (v / LAB_F_MAX) * LAB_F_STEPS;
  const i = x | 0;
  const f = x - i;
  return LAB_F_TABLE[i] + (LAB_F_TABLE[i + 1] - LAB_F_TABLE[i]) * f;
}

/** Convert one sRGB triple (0..255) to CIE L*a*b* (D65). L in 0..100, a/b roughly -128..127. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(r)))];
  const gl = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(g)))];
  const bl = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(b)))];
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE L*a*b* (D65) as a 3-channel float image. Alpha is ignored. */
export function rgbaToLab(img: RGBAImage): FloatImage {
  const out = createFloat(img.width, img.height, 3);
  const d = img.data;
  const o = out.data;
  for (let i = 0, p = 0, q = 0; i < img.width * img.height; i++, p += 4, q += 3) {
    const rl = SRGB_TO_LINEAR[d[p]];
    const gl = SRGB_TO_LINEAR[d[p + 1]];
    const bl = SRGB_TO_LINEAR[d[p + 2]];
    const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
    const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
    const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
    const fx = labFFast(x), fy = labFFast(y), fz = labFFast(z);
    o[q] = 116 * fy - 16;
    o[q + 1] = 500 * (fx - fy);
    o[q + 2] = 200 * (fy - fz);
  }
  return out;
}

function linearToSrgb8(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function labFInv(t: number): number {
  return t > 0.20689655172413793 ? t * t * t : (t - 16 / 116) / 7.787037037037037;
}

/** Inverse of {@link rgbaToLab}; produces an opaque RGBA image. */
export function labToRgba(lab: FloatImage): RGBAImage {
  const out = createRGBA(lab.width, lab.height);
  const s = lab.data;
  const d = out.data;
  for (let i = 0, q = 0, p = 0; i < lab.width * lab.height; i++, q += lab.channels, p += 4) {
    const fy = (s[q] + 16) / 116;
    const fx = fy + s[q + 1] / 500;
    const fz = fy - s[q + 2] / 200;
    const x = labFInv(fx) * 0.95047;
    const y = labFInv(fy);
    const z = labFInv(fz) * 1.08883;
    const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
    const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    d[p] = linearToSrgb8(rl);
    d[p + 1] = linearToSrgb8(gl);
    d[p + 2] = linearToSrgb8(bl);
    d[p + 3] = 255;
  }
  return out;
}

/** Extract one channel of a float image as a gray image. */
export function channel(img: FloatImage, c: number): GrayImage {
  const out = createGray(img.width, img.height);
  for (let i = 0, q = c; i < out.data.length; i++, q += img.channels) out.data[i] = img.data[q];
  return out;
}

/** HSV saturation (0..1) and value (0..1) of an RGBA pixel. Useful for glare detection. */
export function saturationValue(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return [max === 0 ? 0 : (max - min) / max, max / 255];
}
