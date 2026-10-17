/**
 * Test helpers for the pieces package (Node/Vitest only, not part of the app bundle): accuracy
 * metrics against synthetic ground truth, photo degradations for the quality checks, and debug
 * overlays.
 */
import { rgbaToFloatRGB } from '../../cv/color';
import { gaussianBlurFloat } from '../../cv/filter';
import { findHomography, type Point } from '../../cv/geometry';
import { cloneRGBA, createMask, createRGBA, cropRGBA, type Mask, type RGBAImage, type Rect } from '../../cv/image';
import { drawLine, drawPolygon, fillPolygon } from '../../cv/raster';
import { sampleRGBA, warpRGBA } from '../../cv/warp';
import type { PieceShape, SideKind } from '../../model/types';
import { Rng, truthPieceShape, type JigsawCut, type PieceTruth } from '../../testing/synth';
import type { Segmentation } from './types';

// ---------------------------------------------------------------------------------------------
// Accuracy metrics
// ---------------------------------------------------------------------------------------------

/** Rasterise a polygon (photo coordinates) into a mask covering `rect`. */
function rasterize(poly: Point[], rect: Rect): Mask {
  const m = createMask(rect.width, rect.height);
  fillPolygon(m, poly.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y })), 1);
  return m;
}

/** IoU of two bbox-local masks given their photo-space rectangles. */
export function maskIoU(a: Mask, ra: Rect, b: Mask, rb: Rect): number {
  const x0 = Math.min(ra.x, rb.x), y0 = Math.min(ra.y, rb.y);
  const x1 = Math.max(ra.x + ra.width, rb.x + rb.width), y1 = Math.max(ra.y + ra.height, rb.y + rb.height);
  let inter = 0, uni = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ax = x - ra.x, ay = y - ra.y, bx = x - rb.x, by = y - rb.y;
      const va = ax >= 0 && ay >= 0 && ax < ra.width && ay < ra.height ? a.data[ay * ra.width + ax] : 0;
      const vb = bx >= 0 && by >= 0 && bx < rb.width && by < rb.height ? b.data[by * rb.width + bx] : 0;
      if (va && vb) inter++;
      if (va || vb) uni++;
    }
  }
  return uni > 0 ? inter / uni : 0;
}

/** Corner error (max over the 4 corners, px) after the best cyclic alignment, and that shift. */
export function cornerError(shape: PieceShape, truth: PieceShape): { error: number; shift: number } {
  let best = Infinity, shift = 0;
  for (let s = 0; s < 4; s++) {
    let e = 0;
    for (let j = 0; j < 4; j++) {
      const p = shape.corners[j], q = truth.corners[(j + s) % 4];
      e = Math.max(e, Math.hypot(p.x - q.x, p.y - q.y));
    }
    if (e < best) { best = e; shift = s; }
  }
  return { error: best, shift };
}

/** Smallest difference of two angles modulo 90° (degrees). */
export function quarterAngleError(a: number, b: number): number {
  const d = Math.abs((((a - b) % 90) + 90) % 90);
  return Math.min(d, 90 - d);
}

export interface PieceEval {
  truthIndex: number;
  iou: number;
  detected: boolean;
  isPatch: boolean;
  kindOk: boolean;
  /** Single pieces with a shape only. */
  cornerErrorRel?: number;
  sidesCorrect?: number;
  pieceKindOk?: boolean;
  angleError?: number;
  bodySizeErrorRel?: number;
  shapeFound?: boolean;
}

export interface SceneEval {
  pieces: PieceEval[];
  /** Regions that match no truth item (IoU < threshold), excluding fragments. */
  falseRegions: number;
  regions: number;
}

