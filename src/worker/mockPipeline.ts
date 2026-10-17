/**
 * A deterministic stand-in for the real image-processing worker. It produces plausible results so
 * every screen of the UI can be exercised before (and independently of) the real pipeline:
 *
 * - detectBox: an inset, slightly skewed quad + 2 alternative candidates
 * - suggestRectifiedSize / rectify: real calculations (pure TS, runs on the main thread)
 * - registerCloseup / composeHighRes: fake registration, plain upscaling
 * - analyzeScan: simulated progress, fake jigsaw-shaped regions laid out over the photo, candidates
 *   at random cells with varying confidence, one patch, fit hints and a few quality issues
 * - assessFrame: real mean brightness, clipping and a Laplacian-variance sharpness
 *
 * Everything is pure TS (no DOM), so it also runs in Node tests.
 */
import { applyMat3, rotation, type Point, type Quad } from '../cv/geometry';
import { rgbaToGray } from '../cv/color';
import { laplacian, meanVariance } from '../cv/filter';
import type { RGBAImage, Rect } from '../cv/image';
import { limitSize, resizeRGBA } from '../cv/resize';
import { rectifyQuad } from '../cv/warp';
import type {
  BoxDetection,
  CellRef,
  CloseupRegistration,
  CutStyle,
  DetectedRegion,
  FitHint,
  FrameQuality,
  GridSpec,
  MatchStatus,
  PieceKind,
  PieceShape,
  Placement,
  QualityIssue,
  QualityReport,
  RegionMatch,
  SideKind,
  SideShape,
} from '../model/types';
import { SIDE_PROFILE_SAMPLES, cellKey } from '../model/types';
import type { AnalyzeOptions, AnalyzeResponse, ComposeOptions, PipelineApi, ProgressCallback } from './api';

export interface MockPipelineOptions {
  /** Multiplies all simulated latencies (0 = instant). Default 1. */
  delayScale?: number;
}

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string, h = 2166136261): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Cheap fingerprint of an image (dimensions + a sparse pixel sample). */
function imageHash(img: RGBAImage): number {
  let h = hashString(`${img.width}x${img.height}`);
  const step = Math.max(4, Math.floor(img.data.length / 4 / 997)) * 4;
  for (let i = 0; i < img.data.length; i += step) {
    h ^= img.data[i] | (img.data[i + 1] << 8) | (img.data[i + 2] << 16);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function luminanceStats(img: RGBAImage): { mean: number; clipped: number } {
  const d = img.data;
  const n = img.width * img.height;
  const step = n > 400_000 ? Math.ceil(n / 400_000) : 1;
  let sum = 0;
  let clipped = 0;
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    const y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    sum += y;
    if (y < 6 || y > 249) clipped++;
    count++;
  }
  return { mean: count ? sum / count / 255 : 0, clipped: count ? clipped / count : 0 };
}

function bboxOf(pts: Point[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - x0) + 1, height: Math.ceil(y1 - y0) + 1 };
}

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(a / 2);
}

function exposureIssues(mean: number, clipped: number): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (mean < 0.18) {
    issues.push({ code: 'too_dark', severity: 'error', message: 'The photo is too dark.', hint: 'Turn on a light or use the torch.' });
  } else if (mean > 0.88) {
    issues.push({ code: 'too_bright', severity: 'warning', message: 'The photo is overexposed.', hint: 'Avoid direct light or reduce the exposure.' });
  }
  if (clipped > 0.25) {
    issues.push({ code: 'glare', severity: 'warning', message: 'Large areas are washed out.', hint: 'Tilt the box or move the light to avoid reflections.' });
  }
  return issues;
}

function reportScore(issues: QualityIssue[]): number {
  let s = 1;
  for (const i of issues) s -= i.severity === 'error' ? 0.45 : i.severity === 'warning' ? 0.15 : 0.04;
  return clamp(s, 0, 1);
}

// ---------------------------------------------------------------------------------------------
// Fake jigsaw geometry
// ---------------------------------------------------------------------------------------------

const UNIT_SAMPLES = 16;

/** Normalised side profile of one piece side (fraction of the side length, + = outward). */
export function bumpProfile(kind: SideKind, t: number): number {
  if (kind !== 'tab' && kind !== 'blank') return 0;
  // A knob: narrow neck, round head.
  const head = Math.exp(-(((t - 0.5) / 0.11) ** 2));
  const neck = 0.35 * Math.exp(-(((t - 0.5) / 0.22) ** 2));
  const v = 0.24 * Math.max(head, neck);
  return kind === 'tab' ? v : -v;
}

