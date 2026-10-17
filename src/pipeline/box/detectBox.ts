/**
 * Find the puzzle picture on a photo of the box lid (or poster).
 *
 * 1. Downscale to a ~800 px working image; colour Sobel gradient field with noise-adaptive thresholds.
 * 2. Line candidates from independent cues: Hough lines on straight Canny edges, the sides of the
 *    colour-segmented box (table modelled from the photo border), the sides of large connected
 *    edge outlines, and the photo border (for photos that cut the box off).
 * 3. Quads from pairs of roughly parallel lines, scored by edge support on all four sides
 *    (gradient magnitude + orientation, extra weight at the corners), shape and size.
 * 4. Directed search parallel to the best quads' sides adds nested/enclosing lines (picture inside
 *    a printed frame, lid around a picture); quads are re-enumerated.
 * 5. Structure: starting from the outermost related quad, step inwards while the band between the
 *    quad and a nested one looks like a printed frame (uniform, untextured, unlike the picture).
 * 6. Corners refined at full resolution (robust line fits to colour-edge profiles).
 */
import type { Quad } from '../../cv/geometry';
import type { Mask, RGBAImage } from '../../cv/image';
import type { BoxDetection } from '../../model/types';
import { makeGradientField, makeWorkImage, toPhoto, type GradientField, type WorkImage } from './field';
import { directedLines, edgeBaseline, frameEvidence, nestedBands, snapSideLines, type FrameEvidence } from './frame';
import { maxCornerDistance } from './geometry';
import { borderLines, houghCandidates, refitToEdges, sameLine, scoreLine, totalSupport, type Line, type LineSource, type ScoredLine } from './lines';
import { assessBoxPhoto } from './quality';
import { enumerateQuads, evaluateQuad, type QuadCandidate } from './quads';
import { refineQuad } from './refine';
import { contourQuads, segmentBox } from './segment';

export interface DetectBoxOptions {
  /** Longer side of the working image (default 800). */
  workSide?: number;
  /** Refine corners on the full-resolution photo (default true). */
  refine?: boolean;
}

/** Diagnostics for tests / debugging. */
export interface BoxDebug {
  work: WorkImage;
  lines: ScoredLine[];
  ranked: QuadCandidate[];
  evidence?: FrameEvidence;
  timings: Record<string, number>;
}

const MAX_POOL = 64;

class LinePool {
  readonly lines: ScoredLine[] = [];
  constructor(private readonly f: GradientField, private readonly edges: Mask) {}

  /** Add a line (optionally snapped to edge pixels); near-duplicates keep the better-supported one. */
  add(line: Line, source: LineSource, snap: boolean): void {
    let l = line;
    if (snap) {
      const r = refitToEdges(this.edges, this.f, line, 10);
      if (r) l = r;
    }
    const sl = scoreLine(this.f, l, source);
    if (!sl) return;
    const minSupport = 0.08 * Math.min(this.f.width, this.f.height);
    if (totalSupport(sl) < minSupport) return;
    for (let i = 0; i < this.lines.length; i++) {
      const o = this.lines[i];
      if (o.border !== undefined) continue;
      if (sameLine(o, sl, (1.2 * Math.PI) / 180, 1.5)) {
        if (totalSupport(sl) > totalSupport(o)) this.lines[i] = sl;
        return;
      }
    }
    this.lines.push(sl);
  }

  addRaw(l: ScoredLine): void {
    this.lines.push(l);
  }

  /** Keep the best-supported lines (border lines always kept). */
  prune(max: number): void {
    const border = this.lines.filter((l) => l.border !== undefined);
    const other = this.lines.filter((l) => l.border === undefined).sort((a, b) => totalSupport(b) - totalSupport(a));
    this.lines.length = 0;
    this.lines.push(...other.slice(0, max - border.length), ...border);
  }
}