/** Compare a segmentation with the synthetic truth of the rendered items. */
export function evaluateScene(seg: Segmentation, truth: PieceTruth[], cut: JigsawCut, minIoU = 0.85): SceneEval {
  const pieces: PieceEval[] = [];
  const matched = new Set<number>();
  truth.forEach((t, ti) => {
    const rect = { x: t.bbox.x - 2, y: t.bbox.y - 2, width: t.bbox.width + 4, height: t.bbox.height + 4 };
    const tm = rasterize(t.outline, rect);
    let best = -1, bestIoU = 0;
    seg.regions.forEach((r, ri) => {
      const b = r.region.bbox;
      if (b.x > rect.x + rect.width || b.y > rect.y + rect.height || b.x + b.width < rect.x || b.y + b.height < rect.y) return;
      const iou = maskIoU(tm, rect, r.mask, b);
      if (iou > bestIoU) { bestIoU = iou; best = ri; }
    });
    const isPatch = t.pieces.length > 1;
    const ev: PieceEval = { truthIndex: ti, iou: bestIoU, detected: bestIoU >= minIoU, isPatch, kindOk: false };
    if (best >= 0 && bestIoU >= minIoU) {
      matched.add(best);
      const r = seg.regions[best].region;
      ev.kindOk = r.kind === (isPatch ? 'patch' : 'piece');
      if (!isPatch) {
        ev.shapeFound = !!r.shape;
        if (r.shape) {
          const ts = truthPieceShape(cut, t);
          const ce = cornerError(r.shape, ts);
          ev.cornerErrorRel = ce.error / ts.bodySize;
          let ok = 0;
          for (let j = 0; j < 4; j++) if (r.shape.sides[j].kind === ts.sides[(j + ce.shift) % 4].kind) ok++;
          ev.sidesCorrect = ok;
          ev.pieceKindOk = r.shape.kind === ts.kind;
          ev.angleError = quarterAngleError(r.shape.angleDeg, ts.angleDeg);
          ev.bodySizeErrorRel = Math.abs(r.shape.bodySize - ts.bodySize) / ts.bodySize;
        }
      }
    }
    pieces.push(ev);
  });
  let falseRegions = 0;
  seg.regions.forEach((r, ri) => {
    if (!matched.has(ri) && !r.region.issues.some((i) => i.code === 'fragment')) falseRegions++;
  });
  return { pieces, falseRegions, regions: seg.regions.length };
}

// ---------------------------------------------------------------------------------------------
// Degradations
// ---------------------------------------------------------------------------------------------

function fromFloat(f: { width: number; height: number; data: Float32Array }): RGBAImage {
  const out = createRGBA(f.width, f.height);
  for (let i = 0; i < f.width * f.height; i++) {
    out.data[i * 4] = f.data[i * 3];
    out.data[i * 4 + 1] = f.data[i * 3 + 1];
    out.data[i * 4 + 2] = f.data[i * 3 + 2];
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Gaussian (defocus) blur. */
export function blurPhoto(photo: RGBAImage, sigma: number): RGBAImage {
  return fromFloat(gaussianBlurFloat(rgbaToFloatRGB(photo), sigma));
}

/** Linear motion blur: average along a segment of `length` px at `angleDeg` (clockwise from +x). */
export function motionBlurPhoto(photo: RGBAImage, length: number, angleDeg: number): RGBAImage {
  const { width: w, height: h } = photo;
  const out = createRGBA(w, h);
  const n = Math.max(2, Math.round(length * 2));
  const dx = Math.cos((angleDeg * Math.PI) / 180), dy = Math.sin((angleDeg * Math.PI) / 180);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let k = 0; k < n; k++) {
        const t = (k / (n - 1) - 0.5) * length;
        const sx = Math.min(w - 1, Math.max(0, x + dx * t)), sy = Math.min(h - 1, Math.max(0, y + dy * t));
        sampleRGBA(photo, sx, sy, px);
        r += px[0]; g += px[1]; b += px[2]; c++;
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / c;
      out.data[o + 1] = g / c;
      out.data[o + 2] = b / c;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Exposure change: v' = v · gain + offset (clamped). */
export function exposePhoto(photo: RGBAImage, gain: number, offset = 0): RGBAImage {
  const out = cloneRGBA(photo);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = photo.data[i + c] * gain + offset;
  }
  return out;
}

/** Soft white specular blobs on the given items (one per item, radius as a fraction of the body). */
export function addGlare(photo: RGBAImage, items: PieceTruth[], radiusFrac = 0.22, seed = 1): RGBAImage {
  const out = cloneRGBA(photo);
  const rng = new Rng(seed);
  for (const t of items) {
    const c = t.corners;
    const body = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    const cx = t.center.x + rng.uniform(-0.15, 0.15) * body, cy = t.center.y + rng.uniform(-0.15, 0.15) * body;
    const rx = radiusFrac * body, ry = rx * rng.uniform(0.5, 0.9);
    const ang = rng.uniform(0, Math.PI);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const R = Math.ceil(rx * 1.5);
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(out.height, cy + R); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(out.width, cx + R); x++) {
        const u = ((x - cx) * ca + (y - cy) * sa) / rx, v = (-(x - cx) * sa + (y - cy) * ca) / ry;
        const d = u * u + v * v;
        const a = d < 0.6 ? 1 : d < 1.2 ? (1.2 - d) / 0.6 : 0;
        if (a <= 0) continue;
        const o = (y * out.width + x) * 4;
        for (let ch = 0; ch < 3; ch++) out.data[o + ch] = out.data[o + ch] * (1 - a) + 252 * a;
      }
    }
  }
  return out;
}

