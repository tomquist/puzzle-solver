/**
 * Synthetic test data: classic jigsaw cuts of a reference picture, photos of loose pieces / assembled
 * patches with ground truth, and photos of a puzzle box. Pure TypeScript, no DOM, deterministic for
 * a given seed. Used by the tests of several pipeline packages.
 */
import { applyMat3, composeTransforms, findHomography, mat3Invert, rotation, similarityAbout, translation, type Mat3, type Point, type Quad } from '../cv/geometry';
import { createFloat, createMask, createRGBA, type FloatImage, type Mask, type RGBAImage, type Rect } from '../cv/image';
import { gaussianBlurFloat } from '../cv/filter';
import { fillPolygon } from '../cv/raster';
import { sampleRGBA, warpRGBA } from '../cv/warp';
import jpeg from 'jpeg-js';
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
  /** Shadow offset in px: a number shifts down-right by that much per axis (default 2); [dx, dy] any direction. */
  shadowOffset?: number | [number, number];
  /** Softness (Gaussian sigma, px) of the shadow (default 2.2). */
  shadowBlur?: number;
  /**
   * Visible cardboard: the cut edge of a real piece shows its light core, and seen slightly from the
   * side the edge wall is a light band along one side of the piece (outside the printed outline).
   */
  rim?: RimStyle;
  /** Structured table surface (wood grain, woven cloth, patterned tablecloth) instead of a plain colour. */
  pattern?: TablePattern;
  /** Objects cut by the photo border (box lid, table edge, finger); never overlap pieces, not in the truth. */
  clutter?: ClutterKind[];
  /** Radial vignetting: brightness falls to (1 − vignette) in the corners (default 0). */
  vignette?: number;
  /** Specular glare: bright soft spots (partly clipping) on pieces and table. */
  glare?: GlareStyle;
  /**
   * A large soft shadow reaching in from the photo border (the photographer or the phone blocking
   * the light): darkens table and pieces alike.
   */
  shadowZone?: ShadowZoneStyle;
  /** Some pieces printed in dark tones of the table colour (dark wood, deep shadow look-alikes). */
  darkPieces?: DarkPieceStyle;
  /**
   * The phone's (or the photographer's) hard-edged shadow: a rectangle with sharp edges reaching
   * in from one photo side that darkens table and pieces alike.
   */
  hardShadow?: HardShadowStyle;
  /** Water stains on the table: darker, slightly more saturated patches of its colour with a darker rim. */
  stains?: StainStyle;
  /**
   * Assembled patches (items with several pieces) lie along the photo sides (in turn top, bottom,
   * right, left), long side parallel to the side and `gap` px from it (default 4; negative: cut off
   * by the photo border, the truth outline then is the visible part), so that they cover most of
   * the border band; loose pieces lie in between.
   */
  edgePatches?: { gap?: number };
  /** Simulate phone JPEG compression (4:2:0 chroma, this quality 1..100) as the last step. */
  jpegQuality?: number;
  /**
   * A second, lighter table surface (a board, a box lid, another table) covering a strip from one
   * photo side, lit with a gradient of its own; pieces lie on it like on the main table.
   */
  secondSurface?: SecondSurfaceStyle;
  /**
   * Free area per item for the automatic photo size (photo area ≈ packing × summed item boxes;
   * default 2.4). Lower values give dense layouts with many near neighbours.
   */
  packing?: number;
  /**
   * Put some items in close pairs: the first 2·count items form pairs whose outlines are `gap` px
   * apart (random in [min, max]; negative = the second piece overlaps the first by that much).
   */
  pairs?: { count: number; gap?: [number, number] };
  /** Supersampling per axis for anti-aliased borders (default 4). */
  supersample?: number;
  /**
   * How assembled patches look. Default: every piece is drawn separately with dark seams along the
   * internal cut lines, small gaps and a slight per-piece misalignment (like a real assembled grid).
   * `false` renders a patch as one rigid body with faint seams (the old behaviour).
   */
  patch?: PatchStyle | false;
  seed?: number;
}

/** Cardboard edge of the pieces (see {@link RenderOptions.rim}). */
export interface RimStyle {
  /** Visible wall width in px (default 2.5). */
  thickness?: number;
  /** Direction (degrees, clockwise from +x) in which the wall shows (default 60 = down-right). */
  direction?: number;
  /** Cardboard core colour (default light grey-beige). */
  color?: RGB;
  /** Lightening of the outermost px of the print towards the core colour, 0..1 (default 0.5). */
  light?: number;
}

/** Structured table surfaces (colours default to sensible values derived from `background`). */
export type TablePattern =
  /** Wood grain: warped growth rings with thin dark lines and fibres. `scale` multiplies the ring spacing (default 1). */
  | { kind: 'wood'; colors?: [RGB, RGB]; scale?: number }
  /** Plain-weave fabric: threads `period` px apart (default 6), shading contrast 0..1 (default 0.35). */
  | { kind: 'weave'; period?: number; contrast?: number }
  /** Gingham tablecloth: two-colour check, `period` px per repeat (default 64). */
  | { kind: 'check'; colors?: [RGB, RGB]; period?: number }
  /** Polka-dot print: dots of `radius` px (default 7) on a hex grid `period` px apart (default 40). */
  | { kind: 'dots'; colors?: [RGB, RGB]; period?: number; radius?: number }
  /**
   * Wooden planks or floor tiles: light boards `width` px wide (default 300) with faint grain,
   * separated by dark gaps `gap` px wide (default 8, colour `gapColor`, default 0.5 × background);
   * `tiles` adds the crossing gaps of a tile grid.
   */
  | { kind: 'planks'; width?: number; gap?: number; gapColor?: RGB; tiles?: boolean };

/** Things at the photo border that are not pieces. */
export type ClutterKind = 'box-edge' | 'table-edge' | 'finger';

/** Specular glare spots (see {@link RenderOptions.glare}). */
export interface GlareStyle {
  /** Number of spots (default 3). */
  count?: number;
  /** Spot radius range as a fraction of the shorter photo side (default [0.03, 0.08]). */
  radius?: [number, number];
  /** Peak brightness added, fraction of full scale (default 0.8; ≥ 0.6 clips). */
  strength?: number;
}

/** Large soft border shadow (see {@link RenderOptions.shadowZone}). */
export interface ShadowZoneStyle {
  /** Darkening in the core of the zone, 0..1 (default 0.45). */
  strength?: number;
  /** Radius as a fraction of the shorter photo side (default 0.45). */
  radius?: number;
  /** Width of the soft edge as a fraction of the radius (default 0.3). */
  softness?: number;
}

/** A second table surface (see {@link RenderOptions.secondSurface}). */
export interface SecondSurfaceStyle {
  /** Surface colour (default: the background lightened by a quarter, slightly greyer). */
  color?: RGB;
  /** Depth of the strip as a fraction of the photo across its side (default random in [0.3, 0.45]). */
  depth?: number;
  /** Brightness change of its own lighting along the strip, e.g. 0.25 = ±25 % (default 0.25). */
  gradient?: number;
}

