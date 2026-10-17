/**
 * Sub-pixel corner refinement on the full-resolution photo: for each side, locate the strongest
 * colour edge along normal profiles near the coarse side, fit a line robustly (fitLine with
 * iterative outlier rejection) and intersect adjacent sides.
 */
import type { Point, Quad } from '../../cv/geometry';
import type { RGBAImage } from '../../cv/image';
import { fitLine, lineIntersection } from '../../cv/lines';
import { isConvexClockwise } from './geometry';

/** Bilinear RGB sample into out[0..2]; false when outside. */
function sampleRGB(img: RGBAImage, x: number, y: number, out: Float32Array): boolean {
  const w = img.width, h = img.height;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return false;
  const x0 = Math.min(w - 2, Math.floor(x)), y0 = Math.min(h - 2, Math.floor(y));
  const fx = x - x0, fy = y - y0;
  const d = img.data;
  const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
  out[0] = d[i00] * a + d[i10] * b + d[i01] * c + d[i11] * e;
  out[1] = d[i00 + 1] * a + d[i10 + 1] * b + d[i01 + 1] * c + d[i11 + 1] * e;
  out[2] = d[i00 + 2] * a + d[i10 + 2] * b + d[i01 + 2] * c + d[i11 + 2] * e;
  return true;
}

export interface RefineOptions {
  /** Half-width of the normal search window in photo pixels. */
  radius: number;
  /** Sides that must not move (e.g. on the photo border). */
  fixed?: boolean[];
  /** Max samples per side (default 240). */
  maxSamples?: number;
}

export interface RefineResult {
  quad: Quad;
  /** Fraction of profile samples that ended up as inliers, per side (1 for fixed sides). */
  inlierFraction: number[];
  /** RMS residual of the inliers per side (px). */
  rms: number[];
}

