/**
 * Synthetic test data: classic jigsaw cuts of a reference picture, photos of loose pieces / assembled
 * patches with ground truth, and photos of a puzzle box. Pure TypeScript, no DOM, deterministic for
 * a given seed. Used by the tests of several pipeline packages.
 */
import { applyMat3, findHomography, rotation, similarityAbout, type Mat3, type Point, type Quad } from '../cv/geometry';
import { createFloat, createMask, createRGBA, type FloatImage, type Mask, type RGBAImage, type Rect } from '../cv/image';
import { gaussianBlurFloat } from '../cv/filter';
import { fillPolygon } from '../cv/raster';
import { sampleRGBA, warpRGBA } from '../cv/warp';
import { SIDE_PROFILE_SAMPLES, type PieceKind, type PieceShape, type SideKind, type SideShape } from '../model/types';

// ---------------------------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------------------------

/** Small deterministic PRNG (mulberry32); returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper around {@link mulberry32}. */
export class Rng {
  private readonly next: () => number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Uniform in [0, 1). */
  random(): number {
    return this.next();
  }
  /** Uniform in [a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
  /** Standard normal (Box–Muller). */
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
  /** Fisher–Yates shuffled copy. */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ---------------------------------------------------------------------------------------------
// Jigsaw cut
// ---------------------------------------------------------------------------------------------

export interface JigsawPiece {
  index: number;
  row: number;
  col: number;
  /** Dense outline polygon in reference coordinates, clockwise on screen, starting at corners[0]. */
  outline: Point[];
  /** The 4 body corners TL, TR, BR, BL (reference coordinates). */
  corners: Quad;
  /** Side kinds top, right, bottom, left ('flat' | 'tab' | 'blank'). */
  sides: [SideKind, SideKind, SideKind, SideKind];
  /** Dense side paths; side i runs corners[i] -> corners[(i + 1) % 4] (both included). */
  sidePaths: [Point[], Point[], Point[], Point[]];
}

export interface JigsawCut {
  rows: number;
  cols: number;
  width: number;
  height: number;
  pieces: JigsawPiece[];
}

/**
 * Reference coordinates follow the pixel-center convention: the picture spans
 * [-0.5, width - 0.5] x [-0.5, height - 0.5] and cell (r, c) spans
 * [c·W/cols - 0.5, (c+1)·W/cols - 0.5] x [r·H/rows - 0.5, (r+1)·H/rows - 0.5].
 */
export function cellCenter(cut: { rows: number; cols: number; width: number; height: number }, row: number, col: number): Point {
  return { x: ((col + 0.5) * cut.width) / cut.cols - 0.5, y: ((row + 0.5) * cut.height) / cut.rows - 0.5 };
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/**
 * Edge path from A to B in edge-local (u along, v perpendicular, units of edge length) coordinates,
 * then mapped. `bulge` = +1/-1 selects the knob side along n = (-d.y, d.x) (d = unit A->B), 0 = flat.
 */
function edgePath(A: Point, B: Point, bulge: number, rng: Rng): Point[] {
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const d = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
  const n = { x: -d.y, y: d.x };
  const map = (u: number, v: number): Point => ({ x: A.x + d.x * u * L + n.x * v * L, y: A.y + d.y * u * L + n.y * v * L });
  if (bulge === 0) {
    const pts: Point[] = [];
    const N = 16;
    for (let i = 0; i <= N; i++) pts.push(map(i / N, 0));
    return pts;
  }
  // Classic knob made of three cubic Béziers (after Draradech's jigsaw generator).
  const j = 0.035;
  const t = rng.uniform(0.09, 0.112);
  const a = rng.uniform(-j, j), b = rng.uniform(-j, j), c = rng.uniform(-j, j), dd = rng.uniform(-j, j), e = rng.uniform(-j, j);
  const P = (u: number, v: number): Point => ({ x: u, y: v * bulge });
  const p = [
    P(0, 0), P(0.2, a), P(0.5 + b + dd, -t + c), P(0.5 - t + b, t + c),
    P(0.5 - 2 * t + b - dd, 3 * t + c), P(0.5 + 2 * t + b - dd, 3 * t + c), P(0.5 + t + b, t + c),
    P(0.5 + b + dd, -t + c), P(0.8, e), P(1, 0),
  ];
  const w1 = rng.uniform(-0.018, 0.018), w2 = rng.uniform(-0.01, 0.01);
  const wave = (u: number) => w1 * Math.sin(Math.PI * u) + w2 * Math.sin(2 * Math.PI * u);
  const pts: Point[] = [];
  const S = 18;
  for (let seg = 0; seg < 3; seg++) {
    for (let i = seg === 0 ? 0 : 1; i <= S; i++) {
      const q = cubic(p[seg * 3], p[seg * 3 + 1], p[seg * 3 + 2], p[seg * 3 + 3], i / S);
      pts.push(map(q.x, q.y + wave(q.x)));
    }
  }
  pts[0] = { ...A };
  pts[pts.length - 1] = { ...B };
  return pts;
}

/**
 * Classic grid cut in reference coordinates: jittered grid corners, gently wavy edges, one knob per
 * interior edge (random direction and shape), flat border edges. Deterministic for a seed.
 */
export function generateJigsaw(rows: number, cols: number, width: number, height: number, seed: number): JigsawCut {
  const rng = new Rng(seed);
  const cw = width / cols, ch = height / rows;
  const jit = 0.07;
  const corners: Point[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: Point[] = [];
    for (let c = 0; c <= cols; c++) {
      const jx = c === 0 || c === cols ? 0 : rng.uniform(-jit, jit) * cw;
      const jy = r === 0 || r === rows ? 0 : rng.uniform(-jit, jit) * ch;
      line.push({ x: c * cw - 0.5 + jx, y: r * ch - 0.5 + jy });
    }
    corners.push(line);
  }
  // Horizontal edges H[r][c]: corner(r,c) -> corner(r,c+1); n points down. bulge +1 = into row r.
  const hEdges: { path: Point[]; bulge: number }[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: { path: Point[]; bulge: number }[] = [];
    for (let c = 0; c < cols; c++) {
      const bulge = r === 0 || r === rows ? 0 : rng.bool() ? 1 : -1;
      line.push({ path: edgePath(corners[r][c], corners[r][c + 1], bulge, rng), bulge });
    }
    hEdges.push(line);
  }
  // Vertical edges V[r][c]: corner(r,c) -> corner(r+1,c); n points left. bulge +1 = into col c-1.
  const vEdges: { path: Point[]; bulge: number }[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: { path: Point[]; bulge: number }[] = [];
    for (let c = 0; c <= cols; c++) {
      const bulge = c === 0 || c === cols ? 0 : rng.bool() ? 1 : -1;
      line.push({ path: edgePath(corners[r][c], corners[r + 1][c], bulge, rng), bulge });
    }
    vEdges.push(line);
  }
  const pieces: JigsawPiece[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const top = hEdges[r][c], bottom = hEdges[r + 1][c], left = vEdges[r][c], right = vEdges[r][c + 1];
      // A knob bulging into this piece is a blank; bulging away is a tab.
      const kind = (bulge: number, intoThis: number): SideKind => (bulge === 0 ? 'flat' : bulge === intoThis ? 'blank' : 'tab');
      const sides: [SideKind, SideKind, SideKind, SideKind] = [
        kind(top.bulge, 1),
        kind(right.bulge, 1),
        kind(bottom.bulge, -1),
        kind(left.bulge, -1),
      ];
      const sidePaths: [Point[], Point[], Point[], Point[]] = [
        top.path.map((p) => ({ ...p })),
        right.path.map((p) => ({ ...p })),
        [...bottom.path].reverse().map((p) => ({ ...p })),
        [...left.path].reverse().map((p) => ({ ...p })),
      ];
      const outline: Point[] = [];
      for (const sp of sidePaths) for (let i = 0; i < sp.length - 1; i++) outline.push(sp[i]);
      pieces.push({
        index: r * cols + c,
        row: r,
        col: c,
        outline,
        corners: [{ ...corners[r][c] }, { ...corners[r][c + 1] }, { ...corners[r + 1][c + 1] }, { ...corners[r + 1][c] }],
        sides,
        sidePaths,
      });
    }
  }
  return { rows, cols, width, height, pieces };
}

/** Kind of a piece from its side kinds. */
export function pieceKindOf(sides: readonly SideKind[]): PieceKind {
  const flats = sides.filter((s) => s === 'flat').length;
  return flats >= 2 ? 'corner' : flats === 1 ? 'edge' : 'interior';
}

/**
 * Outer outline (reference coordinates, clockwise) of a set of 4-connected pieces, built by removing
 * the shared edges. Throws when the pieces do not form one simply connected patch.
 */
export function patchOutline(cut: JigsawCut, indices: readonly number[]): Point[] {
  if (indices.length === 1) return cut.pieces[indices[0]].outline.map((p) => ({ ...p }));
  const cid = (r: number, c: number) => r * (cut.cols + 1) + c;
  interface Side { from: number; to: number; path: Point[] }
  const sides: Side[] = [];
  for (const idx of indices) {
    const p = cut.pieces[idx];
    const { row: r, col: c } = p;
    const ids = [cid(r, c), cid(r, c + 1), cid(r + 1, c + 1), cid(r + 1, c)];
    for (let s = 0; s < 4; s++) sides.push({ from: ids[s], to: ids[(s + 1) % 4], path: p.sidePaths[s] });
  }
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const count = new Map<string, number>();
  for (const s of sides) count.set(key(s.from, s.to), (count.get(key(s.from, s.to)) ?? 0) + 1);
  const outer = sides.filter((s) => count.get(key(s.from, s.to)) === 1);
  const byStart = new Map<number, Side>();
  for (const s of outer) {
    if (byStart.has(s.from)) throw new Error('patchOutline: patch is not simply connected');
    byStart.set(s.from, s);
  }
  const out: Point[] = [];
  let cur = outer[0];
  for (let n = 0; n < outer.length; n++) {
    for (let i = 0; i < cur.path.length - 1; i++) out.push({ ...cur.path[i] });
    const next = byStart.get(cur.to);
    if (!next) throw new Error('patchOutline: open outline');
    cur = next;
    if (cur === outer[0]) {
      if (n !== outer.length - 1) throw new Error('patchOutline: pieces are not connected');
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Photo of loose pieces
// ---------------------------------------------------------------------------------------------

export type RGB = [number, number, number];

export interface RenderOptions {
  /** Photo size; when omitted it is chosen automatically to fit all items. */
  width?: number;
  height?: number;
  /** Background colour (default dark blue-gray). */
  background?: RGB;
  /** Amplitude (0..255 units) of a smooth random background texture (default 0). */
  backgroundTexture?: number;
  /** Photo px per reference px; a range picks a random scale per item. Default: body ≈ 90 px. */
  scale?: number | [number, number];
  /** Rotation of each item: 'any' (default), 'quarter' (multiples of 90°), 'none', or fixed degrees. */
  rotation?: 'none' | 'quarter' | 'any' | number;
  /** Minimum gap between items in photo px (default 14). */
  margin?: number;
  /** Per-channel gain (white balance / exposure); a number applies to all channels. Default 1. */
  gain?: number | RGB;
  /** Per-channel offset; default 0. */
  offset?: number | RGB;
  /** Strength of a smooth illumination gradient, e.g. 0.2 = ±20 % (default 0). */
  illumination?: number;
  /** Gaussian sensor noise sigma (0..255 units, default 0). */
  noiseSigma?: number;
  /** Gaussian optical blur sigma in photo px (default 0). */
  blurSigma?: number;
  /** Darkening of piece edges (cardboard rim), 0..1 (default 0.45). */
  edgeDarkening?: number;
  /** Width of the dark rim in photo px (default 1.4). */
  edgeWidth?: number;
  /** Drop shadow strength 0..1 (default 0.3). */
  shadow?: number;
  /** Supersampling per axis for anti-aliased borders (default 4). */
  supersample?: number;
  seed?: number;
}

export interface PieceTruth {
  /** Piece indices of this item (single piece or assembled patch); first = anchor. */
  pieces: number[];
  /** Cell of the anchor piece. */
  row: number;
  col: number;
  /** Body center of the anchor piece in photo coordinates. */
  center: Point;
  /** Clockwise rotation (deg, [0, 360)) that turns the item as photographed into upright. */
  rotationDeg: number;
  /** Anchor piece body corners in the photo, in reference TL, TR, BR, BL order. */
  corners: Quad;
  /** Outer outline in photo coordinates (clockwise). */
  outline: Point[];
  bbox: Rect;
  /** Similarity mapping reference coordinates to photo coordinates. */
  transform: Mat3;
  /** Photo px per reference px. */
  scale: number;
}

function toRGB(v: number | RGB | undefined, def: number): RGB {
  if (v === undefined) return [def, def, def];
  return typeof v === 'number' ? [v, v, v] : v;
}

/** Bilinear value noise on a coarse lattice (smooth texture), values roughly -1..1. */
function smoothNoise(width: number, height: number, cell: number, rng: Rng): Float32Array {
  const gw = Math.ceil(width / cell) + 2, gh = Math.ceil(height / cell) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rng.uniform(-1, 1);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = y / cell, y0 = Math.floor(gy), fy = gy - y0;
    const sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < width; x++) {
      const gx = x / cell, x0 = Math.floor(gx), fx = gx - x0;
      const sx = fx * fx * (3 - 2 * fx);
      const a = g[y0 * gw + x0], b = g[y0 * gw + x0 + 1], c = g[(y0 + 1) * gw + x0], d = g[(y0 + 1) * gw + x0 + 1];
      out[y * width + x] = (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    }
  }
  return out;
}

/** 3-4 chamfer distance (in px) from every pixel to the nearest seed pixel. */
function chamfer(width: number, height: number, seed: (i: number) => boolean): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = seed(i) ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - width] + a);
        if (x > 0) v = Math.min(v, d[i - width - 1] + b);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i];
      if (x < width - 1) v = Math.min(v, d[i + 1] + a);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + a);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + b);
        if (x > 0) v = Math.min(v, d[i + width - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

function boundsOf(pts: readonly Point[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function finishPhoto(scene: FloatImage, rng: Rng, opts: RenderOptions): RGBAImage {
  const { width: W, height: H } = scene;
  const gain = toRGB(opts.gain, 1);
  const offset = toRGB(opts.offset, 0);
  const illum = opts.illumination ?? 0;
  const ang = rng.uniform(0, 2 * Math.PI);
  const ax = Math.cos(ang), ay = Math.sin(ang), q = rng.uniform(-0.5, 0.5);
  const s = scene.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W - 0.5, v = y / H - 0.5;
      const f = 1 + illum * (ax * u + ay * v) * 2 + illum * q * (u * u + v * v) * 2;
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) s[o + c] = s[o + c] * gain[c] * f + offset[c];
    }
  }
  const blurred = opts.blurSigma && opts.blurSigma > 0 ? gaussianBlurFloat(scene, opts.blurSigma) : scene;
  const sigma = opts.noiseSigma ?? 0;
  const out = createRGBA(W, H);
  const b = blurred.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    for (let c = 0; c < 3; c++) out.data[p + c] = b[i * 3 + c] + (sigma > 0 ? sigma * rng.normal() : 0);
    out.data[p + 3] = 255;
  }
  return out;
}

