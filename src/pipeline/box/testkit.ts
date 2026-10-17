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
  /** Skin-coloured occluder polygon in photo fractions. */
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
    fillPolygon(m, d.occluder.map((p) => ({ x: p.x * photo.width, y: p.y * photo.height })), 1);
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
  if (d.crop) {
    const x = Math.round(d.crop.x0 * photo.width), y = Math.round(d.crop.y0 * photo.height);
    const w = Math.round((d.crop.x1 - d.crop.x0) * photo.width), h = Math.round((d.crop.y1 - d.crop.y0) * photo.height);
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