interface Body {
  center: Point;
  /** Body size in photo px per cell. */
  s: number;
  /** Cells along x / y in the local frame. */
  unitsX: number;
  unitsY: number;
  angleDeg: number;
  /** Side kinds per unit, sides 0..3 (top, right, bottom, left) in clockwise order. */
  sides: SideKind[][];
}

/** Clockwise contour + body corners (photo coordinates) of a rotated piece/patch body. */
function bodyGeometry(b: Body): { contour: Point[]; corners: Quad } {
  const w = b.unitsX * b.s;
  const h = b.unitsY * b.s;
  const local: Point[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  const R = rotation((b.angleDeg * Math.PI) / 180);
  const toPhoto = (p: Point): Point => {
    const q = applyMat3(R, p);
    return { x: q.x + b.center.x, y: q.y + b.center.y };
  };
  const contour: Point[] = [];
  for (let side = 0; side < 4; side++) {
    const a = local[side];
    const c = local[(side + 1) % 4];
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    const dx = (c.x - a.x) / len;
    const dy = (c.y - a.y) / len;
    const nx = dy; // outward normal for clockwise order with y down
    const ny = -dx;
    const units = b.sides[side];
    for (let u = 0; u < units.length; u++) {
      for (let k = 0; k < UNIT_SAMPLES; k++) {
        const t = k / UNIT_SAMPLES;
        const along = (u + t) * b.s;
        const off = bumpProfile(units[u], t) * b.s;
        contour.push(toPhoto({ x: a.x + dx * along + nx * off, y: a.y + dy * along + ny * off }));
      }
    }
  }
  return { contour, corners: local.map(toPhoto) as Quad };
}

function sideShape(kind: SideKind, length: number): SideShape {
  const profile: number[] = [];
  for (let i = 0; i < SIDE_PROFILE_SAMPLES; i++) profile.push(bumpProfile(kind, i / (SIDE_PROFILE_SAMPLES - 1)));
  return { kind, length, profile };
}

function pieceKindOf(sides: SideKind[]): PieceKind {
  const flats = sides.filter((s) => s === 'flat').length;
  return flats >= 2 ? 'corner' : flats === 1 ? 'edge' : 'interior';
}

// ---------------------------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------------------------

interface LoadedReference {
  width: number;
  height: number;
  grid: GridSpec;
  cut: CutStyle;
}

interface Slot {
  id: number;
  body: Body;
  kind: 'piece' | 'patch';
  /** For pieces: local index of the (first) flat side, or -1. */
  firstFlat: number;
  pieceKind: PieceKind;
}

export function createMockPipeline(options: MockPipelineOptions = {}): PipelineApi {
  const delayScale = options.delayScale ?? 1;
  const wait = (ms: number) => sleep(ms * delayScale);
  const references = new Map<string, LoadedReference>();

  function insetQuad(w: number, h: number, l: number, t: number, r: number, b: number, skew: number): Quad {
    return [
      { x: w * l, y: h * (t + skew) },
      { x: w * (1 - r), y: h * t },
      { x: w * (1 - r - skew), y: h * (1 - b) },
      { x: w * (l + skew * 0.5), y: h * (1 - b - skew * 0.5) },
    ];
  }

  async function detectBox(photo: RGBAImage): Promise<BoxDetection> {
    await wait(350);
    const { width: w, height: h } = photo;
    const best = insetQuad(w, h, 0.08, 0.09, 0.07, 0.08, 0.012);
    const lid = insetQuad(w, h, 0.03, 0.03, 0.03, 0.03, 0.006);
    const inner = insetQuad(w, h, 0.16, 0.17, 0.15, 0.16, 0.01);
    const { mean, clipped } = luminanceStats(photo);
    const issues = exposureIssues(mean, clipped);
    if (Math.max(w, h) < 900) {
      issues.push({
        code: 'low_resolution',
        severity: 'info',
        message: 'The photo is quite small.',
        hint: 'A full-resolution photo gives a sharper reference picture.',
      });
    }
    const confidence = issues.some((i) => i.severity === 'error') ? 0.35 : 0.78;
    if (confidence < 0.5) {
      issues.push({
        code: 'box_not_found',
        severity: 'warning',
        message: 'The picture edges are hard to see.',
        hint: 'Drag the four corners onto the corners of the picture.',
      });
    }
    return {
      quad: best,
      confidence,
      candidates: [
        { quad: best, score: 0.82, label: 'Picture' },
        { quad: lid, score: 0.61, label: 'Whole lid' },
        { quad: inner, score: 0.38, label: 'Inner frame' },
      ],
      quality: { score: reportScore(issues), issues, metrics: { brightness: mean, clipped } },
    };
  }

  async function suggestRectifiedSize(quad: Quad, aspect?: number, maxSide = 3000): Promise<{ width: number; height: number }> {
    const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    let w = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2;
    let h = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
    if (aspect && Number.isFinite(aspect) && aspect > 0) {
      const area = w * h;
      h = Math.sqrt(area / aspect);
      w = h * aspect;
    }
    const long = Math.max(w, h);
    if (long > maxSide) {
      w *= maxSide / long;
      h *= maxSide / long;
    }
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }

  async function rectify(photo: RGBAImage, quad: Quad, width: number, height: number): Promise<RGBAImage> {
    await wait(50);
    return rectifyQuad(photo, quad, width, height, width * height > 2_500_000 ? 1 : 2);
  }

  async function registerCloseup(reference: RGBAImage, closeup: RGBAImage): Promise<CloseupRegistration | null> {
    await wait(500);
    const { mean } = luminanceStats(closeup);
    if (Math.max(closeup.width, closeup.height) < 320 || mean < 0.08 || mean > 0.97) return null;
    const rnd = seededRandom(imageHash(closeup) ^ imageHash(reference));
    const cw = reference.width * (0.3 + 0.15 * rnd());
    const ch = Math.min(reference.height * 0.9, (cw * closeup.height) / closeup.width);
    const x = rnd() * (reference.width - cw);
    const y = rnd() * (reference.height - ch);
    const sx = cw / closeup.width;
    const sy = ch / closeup.height;
    return {
      toReference: [sx, 0, x, 0, sy, y, 0, 0, 1],
      inliers: 60 + Math.round(rnd() * 140),
      confidence: 0.6 + 0.35 * rnd(),
      coverage: { x, y, width: cw, height: ch },
      scaleGain: closeup.width / cw,
    };
  }

  async function composeHighRes(
    reference: RGBAImage,
    closeups: { image: RGBAImage; registration: CloseupRegistration }[],
    opts: ComposeOptions,
  ): Promise<RGBAImage> {
    await wait(300 + 150 * closeups.length);
    const maxSide = opts.maxSide ?? 6000;
    const long = Math.max(reference.width, reference.height);
    const scale = Math.max(1, Math.min(opts.scale, maxSide / long));
    return resizeRGBA(reference, reference.width * scale, reference.height * scale);
  }

  async function loadReference(puzzleId: string, reference: RGBAImage, grid: GridSpec, cut: CutStyle): Promise<void> {
    await wait(references.has(puzzleId) ? 0 : 250);
    references.set(puzzleId, { width: reference.width, height: reference.height, grid: { ...grid }, cut });
  }

  async function hasReference(puzzleId: string): Promise<boolean> {
    return references.has(puzzleId);
  }

  async function assessFrame(frame: RGBAImage): Promise<FrameQuality> {
    const gray = rgbaToGray(frame);
    const { mean, clipped } = luminanceStats(frame);
    const lap = meanVariance(laplacian(gray));
    const sharpness = clamp(1 - Math.exp(-lap.variance / 120), 0, 1);
    let message: string | undefined;
    if (mean < 0.15) message = 'Too dark';
    else if (mean > 0.9) message = 'Too bright';
    else if (clipped > 0.2) message = 'Glare – move the light';
    else if (sharpness < 0.3) message = 'Hold still';
    return { sharpness, brightness: mean, clipped, ok: !message, message };
  }

  // -------------------------------------------------------------------------------------------
  // analyzeScan
  // -------------------------------------------------------------------------------------------

  function layoutSlots(w: number, h: number, rnd: () => number): Slot[] {
    const landscape = w >= h;
    const nx = landscape ? 5 : 3;
    const ny = landscape ? 3 : 5;
    const cw = w / nx;
    const chh = h / ny;
    const s = 0.4 * Math.min(cw, chh);
    const patchAt = nx + 1; // second row, second slot: a 2-wide patch spanning two slots
    const skip = new Set<number>([patchAt + 1, Math.floor(rnd() * nx * ny)]);
    skip.delete(patchAt);
    const slots: Slot[] = [];
    let id = 1;
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const i = gy * nx + gx;
        if (skip.has(i)) continue;
        const jitter = () => (rnd() - 0.5) * 0.18;
        const isPatch = i === patchAt && gx + 1 < nx;
        const center = isPatch
          ? { x: (gx + 1) * cw, y: (gy + 0.5 + jitter() * 0.5) * chh }
          : { x: (gx + 0.5 + jitter()) * cw, y: (gy + 0.5 + jitter()) * chh };
        const angleDeg = Math.round((rnd() - 0.5) * 80);
        const randomKind = (): SideKind => (rnd() < 0.5 ? 'tab' : 'blank');
        if (isPatch) {
          const sides: SideKind[][] = [
            [randomKind(), randomKind()],
            [randomKind()],
            [randomKind(), randomKind()],
            [randomKind()],
          ];
          slots.push({ id: id++, kind: 'patch', firstFlat: -1, pieceKind: 'unknown', body: { center, s: s * 0.9, unitsX: 2, unitsY: 1, angleDeg: Math.round(angleDeg / 4), sides } });
          continue;
        }
        const sides: SideKind[] = [randomKind(), randomKind(), randomKind(), randomKind()];
        let firstFlat = -1;
        const r = rnd();
        if (i % 6 === 0 || r < 0.12) {
          firstFlat = Math.floor(rnd() * 4);
          sides[firstFlat] = 'flat';
          sides[(firstFlat + 1) % 4] = 'flat';
        } else if (r < 0.42) {
          firstFlat = Math.floor(rnd() * 4);
          sides[firstFlat] = 'flat';
        }
        slots.push({
          id: id++,
          kind: 'piece',
          firstFlat,
          pieceKind: pieceKindOf(sides),
          body: { center, s, unitsX: 1, unitsY: 1, angleDeg, sides: sides.map((k) => [k]) },
        });
      }
    }
    return slots;
  }

  function makeRegion(slot: Slot, w: number, h: number, rnd: () => number): DetectedRegion {
    const { contour: raw, corners } = bodyGeometry(slot.body);
    let clipped = false;
    const contour = raw.map((p) => {
      const x = clamp(p.x, 0, w - 1);
      const y = clamp(p.y, 0, h - 1);
      if (x !== p.x || y !== p.y) clipped = true;
      return { x, y };
    });
    const bbox = bboxOf(contour);
    const touchesBorder = clipped || bbox.x <= 1 || bbox.y <= 1 || bbox.x + bbox.width >= w - 1 || bbox.y + bbox.height >= h - 1;
    let shape: PieceShape | undefined;
    if (slot.kind === 'piece') {
      const kinds = slot.body.sides.map((u) => u[0]);
      shape = {
        corners,
        sides: kinds.map((k) => sideShape(k, slot.body.s)) as PieceShape['sides'],
        angleDeg: slot.body.angleDeg,
        bodySize: slot.body.s,
        center: { ...slot.body.center },
        kind: slot.pieceKind,
        confidence: 0.55 + 0.4 * rnd(),
      };
    }
    return {
      id: slot.id,
      kind: slot.kind,
      bbox,
      contour,
      area: Math.round(polygonArea(contour)),
      touchesBorder,
      shape,
      orientationDeg: slot.body.angleDeg,
      issues: [],
    };
  }

  function cellCenter(ref: LoadedReference, row: number, col: number, rnd: () => number): Point {
    const cw = ref.width / ref.grid.cols;
    const ch = ref.height / ref.grid.rows;
    return { x: (col + 0.5 + (rnd() - 0.5) * 0.08) * cw, y: (row + 0.5 + (rnd() - 0.5) * 0.08) * ch };
  }

  /** A cell (and the quarter turn k) that suits the slot: borders for edge/corner pieces. */
  function proposeCell(slot: Slot, ref: LoadedReference, rnd: () => number): { cell: CellRef; k: number } {
    const { rows, cols } = ref.grid;
    const ri = (lo: number, hi: number) => (hi <= lo ? lo : lo + Math.floor(rnd() * (hi - lo + 1)));
    if (slot.kind === 'piece' && slot.pieceKind === 'corner' && rows > 1 && cols > 1) {
      // Target puzzle side of the first flat: 3 = top-left corner, 0 = top-right, 1 = bottom-right, 2 = bottom-left.
      const target = ri(0, 3);
      const k = mod(target - slot.firstFlat, 4);
      const cell = [
        { row: 0, col: cols - 1 },
        { row: rows - 1, col: cols - 1 },
        { row: rows - 1, col: 0 },
        { row: 0, col: 0 },
      ][target];
      return { cell, k };
    }
    if (slot.kind === 'piece' && slot.pieceKind === 'edge' && rows > 2 && cols > 2) {
      const border = ri(0, 3);
      const k = mod(border - slot.firstFlat, 4);
      const cell =
        border === 0 ? { row: 0, col: ri(1, cols - 2) }
        : border === 1 ? { row: ri(1, rows - 2), col: cols - 1 }
        : border === 2 ? { row: rows - 1, col: ri(1, cols - 2) }
        : { row: ri(1, rows - 2), col: 0 };
      return { cell, k };
    }
    // Interior cells (patches need room for their second cell to the right).
    return { cell: { row: ri(Math.min(1, rows - 1), Math.max(0, rows - 2)), col: ri(Math.min(1, cols - 1), Math.max(0, cols - 2)) }, k: ri(0, 3) };
  }

  function makeMatch(
    slot: Slot,
    region: DetectedRegion,
    ref: LoadedReference,
    placed: Set<string>,
    rnd: () => number,
  ): RegionMatch {
    const r = rnd();
    const status: MatchStatus = r < 0.55 ? 'confident' : r < 0.85 ? 'ambiguous' : 'unmatched';
    const count = status === 'unmatched' ? (rnd() < 0.4 ? 0 : 2) : 3 + Math.floor(rnd() * 3);
    const seen = new Set<string>();
    const candidates: Placement[] = [];
    let conf = status === 'confident' ? 0.78 + 0.18 * rnd() : status === 'ambiguous' ? 0.4 + 0.2 * rnd() : 0.12 + 0.12 * rnd();
    for (let attempt = 0; candidates.length < count && attempt < 40; attempt++) {
      const { cell, k } = proposeCell(slot, ref, rnd);
      const key = cellKey(cell);
      if (seen.has(key) || placed.has(key)) continue;
      seen.add(key);
      const cover = slot.kind === 'patch' ? { x: 0.5, y: 0 } : { x: 0, y: 0 };
      const c = cellCenter(ref, cell.row, cell.col, rnd);
      candidates.push({
        row: cell.row,
        col: cell.col,
        x: c.x + (cover.x * ref.width) / ref.grid.cols,
        y: c.y,
        rotationDeg: mod(k * 90 - region.orientationDeg, 360),
        score: Math.round((conf * 0.9 - 0.05) * 1000) / 1000,
        confidence: Math.round(conf * 1000) / 1000,
      });
      conf *= candidates.length === 1 && status === 'ambiguous' ? 0.9 : 0.45 + 0.2 * rnd();
    }
    const match: RegionMatch = { regionId: region.id, candidates, status: candidates.length ? status : 'unmatched' };
    if (slot.kind === 'patch' && candidates[0]) {
      const { row, col } = candidates[0];
      match.coveredCells = [
        { row, col },
        { row, col: col + 1 },
      ];
    }
    return match;
  }

  /** Make a few regions neighbours on purpose and describe them as fit hints. */
  function addFits(regions: DetectedRegion[], matches: RegionMatch[], ref: LoadedReference): FitHint[] {
    const fits: FitHint[] = [];
    const interior = matches.filter((m) => {
      const reg = regions.find((r) => r.id === m.regionId);
      return reg?.kind === 'piece' && reg.shape?.kind === 'interior' && m.candidates.length > 0;
    });
    const patch = matches.find((m) => regions.find((r) => r.id === m.regionId)?.kind === 'patch' && m.candidates.length > 0);
    const cw = ref.width / ref.grid.cols;
    const ch = ref.height / ref.grid.rows;
    const moveTo = (m: RegionMatch, row: number, col: number) => {
      const best = m.candidates[0];
      if (row < 0 || col < 0 || row >= ref.grid.rows || col >= ref.grid.cols) return false;
      best.row = row;
      best.col = col;
      best.x = (col + 0.5) * cw;
      best.y = (row + 0.5) * ch;
      return true;
    };
    if (interior.length >= 2) {
      const [a, b] = interior;
      const best = a.candidates[0];
      if (moveTo(b, best.row, best.col + 1)) {
        fits.push({ a: a.regionId, b: b.regionId, sideA: 'right', sideB: 'left', confidence: 0.74, reason: 'location+shape' });
      }
    }
    if (patch && interior.length >= 3) {
      const p = patch.candidates[0];
      const c = interior[2];
      if (moveTo(c, p.row - 1, p.col)) {
        fits.push({ a: c.regionId, b: patch.regionId, sideA: 'bottom', sideB: 'top', confidence: 0.62, reason: 'location' });
      }
    }
    if (interior.length >= 5) {
      fits.push({ a: interior[3].regionId, b: interior[4].regionId, sideA: 'top', sideB: 'bottom', confidence: 0.41, reason: 'shape' });
    }
    return fits;
  }

  async function analyzeScan(
    puzzleId: string,
    photo: RGBAImage,
    opts: AnalyzeOptions = {},
    onProgress?: ProgressCallback,
  ): Promise<AnalyzeResponse> {
    const ref = references.get(puzzleId);
    if (!ref) throw new Error('The puzzle picture is not loaded yet (call loadReference first).');
    const timings: Record<string, number> = {};
    const t0 = Date.now();
    const step = async (stage: string, progress: number, message: string, ms: number) => {
      onProgress?.({ stage, progress, message });
      const s = Date.now();
      await wait(ms);
      timings[stage] = (timings[stage] ?? 0) + Date.now() - s;
    };

    await step('prepare', 0.02, 'Preparing photo…', 80);
    const { image } = limitSize(photo, opts.maxSide ?? 2400);
    const { width: w, height: h } = image;
    await step('quality', 0.08, 'Checking photo quality…', 150);
    const { mean, clipped } = luminanceStats(image);
    const rnd = seededRandom(imageHash(image) ^ hashString(puzzleId));

    await step('segment', 0.2, 'Finding pieces…', 250);
    const slots = layoutSlots(w, h, rnd);
    await step('shape', 0.38, 'Analysing piece shapes…', 200);
    const regions = slots.map((s) => makeRegion(s, w, h, rnd));

    const placed = new Set((opts.placedCells ?? []).map(cellKey));
    const matches: RegionMatch[] = [];
    for (let i = 0; i < slots.length; i++) {
      matches.push(makeMatch(slots[i], regions[i], ref, placed, rnd));
      if (i % 3 === 0) {
        await step('match', 0.4 + (0.5 * (i + 1)) / slots.length, `Matching pieces (${i + 1} of ${slots.length})…`, 60);
      }
    }
    await step('fits', 0.94, 'Looking for pieces that fit together…', 120);
    const fits = addFits(regions, matches, ref);

    // Quality issues: exposure (real), plus a few simulated ones to exercise the UI.
    const issues = exposureIssues(mean, clipped);
    const cut = regions.filter((r) => r.touchesBorder).map((r) => r.id);
    if (cut.length) {
      issues.push({ code: 'cut_off', severity: 'warning', message: `${cut.length === 1 ? 'A piece is' : `${cut.length} pieces are`} cut off by the photo edge.`, hint: 'Keep all pieces fully inside the frame.', regionIds: cut });
      for (const r of regions) if (r.touchesBorder) r.issues.push(issues[issues.length - 1]);
    }
    const uncertain = regions.filter((r) => r.shape && r.shape.confidence < 0.65).map((r) => r.id);
    if (uncertain.length) {
      const issue: QualityIssue = { code: 'shape_uncertain', severity: 'info', message: 'Some piece outlines are uncertain.', hint: 'Spread the pieces a little further apart.', regionIds: uncertain };
      issues.push(issue);
      for (const r of regions) if (uncertain.includes(r.id)) r.issues.push(issue);
    }
    if (rnd() < 0.7) {
      issues.push({
        code: 'glare',
        severity: 'warning',
        message: 'Glare on part of the photo.',
        hint: 'Move the lamp to the side or turn off the flash.',
        area: { x: Math.round(w * 0.62), y: Math.round(h * 0.05), width: Math.round(w * 0.25), height: Math.round(h * 0.22) },
      });
    }
    const quality: QualityReport = {
      score: reportScore(issues),
      issues,
      metrics: { brightness: mean, clipped, sharpness: 0.7, medianPieceSize: slots[0]?.body.s ?? 0, regions: regions.length },
    };
    await step('done', 1, 'Done', 0);
    timings.total = Date.now() - t0;
    return {
      result: { width: w, height: h, regions, matches, fits, quality, timings },
      analysedImage: image,
    };
  }

  return {
    detectBox,
    suggestRectifiedSize,
    rectify,
    registerCloseup,
    composeHighRes,
    loadReference,
    hasReference,
    analyzeScan,
    assessFrame,
  };
}