function quadLines(q: Quad): Line[] {
  const out: Line[] = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    out.push({ p: a, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
  }
  return out;
}

interface Structure {
  picture: QuadCandidate;
  lid?: QuadCandidate;
  frameInner?: QuadCandidate;
  evidence?: FrameEvidence;
}

/** Decide picture vs lid vs nested frame among the ranked quads. */
function analyseStructure(ranked: QuadCandidate[], work: WorkImage, f: GradientField): Structure {
  const top = ranked[0];
  const isBand = (b: number[]) => Math.max(...b) > 0.006;
  // Best enclosing quad (the lid when the picture itself ranked first).
  let outer = top;
  let outerScore = -1;
  for (const c of ranked) {
    if (c === top || c.support < Math.max(0.45, 0.7 * top.support) || c.score < 0.3 * top.score) continue;
    const nb = nestedBands(c.quad, top.quad);
    if (!nb || !isBand(nb.bands)) continue;
    if (c.score > outerScore) {
      outer = c;
      outerScore = c.score;
    }
  }
  let cur = outer;
  let lid: QuadCandidate | undefined;
  let frameInner: QuadCandidate | undefined;
  let evidence: FrameEvidence | undefined;
  for (let iter = 0; iter < 3; iter++) {
    let best: { c: QuadCandidate; ev: FrameEvidence; v: number } | null = null;
    let bestWeak: { c: QuadCandidate; v: number } | null = null;
    for (const c of ranked) {
      if (c === cur || c.support < Math.max(0.4, 0.6 * cur.support)) continue;
      const nb = nestedBands(cur.quad, c.quad);
      if (!nb || !isBand(nb.bands)) continue;
      const ev = frameEvidence(work.rgba, f, cur.quad, nb.bands);
      const need = ev.bandSides >= 3 ? 0.35 : 0.55;
      // A narrow band (< 2.5 %) on only one or two sides is a shadow or the lid's side wall, not a frame.
      const tooThin = ev.bandSides <= 2 && ev.minBand < 0.025;
      if (ev.evidence < need || tooThin) {
        const v = c.support * c.geom;
        if (!bestWeak || v > bestWeak.v) bestWeak = { c, v };
        continue;
      }
      // Prefer the most complete frame (more sides with a band), then evidence and edge support.
      const v = ev.evidence * c.support * (1 + 0.2 * ev.bandSides);
      if (!best || v > best.v) best = { c, ev, v };
    }
    if (!best) {
      frameInner = bestWeak?.c;
      break;
    }
    lid ??= cur;
    cur = best.c;
    evidence = best.ev;
  }
  // Stepped outwards but found no frame inside: the outer quad is not a lid around the picture.
  if (!lid && cur !== top) return { picture: top, frameInner };
  return { picture: cur, lid, frameInner, evidence };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Full detection with diagnostics (see {@link detectBox}). */
export function detectBoxDebug(photo: RGBAImage, opts: DetectBoxOptions = {}): { result: BoxDetection; debug: BoxDebug } {
  const timings: Record<string, number> = {};
  let t = now();
  const lap = (name: string) => {
    const n = now();
    timings[name] = n - t;
    t = n;
  };
  const work = makeWorkImage(photo, opts.workSide ?? 800);
  const W = work.rgba.width, H = work.rgba.height;
  const field = makeGradientField(work.rgba);
  lap('prepare');
  const { edges, lines: hough } = houghCandidates(work.gray, field);
  lap('hough');
  const seg = segmentBox(work.rgba);
  const cq = contourQuads(edges);
  lap('regions');
  const pool = new LinePool(field, edges);
  for (const l of hough) pool.add(l, 'hough', false);
  if (seg.quad) for (const l of quadLines(seg.quad)) pool.add(l, 'segment', true);
  for (const q of cq) for (const l of quadLines(q)) pool.add(l, 'contour', true);
  pool.prune(MAX_POOL - 4);
  for (const b of borderLines(field, 0.8)) pool.addRaw(b);
  const ctx = { width: W, height: H, lines: pool.lines };
  let ranked = enumerateQuads(ctx);
  lap('enumerate');
  if (ranked.length) {
    const seeds = ranked.slice(0, 3).filter((c, i, a) => a.findIndex((o) => maxCornerDistance(o.quad, c.quad) < 0.05 * Math.hypot(W, H)) === i);
    const extra: Line[] = [];
    for (const s of seeds) extra.push(...snapSideLines(field, s.quad), ...directedLines(field, s.quad));
    const border = pool.lines.filter((l) => l.border !== undefined);
    pool.lines.splice(0, pool.lines.length, ...pool.lines.filter((l) => l.border === undefined));
    for (const l of extra) pool.add(l, 'directed', false);
    pool.prune(MAX_POOL - 4);
    for (const b of border) pool.addRaw(b);
    ranked = enumerateQuads({ width: W, height: H, lines: pool.lines });
  }
  // The whole photo (all four sides on the border) competes on the same terms: it wins when the
  // picture continues beyond every border (photo taken from too close).
  const bIdx = [0, 1, 2, 3].map((b) => pool.lines.findIndex((l) => l.border === b));
  if (bIdx.every((i) => i >= 0)) {
    const corners = [{ x: -0.5, y: -0.5 }, { x: W - 0.5, y: -0.5 }, { x: W - 0.5, y: H - 0.5 }, { x: -0.5, y: H - 0.5 }];
    const whole = evaluateQuad({ width: W, height: H, lines: pool.lines }, bIdx, corners, 4);
    if (whole && whole.score > 0) {
      ranked.push(whole);
      ranked.sort((a, b) => b.score - a.score);
    }
  }
  lap('directed');

  const photoQuadOf = (q: Quad): Quad => q.map((p) => toPhoto(work, p)) as Quad;
  const wholePhoto: Quad = [
    { x: -0.5, y: -0.5 },
    { x: photo.width - 0.5, y: -0.5 },
    { x: photo.width - 0.5, y: photo.height - 0.5 },
    { x: -0.5, y: photo.height - 0.5 },
  ];
  const refineOn = opts.refine ?? true;
  const radius = 2.5 / Math.min(work.sx, work.sy) + 3;
  const toFinal = (c: QuadCandidate, refine = refineOn): { quad: Quad; refined: number } => {
    let q = photoQuadOf(c.quad);
    // Snap border sides exactly onto the photo border.
    const fixed = c.lines.map((li) => pool.lines[li].border !== undefined);
    q = snapBorderSides(q, c.lines.map((li) => pool.lines[li].border), photo.width, photo.height);
    if (!refine) return { quad: q, refined: 1 };
    const r = refineQuad(photo, q, { radius, fixed });
    const fr = r.inlierFraction.reduce((a, b) => a + b, 0) / 4;
    if (fr <= 0) return { quad: r.quad, refined: fr };
    // Second pass in a narrow window: less chance to latch onto picture edges near the border.
    const r2 = refineQuad(photo, r.quad, { radius: Math.max(2.5, 0.35 * radius), fixed });
    const fr2 = r2.inlierFraction.reduce((a, b) => a + b, 0) / 4;
    return fr2 >= 0.8 * fr ? { quad: r2.quad, refined: fr2 } : { quad: r.quad, refined: fr };
  };

  let result: BoxDetection;
  let evidence: FrameEvidence | undefined;
  let cutOff = false;
  if (!ranked.length) {
    result = {
      quad: wholePhoto,
      confidence: 0.05,
      candidates: [{ quad: wholePhoto, score: 0.05, label: 'whole-photo' }],
      quality: { score: 0, issues: [], metrics: {} },
    };
  } else {
    const st = analyseStructure(ranked, work, field);
    evidence = st.evidence;
    lap('structure');
    const pic = toFinal(st.picture);
    const picIsWhole = st.picture.borderSides === 4;
    cutOff = st.picture.borderSides > 0;
    const topScore = Math.max(st.picture.score, st.lid?.score ?? 0);
    const candidates: BoxDetection['candidates'] = [{ quad: pic.quad, score: round3(topScore), label: picIsWhole ? 'whole-photo' : 'picture' }];
    const used: QuadCandidate[] = [st.picture];
    if (st.lid) {
      candidates.push({ quad: toFinal(st.lid).quad, score: round3(st.lid.score), label: 'lid' });
      used.push(st.lid);
    }
    if (st.frameInner) {
      candidates.push({ quad: toFinal(st.frameInner).quad, score: round3(st.frameInner.score), label: 'frame-inner' });
      used.push(st.frameInner);
    }
    const tol = 0.03 * Math.hypot(W, H);
    for (const c of ranked) {
      if (candidates.length >= 5) break;
      if (used.some((u) => maxCornerDistance(u.quad, c.quad) < tol)) continue;
      if (c.score < 0.4 * ranked[0].score) break;
      if (c.borderSides === 4) continue;
      // Alternatives keep their working-resolution corners (cheaper; the user adjusts them anyway).
      candidates.push({ quad: toFinal(c, false).quad, score: round3(c.score), label: 'alternative' });
      used.push(c);
    }
    if (!picIsWhole) candidates.push({ quad: wholePhoto, score: 0.05, label: 'whole-photo' });
    let confidence = Math.max(0, Math.min(1, (st.picture.support - 0.25) / 0.55)) * Math.min(1, st.picture.geom + 0.15);
    confidence *= Math.pow(0.7, st.picture.borderSides);
    // A box photo shows the picture reasonably large; tiny quads are rarely the target.
    confidence *= Math.min(1, Math.max(0.2, (st.picture.areaFrac - 0.02) / 0.13));
    confidence *= 0.75 + 0.25 * Math.min(1, pic.refined / 0.6);
    // Edges that are no stronger than the texture next to them are not evidence of a box.
    const baseline = edgeBaseline(field, st.picture.quad, st.picture.lines.map((li) => pool.lines[li].border !== undefined));
    confidence *= Math.max(0, 1 - 1.3 * baseline);
    confidence = Math.max(0.02, Math.min(0.99, confidence));
    if (confidence < 0.15 && !picIsWhole) {
      // Nothing convincing: start the manual corner editing from the whole photo.
      const wi = candidates.findIndex((c) => c.label === 'whole-photo');
      const [whole] = candidates.splice(wi, 1);
      candidates.unshift({ ...whole, score: round3(candidates[0].score) });
      cutOff = false;
    }
    // Scores follow the preference order (best first).
    for (let i = 1; i < candidates.length; i++) candidates[i].score = round3(Math.min(candidates[i].score, 0.98 * candidates[i - 1].score));
    result = { quad: candidates[0].quad, confidence: round3(confidence), candidates, quality: { score: 0, issues: [], metrics: {} } };
  }
  lap('refine');
  result.quality = assessBoxPhoto(photo, work, result.quad, result.confidence, cutOff);
  lap('quality');
  return { result, debug: { work, lines: pool.lines, ranked, evidence, timings } };
}

/**
 * Find the quadrilateral of the puzzle picture on a photo of the box lid. Returns the best quad
 * (TL, TR, BR, BL outer corners in photo coordinates, compatible with `rectifyQuad`), a 0..1
 * confidence, alternative candidates (labels 'picture', 'lid', 'frame-inner', 'alternative',
 * 'whole-photo'; best first) and a quality report for the photo.
 */
export function detectBox(photo: RGBAImage, opts: DetectBoxOptions = {}): BoxDetection {
  return detectBoxDebug(photo, opts).result;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Move sides that lie on the photo border exactly onto it (outer pixel edge). */
function snapBorderSides(q: Quad, borders: (number | undefined)[], w: number, h: number): Quad {
  const out = q.map((p) => ({ ...p })) as Quad;
  const set = (i: number, axis: 'x' | 'y', v: number) => {
    out[i][axis] = v;
  };
  borders.forEach((b, s) => {
    if (b === undefined) return;
    const i = s, j = (s + 1) % 4;
    if (b === 0) { set(i, 'y', -0.5); set(j, 'y', -0.5); }
    else if (b === 1) { set(i, 'x', w - 0.5); set(j, 'x', w - 0.5); }
    else if (b === 2) { set(i, 'y', h - 0.5); set(j, 'y', h - 0.5); }
    else { set(i, 'x', -0.5); set(j, 'x', -0.5); }
  });
  return out;
}