/**
 * Render a photo of loose pieces / assembled patches lying on a table. Each entry of `pieces` is a
 * piece index or an array of adjacent piece indices (rendered as one rigid patch; first = anchor).
 * Items never overlap; throws when they cannot be placed.
 */
export function renderPiecesPhoto(
  reference: RGBAImage,
  cut: JigsawCut,
  pieces: (number | number[])[],
  opts: RenderOptions = {},
): { photo: RGBAImage; truth: PieceTruth[] } {
  const rng = new Rng(opts.seed ?? 1);
  const cellSize = (cut.width / cut.cols + cut.height / cut.rows) / 2;
  const defScale = 90 / cellSize;
  const margin = opts.margin ?? 14;
  const ss = Math.max(1, Math.round(opts.supersample ?? 4));
  const refScaleX = reference.width / cut.width, refScaleY = reference.height / cut.height;

  interface Item {
    indices: number[];
    refOutlines: Point[][];
    union: Point[];
    pivot: Point;
    theta: number;
    scale: number;
    local: { x0: number; y0: number; x1: number; y1: number };
    pos?: Point;
  }
  const items: Item[] = pieces.map((entry) => {
    const indices = Array.isArray(entry) ? entry : [entry];
    const union = patchOutline(cut, indices);
    let px = 0, py = 0;
    for (const i of indices) for (const c of cut.pieces[i].corners) { px += c.x; py += c.y; }
    const pivot = { x: px / (4 * indices.length), y: py / (4 * indices.length) };
    const rot = opts.rotation ?? 'any';
    const deg = typeof rot === 'number' ? rot : rot === 'none' ? 0 : rot === 'quarter' ? 90 * rng.int(4) : rng.uniform(0, 360);
    const sc = opts.scale === undefined ? defScale : typeof opts.scale === 'number' ? opts.scale : rng.uniform(opts.scale[0], opts.scale[1]);
    const theta = (deg * Math.PI) / 180;
    const T = similarityAbout(pivot, { x: 0, y: 0 }, theta, sc);
    const local = boundsOf(union.map((p) => applyMat3(T, p)));
    return { indices, refOutlines: indices.map((i) => cut.pieces[i].outline), union, pivot, theta, scale: sc, local };
  });

  // Placement (random, non-overlapping axis-aligned boxes with margin).
  const place = (W: number, H: number): boolean => {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const it of items) {
      const w = it.local.x1 - it.local.x0, h = it.local.y1 - it.local.y0;
      let ok = false;
      for (let attempt = 0; attempt < 3000 && !ok; attempt++) {
        const x0 = rng.uniform(margin, W - margin - w);
        const y0 = rng.uniform(margin, H - margin - h);
        if (!(x0 >= margin && y0 >= margin)) break;
        const box = { x0, y0, x1: x0 + w, y1: y0 + h };
        if (placed.some((b) => box.x0 < b.x1 + margin && box.x1 + margin > b.x0 && box.y0 < b.y1 + margin && box.y1 + margin > b.y0)) continue;
        placed.push(box);
        it.pos = { x: x0 - it.local.x0, y: y0 - it.local.y0 };
        ok = true;
      }
      if (!ok) return false;
    }
    return true;
  };
  let W = opts.width, H = opts.height;
  if (W !== undefined && H !== undefined) {
    if (!place(W, H)) throw new Error(`renderPiecesPhoto: cannot place ${items.length} items in ${W}x${H}`);
  } else {
    let area = 0;
    for (const it of items) area += (it.local.x1 - it.local.x0 + margin) * (it.local.y1 - it.local.y0 + margin);
    let side = Math.sqrt(area * 2.4);
    for (let tries = 0; ; tries++) {
      W = opts.width ?? Math.ceil(side * 1.15);
      H = opts.height ?? Math.ceil(side / 1.15);
      if (place(W, H)) break;
      if (tries > 40) throw new Error('renderPiecesPhoto: cannot place items');
      side *= 1.08;
    }
  }
  const PW = W, PH = H;

  // Scene in float sRGB.
  const scene = createFloat(PW, PH, 3);
  const bg = opts.background ?? [38, 42, 50];
  const tex = opts.backgroundTexture ?? 0;
  const noiseA = tex > 0 ? smoothNoise(PW, PH, 60, rng) : null;
  const noiseB = tex > 0 ? smoothNoise(PW, PH, 9, rng) : null;
  for (let i = 0; i < PW * PH; i++) {
    const t = noiseA && noiseB ? tex * (0.7 * noiseA[i] + 0.3 * noiseB[i]) : 0;
    scene.data[i * 3] = bg[0] + t;
    scene.data[i * 3 + 1] = bg[1] + t;
    scene.data[i * 3 + 2] = bg[2] + t;
  }

  const truth: PieceTruth[] = [];
  const shadowStrength = opts.shadow ?? 0.3;
  const edgeDark = opts.edgeDarkening ?? 0.45;
  const edgeW = opts.edgeWidth ?? 1.4;
  const px = [0, 0, 0, 0];
  const renders: { bx: number; by: number; bw: number; bh: number; cov: Float32Array; label: Int32Array; T: Mat3; Tinv: Mat3 }[] = [];

  for (const it of items) {
    const pos = it.pos!;
    const T = similarityAbout(it.pivot, pos, it.theta, it.scale);
    const Tinv = similarityAbout(pos, it.pivot, -it.theta, 1 / it.scale);
    const photoOutlines = it.refOutlines.map((o) => o.map((p) => applyMat3(T, p)));
    const ub = boundsOf(photoOutlines.flat());
    const bx = Math.max(0, Math.floor(ub.x0) - 4), by = Math.max(0, Math.floor(ub.y0) - 4);
    const bw = Math.min(PW, Math.ceil(ub.x1) + 5) - bx, bh = Math.min(PH, Math.ceil(ub.y1) + 5) - by;
    // Supersampled coverage and per-pixel piece label.
    const cov = new Float32Array(bw * bh);
    const label = new Int32Array(bw * bh).fill(-1);
    const ssMask: Mask = createMask(bw * ss, bh * ss);
    photoOutlines.forEach((o, k) => {
      ssMask.data.fill(0);
      fillPolygon(ssMask, o.map((p) => ({ x: (p.x - bx + 0.5) * ss - 0.5, y: (p.y - by + 0.5) * ss - 0.5 })), 1);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          let n = 0;
          for (let sy = 0; sy < ss; sy++) {
            const row = (y * ss + sy) * bw * ss + x * ss;
            for (let sx = 0; sx < ss; sx++) n += ssMask.data[row + sx];
          }
          if (n === 0) continue;
          const i = y * bw + x;
          cov[i] = Math.min(1, cov[i] + n / (ss * ss));
          if (n * 2 >= ss * ss) label[i] = k;
        }
      }
    });
    renders.push({ bx, by, bw, bh, cov, label, T, Tinv });

    const anchor = cut.pieces[it.indices[0]];
    const corners = anchor.corners.map((p) => applyMat3(T, p)) as Quad;
    const center = { x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4, y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4 };
    const outline = it.union.map((p) => applyMat3(T, p));
    const ob = boundsOf(outline);
    const deg = (it.theta * 180) / Math.PI;
    truth.push({
      pieces: [...it.indices],
      row: anchor.row,
      col: anchor.col,
      center,
      rotationDeg: (((-deg % 360) + 360) % 360) % 360,
      corners,
      outline,
      bbox: { x: Math.floor(ob.x0), y: Math.floor(ob.y0), width: Math.ceil(ob.x1) - Math.floor(ob.x0) + 1, height: Math.ceil(ob.y1) - Math.floor(ob.y0) + 1 },
      transform: T,
      scale: it.scale,
    });
  }

  // Drop shadows (soft, offset down-right) on the background.
  if (shadowStrength > 0) {
    const sh = new Float32Array(PW * PH);
    const off = 2;
    for (const r of renders) {
      for (let y = 0; y < r.bh; y++) {
        for (let x = 0; x < r.bw; x++) {
          const X = r.bx + x + off, Y = r.by + y + off;
          if (X < PW && Y < PH) sh[Y * PW + X] = Math.max(sh[Y * PW + X], r.cov[y * r.bw + x]);
        }
      }
    }
    const blurred = gaussianBlurFloat({ width: PW, height: PH, channels: 1, data: sh }, 2.2).data;
    for (let i = 0; i < PW * PH; i++) {
      const f = 1 - shadowStrength * blurred[i];
      scene.data[i * 3] *= f;
      scene.data[i * 3 + 1] *= f;
      scene.data[i * 3 + 2] *= f;
    }
  }

  // Pieces.
  for (const r of renders) {
    const { bw, bh, cov, label } = r;
    // Distance to the outer boundary and to seams between pieces of a patch.
    const dOut = chamfer(bw, bh, (i) => label[i] < 0);
    const dSeam = chamfer(bw, bh, (i) => {
      if (label[i] < 0) return false;
      const x = i % bw, y = (i - x) / bw;
      return (x > 0 && label[i - 1] >= 0 && label[i - 1] !== label[i]) || (y > 0 && label[i - bw] >= 0 && label[i - bw] !== label[i]);
    });
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        const a = cov[i];
        if (a <= 0) continue;
        const X = r.bx + x, Y = r.by + y;
        const p = applyMat3(r.Tinv, { x: X, y: Y });
        if (!sampleRGBA(reference, (p.x + 0.5) * refScaleX - 0.5, (p.y + 0.5) * refScaleY - 0.5, px)) {
          const cx = Math.min(reference.width - 1, Math.max(0, p.x)), cy = Math.min(reference.height - 1, Math.max(0, p.y));
          sampleRGBA(reference, cx, cy, px);
        }
        const de = Math.max(0, dOut[i] - 0.5);
        const ds = dSeam[i];
        let f = 1 - edgeDark * Math.exp(-(de * de) / (2 * edgeW * edgeW));
        if (ds < 1e8) f *= 1 - 0.5 * edgeDark * Math.exp(-(ds * ds) / (2 * 0.8 * 0.8));
        const o = (Y * PW + X) * 3;
        for (let c = 0; c < 3; c++) scene.data[o + c] = scene.data[o + c] * (1 - a) + a * px[c] * f;
      }
    }
  }

  return { photo: finishPhoto(scene, rng, opts), truth };
}