/** Refine a quad (photo coordinates) against the photo's colour edges. */
export function refineQuad(photo: RGBAImage, quad: Quad, opts: RefineOptions): RefineResult {
  const R = Math.max(2, opts.radius);
  const step = 0.5;
  const nOff = Math.floor((2 * R) / step) + 1;
  const prof = new Float32Array(nOff * 3);
  const ok = new Uint8Array(nOff);
  const D = new Float32Array(nOff);
  const px = new Float32Array(3);
  const lines: { p: Point; d: Point }[] = [];
  const inlierFraction: number[] = [], rms: number[] = [];
  const sigma = R / 1.5;
  const k2 = Math.round(1 / step); // ±1 px central difference
  for (let s = 0; s < 4; s++) {
    const A = quad[s], B = quad[(s + 1) % 4];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const dx = (B.x - A.x) / len, dy = (B.y - A.y) / len;
    const nx = dy, ny = -dx; // outward normal for a clockwise quad
    if (opts.fixed?.[s] || len < 8) {
      lines.push({ p: A, d: { x: dx, y: dy } });
      inlierFraction.push(1);
      rms.push(0);
      continue;
    }
    const nS = Math.max(16, Math.min(opts.maxSamples ?? 240, Math.round(len / 3)));
    const pts: Point[] = [];
    // Typical edge strength to reject samples without a real edge.
    const strengths: number[] = [];
    const cand: { p: Point; v: number }[] = [];
    for (let k = 0; k < nS; k++) {
      const t = 0.04 + 0.92 * ((k + 0.5) / nS);
      const cx = A.x + t * (B.x - A.x), cy = A.y + t * (B.y - A.y);
      for (let j = 0; j < nOff; j++) {
        const o = -R + j * step;
        ok[j] = sampleRGB(photo, cx + o * nx, cy + o * ny, px) ? 1 : 0;
        prof[j * 3] = px[0];
        prof[j * 3 + 1] = px[1];
        prof[j * 3 + 2] = px[2];
      }
      let best = -1, bestV = 0;
      for (let j = k2; j < nOff - k2; j++) {
        if (!ok[j - k2] || !ok[j + k2]) { D[j] = 0; continue; }
        const a = (j + k2) * 3, b = (j - k2) * 3;
        const r = prof[a] - prof[b], g = prof[a + 1] - prof[b + 1], bl = prof[a + 2] - prof[b + 2];
        D[j] = r * r + g * g + bl * bl;
        const o = -R + j * step;
        const v = D[j] * Math.exp(-(o * o) / (2 * sigma * sigma));
        if (v > bestV) { bestV = v; best = j; }
      }
      if (best < 0) continue;
      let off = -R + best * step;
      if (best > k2 && best < nOff - k2 - 1) {
        const y0 = D[best - 1], y1 = D[best], y2 = D[best + 1];
        const den = y0 - 2 * y1 + y2;
        if (den < 0) off += step * Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
      }
      strengths.push(Math.sqrt(D[best]));
      cand.push({ p: { x: cx + off * nx, y: cy + off * ny }, v: Math.sqrt(D[best]) });
    }
    if (cand.length >= 8) {
      const sorted = [...strengths].sort((a, b) => a - b);
      const ref = sorted[Math.floor(sorted.length * 0.75)];
      // Edge must be reasonably strong compared with the side's typical edge (≥ 14 levels absolute).
      const minV = Math.max(14, 0.35 * ref);
      for (const c of cand) if (c.v >= minV) pts.push(c.p);
    }
    const fit = robustLine(pts);
    if (fit && fit.inliers >= Math.max(8, 0.35 * nS)) {
      lines.push({ p: fit.p, d: fit.d });
      inlierFraction.push(fit.inliers / nS);
      rms.push(fit.rms);
    } else {
      lines.push({ p: A, d: { x: dx, y: dy } });
      inlierFraction.push(0);
      rms.push(Infinity);
    }
  }
  const corners: Point[] = [];
  for (let s = 0; s < 4; s++) {
    const l1 = lines[(s + 3) % 4], l2 = lines[s];
    const c = lineIntersection(l1.p, l1.d, l2.p, l2.d);
    corners.push(c ?? quad[s]);
  }
  const q = corners as Quad;
  // Sanity: corners must stay close to the coarse ones and the quad convex.
  const maxMove = 3 * R;
  const sane = isConvexClockwise(q) && q.every((c, i) => Math.hypot(c.x - quad[i].x, c.y - quad[i].y) <= maxMove);
  return sane ? { quad: q, inlierFraction, rms } : { quad, inlierFraction: [0, 0, 0, 0], rms: [Infinity, Infinity, Infinity, Infinity] };
}

/** Total-least-squares line with iterative MAD-based outlier rejection. */
function robustLine(pts: Point[]): { p: Point; d: Point; inliers: number; rms: number } | null {
  if (pts.length < 6) return null;
  let cur = pts;
  let fit = fitLine(cur);
  if (!fit) return null;
  for (let it = 0; it < 4; it++) {
    const f = fit;
    const res = pts.map((p) => Math.abs(-(p.x - f.point.x) * f.direction.y + (p.y - f.point.y) * f.direction.x));
    const sorted = [...res].sort((a, b) => a - b);
    const mad = sorted[Math.floor(sorted.length / 2)];
    const tol = Math.max(0.75, 3 * 1.4826 * mad);
    const next = pts.filter((_, i) => res[i] <= tol);
    if (next.length < 6) break;
    const nf = fitLine(next);
    if (!nf) break;
    fit = nf;
    if (next.length === cur.length) { cur = next; break; }
    cur = next;
  }
  const f = fit;
  let ss = 0;
  for (const p of cur) {
    const r = -(p.x - f.point.x) * f.direction.y + (p.y - f.point.y) * f.direction.x;
    ss += r * r;
  }
  return { p: f.point, d: f.direction, inliers: cur.length, rms: Math.sqrt(ss / Math.max(1, cur.length)) };
}
