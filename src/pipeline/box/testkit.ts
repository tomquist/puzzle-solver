/**
 * Test helpers for the box package (Node-only: uses the synthetic renderer and PNG output).
 * Extra degradations beyond `renderBoxPhoto`: glare blobs, cropping (lid cut off by the photo
 * border), an occluding "hand", exposure scaling and blur.
 */
import { gaussianBlurFloat } from '../../cv/filter';
import { distance, type Point, type Quad } from '../../cv/geometry';
import { cloneRGBA, cropRGBA, createFloat, createMask, type RGBAImage } from '../../cv/image';
import { drawPolygon, fillPolygon } from '../../cv/raster';
import { resizeRGBA } from '../../cv/resize';
import { loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { renderBoxPhoto, Rng, type BoxPhotoOptions } from '../../testing/synth';
import type { BoxDetection } from '../../model/types';

export type Painting = 'starry-night' | 'great-wave';

const refCache = new Map<string, RGBAImage>();

/** A test painting resized so its longer side is `maxSide`. */
export function painting(name: Painting, maxSide = 900): RGBAImage {
  const key = `${name}@${maxSide}`;
  let img = refCache.get(key);
  if (!img) {
    const src = loadTestAsset(name);
    const f = maxSide / Math.max(src.width, src.height);
    img = resizeRGBA(src, Math.round(src.width * f), Math.round(src.height * f));
    refCache.set(key, img);
  }
  return img;
}

export interface Degrade {
  /** Glare blobs: centre in picture unit coordinates, radius as fraction of the picture diagonal. */
  glare?: { u: number; v: number; r: number; strength?: number }[];
  /** Crop the photo to this rectangle (fractions of the photo). */
  crop?: { x0: number; y0: number; x1: number; y1: number };
  /**
   * Crop the photo to the picture's bounding box grown by these margins (fractions of the picture
   * size; left, top, right, bottom). Small margins cut the lid edges off; negative ones cut the picture.
   */
  cropAroundPicture?: [number, number, number, number];
  /** Skin-coloured occluder ("hand") polygon in picture unit coordinates (may extend beyond 0..1). */
  occluder?: Point[];
  /** Multiply all channels (exposure). */
  gain?: number;
  /** Extra Gaussian blur (px). */
  blur?: number;
}

export interface SceneSpec {
  name: string;
  painting: Painting;
  opts: BoxPhotoOptions;
  degrade?: Degrade;
  /** Painting size (longer side, px). */
  refSide?: number;
}

export interface Scene {
  spec: SceneSpec;
  photo: RGBAImage;
  pictureQuad: Quad;
  lidQuad: Quad;
  reference: RGBAImage;
}

function bilinearQuad(q: Quad, u: number, v: number): Point {
  const top = { x: q[0].x + u * (q[1].x - q[0].x), y: q[0].y + u * (q[1].y - q[0].y) };
  const bot = { x: q[3].x + u * (q[2].x - q[3].x), y: q[3].y + u * (q[2].y - q[3].y) };
  return { x: top.x + v * (bot.x - top.x), y: top.y + v * (bot.y - top.y) };
}

/** Add a soft specular highlight (towards white, clipped core). */
export function addGlare(img: RGBAImage, c: Point, radius: number, strength = 1.6): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(c.x - 3 * radius)), x1 = Math.min(img.width - 1, Math.ceil(c.x + 3 * radius));
  const y0 = Math.max(0, Math.floor(c.y - 3 * radius)), y1 = Math.min(img.height - 1, Math.ceil(c.y + 3 * radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
      const a = Math.min(1, strength * Math.exp(-d2 / (2 * r2)));
      if (a < 0.01) continue;
      const o = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = img.data[o + k] + (255 - img.data[o + k]) * a;
    }
  }
}

/** Gaussian blur of an RGBA image (alpha untouched). */
export function blurRGBA(img: RGBAImage, sigma: number): RGBAImage {
  const f = createFloat(img.width, img.height, 3);
  for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < 3; c++) f.data[i * 3 + c] = img.data[i * 4 + c];
  const b = gaussianBlurFloat(f, sigma);
  const out = cloneRGBA(img);
  for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < 3; c++) out.data[i * 4 + c] = b.data[i * 3 + c];
  return out;
}

/** Multiply RGB by `g` (clipped). */
export function scaleExposure(img: RGBAImage, g: number): RGBAImage {
  const out = cloneRGBA(img);
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] * g;
  return out;
}