/** Hard-edged shadow (see {@link RenderOptions.hardShadow}). */
export interface HardShadowStyle {
  /** Rectangle as fractions of the photo [x0, y0, x1, y1] (may reach beyond it; default [0.3, 0.3, 0.75, 1.1]). */
  rect?: [number, number, number, number];
  /** Darkening inside, 0..1 (default 0.3). */
  strength?: number;
  /** Softness of the edge (Gaussian-like ramp width in px, default 3). */
  edge?: number;
}

/** Water stains (see {@link RenderOptions.stains}). */
export interface StainStyle {
  /** Number of stains (default 5). */
  count?: number;
  /** Darkening at the rim, 0..1 (default 0.22; the inside darkens by 40 % of it). */
  strength?: number;
  /** Radius range as a fraction of the shorter photo side (default [0.06, 0.16]). */
  radius?: [number, number];
}

/** Pieces in dark table-coloured tones (see {@link RenderOptions.darkPieces}). */
export interface DarkPieceStyle {
  /** Share of the items drawn dark (default 0.35). */
  share?: number;
  /** Brightness relative to the background colour (default 0.5); the print still modulates it. */
  level?: number;
}

/** Appearance of assembled patches (see {@link RenderOptions.patch}). */
export interface PatchStyle {
  /** Darkening of internal seams relative to `edgeDarkening` (default 0.8). */
  seam?: number;
  /** Gap between neighbouring pieces in photo px, random per patch in [min, max] (default [0, 2]). */
  gap?: [number, number];
  /** Maximum random rotation of each piece in degrees (default 1.5). */
  jitterDeg?: number;
  /** Maximum random shift of each piece in photo px (default 2). */
  jitterPx?: number;
}

/** Ground truth of one piece of an assembled patch, as it lies in the photo. */
export interface PatchMemberTruth {
  piece: number;
  row: number;
  col: number;
  /** Body center in photo coordinates. */
  center: Point;
  /** Body corners in reference TL, TR, BR, BL order (photo coordinates). */
  corners: Quad;
  /** Outline in photo coordinates. */
  outline: Point[];
  /** Clockwise rotation (deg, [0, 360)) that turns this piece upright. */
  rotationDeg: number;
  /** Reference → photo mapping of this piece. */
  transform: Mat3;
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
  /** Patches: every piece as it lies in the photo (with gaps and misalignment); first = anchor. */
  members?: PatchMemberTruth[];
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

/** A polygon clipped to the rectangle [0, w] × [0, h] (Sutherland–Hodgman). */
function clipToRect(poly: readonly Point[], w: number, h: number): Point[] {
  let out = [...poly];
  const edges: [(p: Point) => number, (a: Point, b: Point) => Point][] = [
    [(p) => p.x, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => w - p.x, (a, b) => ({ x: w, y: a.y + ((b.y - a.y) * (w - a.x)) / (b.x - a.x) })],
    [(p) => p.y, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => h - p.y, (a, b) => ({ x: a.x + ((b.x - a.x) * (h - a.y)) / (b.y - a.y), y: h })],
  ];
  for (const [inside, cross] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length], b = src[i];
      const ia = inside(a) >= 0, ib = inside(b) >= 0;
      if (ib) {
        if (!ia) out.push(cross(a, b));
        out.push(b);
      } else if (ia) out.push(cross(a, b));
    }
    if (out.length === 0) break;
  }
  return out;
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

// ---------------------------------------------------------------------------------------------
// Real-photo effects (all opt-in; each draws from its own random stream so that enabling one
// does not change anything else in the scene)
// ---------------------------------------------------------------------------------------------

/** Separate deterministic random stream `k` of a scene. */
function streamRng(seed: number | undefined, k: number): Rng {
  return new Rng((((seed ?? 1) * 104729) ^ (k * 2654435761)) >>> 0);
}

/** Smooth value noise (values about −1..1) sampled at arbitrary coordinates (lattice spacing 1). */
function noiseField(rng: Rng): (x: number, y: number) => number {
  const N = 256;
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rng.uniform(-1, 1);
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const i0 = ((x0 % N) + N) % N, j0 = ((y0 % N) + N) % N, i1 = (i0 + 1) % N, j1 = (j0 + 1) % N;
    const a = g[j0 * N + i0], b = g[j0 * N + i1], c = g[j1 * N + i0], d = g[j1 * N + i1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scaleRGB = (a: RGB, f: number): RGB => [a[0] * f, a[1] * f, a[2] * f];
const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Paint a structured table surface into `scene` (float sRGB, 3 channels). */
function paintPattern(scene: FloatImage, p: TablePattern, bg: RGB, rng: Rng): void {
  const { width: W, height: H, data } = scene;
  const put = (i: number, c: RGB) => {
    data[i * 3] = c[0];
    data[i * 3 + 1] = c[1];
    data[i * 3 + 2] = c[2];
  };
  if (p.kind === 'wood') {
    const [light, dark] = p.colors ?? [scaleRGB(bg, 1.15), scaleRGB(bg, 0.55)];
    const ang = rng.uniform(-0.15, 0.15) + (rng.bool() ? Math.PI / 2 : 0);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const period = 16 * (p.scale ?? 1);
    const n1 = noiseField(rng), n2 = noiseField(rng), n3 = noiseField(rng);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        const w = 1.6 * n1(u / 260, v / 70) + 0.35 * n2(u / 45, v / 14);
        const ring = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v / period + w));
        const line = ring ** 10;
        const fib = n3(u / 30, v / 1.3);
        const t = Math.min(1, Math.max(0, 0.55 * line + 0.3 * (0.5 + 0.25 * w) + 0.15 * (0.5 + 0.5 * fib)));
        put(y * W + x, mixRGB(light, dark, t));
      }
    }
  } else if (p.kind === 'weave') {
    const per = p.period ?? 6, con = p.contrast ?? 0.35;
    const ang = rng.uniform(-0.3, 0.3);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const tv = new Float32Array(4096);
    for (let i = 0; i < tv.length; i++) tv[i] = rng.uniform(-1, 1);
    const warpTint: RGB = scaleRGB(bg, 1.04), weftTint: RGB = scaleRGB(bg, 0.94);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x * ca + y * sa + 1e4, v = -x * sa + y * ca + 1e4;
        const i = Math.floor(u / per), j = Math.floor(v / per);
        const fx = u / per - i, fy = v / per - j;
        const warpTop = ((i + j) & 1) === 0;
        const f = warpTop ? fx : fy;
        const prof = 1 - 4 * (f - 0.5) * (f - 0.5);
        const thread = warpTop ? tv[i & 4095] : tv[(j + 2048) & 4095];
        const k = 1 + con * (prof - 0.6) + 0.08 * thread;
        put(y * W + x, scaleRGB(warpTop ? warpTint : weftTint, k));
      }
    }
  } else if (p.kind === 'check') {
    const [a, b] = p.colors ?? [[236, 232, 226], [186, 44, 52]];
    const per = p.period ?? 64;
    const ang = rng.uniform(-0.35, 0.35);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const band = (t: number) => {
      // 1 inside the first half of each period, soft 1 px edges.
      const m = ((t % per) + per) % per;
      return smooth01(Math.min(m + 0.5, per / 2 - m + 0.5));
    };
    const ox = rng.uniform(0, per), oy = rng.uniform(0, per);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x * ca + y * sa + ox, v = -x * sa + y * ca + oy;
        put(y * W + x, mixRGB(a, b, (band(u) + band(v)) / 2));
      }
    }
  } else if (p.kind === 'planks') {
    const width = p.width ?? 300, gap = p.gap ?? 8;
    const gapColor = p.gapColor ?? scaleRGB(bg, 0.5);
    const ang = rng.uniform(-0.05, 0.05) + (rng.bool() ? Math.PI / 2 : 0);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ou = rng.uniform(0, width), ov = rng.uniform(0, width);
    const tone = new Float32Array(256);
    for (let i = 0; i < tone.length; i++) tone[i] = rng.uniform(-0.04, 0.04);
    const n1 = noiseField(rng), n2 = noiseField(rng);
    // 1 inside a gap (centred on multiples of `width`), soft 1-px edges.
    const inGap = (t: number) => {
      const m = ((t % width) + width) % width;
      return smooth01(gap / 2 + 0.5 - Math.min(m, width - m));
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x * ca + y * sa + ou, v = -x * sa + y * ca + ov;
        const iu = Math.floor(u / width + 0.5), iv = p.tiles ? Math.floor(v / width + 0.5) : 0;
        // Per-board tone and faint grain running along the boards.
        const k = 1 + tone[(iu * 31 + iv * 17) & 255] + 0.035 * n1(u / 16, v / 300) + 0.02 * n2(u / 3, v / 50);
        const g = Math.max(inGap(u), p.tiles ? inGap(v) : 0);
        put(y * W + x, mixRGB(scaleRGB(bg, k), gapColor, g));
      }
    }
  } else {
    const [a, b] = p.colors ?? [[42, 62, 112], [232, 226, 210]];
    const per = p.period ?? 40, r = p.radius ?? 7;
    const ang = rng.uniform(0, Math.PI / 3);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rowH = (per * Math.sqrt(3)) / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        const j = Math.round(v / rowH);
        const shift = (j & 1) * per * 0.5;
        const i = Math.round((u - shift) / per);
        const d = Math.hypot(u - (i * per + shift), v - j * rowH);
        put(y * W + x, mixRGB(a, b, smooth01(r + 0.5 - d)));
      }
    }
  }
}