/** Crop a photo (pieces near the cut become cut off). */
export function cropPhoto(photo: RGBAImage, rect: Rect): RGBAImage {
  return cropRGBA(photo, rect);
}

/**
 * Simulate a tilted camera: the top edge is shrunk to `topScale` of the bottom edge (keystone).
 * Returns the warped photo and the homography (photo → warped).
 */
export function perspectivePhoto(photo: RGBAImage, topScale: number, fill: [number, number, number, number]) {
  const { width: w, height: h } = photo;
  const inset = ((1 - topScale) * w) / 2;
  const src: Point[] = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const dst: Point[] = [{ x: inset, y: 0 }, { x: w - inset, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const H = findHomography(src, dst)!;
  return { photo: warpRGBA(photo, H, w, h, { fill }), H };
}

/**
 * Move item `b` so that it touches item `a` (slight overlap of the outlines; `a` stays on top).
 * The vacated place of `b` is filled with the median colour of a ring around it.
 */
export function makeTouching(photo: RGBAImage, a: PieceTruth, b: PieceTruth, overlapPx = 3): RGBAImage {
  const out = cloneRGBA(photo);
  const { width: w, height: h } = photo;
  const pad = 4;
  const rb = { x: b.bbox.x - pad, y: b.bbox.y - pad, width: b.bbox.width + 2 * pad, height: b.bbox.height + 2 * pad };
  const mb = rasterize(b.outline, rb);
  // Dilate b's mask by ~2 px so the anti-aliased rim and shadow move along.
  const grown = createMask(rb.width, rb.height);
  for (let y = 0; y < rb.height; y++) {
    for (let x = 0; x < rb.width; x++) {
      let on = 0;
      for (let dy = -2; dy <= 2 && !on; dy++) for (let dx = -2; dx <= 2 && !on; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < rb.width && yy < rb.height && mb.data[yy * rb.width + xx]) on = 1;
      }
      grown.data[y * rb.width + x] = on;
    }
  }
  const ra = { x: a.bbox.x - pad, y: a.bbox.y - pad, width: a.bbox.width + 2 * pad, height: a.bbox.height + 2 * pad };
  const ma = rasterize(a.outline, ra);
  const inA = (x: number, y: number) => {
    const ax = x - ra.x, ay = y - ra.y;
    return ax >= 0 && ay >= 0 && ax < ra.width && ay < ra.height && ma.data[ay * ra.width + ax] === 1;
  };
  // Direction from b to a; advance until the true outlines overlap by `overlapPx` pixels along it.
  const dxv = a.center.x - b.center.x, dyv = a.center.y - b.center.y;
  const dl = Math.hypot(dxv, dyv);
  const ux = dxv / dl, uy = dyv / dl;
  let shift = 0;
  for (let s = 0; s < dl; s += 0.5) {
    let hit = false;
    for (let y = 0; y < rb.height && !hit; y++) {
      for (let x = 0; x < rb.width && !hit; x++) {
        if (mb.data[y * rb.width + x] && inA(Math.round(x + rb.x + ux * s), Math.round(y + rb.y + uy * s))) hit = true;
      }
    }
    if (hit) { shift = s + overlapPx; break; }
  }
  const tx = Math.round(ux * shift), ty = Math.round(uy * shift);
  // Ring colour around b for the vacated place.
  const ring: number[][] = [[], [], []];
  for (let y = rb.y; y < rb.y + rb.height; y++) {
    for (let x = rb.x; x < rb.x + rb.width; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const onEdge = y === rb.y || x === rb.x || y === rb.y + rb.height - 1 || x === rb.x + rb.width - 1;
      if (!onEdge) continue;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) ring[c].push(photo.data[o + c]);
    }
  }
  const med = ring.map((v) => v.sort((p, q) => p - q)[v.length >> 1] ?? 0);
  for (let y = 0; y < rb.height; y++) {
    for (let x = 0; x < rb.width; x++) {
      if (!grown.data[y * rb.width + x]) continue;
      const X = x + rb.x, Y = y + rb.y;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const o = (Y * w + X) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = med[c];
    }
  }
  for (let y = 0; y < rb.height; y++) {
    for (let x = 0; x < rb.width; x++) {
      if (!grown.data[y * rb.width + x]) continue;
      const X = x + rb.x + tx, Y = y + rb.y + ty;
      if (X < 0 || Y < 0 || X >= w || Y >= h || inA(X, Y)) continue;
      const si = ((y + rb.y) * w + (x + rb.x)) * 4, o = (Y * w + X) * 4;
      if (y + rb.y < 0 || x + rb.x < 0 || y + rb.y >= h || x + rb.x >= w) continue;
      for (let c = 0; c < 3; c++) out.data[o + c] = photo.data[si + c];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Debug overlays
// ---------------------------------------------------------------------------------------------

const SIDE_COLORS: Record<SideKind, [number, number, number, number]> = {
  flat: [40, 120, 255, 255],
  tab: [40, 220, 60, 255],
  blank: [255, 50, 50, 255],
  unknown: [255, 230, 0, 255],
};

/**
 * Debug overlay: outlines (white = piece, magenta = patch, gray = unknown), body quads with sides
 * coloured by kind (blue flat, green tab, red blank, yellow unknown), corner 0 marked, and the
 * truth corners (cyan) when given.
 */
export function drawOverlay(photo: RGBAImage, seg: Segmentation, truth?: PieceTruth[]): RGBAImage {
  const img = cloneRGBA(photo);
  for (const sr of seg.regions) {
    const r = sr.region;
    const col: [number, number, number, number] = r.kind === 'piece' ? [255, 255, 255, 255] : r.kind === 'patch' ? [255, 0, 255, 255] : [140, 140, 140, 255];
    drawPolygon(img, r.contour, col, 1);
    if (r.shape) {
      const c = r.shape.corners;
      for (let j = 0; j < 4; j++) drawLine(img, c[j], c[(j + 1) % 4], SIDE_COLORS[r.shape.sides[j].kind], 2);
      const p = c[0];
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = Math.round(p.x + dx), y = Math.round(p.y + dy);
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const o = (y * img.width + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 140; img.data[o + 2] = 0;
      }
    }
    if (r.issues.length) {
      const b = r.bbox;
      drawPolygon(img, [{ x: b.x - 3, y: b.y - 3 }, { x: b.x + b.width + 2, y: b.y - 3 }, { x: b.x + b.width + 2, y: b.y + b.height + 2 }, { x: b.x - 3, y: b.y + b.height + 2 }], [255, 160, 0, 255], 1);
    }
  }
  if (truth) {
    for (const t of truth) {
      for (const p of t.corners) {
        for (let d = -2; d <= 2; d++) {
          for (const [x, y] of [[p.x + d, p.y], [p.x, p.y + d]]) {
            const xi = Math.round(x), yi = Math.round(y);
            if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) continue;
            const o = (yi * img.width + xi) * 4;
            img.data[o] = 0; img.data[o + 1] = 255; img.data[o + 2] = 255;
          }
        }
      }
    }
  }
  return img;
}