/** Render a scene with its degradations; quads are adjusted for cropping. */
export function renderScene(spec: SceneSpec): Scene {
  const reference = painting(spec.painting, spec.refSide ?? 900);
  const r = renderBoxPhoto(reference, spec.opts);
  let photo = r.photo;
  let pictureQuad = r.pictureQuad, lidQuad = r.lidQuad;
  const d = spec.degrade ?? {};
  if (d.glare) {
    const diag = distance(pictureQuad[0], pictureQuad[2]);
    for (const g of d.glare) addGlare(photo, bilinearQuad(pictureQuad, g.u, g.v), g.r * diag, g.strength);
  }
  if (d.occluder) {
    const m = createMask(photo.width, photo.height);
    fillPolygon(m, d.occluder.map((p) => bilinearQuad(pictureQuad, p.x, p.y)), 1);
    const rng = new Rng(11);
    for (let i = 0; i < m.data.length; i++) {
      if (!m.data[i]) continue;
      const n = rng.uniform(-6, 6);
      photo.data[i * 4] = 205 + n;
      photo.data[i * 4 + 1] = 160 + n;
      photo.data[i * 4 + 2] = 135 + n;
    }
    photo = blurRGBA(photo, 0.8);
  }
  if (d.blur) photo = blurRGBA(photo, d.blur);
  if (d.gain !== undefined) photo = scaleExposure(photo, d.gain);
  let crop = d.crop;
  if (d.cropAroundPicture) {
    const xs = pictureQuad.map((p) => p.x), ys = pictureQuad.map((p) => p.y);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const [ml, mt, mr, mb] = d.cropAroundPicture;
    const bw = bx1 - bx0, bh = by1 - by0;
    crop = {
      x0: Math.max(0, (bx0 - ml * bw) / photo.width),
      y0: Math.max(0, (by0 - mt * bh) / photo.height),
      x1: Math.min(1, (bx1 + mr * bw) / photo.width),
      y1: Math.min(1, (by1 + mb * bh) / photo.height),
    };
  }
  if (crop) {
    const x = Math.round(crop.x0 * photo.width), y = Math.round(crop.y0 * photo.height);
    const w = Math.round((crop.x1 - crop.x0) * photo.width), h = Math.round((crop.y1 - crop.y0) * photo.height);
    photo = cropRGBA(photo, { x, y, width: w, height: h });
    const sh = (q: Quad): Quad => q.map((p) => ({ x: p.x - x, y: p.y - y })) as Quad;
    pictureQuad = sh(pictureQuad);
    lidQuad = sh(lidQuad);
  }
  return { spec, photo, pictureQuad, lidQuad, reference };
}

/** Max corner error in % of the (true) quad diagonal. */
export function cornerErrorPct(q: Quad, truth: Quad): number {
  const diag = (distance(truth[0], truth[2]) + distance(truth[1], truth[3])) / 2;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, distance(q[i], truth[i]));
  return (100 * m) / diag;
}

/** Save an overlay: truth green, lid truth dark green, detection red, other candidates yellow. */
export function saveOverlay(path: string, scene: Scene, det: BoxDetection): void {
  const img = cloneRGBA(scene.photo);
  const t = Math.max(1, Math.round(img.width / 800));
  for (const c of det.candidates.slice(1)) if (c.label !== 'whole-photo') drawPolygon(img, c.quad, [255, 220, 0, 255], t);
  drawPolygon(img, scene.lidQuad, [0, 120, 0, 255], t);
  drawPolygon(img, scene.pictureQuad, [0, 255, 0, 255], t);
  drawPolygon(img, det.quad, [255, 0, 0, 255], t);
  const f = Math.min(1, 1000 / Math.max(img.width, img.height));
  savePng(path, f < 1 ? resizeRGBA(img, Math.round(img.width * f), Math.round(img.height * f)) : img);
}

type RGB = [number, number, number];

/**
 * The accuracy sweep: both paintings, frames from none to wide, wood / plain / coloured /
 * lid-coloured tables, perspective 0.02–0.12, noise, blur, illumination gradients, glare, an
 * occluding hand and photos that cut off the lid edges.
 */