/** Darken a large soft zone reaching in from a random photo border (table and pieces alike). */
function applyShadowZone(scene: FloatImage, z: ShadowZoneStyle, rng: Rng): void {
  const { width: W, height: H, data } = scene;
  const strength = z.strength ?? 0.45;
  const R = (z.radius ?? 0.45) * Math.min(W, H);
  const soft = Math.max(1, (z.softness ?? 0.3) * R);
  const side = rng.int(4), t = rng.uniform(0.15, 0.85);
  const cx = side === 0 || side === 2 ? t * W : side === 1 ? W + 0.25 * R : -0.25 * R;
  const cy = side === 1 || side === 3 ? t * H : side === 0 ? H + 0.25 * R : -0.25 * R;
  const wobble = noiseField(rng);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 1.3 * R + soft) continue;
      const edge = R * (1 + 0.12 * wobble(3 * Math.atan2(y - cy, x - cx) + 10, 0.5));
      const f = 1 - strength * smooth01((edge - d) / soft + 0.5);
      const o = (y * W + x) * 3;
      data[o] *= f;
      data[o + 1] *= f;
      data[o + 2] *= f;
    }
  }
}

/** Darken a rectangle with sharp (few px) edges: a hard-edged shadow over table and pieces alike. */
function applyHardShadow(scene: FloatImage, z: HardShadowStyle): void {
  const { width: W, height: H, data } = scene;
  const [fx0, fy0, fx1, fy1] = z.rect ?? [0.3, 0.3, 0.75, 1.1];
  const strength = z.strength ?? 0.3, edge = Math.max(0.5, z.edge ?? 3);
  const x0 = fx0 * W, y0 = fy0 * H, x1 = fx1 * W, y1 = fy1 * H;
  for (let y = 0; y < H; y++) {
    const ty = smooth01((Math.min(y - y0, y1 - y) / edge + 1) / 2);
    if (ty <= 0) continue;
    for (let x = 0; x < W; x++) {
      const t = ty * smooth01((Math.min(x - x0, x1 - x) / edge + 1) / 2);
      if (t <= 0) continue;
      const f = 1 - strength * t, o = (y * W + x) * 3;
      data[o] *= f;
      data[o + 1] *= f;
      data[o + 2] *= f;
    }
  }
}

/**
 * Water stains on the table: irregular round patches, darker and slightly more saturated (same
 * hue), with a darker rim where the water dried.
 */
function paintStains(scene: FloatImage, z: StainStyle, rng: Rng): void {
  const { width: W, height: H, data } = scene;
  const count = z.count ?? 5, strength = z.strength ?? 0.22;
  const [r0, r1] = z.radius ?? [0.06, 0.16];
  const wobble = noiseField(rng);
  for (let k = 0; k < count; k++) {
    const R = rng.uniform(r0, r1) * Math.min(W, H);
    const cx = rng.uniform(0, W), cy = rng.uniform(0, H), phase = rng.uniform(0, 100);
    const rim = Math.max(3, 0.08 * R);
    const bx0 = Math.max(0, Math.floor(cx - 1.4 * R)), bx1 = Math.min(W - 1, Math.ceil(cx + 1.4 * R));
    const by0 = Math.max(0, Math.floor(cy - 1.4 * R)), by1 = Math.min(H - 1, Math.ceil(cy + 1.4 * R));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const edge = R * (1 + 0.25 * wobble(2 * Math.atan2(y - cy, x - cx) + phase, phase));
        const d = Math.hypot(x - cx, y - cy) - edge;
        if (d > rim) continue;
        // Inside: 40 % of the darkening; the rim (a band just inside the edge) all of it.
        const inside = smooth01(-d / 2 + 0.5);
        const ring = Math.exp(-((d + rim) * (d + rim)) / (2 * (0.5 * rim) ** 2));
        const t = strength * Math.max(0.4 * inside, ring);
        if (t <= 0) continue;
        const o = (y * W + x) * 3;
        const m = (data[o] + data[o + 1] + data[o + 2]) / 3;
        for (let c = 0; c < 3; c++) data[o + c] = (1 - t) * (data[o + c] + 0.8 * t * (data[o + c] - m));
      }
    }
  }
}

/**
 * Paint a second table surface: a strip from a random photo side (straight, slightly tilted edge,
 * anti-aliased, with a faint shadow line along it), its own colour and lighting gradient.
 */