// ---------------------------------------------------------------------------------------------
// Ground-truth piece shape (for matcher tests; mirrors the PieceShape contract)
// ---------------------------------------------------------------------------------------------

/**
 * Side profile per the {@link SideShape} contract: perpendicular deviation of `path` (start corner
 * -> end corner, clockwise contour) from its baseline at evenly spaced baseline positions, divided by
 * the length; positive = outward. Where the contour overhangs, the most extreme deviation is used.
 */
export function sideProfile(path: readonly Point[], samples = SIDE_PROFILE_SAMPLES): { length: number; profile: number[] } {
  const A = path[0], B = path[path.length - 1];
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const d = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
  const nOut = { x: d.y, y: -d.x };
  const u = path.map((p) => ((p.x - A.x) * d.x + (p.y - A.y) * d.y) / L);
  const v = path.map((p) => ((p.x - A.x) * nOut.x + (p.y - A.y) * nOut.y) / L);
  const profile: number[] = [];
  for (let k = 0; k < samples; k++) {
    const t = k / (samples - 1);
    let best = 0, found = false;
    for (let i = 0; i + 1 < path.length; i++) {
      const u0 = u[i], u1 = u[i + 1];
      if ((u0 <= t && u1 >= t) || (u1 <= t && u0 >= t)) {
        const f = u1 === u0 ? 0 : (t - u0) / (u1 - u0);
        const val = v[i] + f * (v[i + 1] - v[i]);
        if (!found || Math.abs(val) > Math.abs(best)) best = val;
        found = true;
      }
    }
    profile.push(best);
  }
  return { length: L, profile };
}

