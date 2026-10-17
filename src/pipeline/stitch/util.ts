/** Small geometry helpers shared by registration and compositing. */
import { applyMat3, type Mat3, type Point } from '../../cv/geometry';

/**
 * Pixel-center transform from an image of size fromW x fromH to the same image resized to
 * toW x toH (the convention of `resizeRGBA`/`limitSize`): x' = (x + 0.5) * toW / fromW - 0.5.
 */
export function resizeTransform(fromW: number, fromH: number, toW: number, toH: number): Mat3 {
  const sx = toW / fromW, sy = toH / fromH;
  return [sx, 0, 0.5 * sx - 0.5, 0, sy, 0.5 * sy - 0.5, 0, 0, 1];
}

/** Outer corners of a width x height image (TL, TR, BR, BL) in pixel-center coordinates. */
export function imageCorners(width: number, height: number): Point[] {
  return [
    { x: -0.5, y: -0.5 },
    { x: width - 0.5, y: -0.5 },
    { x: width - 0.5, y: height - 0.5 },
    { x: -0.5, y: height - 0.5 },
  ];
}

/** Projective denominator of H at p (positive in front of the projection). */
export function projectiveW(H: Mat3, p: Point): number {
  return H[6] * p.x + H[7] * p.y + H[8];
}

/** Determinant of the 3x3 matrix. */
export function det3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/**
 * Local linear scale of the homography at p: sqrt(|det J|) where J is the Jacobian of the
 * projective map (det J = det H / w^3).
 */
export function localScale(H: Mat3, p: Point): number {
  const w = projectiveW(H, p);
  return Math.sqrt(Math.abs(det3(H) / (w * w * w)));
}

/** 2x2 Jacobian [a, b, c, d] (row-major) of the projective map at p. */
export function jacobian(H: Mat3, p: Point): [number, number, number, number] {
  const w = projectiveW(H, p);
  const q = applyMat3(H, p);
  return [(H[0] - H[6] * q.x) / w, (H[1] - H[7] * q.x) / w, (H[3] - H[6] * q.y) / w, (H[4] - H[7] * q.y) / w];
}

/** Map a polygon through H. */
export function mapPolygon(H: Mat3, pts: Point[]): Point[] {
  return pts.map((p) => applyMat3(H, p));
}

/** True when the polygon is strictly convex with clockwise-on-screen (positive) orientation. */
export function isConvexClockwise(pts: Point[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(cr > 0)) return false;
  }
  return true;
}

/** Hermite smoothstep of t clamped to [0, 1]. */
export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