function paintSecondSurface(scene: FloatImage, z: SecondSurfaceStyle, bg: RGB, rng: Rng): void {
  const { width: W, height: H, data } = scene;
  const side = rng.int(4);
  const depth = z.depth ?? rng.uniform(0.3, 0.45);
  const tilt = rng.uniform(-0.06, 0.06);
  const grad = z.gradient ?? 0.25;
  const dir = rng.uniform(0, 2 * Math.PI);
  const col: RGB = z.color ?? [0, 1, 2].map((c) => Math.min(250, 1.25 * (0.85 * bg[c] + 0.15 * ((bg[0] + bg[1] + bg[2]) / 3)))) as RGB;
  const across = side % 2 === 0 ? H : W, along = side % 2 === 0 ? W : H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // (t, d): position along the side and depth inwards from it.
      const t = side === 0 ? x : side === 1 ? y : side === 2 ? W - x : H - y;
      const d = side === 0 ? y : side === 1 ? W - x : side === 2 ? H - y : x;
      const edge = depth * across + tilt * (t - along / 2);
      const a = Math.max(0, Math.min(1, edge - d + 0.5));
      const line = 0.12 * Math.exp(-((d - edge) ** 2) / (2 * 1.5 * 1.5));
      const o = (y * W + x) * 3;
      if (a > 0) {
        const light = 1 + grad * ((Math.cos(dir) * (x / W - 0.5) + Math.sin(dir) * (y / H - 0.5)) * 2);
        for (let c = 0; c < 3; c++) data[o + c] = data[o + c] * (1 - a) + a * col[c] * light;
      }
      for (let c = 0; c < 3; c++) data[o + c] *= 1 - line;
    }
  }
}

/** Anti-aliased coverage of a polygon over the whole photo (supersampled). */
function polygonCoverage(poly: Point[], W: number, H: number, ss: number): { rect: Rect; cov: Float32Array } | null {
  const b = boundsOf(poly);
  const x0 = Math.max(0, Math.floor(b.x0) - 1), y0 = Math.max(0, Math.floor(b.y0) - 1);
  const x1 = Math.min(W, Math.ceil(b.x1) + 2), y1 = Math.min(H, Math.ceil(b.y1) + 2);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0, h = y1 - y0;
  const m = createMask(w * ss, h * ss);
  fillPolygon(m, poly.map((p) => ({ x: (p.x - x0 + 0.5) * ss - 0.5, y: (p.y - y0 + 0.5) * ss - 0.5 })), 1);
  const cov = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let sy = 0; sy < ss; sy++) {
        const row = (y * ss + sy) * w * ss + x * ss;
        for (let sx = 0; sx < ss; sx++) n += m.data[row + sx];
      }
      cov[y * w + x] = n / (ss * ss);
    }
  }
  return { rect: { x: x0, y: y0, width: w, height: h }, cov };
}

/** A clutter object: outline (may extend beyond the photo) and how to colour a covered pixel. */
interface ClutterObject {
  poly: Point[];
  shade: (x: number, y: number) => RGB;
}

/**
 * Clutter at the photo border for a W×H photo: random parameters are drawn once by the caller's
 * stream (`params`), so the geometry follows the photo size chosen during placement.
 */
function makeClutter(kinds: ClutterKind[], rng: Rng, body: number, reference: RGBAImage): (W: number, H: number) => ClutterObject[] {
  const specs = kinds.map((kind, k) => ({
    kind, side: (rng.int(4) + k) % 4, a: rng.uniform(0.2, 0.8), span: rng.uniform(0.35, 0.6), depth: rng.uniform(0.06, 0.11),
    tilt: rng.uniform(-0.25, 0.25), hue: rng.uniform(0, 1), dir: rng.uniform(-0.5, 0.5),
  }));
  const noise = noiseField(rng);
  return (W, H) =>
    specs.map((s): ClutterObject => {
      // (t, d): position along the side and depth inwards from it.
      const L = s.side % 2 === 0 ? W : H, D = s.side % 2 === 0 ? H : W;
      const at = (t: number, d: number): Point =>
        s.side === 0 ? { x: t, y: d } : s.side === 1 ? { x: W - d, y: t } : s.side === 2 ? { x: W - t, y: H - d } : { x: d, y: H - t };
      const td = (x: number, y: number): [number, number] =>
        s.side === 0 ? [x, y] : s.side === 1 ? [y, W - x] : s.side === 2 ? [W - x, H - y] : [H - y, x];
      if (s.kind === 'finger') {
        const t0 = s.a * L, w = 0.45 * body, len = 1.5 * body;
        const ax = Math.sin(s.dir), ad = Math.cos(s.dir); // finger axis (t, d)
        const nx = Math.cos(s.dir), nd = -Math.sin(s.dir); // across the finger
        const cT = t0 + len * ax, cD = len * ad, bT = t0 - body * ax, bD = -body * ad;
        const pts: Point[] = [at(bT + (nx * w) / 2, bD + (nd * w) / 2)];
        for (let i = 0; i <= 16; i++) {
          const f = (Math.PI * i) / 16;
          pts.push(at(cT + (w / 2) * (Math.cos(f) * nx + Math.sin(f) * ax), cD + (w / 2) * (Math.cos(f) * nd + Math.sin(f) * ad)));
        }
        pts.push(at(bT - (nx * w) / 2, bD - (nd * w) / 2));
        const skin: RGB = [224, 172, 140];
        return {
          poly: pts,
          shade: (x, y) => {
            const [t, d] = td(x, y);
            const across = Math.min(1, Math.abs((t - t0) * nx + d * nd) / (w / 2));
            return scaleRGB(skin, 0.7 + 0.3 * Math.cos((across * Math.PI) / 2) + 0.04 * noise(x / 3, y / 3));
          },
        };
      }
      const depth = s.depth * D;
      const full = s.kind === 'table-edge';
      const t0 = full ? -0.1 * L : (s.a - s.span / 2) * L, t1 = full ? 1.1 * L : (s.a + s.span / 2) * L;
      const d0 = depth * (1 - s.tilt), d1 = depth * (1 + s.tilt);
      const poly = [at(t0, -60), at(t1, -60), at(t1, d1), at(t0, d0)];
      const edgeAt = (t: number) => d0 + ((d1 - d0) * (t - t0)) / (t1 - t0);
      if (full) {
        const floor: RGB = [66, 58, 54];
        return {
          poly,
          shade: (x, y) => {
            // Floor beyond the table, with a light bevel along the table edge.
            const [t, d] = td(x, y);
            const bevel = Math.exp(-((edgeAt(t) - d) ** 2) / (2 * 1.5 * 1.5));
            return mixRGB(scaleRGB(floor, 1 + 0.12 * noise(x / 4, y / 4)), [235, 225, 210], 0.7 * bevel);
          },
        };
      }
      // Box lid corner: coloured rim along the inner edge, part of the picture printed further out.
      const lid = hsvToRgb(s.hue, 0.7, 0.7);
      const px = [0, 0, 0, 0];
      return {
        poly,
        shade: (x, y) => {
          const [t, d] = td(x, y);
          if (edgeAt(t) - d < 0.3 * depth) return lid;
          const u = (((t * 1.3) % reference.width) + reference.width) % reference.width;
          const v = ((((depth - d) * 1.3 + 40) % reference.height) + reference.height) % reference.height;
          sampleRGBA(reference, u, v, px);
          return [px[0], px[1], px[2]];
        },
      };
    });
}

/** Rectangles (photo coordinates, with margin) that pieces must keep clear of. */
function clutterZones(objs: ClutterObject[], W: number, H: number, margin: number): { x0: number; y0: number; x1: number; y1: number }[] {
  return objs.map((o) => {
    const b = boundsOf(o.poly);
    return { x0: Math.max(0, b.x0) - margin, y0: Math.max(0, b.y0) - margin, x1: Math.min(W, b.x1) + margin, y1: Math.min(H, b.y1) + margin };
  });
}