/**
 * Build the PieceShape a perfect shape analyser would report for a rendered single piece, following
 * the PieceShape conventions (local frame from the photo, not from the upright orientation).
 */
export function truthPieceShape(cut: JigsawCut, truth: PieceTruth, confidence = 1): PieceShape {
  const piece = cut.pieces[truth.pieces[0]];
  const tc = truth.corners;
  const theta = (Math.atan2(tc[1].y - tc[0].y, tc[1].x - tc[0].x) * 180) / Math.PI; // direction of the true top side
  // k quarter turns clockwise: local corner i = true corner (i - k) mod 4.
  let k = Math.round(theta / 90);
  let angle = theta - 90 * k;
  if (angle <= -45) { angle += 90; k -= 1; }
  if (angle > 45) { angle -= 90; k += 1; }
  k = ((k % 4) + 4) % 4;
  const idx = (i: number) => (((i - k) % 4) + 4) % 4;
  const corners = [0, 1, 2, 3].map((i) => ({ ...tc[idx(i)] })) as [Point, Point, Point, Point];
  const sides = [0, 1, 2, 3].map((i): SideShape => {
    const j = idx(i);
    const path = piece.sidePaths[j].map((p) => applyMat3(truth.transform, p));
    const { length, profile } = sideProfile(path);
    return { kind: piece.sides[j], length, profile };
  }) as [SideShape, SideShape, SideShape, SideShape];
  const bodySize = sides.reduce((s, x) => s + x.length, 0) / 4;
  return { corners, sides, angleDeg: angle, bodySize, center: { ...truth.center }, kind: pieceKindOf(piece.sides), confidence };
}