export function sweepScenes(): SceneSpec[] {
  const S = (name: string, p: Painting, opts: BoxPhotoOptions, degrade?: Degrade): SceneSpec => ({
    name,
    painting: p,
    opts: { width: 1200, height: 900, ...opts },
    degrade,
  });
  const sn: Painting = 'starry-night', gw: Painting = 'great-wave';
  const list: SceneSpec[] = [
    S('sn-frame-wood', sn, { seed: 1, frameWidth: 0.06, perspective: 0.06 }),
    S('gw-plain-noframe', gw, { seed: 2, frameWidth: 0, background: 'plain', perspective: 0.04 }),
    S('sn-wood-noframe-persp', sn, { seed: 3, frameWidth: 0, perspective: 0.1, noiseSigma: 4, blurSigma: 0.8 }),
    S('gw-frame-red-table', gw, { seed: 4, frameWidth: 0.04, background: [120, 60, 60], perspective: 0.08 }),
    S('sn-wideframe-plain', sn, { seed: 5, frameWidth: 0.1, background: 'plain', perspective: 0.12 }),
    S('gw-frame-wood-flat', gw, { seed: 6, frameWidth: 0.06, perspective: 0.02 }),
    S('sn-thinframe-dark', sn, { seed: 7, frameWidth: 0.03, background: [40, 40, 45], perspective: 0.07 }),
    S('gw-noframe-wood-persp', gw, { seed: 8, frameWidth: 0, perspective: 0.12 }),
    S('sn-lidlike-table', sn, { seed: 9, frameWidth: 0.06, lidColor: [70, 100, 170], background: [82, 104, 158] as RGB, perspective: 0.06 }),
    S('gw-lidlike-table', gw, { seed: 10, frameWidth: 0.06, lidColor: [180, 40, 40], background: [168, 52, 46] as RGB, perspective: 0.08 }),
    S('sn-noise8', sn, { seed: 11, frameWidth: 0, background: 'plain', noiseSigma: 8, perspective: 0.05 }),
    S('gw-blur1.5', gw, { seed: 12, frameWidth: 0.08, background: 'plain', blurSigma: 1.5, perspective: 0.06 }),
    S('sn-illum0.3', sn, { seed: 13, frameWidth: 0.05, illumination: 0.3, perspective: 0.08 }),
    S('gw-green-cloth', gw, { seed: 14, frameWidth: 0, background: [60, 90, 60], perspective: 0.09 }),
    S('sn-glare', sn, { seed: 15, frameWidth: 0.06, perspective: 0.05 }, { glare: [{ u: 0.65, v: 0.35, r: 0.05 }] }),
    S('gw-glare', gw, { seed: 16, frameWidth: 0.04, background: 'plain', perspective: 0.06 }, { glare: [{ u: 0.3, v: 0.6, r: 0.06 }] }),
    S('sn-hand-corner', sn, { seed: 17, frameWidth: 0, perspective: 0.06 }, { occluder: [{ x: 0.88, y: 0.93 }, { x: 1.25, y: 0.82 }, { x: 1.4, y: 1.4 }, { x: 0.82, y: 1.4 }] }),
    S('gw-hand-edge', gw, { seed: 18, frameWidth: 0.06, perspective: 0.05 }, { occluder: [{ x: 0.4, y: 0.9 }, { x: 0.6, y: 0.88 }, { x: 0.65, y: 1.5 }, { x: 0.38, y: 1.5 }] }),
    S('sn-crop-lid', sn, { seed: 19, frameWidth: 0.08, perspective: 0.05 }, { cropAroundPicture: [0.04, 0.04, 0.04, 0.06] }),
    S('gw-crop-lid-side', gw, { seed: 20, frameWidth: 0.05, background: 'plain', perspective: 0.04 }, { cropAroundPicture: [0.02, 0.3, 0.3, 0.3] }),
    S('sn-portrait-plain', sn, { seed: 21, frameWidth: 0, background: 'plain', perspective: 0.12, width: 900, height: 1200 }),
    S('gw-portrait-wood', gw, { seed: 22, frameWidth: 0.03, perspective: 0.06, width: 900, height: 1200 }),
    S('sn-beige-table', sn, { seed: 23, frameWidth: 0.12, background: [200, 190, 170], perspective: 0.07 }),
    S('gw-black-table', gw, { seed: 24, frameWidth: 0, background: [30, 30, 30], perspective: 0.08 }),
    S('gw-cream-table-noframe', gw, { seed: 25, frameWidth: 0, background: [214, 204, 178], perspective: 0.05 }),
    S('sn-big-1600', sn, { seed: 26, frameWidth: 0.06, perspective: 0.09, width: 1600, height: 1200 }),
  ];
  // Seeded random combinations.
  const rng = new Rng(4242);
  const bgs: BoxPhotoOptions['background'][] = ['wood', 'plain', [90, 70, 50], [150, 150, 160], [35, 55, 80]];
  for (let i = 0; list.length < 36; i++) {
    const p = i % 2 ? gw : sn;
    const frame = [0, 0.03, 0.06, 0.09][rng.int(4)];
    const bg = bgs[rng.int(bgs.length)];
    list.push(S(`rnd${i}-${p === sn ? 'sn' : 'gw'}`, p, {
      seed: 100 + i,
      frameWidth: frame,
      background: bg,
      perspective: rng.uniform(0.02, 0.12),
      noiseSigma: rng.uniform(1, 6),
      blurSigma: rng.uniform(0.4, 1.2),
      illumination: rng.uniform(0.05, 0.25),
    }));
  }
  return list;
}
