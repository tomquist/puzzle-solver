/**
 * Synthetic close-up photos for tests: a region of a high-resolution image seen through a known
 * homography, with exposure/white-balance change, vignetting, blur, noise, optional glare and an
 * unrelated textured background where the view leaves the picture. Pure TS (no Node APIs).
 */
import { createRng, gaussianSample } from '../../cv/features/random';
import { gaussianBlurFloat } from '../../cv/filter';
import { composeTransforms, rotation, scaling, translation, type Mat3, type Point } from '../../cv/geometry';
import { createFloat, createRGBA, type RGBAImage } from '../../cv/image';
import { warpRGBA } from '../../cv/warp';

export interface SyntheticCloseupOptions {
  /** Center of the view in source-image pixels. */
  center: Point;
  /** Rotation of the view in radians (clockwise on screen). */
  angle: number;
  /** Close-up pixels per source pixel at the view center. */
  zoom: number;
  /** Output size. */
  width: number;
  height: number;
  /** Projective terms (1/px in centered close-up coordinates), e.g. [2e-4, -1e-4]. */
  perspective?: [number, number];
  /** Per-channel gain and offset applied to the view. */
  gain?: [number, number, number];
  offset?: [number, number, number];
  /** Relative darkening at the corners (0 = none). */
  vignette?: number;
  /** Gaussian blur sigma in close-up pixels. */
  blur?: number;
  /** Gaussian noise sigma (0..255 scale). */
  noise?: number;
  /** Bright specular spot in close-up pixels. */
  glare?: { x: number; y: number; radius: number; strength: number };
  seed?: number;
}

/**
 * Render a synthetic close-up of `source`. Returns the image and the ground-truth homography
 * mapping source pixels to close-up pixels.
 */
export function makeSyntheticCloseup(source: RGBAImage, o: SyntheticCloseupOptions): { image: RGBAImage; sourceToCloseup: Mat3 } {
  const { width: W, height: H } = o;
  const [p1, p2] = o.perspective ?? [0, 0];
  const persp: Mat3 = [1, 0, 0, 0, 1, 0, p1, p2, 1];
  const G = composeTransforms(
    translation(-o.center.x, -o.center.y),
    scaling(o.zoom),
    rotation(o.angle),
    persp,
    translation((W - 1) / 2, (H - 1) / 2),
  );
  const view = warpRGBA(source, G, W, H, { supersample: 2, fill: [0, 0, 0, 0] });
  const rng = createRng(o.seed ?? 7);

  // Unrelated background (table/box texture): smooth random blobs plus fine grain.
  const bgSmall = createFloat(Math.ceil(W / 16) + 1, Math.ceil(H / 16) + 1, 3);
  for (let i = 0; i < bgSmall.data.length; i += 3) {
    const t = rng();
    bgSmall.data[i] = 120 + 80 * t;
    bgSmall.data[i + 1] = 90 + 60 * t;
    bgSmall.data[i + 2] = 60 + 40 * rng();
  }
  const f = createFloat(W, H, 3);
  const gain = o.gain ?? [1, 1, 1];
  const offset = o.offset ?? [0, 0, 0];
  const vig = o.vignette ?? 0;
  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  const rmax2 = cx * cx + cy * cy;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = view.data[i * 4 + 3] / 255;
      const bx = Math.min(bgSmall.width - 1, Math.floor(x / 16));
      const by = Math.min(bgSmall.height - 1, Math.floor(y / 16));
      const bi = (by * bgSmall.width + bx) * 3;
      const v = 1 - vig * (((x - cx) ** 2 + (y - cy) ** 2) / rmax2);
      for (let c = 0; c < 3; c++) {
        const bg = bgSmall.data[bi + c] + 25 * ((x * 7 + y * 13) % 5 === 0 ? 1 : 0);
        const pic = view.data[i * 4 + c] * gain[c] + offset[c];
        f.data[i * 3 + c] = (a * pic + (1 - a) * bg) * v;
      }
    }
  }
  if (o.glare) {
    const { x: gx, y: gy, radius, strength } = o.glare;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d2 = ((x - gx) ** 2 + (y - gy) ** 2) / (radius * radius);
        if (d2 > 9) continue;
        const add = strength * Math.exp(-d2);
        for (let c = 0; c < 3; c++) f.data[(y * W + x) * 3 + c] += add;
      }
    }
  }
  const blurred = o.blur && o.blur > 0 ? gaussianBlurFloat(f, o.blur) : f;
  const out = createRGBA(W, H);
  const noise = o.noise ?? 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = blurred.data[i * 3 + c] + (noise > 0 ? noise * gaussianSample(rng) : 0);
    out.data[i * 4 + 3] = 255;
  }
  return { image: out, sourceToCloseup: G };
}