// ---------------------------------------------------------------------------------------------
// Box photo
// ---------------------------------------------------------------------------------------------

export interface BoxPhotoOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** Colour of the lid frame around the picture (default random saturated colour). */
  lidColor?: RGB;
  /** Frame width as a fraction of the picture width (default 0.06; 0 = picture covers the lid). */
  frameWidth?: number;
  /** Perspective strength: random corner displacement as a fraction of the lid size (default 0.06). */
  perspective?: number;
  /** Table: 'wood' (default), 'plain' or a colour. */
  background?: 'wood' | 'plain' | RGB;
  noiseSigma?: number;
  blurSigma?: number;
  gain?: number | RGB;
  illumination?: number;
}

/**
 * Render a photo of the puzzle box lid: the picture inside a coloured frame with a few logo/text
 * blocks, on a table, with perspective distortion, lighting and noise. Quads are outer corners
 * (TL, TR, BR, BL) in photo coordinates, compatible with `rectifyQuad`.
 */
export function renderBoxPhoto(reference: RGBAImage, opts: BoxPhotoOptions = {}): { photo: RGBAImage; pictureQuad: Quad; lidQuad: Quad } {
  const rng = new Rng(opts.seed ?? 7);
  const W = opts.width ?? 1600, H = opts.height ?? 1200;
  const pw = reference.width, ph = reference.height;
  const f = Math.round((opts.frameWidth ?? 0.06) * pw);
  const fb = Math.round(f * 1.6);
  const lw = pw + 2 * f, lh = ph + f + fb;
  const hue = rng.uniform(0, 1);
  const lidColor: RGB = opts.lidColor ?? hsvToRgb(hue, rng.uniform(0.5, 0.85), rng.uniform(0.45, 0.8));
  const lid = createRGBA(lw, lh, [lidColor[0], lidColor[1], lidColor[2], 255]);
  const fillRect = (x: number, y: number, w: number, h: number, c: RGB) => {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(lh, Math.round(y + h)); yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(lw, Math.round(x + w)); xx++) {
        const o = (yy * lw + xx) * 4;
        lid.data[o] = c[0];
        lid.data[o + 1] = c[1];
        lid.data[o + 2] = c[2];
      }
    }
  };
  if (f > 4) {
    // Logo block, a "piece count" badge and lines of "text" on the frame.
    const contrast: RGB = [255 - lidColor[0], 255 - lidColor[1], 255 - lidColor[2]];
    fillRect(f * 0.8, lh - fb * 0.85, f * 3.2, fb * 0.7, [250, 250, 245]);
    fillRect(f * 1.0, lh - fb * 0.7, f * 2.8, fb * 0.4, [200, 30, 40]);
    fillRect(lw - f * 4.5, lh - fb * 0.85, f * 3.5, fb * 0.7, contrast);
    for (let line = 0; line < 2; line++) {
      let x = f * 5;
      const y = lh - fb * 0.8 + line * fb * 0.38;
      while (x < lw - f * 6) {
        const w = rng.uniform(0.3, 1.4) * f;
        fillRect(x, y, w, fb * 0.22, [20, 20, 25]);
        x += w + f * 0.3;
      }
    }
    fillRect(lw * 0.4, f * 0.25, lw * 0.2, f * 0.5, [245, 240, 230]);
  }
  for (let y = 0; y < ph; y++) lid.data.set(reference.data.subarray(y * pw * 4, (y + 1) * pw * 4), ((y + f) * lw + f) * 4);

  // Target lid quad in the photo.
  const fit = Math.min((W * 0.78) / lw, (H * 0.78) / lh) * rng.uniform(0.9, 1.0);
  const cx = W / 2 + rng.uniform(-0.05, 0.05) * W, cy = H / 2 + rng.uniform(-0.05, 0.05) * H;
  const rot = (rng.uniform(-7, 7) * Math.PI) / 180;
  const persp = opts.perspective ?? 0.06;
  const R = rotation(rot);
  const size = Math.max(lw, lh) * fit;
  // Perspective: a tilted lid makes one edge shorter than the opposite one, plus random jitter.
  const tiltX = rng.uniform(-1, 1) * persp, tiltY = rng.uniform(-1, 1) * persp;
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const lidQuad = signs.map(([sx, sy]) => {
    const x = ((sx * lw) / 2) * fit * (1 + sy * tiltY) + rng.uniform(-0.2, 0.2) * persp * size;
    const y = ((sy * lh) / 2) * fit * (1 + sx * tiltX) + rng.uniform(-0.2, 0.2) * persp * size;
    const p = applyMat3(R, { x, y });
    return { x: cx + p.x, y: cy + p.y };
  }) as Quad;
  const lidCorners = [{ x: -0.5, y: -0.5 }, { x: lw - 0.5, y: -0.5 }, { x: lw - 0.5, y: lh - 0.5 }, { x: -0.5, y: lh - 0.5 }];
  const Hm = findHomography(lidCorners, lidQuad);
  if (!Hm) throw new Error('renderBoxPhoto: degenerate perspective');
  const pictureQuad = [
    { x: f - 0.5, y: f - 0.5 }, { x: f + pw - 0.5, y: f - 0.5 }, { x: f + pw - 0.5, y: f + ph - 0.5 }, { x: f - 0.5, y: f + ph - 0.5 },
  ].map((p) => applyMat3(Hm, p)) as Quad;

  // Table background.
  const scene = createFloat(W, H, 3);
  const bgOpt = opts.background ?? 'wood';
  const grain = smoothNoise(W, H, 40, rng);
  const fine = smoothNoise(W, H, 6, rng);
  const woodAngle = rng.uniform(-0.2, 0.2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c: RGB;
      if (bgOpt === 'wood') {
        const t = y * Math.cos(woodAngle) + x * Math.sin(woodAngle);
        const s = 0.5 + 0.5 * Math.sin(t / 7 + 6 * grain[i]);
        const v = 0.85 + 0.15 * s + 0.04 * fine[i];
        c = [150 * v, 105 * v, 70 * v];
      } else {
        const b = bgOpt === 'plain' ? [200, 200, 195] : bgOpt;
        const v = 1 + 0.03 * grain[i] + 0.02 * fine[i];
        c = [b[0] * v, b[1] * v, b[2] * v];
      }
      scene.data[i * 3] = c[0];
      scene.data[i * 3 + 1] = c[1];
      scene.data[i * 3 + 2] = c[2];
    }
  }
  // Soft shadow of the lid.
  const shadow = new Float32Array(W * H);
  const sm = createMask(W, H);
  fillPolygon(sm, lidQuad.map((p) => ({ x: p.x + 6, y: p.y + 8 })), 1);
  for (let i = 0; i < W * H; i++) shadow[i] = sm.data[i];
  const shB = gaussianBlurFloat({ width: W, height: H, channels: 1, data: shadow }, 6).data;
  const warped = warpRGBA(lid, Hm, W, H, { supersample: 2 });
  for (let i = 0; i < W * H; i++) {
    const a = warped.data[i * 4 + 3] / 255;
    const sf = 1 - 0.35 * shB[i];
    for (let c = 0; c < 3; c++) scene.data[i * 3 + c] = scene.data[i * 3 + c] * sf * (1 - a) + warped.data[i * 4 + c] * a;
  }
  const photo = finishPhoto(scene, rng, {
    gain: opts.gain ?? [rng.uniform(0.92, 1.08), 1, rng.uniform(0.92, 1.08)],
    illumination: opts.illumination ?? 0.12,
    noiseSigma: opts.noiseSigma ?? 3,
    blurSigma: opts.blurSigma ?? 0.6,
  });
  return { photo, pictureQuad, lidQuad };
}

function hsvToRgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [r * 255, g * 255, b * 255];
}

// ---------------------------------------------------------------------------------------------
// Print differences between the box and the pieces
// ---------------------------------------------------------------------------------------------

export interface PerturbOptions {
  seed?: number;
  /** Max absolute per-channel offset (default 8). */
  colorShift?: number;
  /** Max per-channel relative gain deviation (default 0.05). */
  gainJitter?: number;
  /** Saturation factor; default random in [0.88, 1.12]. */
  saturation?: number;
  /** Gaussian blur sigma in px (default 0.7). */
  blurSigma?: number;
  /** Gamma; default random in [0.92, 1.08]. */
  gamma?: number;
}

/** Simulate box-print vs piece-print differences: colour shift, gain, saturation, gamma and blur. */
export function perturbReference(img: RGBAImage, opts: PerturbOptions = {}): RGBAImage {
  const rng = new Rng(opts.seed ?? 3);
  const shift = opts.colorShift ?? 8;
  const gj = opts.gainJitter ?? 0.05;
  const off = [0, 1, 2].map(() => rng.uniform(-shift, shift));
  const gain = [0, 1, 2].map(() => 1 + rng.uniform(-gj, gj));
  const sat = opts.saturation ?? rng.uniform(0.88, 1.12);
  const gamma = opts.gamma ?? rng.uniform(0.92, 1.08);
  const { width: w, height: h } = img;
  const f = createFloat(w, h, 3);
  for (let i = 0; i < w * h; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const rgb = [y + sat * (r - y), y + sat * (g - y), y + sat * (b - y)];
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, Math.min(255, rgb[c] * gain[c] + off[c]));
      f.data[i * 3 + c] = 255 * Math.pow(v / 255, gamma);
    }
  }
  const blurred = opts.blurSigma === 0 ? f : gaussianBlurFloat(f, opts.blurSigma ?? 0.7);
  const out = createRGBA(w, h);
  for (let i = 0; i < w * h; i++) {
    out.data[i * 4] = blurred.data[i * 3];
    out.data[i * 4 + 1] = blurred.data[i * 3 + 1];
    out.data[i * 4 + 2] = blurred.data[i * 3 + 2];
    out.data[i * 4 + 3] = 255;
  }
  return out;
}
