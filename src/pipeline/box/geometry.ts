/**
 * Quad geometry for box detection: rotation of the corner labelling, perspective-aware aspect-ratio
 * estimation, rectified output size, and small helpers (angles, convexity, unit-square mapping).
 */
import { applyMat3, distance, findHomography, polygonSignedArea, type Mat3, type Point, type Quad } from '../../cv/geometry';
import { lineIntersection } from '../../cv/lines';

/**
 * Cyclic relabelling of the quad corners so that rectifying the result rotates the output image by
 * `quarterTurns` × 90° clockwise (negative = counter-clockwise). The corner positions are unchanged.
 */
export function rotateQuad(quad: Quad, quarterTurns: number): Quad {
  const k = ((Math.round(quarterTurns) % 4) + 4) % 4;
  return [0, 1, 2, 3].map((i) => ({ x: quad[(i - k + 4) % 4].x, y: quad[(i - k + 4) % 4].y })) as Quad;
}

/** Absolute area of a quad. */
export function quadArea(q: Quad): number {
  return Math.abs(polygonSignedArea(q));
}

/** Interior angles in degrees at TL, TR, BR, BL. */
export function quadAngles(q: Quad): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const ux = a.x - p.x, uy = a.y - p.y, vx = b.x - p.x, vy = b.y - p.y;
    const c = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    out.push((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
  }
  return out;
}

/** Side lengths top, right, bottom, left. */
export function quadSides(q: Quad): [number, number, number, number] {
  return [distance(q[0], q[1]), distance(q[1], q[2]), distance(q[2], q[3]), distance(q[3], q[0])];
}

/** True when the quad is strictly convex and clockwise on screen (TL, TR, BR, BL). */
export function isConvexClockwise(q: Point[]): boolean {
  const n = q.length;
  for (let i = 0; i < n; i++) {
    const a = q[i], b = q[(i + 1) % n], c = q[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(cross > 0)) return false;
  }
  return true;
}

/** Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto TL, TR, BR, BL. */
export function unitSquareToQuad(q: Quad): Mat3 | null {
  return findHomography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], q);
}

/** Map a quad with a point transform. */
export function mapQuad(q: Quad, f: (p: Point) => Point): Quad {
  return [f(q[0]), f(q[1]), f(q[2]), f(q[3])];
}

/** Rectangle [u0,u1]×[v0,v1] of unit-square coordinates mapped through `H` as a quad. */
export function subQuad(H: Mat3, u0: number, v0: number, u1: number, v1: number): Quad {
  return [
    applyMat3(H, { x: u0, y: v0 }),
    applyMat3(H, { x: u1, y: v0 }),
    applyMat3(H, { x: u1, y: v1 }),
    applyMat3(H, { x: u0, y: v1 }),
  ];
}

/** Largest corner displacement between two quads (same corner order). */
export function maxCornerDistance(a: Quad, b: Quad): number {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, distance(a[i], b[i]));
  return m;
}

/** Length of a quad's diagonal (mean of both diagonals). */
export function quadDiagonal(q: Quad): number {
  return (distance(q[0], q[2]) + distance(q[1], q[3])) / 2;
}

type V3 = [number, number, number];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Estimate the true width/height ratio of the rectangle seen as `quad` under perspective
 * (Zhang & He, "Whiteboard scanning and image enhancement", 2007). The principal point is assumed
 * at the projected rectangle centre (intersection of the diagonals) because the photo size is not
 * known here; the focal length is recovered from the two vanishing points when plausible, otherwise
 * a typical phone focal length (≈ 1.1 × the quad size) is assumed. Exact for a centred rectangle;
 * a box photographed off-centre adds a small error. For a parallelogram this reduces to the ratio
 * of the mean opposite side lengths.
 */
export function estimateQuadAspect(quad: Quad): number {
  const [tl, tr, br, bl] = quad;
  const sides = quadSides(quad);
  const scale = (sides[0] + sides[1] + sides[2] + sides[3]) / 4;
  const fallback = (sides[0] + sides[2]) / Math.max(1e-9, sides[1] + sides[3]);
  if (!(scale > 1e-9)) return 1;
  const c =
    lineIntersection(tl, { x: br.x - tl.x, y: br.y - tl.y }, tr, { x: bl.x - tr.x, y: bl.y - tr.y }) ??
    { x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4 };
  const h = (p: Point): V3 => [(p.x - c.x) / scale, (p.y - c.y) / scale, 1];
  // Zhang & He numbering: m1 = (0,0), m2 = (w,0), m3 = (0,h), m4 = (w,h).
  const m1 = h(tl), m2 = h(tr), m3 = h(bl), m4 = h(br);
  const c14 = cross3(m1, m4);
  const den2 = dot3(cross3(m2, m4), m3);
  const den3 = dot3(cross3(m3, m4), m2);
  if (Math.abs(den2) < 1e-12 || Math.abs(den3) < 1e-12) return fallback;
  const k2 = dot3(c14, m3) / den2;
  const k3 = dot3(c14, m2) / den3;
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  // Focal length (in units of the mean side length) from the orthogonality of the vanishing
  // directions; outside the plausible range of phone cameras (where the estimate is dominated by
  // the unknown principal point) a typical value is used instead.
  const DEFAULT_F2 = 1.1 * 1.1, MIN_F2 = 0.8 * 0.8, MAX_F2 = 3 * 3;
  let f2 = DEFAULT_F2;
  const zz = n2[2] * n3[2];
  if (Math.abs(zz) > 1e-9) {
    const est = -(n2[0] * n3[0] + n2[1] * n3[1]) / zz;
    if (Number.isFinite(est) && est >= MIN_F2 && est <= MAX_F2) f2 = est;
  }
  const num = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
  const den = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
  const a = Math.sqrt(num / den);
  return Number.isFinite(a) && a > 0 ? a : fallback;
}

/**
 * Output size for rectifying `quad`. With `aspect` (width / height, e.g. from the physical size)
 * the ratio is honoured exactly; otherwise it is estimated perspective-aware from the quad. The
 * pixel count roughly equals the quad's area in the photo (no significant upsampling), and the
 * longer side is capped at `maxSide`.
 */
export function suggestRectifiedSize(quad: Quad, aspect?: number, maxSide = 3000): { width: number; height: number } {
  const a = aspect !== undefined && Number.isFinite(aspect) && aspect > 0 ? aspect : estimateQuadAspect(quad);
  const area = Math.max(1, quadArea(quad));
  let w = Math.sqrt(area * a), h = Math.sqrt(area / a);
  const cap = Math.max(1, maxSide);
  const long = Math.max(w, h);
  if (long > cap) {
    w *= cap / long;
    h *= cap / long;
  }
  // Round while keeping the requested ratio as exact as integer sizes allow.
  if (w >= h) {
    const W = Math.max(1, Math.round(w));
    return { width: W, height: Math.max(1, Math.round(W / a)) };
  }
  const H = Math.max(1, Math.round(h));
  return { width: Math.max(1, Math.round(H * a)), height: H };
}