/**
 * Decoder variation of a photo: its colour as a JPEG stores it (YCbCr, chroma averaged over 2×2
 * pixels, 4:2:0) and upsampled again either by replicating each chroma sample ('replicate', as
 * jpeg-js does) or by the triangle filter of libjpeg-turbo's "fancy" upsampling ('fancy', as
 * browsers do). Brightness is kept per pixel. Two variants of the same photo differ by about one
 * level on average and by up to a few dozen at colour edges, like two decoders of one file.
 */
export function chromaResample(img: RGBAImage, mode: 'replicate' | 'fancy'): RGBAImage {
  const { width: w, height: h, data: src } = img;
  const cw = (w + 1) >> 1, chh = (h + 1) >> 1;
  const Y = new Float32Array(w * h);
  const cb = new Float32Array(cw * chh), cr = new Float32Array(cw * chh), cnt = new Float32Array(cw * chh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, r = src[p], g = src[p + 1], b = src[p + 2];
      Y[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      const k = (y >> 1) * cw + (x >> 1);
      cb[k] += -0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[k] += 0.5 * r - 0.418688 * g - 0.081312 * b;
      cnt[k]++;
    }
  }
  for (let k = 0; k < cb.length; k++) { cb[k] /= cnt[k]; cr[k] /= cnt[k]; }
  const out = new Uint8ClampedArray(w * h * 4);
  const at = (a: Float32Array, cx: number, cy: number) => a[Math.min(chh - 1, Math.max(0, cy)) * cw + Math.min(cw - 1, Math.max(0, cx))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let u: number, v: number;
      if (mode === 'replicate') {
        u = at(cb, x >> 1, y >> 1);
        v = at(cr, x >> 1, y >> 1);
      } else {
        // Nearest chroma sample weighted 3/4, the next one towards this pixel 1/4, per axis.
        const cx = x >> 1, cy = y >> 1, nx = x & 1 ? cx + 1 : cx - 1, ny = y & 1 ? cy + 1 : cy - 1;
        u = (9 * at(cb, cx, cy) + 3 * at(cb, nx, cy) + 3 * at(cb, cx, ny) + at(cb, nx, ny)) / 16;
        v = (9 * at(cr, cx, cy) + 3 * at(cr, nx, cy) + 3 * at(cr, cx, ny) + at(cr, nx, ny)) / 16;
      }
      const l = Y[y * w + x], o = (y * w + x) * 4;
      out[o] = Math.round(l + 1.402 * v);
      out[o + 1] = Math.round(l - 0.344136 * u - 0.714136 * v);
      out[o + 2] = Math.round(l + 1.772 * u);
      out[o + 3] = src[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Phone-style JPEG round trip: 4:2:0 chroma subsampling, then jpeg-js at `quality`. */
export function jpegRoundTrip(img: RGBAImage, quality: number): RGBAImage {
  const { width: w, height: h } = img;
  const src = img.data;
  const sub = new Uint8ClampedArray(src);
  // Average chroma over 2×2 blocks (keep luma per pixel).
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let cb = 0, cr = 0, n = 0;
      const idx: number[] = [];
      for (let dy = 0; dy < 2 && y + dy < h; dy++) {
        for (let dx = 0; dx < 2 && x + dx < w; dx++) {
          const o = ((y + dy) * w + x + dx) * 4;
          const r = src[o], g = src[o + 1], b = src[o + 2];
          cb += -0.168736 * r - 0.331264 * g + 0.5 * b;
          cr += 0.5 * r - 0.418688 * g - 0.081312 * b;
          n++;
          idx.push(o);
        }
      }
      cb /= n;
      cr /= n;
      for (const o of idx) {
        const Y = 0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2];
        sub[o] = Y + 1.402 * cr;
        sub[o + 1] = Y - 0.344136 * cb - 0.714136 * cr;
        sub[o + 2] = Y + 1.772 * cb;
      }
    }
  }
  const enc = jpeg.encode({ width: w, height: h, data: sub }, Math.max(1, Math.min(100, Math.round(quality))));
  const dec = jpeg.decode(enc.data, { useTArray: true, formatAsRGBA: true });
  return { width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.length) };
}

