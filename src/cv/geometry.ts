/**
 * 2-D geometry helpers: points, 3x3 matrices (row-major), homographies.
 *
 * Angles: radians unless a name ends in `Deg`. Because y points down in image coordinates, a
 * positive rotation angle is CLOCKWISE on screen. `rotate(θ)` = [[cos θ, -sin θ], [sin θ, cos θ]].
 */

export interface Point {
  x: number;
  y: number;
}

/** Four corners, ordered top-left, top-right, bottom-right, bottom-left (clockwise on screen). */
export type Quad = [Point, Point, Point, Point];

/** Row-major 3x3 matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
export type Mat3 = number[];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

/** Compose transforms applied in order: first `ms[0]`, then `ms[1]`, ... */
export function composeTransforms(...ms: Mat3[]): Mat3 {
  let r = IDENTITY;
  for (const m of ms) r = mat3Multiply(m, r);
  return r;
}

export function mat3Invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('mat3Invert: singular matrix');
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export function applyMat3(m: Mat3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

export function translation(tx: number, ty: number): Mat3 {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function scaling(sx: number, sy = sx): Mat3 {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

/** Rotation about the origin; positive = clockwise on screen. */
export function rotation(theta: number): Mat3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * Similarity transform that maps point `from` to point `to`, rotating by `theta` (clockwise) and
 * scaling by `scale` around `from`.
 */
export function similarityAbout(from: Point, to: Point, theta: number, scale: number): Mat3 {
  return composeTransforms(translation(-from.x, -from.y), rotation(theta), scaling(scale), translation(to.x, to.y));
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Solve the n x n system A x = b in place (Gaussian elimination, partial pivoting). Returns null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) [M[piv], M[col]] = [M[col], M[piv]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function normalizationTransform(pts: Point[]): Mat3 {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/**
 * Homography H with H * src[i] ≈ dst[i]. Exact for 4 points, least squares (normalized DLT with
 * h22 = 1) for more. Returns null for degenerate configurations.
 */
export function findHomography(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length !== dst.length || src.length < 4) return null;
  const T1 = normalizationTransform(src);
  const T2 = normalizationTransform(dst);
  const s = src.map((p) => applyMat3(T1, p));
  const d = dst.map((p) => applyMat3(T2, p));
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
      Atb[i] += row[i] * rhs;
    }
  };
  for (let i = 0; i < s.length; i++) {
    const { x, y } = s[i];
    const { x: u, y: v } = d[i];
    addRow([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    addRow([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  const Hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  let H: Mat3;
  try {
    H = mat3Multiply(mat3Invert(T2), mat3Multiply(Hn, T1));
  } catch {
    return null;
  }
  const n = H[8];
  if (Math.abs(n) < 1e-15) return null;
  return H.map((v) => v / n);
}

/** Least-squares 2-D affine transform (as Mat3) with A * src[i] ≈ dst[i]. Needs >= 3 points. */
export function findAffine(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length !== dst.length || src.length < 3) return null;
  const AtA: number[][] = Array.from({ length: 3 }, () => [0, 0, 0]);
  const bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < src.length; i++) {
    const r = [src[i].x, src[i].y, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) AtA[a][b] += r[a] * r[b];
      bx[a] += r[a] * dst[i].x;
      by[a] += r[a] * dst[i].y;
    }
  }
  const px = solveLinear(AtA, bx);
  const py = solveLinear(AtA, by);
  if (!px || !py) return null;
  return [px[0], px[1], px[2], py[0], py[1], py[2], 0, 0, 1];
}

/**
 * Least-squares similarity transform (rotation + uniform scale + translation), Umeyama-style.
 * Returns the matrix plus the decomposed parameters (theta clockwise, radians).
 */
export function findSimilarity(src: Point[], dst: Point[]): { matrix: Mat3; theta: number; scale: number } | null {
  const n = src.length;
  if (n !== dst.length || n < 2) return null;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x - sx, py = src[i].y - sy;
    const qx = dst[i].x - dx, qy = dst[i].y - dy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    ss += px * px + py * py;
  }
  if (ss < 1e-12) return null;
  const theta = Math.atan2(b, a);
  const scale = Math.hypot(a, b) / ss;
  const c = Math.cos(theta) * scale, s = Math.sin(theta) * scale;
  const matrix: Mat3 = [c, -s, dx - (c * sx - s * sy), s, c, dy - (s * sx + c * sy), 0, 0, 1];
  return { matrix, theta, scale };
}

/** Polygon area (shoelace). Positive for clockwise-on-screen (y down) vertex order. */
export function polygonSignedArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

/**
 * Order four arbitrary points as TL, TR, BR, BL (clockwise on screen) — the convention of {@link Quad}.
 */
export function orderQuad(pts: Point[]): Quad {
  if (pts.length !== 4) throw new Error('orderQuad: need 4 points');
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = [...pts].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  // atan2 ascending with y down goes clockwise on screen starting near "left" (-pi). Rotate so the
  // point with smallest x + y (top-left) is first.
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const v = sorted[i].x + sorted[i].y;
    if (v < best) { best = v; start = i; }
  }
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]) as Quad;
}