/** Outline resampled to ≤ `step` px spacing (for distance computations). */
function densify(pts: Point[], step: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Smallest distance between two point sets, `b` shifted by (dx, dy). */
function minDistance(a: Point[], b: Point[], dx: number, dy: number): number {
  let best = Infinity;
  for (const p of a) {
    for (const q of b) {
      const ex = q.x + dx - p.x, ey = q.y + dy - p.y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

function finishPhoto(scene: FloatImage, rng: Rng, opts: RenderOptions): RGBAImage {
  const { width: W, height: H } = scene;
  const gain = toRGB(opts.gain, 1);
  const offset = toRGB(opts.offset, 0);
  const illum = opts.illumination ?? 0;
  const ang = rng.uniform(0, 2 * Math.PI);
  const ax = Math.cos(ang), ay = Math.sin(ang), q = rng.uniform(-0.5, 0.5);
  const s = scene.data;
  const vig = opts.vignette ?? 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W - 0.5, v = y / H - 0.5;
      let f = 1 + illum * (ax * u + ay * v) * 2 + illum * q * (u * u + v * v) * 2;
      if (vig > 0) f *= 1 - vig * 2 * (u * u + v * v);
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) s[o + c] = s[o + c] * gain[c] * f + offset[c];
    }
  }
  if (opts.glare) {
    // Specular spots: additive white, soft elliptical falloff (clips where strong).
    const g = streamRng(opts.seed, 4);
    const n = opts.glare.count ?? 3, [r0, r1] = opts.glare.radius ?? [0.03, 0.08], amp = 255 * (opts.glare.strength ?? 0.8);
    for (let k = 0; k < n; k++) {
      const cx = g.uniform(0.1, 0.9) * W, cy = g.uniform(0.1, 0.9) * H;
      const r = g.uniform(r0, r1) * Math.min(W, H), asp = g.uniform(0.45, 1), th = g.uniform(0, Math.PI);
      const ct = Math.cos(th), st = Math.sin(th);
      const R = Math.ceil(3 * r);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(H, Math.ceil(cy + R)); y++) {
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(W, Math.ceil(cx + R)); x++) {
          const du = ((x - cx) * ct + (y - cy) * st) / r, dv = (-(x - cx) * st + (y - cy) * ct) / (r * asp);
          const add = amp * Math.exp(-(du * du + dv * dv) / 2);
          const o = (y * W + x) * 3;
          for (let c = 0; c < 3; c++) s[o + c] += add;
        }
      }
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
 * piece index or an array of adjacent piece indices forming an assembled patch (first = anchor;
 * drawn piece by piece with seams, gaps and misalignment unless `opts.patch === false`).
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
    /** Placement bounds: `local` plus the items attached to this one (close pairs). */
    ext?: { x0: number; y0: number; x1: number; y1: number };
    /** Close pairs: this item lies at the position of item `to` plus `off`. */
    attach?: { to: number; off: Point };
    /** Edge patches: the photo side it lies along (0 top, 1 right, 2 bottom, 3 left). */
    side?: number;
    pos?: Point;
  }
  // Edge patches take turns over the sides (top, bottom, right, left), long side parallel to it
  // (own random stream).
  const erng = opts.edgePatches ? streamRng(opts.seed, 9) : null;
  let edgeCount = 0;
  const items: Item[] = pieces.map((entry) => {
    const indices = Array.isArray(entry) ? entry : [entry];
    const union = patchOutline(cut, indices);
    let px = 0, py = 0;
    for (const i of indices) for (const c of cut.pieces[i].corners) { px += c.x; py += c.y; }
    const pivot = { x: px / (4 * indices.length), y: py / (4 * indices.length) };
    const rot = opts.rotation ?? 'any';
    let deg: number, side: number | undefined;
    if (erng && indices.length > 1) {
      side = [0, 2, 1, 3][edgeCount++ % 4];
      const rows = new Set(indices.map((i) => cut.pieces[i].row)).size, cols = new Set(indices.map((i) => cut.pieces[i].col)).size;
      const wide = cols >= rows, horizontalSide = side % 2 === 0;
      deg = (wide === horizontalSide ? 0 : 90) + 180 * erng.int(2) + erng.uniform(-2, 2);
    } else {
      deg = typeof rot === 'number' ? rot : rot === 'none' ? 0 : rot === 'quarter' ? 90 * rng.int(4) : rng.uniform(0, 360);
    }
    const sc = opts.scale === undefined ? defScale : typeof opts.scale === 'number' ? opts.scale : rng.uniform(opts.scale[0], opts.scale[1]);
    const theta = (deg * Math.PI) / 180;
    const T = similarityAbout(pivot, { x: 0, y: 0 }, theta, sc);
    const local = boundsOf(union.map((p) => applyMat3(T, p)));
    return { indices, refOutlines: indices.map((i) => cut.pieces[i].outline), union, pivot, theta, scale: sc, local, side };
  });

  // Close pairs: the second item of a pair is attached to the first at a given outline gap.
  if (opts.pairs && opts.pairs.count > 0) {
    const prng2 = streamRng(opts.seed, 1);
    const [g0, g1] = opts.pairs.gap ?? [1, 3];
    for (let k = 0; k < Math.min(opts.pairs.count, Math.floor(items.length / 2)); k++) {
      const A = items[2 * k], B = items[2 * k + 1];
      const local = (it: Item) => it.union.map((p) => applyMat3(similarityAbout(it.pivot, { x: 0, y: 0 }, it.theta, it.scale), p));
      const la = local(A), lb = local(B);
      const coarseA = densify(la, 2), coarseB = densify(lb, 2), fineA = densify(la, 0.5), fineB = densify(lb, 0.5);
      const ca = { x: (A.local.x0 + A.local.x1) / 2, y: (A.local.y0 + A.local.y1) / 2 }, cb = { x: (B.local.x0 + B.local.x1) / 2, y: (B.local.y0 + B.local.y1) / 2 };
      const phi = prng2.uniform(0, 2 * Math.PI), dx = Math.cos(phi), dy = Math.sin(phi);
      const gap = prng2.uniform(g0, g1);
      const target = Math.max(0.5, gap);
      const offAt = (t: number) => ({ x: ca.x - cb.x + dx * t, y: ca.y - cb.y + dy * t });
      const dist = (t: number, fine: boolean) => {
        const o = offAt(t);
        return minDistance(fine ? fineA : coarseA, fine ? fineB : coarseB, o.x, o.y);
      };
      // Walk B in from far away until the outlines come within reach, then bisect.
      let hi = Math.hypot(A.local.x1 - A.local.x0, A.local.y1 - A.local.y0) / 2 + Math.hypot(B.local.x1 - B.local.x0, B.local.y1 - B.local.y0) / 2 + 10;
      let lo = hi;
      while (lo > 0 && dist(lo, false) > target + 2) { hi = lo; lo -= 2; }
      lo = Math.max(0, lo - 2);
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (dist(mid, true) > target) hi = mid; else lo = mid;
      }
      // Overlap: push B further in by the overlap depth.
      const t = gap < 0 ? hi + gap : hi;
      B.attach = { to: 2 * k, off: offAt(t) };
    }
  }
  for (const it of items) it.ext = { ...it.local };
  for (const it of items) {
    if (!it.attach) continue;
    const e = items[it.attach.to].ext!, o = it.attach.off;
    items[it.attach.to].ext = { x0: Math.min(e.x0, it.local.x0 + o.x), y0: Math.min(e.y0, it.local.y0 + o.y), x1: Math.max(e.x1, it.local.x1 + o.x), y1: Math.max(e.y1, it.local.y1 + o.y) };
  }

  // Clutter at the photo border (geometry follows the photo size).
  const bodyPx = cellSize * (opts.scale === undefined ? defScale : typeof opts.scale === 'number' ? opts.scale : (opts.scale[0] + opts.scale[1]) / 2);
  const clutterFor = opts.clutter && opts.clutter.length > 0 ? makeClutter(opts.clutter, streamRng(opts.seed, 3), bodyPx, reference) : null;

  // Edge patches: even slots along each side; the left and right sides between the patches along
  // the top and bottom.
  const eg = opts.edgePatches?.gap ?? 4;
  const edgeSlot = new Map<Item, { slot: number; of: number }>();
  let bandDepth = 0;
  for (let side = 0; side < 4; side++) {
    const on = items.filter((it) => it.side === side);
    on.forEach((it, k) => edgeSlot.set(it, { slot: k, of: on.length }));
    if (side % 2 === 0) for (const it of on) bandDepth = Math.max(bandDepth, it.ext!.y1 - it.ext!.y0);
  }

  // Placement (random, non-overlapping axis-aligned boxes with margin).
  const place = (W: number, H: number): boolean => {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = clutterFor ? clutterZones(clutterFor(W, H), W, H, margin) : [];
    // (Edge patches first: their slots are fixed.)
    for (const it of [...items.filter((i) => i.side !== undefined), ...items.filter((i) => i.side === undefined)]) {
      if (it.attach) continue;
      const ext = it.ext!;
      const w = ext.x1 - ext.x0, h = ext.y1 - ext.y0;
      let ok = false;
      for (let attempt = 0; attempt < 3000 && !ok; attempt++) {
        let x0 = rng.uniform(margin, W - margin - w);
        let y0 = rng.uniform(margin, H - margin - h);
        if (it.side !== undefined) {
          // In its slot along its photo side, `gap` px from it.
          const { slot, of } = edgeSlot.get(it)!;
          const along = it.side % 2 === 0 ? w : h;
          const [a0, a1] = it.side % 2 === 0 ? [eg, W - eg] : [eg + bandDepth + margin, H - eg - bandDepth - margin];
          const len = (a1 - a0) / of;
          if (len < along) break;
          const t = a0 + slot * len + rng.uniform(0, len - along);
          if (it.side % 2 === 0) {
            x0 = t;
            y0 = it.side === 0 ? eg : H - eg - h;
          } else {
            x0 = it.side === 3 ? eg : W - eg - w;
            y0 = t;
          }
          const box = { x0, y0, x1: x0 + w, y1: y0 + h };
          if (placed.some((b) => box.x0 < b.x1 + margin && box.x1 + margin > b.x0 && box.y0 < b.y1 + margin && box.y1 + margin > b.y0)) continue;
          placed.push(box);
          it.pos = { x: x0 - ext.x0, y: y0 - ext.y0 };
          ok = true;
          continue;
        }
        if (!(x0 >= margin && y0 >= margin)) break;
        const box = { x0, y0, x1: x0 + w, y1: y0 + h };
        if (placed.some((b) => box.x0 < b.x1 + margin && box.x1 + margin > b.x0 && box.y0 < b.y1 + margin && box.y1 + margin > b.y0)) continue;
        placed.push(box);
        it.pos = { x: x0 - ext.x0, y: y0 - ext.y0 };
        ok = true;
      }
      if (!ok) return false;
    }
    for (const it of items) if (it.attach) it.pos = { x: items[it.attach.to].pos!.x + it.attach.off.x, y: items[it.attach.to].pos!.y + it.attach.off.y };
    return true;
  };
  let W = opts.width, H = opts.height;
  if (W !== undefined && H !== undefined) {
    if (!place(W, H)) throw new Error(`renderPiecesPhoto: cannot place ${items.length} items in ${W}x${H}`);
  } else {
    let area = 0;
    for (const it of items) if (!it.attach) area += (it.ext!.x1 - it.ext!.x0 + margin) * (it.ext!.y1 - it.ext!.y0 + margin);
    // Clutter takes a border strip of the photo.
    if (clutterFor) area *= 1 + 0.25 * opts.clutter!.length;
    let side = Math.sqrt(area * (opts.packing ?? 2.4));
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
  if (opts.pattern) {
    paintPattern(scene, opts.pattern, bg, streamRng(opts.seed, 2));
    if (noiseA && noiseB) for (let i = 0; i < PW * PH; i++) {
      const t = tex * (0.7 * noiseA[i] + 0.3 * noiseB[i]);
      for (let c = 0; c < 3; c++) scene.data[i * 3 + c] += t;
    }
  } else {
    for (let i = 0; i < PW * PH; i++) {
      const t = noiseA && noiseB ? tex * (0.7 * noiseA[i] + 0.3 * noiseB[i]) : 0;
      scene.data[i * 3] = bg[0] + t;
      scene.data[i * 3 + 1] = bg[1] + t;
      scene.data[i * 3 + 2] = bg[2] + t;
    }
  }
  if (opts.secondSurface) paintSecondSurface(scene, opts.secondSurface, bg, streamRng(opts.seed, 7));
  if (opts.stains) paintStains(scene, opts.stains, streamRng(opts.seed, 10));
  if (clutterFor) {
    for (const obj of clutterFor(PW, PH)) {
      const c = polygonCoverage(obj.poly, PW, PH, ss);
      if (!c) continue;
      for (let y = 0; y < c.rect.height; y++) {
        for (let x = 0; x < c.rect.width; x++) {
          const a = c.cov[y * c.rect.width + x];
          if (a <= 0) continue;
          const X = c.rect.x + x, Y = c.rect.y + y;
          const col = obj.shade(X, Y);
          const o = (Y * PW + X) * 3;
          for (let k = 0; k < 3; k++) scene.data[o + k] = scene.data[o + k] * (1 - a) + a * col[k];
        }
      }
    }
  }

  const truth: PieceTruth[] = [];
  const shadowStrength = opts.shadow ?? 0.3;
  const edgeDark = opts.edgeDarkening ?? 0.45;
  const edgeW = opts.edgeWidth ?? 1.4;
  const style = opts.patch === false ? null : opts.patch ?? {};
  const seamDark = (style?.seam ?? 0.8) * edgeDark;
  const px = [0, 0, 0, 0];
  const renders: { bx: number; by: number; bw: number; bh: number; cov: Float32Array; label: Int32Array; owner: Int32Array; Tinv: Mat3[]; seamDark: number; seamW: number; wall: Float32Array | null; dark: boolean }[] = [];
  // Dark table-coloured pieces: chosen from their own random stream.
  const darkRng = opts.darkPieces ? streamRng(opts.seed, 6) : null;
  const darkShare = opts.darkPieces?.share ?? 0.35, darkLevel = opts.darkPieces?.level ?? 0.5;
  const rim = opts.rim;
  const rimT = rim ? rim.thickness ?? 2.5 : 0;
  const rimDir = (((rim?.direction ?? 60) * Math.PI) / 180);
  const rimColor: RGB = rim?.color ?? [212, 204, 188];
  const rimLight = rim ? rim.light ?? 0.5 : 0;
  const norm = (deg: number) => (((deg % 360) + 360) % 360) % 360;

  // Patch details draw from their own random stream, so placements match the rigid style.
  const prng = new Rng(((opts.seed ?? 1) * 7919 + 17) >>> 0);
  for (const it of items) {
    const pos = it.pos!;
    const T = similarityAbout(it.pivot, pos, it.theta, it.scale);
    // Per-piece transforms: a real assembled patch has small gaps and misaligned pieces.
    const multi = it.indices.length > 1 && style !== null;
    const gap = multi ? prng.uniform(style!.gap?.[0] ?? 0, style!.gap?.[1] ?? 2) : 0;
    const jDeg = multi ? style!.jitterDeg ?? 1.5 : 0, jPx = multi ? style!.jitterPx ?? 2 : 0;
    const meanRow = it.indices.reduce((a, i) => a + cut.pieces[i].row, 0) / it.indices.length;
    const meanCol = it.indices.reduce((a, i) => a + cut.pieces[i].col, 0) / it.indices.length;
    const memberT: Mat3[] = it.indices.map((i) => {
      if (!multi) return T;
      const piece = cut.pieces[i];
      const c = piece.corners;
      const center = applyMat3(T, { x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 });
      const spread = applyMat3(rotation(it.theta), { x: gap * (piece.col - meanCol), y: gap * (piece.row - meanRow) });
      const d = (prng.uniform(-jDeg, jDeg) * Math.PI) / 180;
      const shift = { x: spread.x + prng.uniform(-jPx, jPx), y: spread.y + prng.uniform(-jPx, jPx) };
      return composeTransforms(T, translation(-center.x, -center.y), rotation(d), translation(center.x + shift.x, center.y + shift.y));
    });
    const Tinv = memberT.map((m) => mat3Invert(m));
    const photoOutlines = it.refOutlines.map((o, k) => o.map((p) => applyMat3(memberT[k], p)));
    const ub = boundsOf(photoOutlines.flat());
    const padR = rim ? Math.ceil(rimT) + 1 : 0;
    const bx = Math.max(0, Math.floor(ub.x0) - 4 - padR), by = Math.max(0, Math.floor(ub.y0) - 4 - padR);
    const bw = Math.min(PW, Math.ceil(ub.x1) + 5 + padR) - bx, bh = Math.min(PH, Math.ceil(ub.y1) + 5 + padR) - by;
    // Supersampled coverage, per-pixel piece label (centre inside) and owner (most coverage).
    const cov = new Float32Array(bw * bh);
    const label = new Int32Array(bw * bh).fill(-1);
    const owner = new Int32Array(bw * bh).fill(-1);
    const best = new Float32Array(bw * bh);
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
          const f = n / (ss * ss);
          cov[i] = Math.min(1, cov[i] + f);
          if (f > best[i]) { best[i] = f; owner[i] = k; }
          if (n * 2 >= ss * ss && (label[i] < 0 || f >= best[i])) label[i] = k;
        }
      }
    });
    // Cardboard wall: the outline swept by up to `thickness` px in the rim direction.
    let wall: Float32Array | null = null;
    if (rim && rimT > 0) {
      wall = new Float32Array(bw * bh);
      ssMask.data.fill(0);
      const steps = Math.max(1, Math.ceil(rimT / 0.5));
      for (const o of photoOutlines) {
        for (let k = 0; k <= steps; k++) {
          const sx = (rimT * k * Math.cos(rimDir)) / steps, sy = (rimT * k * Math.sin(rimDir)) / steps;
          fillPolygon(ssMask, o.map((p) => ({ x: (p.x + sx - bx + 0.5) * ss - 0.5, y: (p.y + sy - by + 0.5) * ss - 0.5 })), 1);
        }
      }
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          let n = 0;
          for (let sy = 0; sy < ss; sy++) {
            const row = (y * ss + sy) * bw * ss + x * ss;
            for (let sx = 0; sx < ss; sx++) n += ssMask.data[row + sx];
          }
          wall[y * bw + x] = n / (ss * ss);
        }
      }
    }
    renders.push({ bx, by, bw, bh, cov, label, owner, Tinv, seamDark: multi ? seamDark : 0.5 * edgeDark, seamW: multi ? 1.0 : 0.8, wall, dark: darkRng !== null && darkRng.random() < darkShare });

    const deg = (it.theta * 180) / Math.PI;
    const members: PatchMemberTruth[] = it.indices.map((i, k) => {
      const piece = cut.pieces[i];
      const corners = piece.corners.map((p) => applyMat3(memberT[k], p)) as Quad;
      const a = memberT[k];
      const mdeg = (Math.atan2(a[3], a[0]) * 180) / Math.PI;
      return {
        piece: i,
        row: piece.row,
        col: piece.col,
        center: { x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4, y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4 },
        corners,
        outline: photoOutlines[k],
        rotationDeg: norm(-mdeg),
        transform: memberT[k],
      };
    });
    const anchor = cut.pieces[it.indices[0]];
    // (An edge patch reaching beyond the photo is judged by its visible part.)
    const whole = it.union.map((p) => applyMat3(T, p));
    const outline = it.side !== undefined ? clipToRect(whole, PW, PH) : whole;
    const ob = it.side !== undefined ? boundsOf(outline) : boundsOf([...outline, ...photoOutlines.flat()]);
    truth.push({
      pieces: [...it.indices],
      row: anchor.row,
      col: anchor.col,
      center: members[0].center,
      rotationDeg: norm(-deg),
      corners: members[0].corners,
      outline,
      bbox: { x: Math.floor(ob.x0), y: Math.floor(ob.y0), width: Math.ceil(ob.x1) - Math.floor(ob.x0) + 1, height: Math.ceil(ob.y1) - Math.floor(ob.y0) + 1 },
      transform: T,
      scale: it.scale,
      ...(it.indices.length > 1 ? { members } : {}),
    });
  }

  // Drop shadows (soft, offset down-right) on the background.
  if (shadowStrength > 0) {
    const sh = new Float32Array(PW * PH);
    const so = opts.shadowOffset ?? 2;
    const offX = Math.round(typeof so === 'number' ? so : so[0]), offY = Math.round(typeof so === 'number' ? so : so[1]);
    for (const r of renders) {
      for (let y = 0; y < r.bh; y++) {
        for (let x = 0; x < r.bw; x++) {
          const X = r.bx + x + offX, Y = r.by + y + offY;
          if (X >= 0 && Y >= 0 && X < PW && Y < PH) sh[Y * PW + X] = Math.max(sh[Y * PW + X], r.wall ? r.wall[y * r.bw + x] : r.cov[y * r.bw + x]);
        }
      }
    }
    const blurred = gaussianBlurFloat({ width: PW, height: PH, channels: 1, data: sh }, opts.shadowBlur ?? 2.2).data;
    for (let i = 0; i < PW * PH; i++) {
      const f = 1 - shadowStrength * blurred[i];
      scene.data[i * 3] *= f;
      scene.data[i * 3 + 1] *= f;
      scene.data[i * 3 + 2] *= f;
    }
  }

  // Pieces.
  for (const r of renders) {
    const { bw, bh, cov, label, owner } = r;
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
        if (r.wall && r.wall[i] > 0) {
          // Cardboard wall first; the print is composited over it.
          const o = ((r.by + y) * PW + r.bx + x) * 3, wa = r.wall[i];
          for (let c = 0; c < 3; c++) scene.data[o + c] = scene.data[o + c] * (1 - wa) + wa * rimColor[c] * 0.92;
        }
        if (a <= 0) continue;
        const X = r.bx + x, Y = r.by + y;
        const p = applyMat3(r.Tinv[Math.max(0, owner[i])], { x: X, y: Y });
        if (!sampleRGBA(reference, (p.x + 0.5) * refScaleX - 0.5, (p.y + 0.5) * refScaleY - 0.5, px)) {
          const cx = Math.min(reference.width - 1, Math.max(0, p.x)), cy = Math.min(reference.height - 1, Math.max(0, p.y));
          sampleRGBA(reference, cx, cy, px);
        }
        if (r.dark) {
          // Dark tones of the table colour, modulated by the print's lightness (some print hue kept).
          const l = (0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]) / 255;
          const f = darkLevel * (0.6 + 0.8 * l);
          for (let c = 0; c < 3; c++) px[c] = 0.75 * bg[c] * f + 0.25 * px[c] * darkLevel;
        }
        const de = Math.max(0, dOut[i] - 0.5);
        const ds = dSeam[i];
        let f = 1 - edgeDark * Math.exp(-(de * de) / (2 * edgeW * edgeW));
        if (ds < 1e8) f *= 1 - r.seamDark * Math.exp(-(ds * ds) / (2 * r.seamW * r.seamW));
        const o = (Y * PW + X) * 3;
        if (rimLight > 0) {
          // Light cardboard core at the cut edge.
          const l = rimLight * Math.exp(-(de * de) / (2 * 0.7 * 0.7));
          for (let c = 0; c < 3; c++) scene.data[o + c] = scene.data[o + c] * (1 - a) + a * (px[c] * f * (1 - l) + rimColor[c] * l);
        } else {
          for (let c = 0; c < 3; c++) scene.data[o + c] = scene.data[o + c] * (1 - a) + a * px[c] * f;
        }
      }
    }
  }

  if (opts.shadowZone) applyShadowZone(scene, opts.shadowZone, streamRng(opts.seed, 5));
  if (opts.hardShadow) applyHardShadow(scene, opts.hardShadow);
  const photo = finishPhoto(scene, rng, opts);
  return { photo: opts.jpegQuality ? jpegRoundTrip(photo, opts.jpegQuality) : photo, truth };
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
