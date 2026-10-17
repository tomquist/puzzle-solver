/**
 * Feedback inspection output: annotated PNGs and a text summary of a replayed feedback file
 * (see replay.ts). Used by `npm run feedback:inspect`.
 *
 * Files written to the output directory:
 *   1-original.png    photo + regions stored in the file + the user's marks (M1, M2, …; P = placement)
 *   2-current.png     photo + regions of the current pipeline + verdict per mark / placement
 *   3-score.png       foreground score heat map with the thresholds (why pixels count as piece)
 *   4-mask.png        colour foreground, texture-only additions, dropped specks, current outlines
 *   5-background.png  table model (modelled colour), its statistics and the quality reports
 *   6-marks-<n>.png   zoom per mark / failed placement: app | current | score | mask
 *   7-box.png         box photo: user quad vs. current detectBox quad, corner errors
 *   summary.txt       the printed summary; replay.json: judgements and metrics
 * Colours are the same in every image (see COLORS in draw.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { Point } from '../../src/cv/geometry';
import { createRGBA, type Mask, type Rect, type RGBAImage } from '../../src/cv/image';
import { labToRgba } from '../../src/cv/color';
import type { DetectedRegion, QualityReport, RegionMatch, ScanResult } from '../../src/model/types';
import { backgroundAt } from '../../src/pipeline/pieces';
import { COLORS, fillRect, heat, hstack, View, vstack, withHeader, type Color, type HeaderLines } from './draw';
import { feedbackMetrics, type FeedbackReplay, type MarkJudgement, type PlacementJudgement } from './replay';
import { formatCells } from './regions';

const MAX_SIDE = 1400;
const TEXT = 2;
const TILE = 300;

const MARK_COLOR: Record<MarkJudgement['mark']['kind'], Color> = {
  missed: COLORS.missed,
  not_a_piece: COLORS.notPiece,
  merged: COLORS.merged,
  bad_outline: COLORS.badOutline,
  wrong_place: COLORS.wrongPlace,
};
const MARK_TEXT: Record<MarkJudgement['mark']['kind'], string> = {
  missed: 'MISSED', not_a_piece: 'NOT A PIECE', merged: 'MERGED', bad_outline: 'BAD OUTLINE', wrong_place: 'WRONG PLACE',
};
const OUTLINE_LEGEND: [string, Color][] = [
  ['OUTLINES:', COLORS.white], ['CONFIDENT', COLORS.confident], ['AMBIGUOUS', COLORS.ambiguous], ['UNMATCHED', COLORS.unmatched], ['FRAGMENT', COLORS.fragment],
];
const MARK_LEGEND: [string, Color][] = [
  ['MARKS:', COLORS.white], ['MISSED', COLORS.missed], ['NOT A PIECE', COLORS.notPiece], ['MERGED', COLORS.merged], ['BAD OUTLINE', COLORS.badOutline], ['WRONG PLACE', COLORS.wrongPlace],
];
const MASK_COLOURS = { colour: [255, 255, 255, 255] as Color, texture: [0, 220, 255, 255] as Color, removed: [255, 140, 0, 255] as Color };

function statusColor(r: DetectedRegion, m: RegionMatch | undefined): Color {
  if (r.kind === 'unknown') return COLORS.fragment;
  if (!m || m.status === 'unmatched' || m.candidates.length === 0) return COLORS.unmatched;
  return m.status === 'confident' ? COLORS.confident : COLORS.ambiguous;
}

const verdictColor = (fixed: boolean | null): Color => (fixed === true ? COLORS.ok : fixed === false ? COLORS.bad : COLORS.neutral);
const darker = (c: Color): Color => [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 235];

function savePng(path: string, img: RGBAImage): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(path, PNG.sync.write(png));
}

/** Typical piece size in photo px (marker sizes, zoom extents). */
function pieceSize(r: FeedbackReplay): number {
  return r.diagnostics?.refBody || r.current?.regions.find((x) => x.shape)?.shape?.bodySize || 80;
}

const scaled = (pts: Point[], s: number): Point[] => (s === 1 ? pts : pts.map((p) => ({ x: p.x * s, y: p.y * s })));
const scaleRect = (b: Rect, s: number): Rect => ({ x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s });

function drawRegions(v: View, result: ScanResult, s: number, highlight?: Set<number>, strictLabels = false): void {
  const matches = new Map(result.matches.map((m) => [m.regionId, m]));
  for (const r of result.regions) v.polygon(scaled(r.contour, s), statusColor(r, matches.get(r.id)), highlight?.has(r.id) ? 4 : 2);
  for (const r of result.regions) {
    const b = scaleRect(r.bbox, s);
    v.label({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, String(r.id), COLORS.white, [0, 0, 0, 170], TEXT, strictLabels);
  }
}

/** Marker radius in view px. */
const markRadius = (v: View, size: number): number => Math.max(14, 0.45 * size * v.scale);

/** Where a mark's label goes: above the marked region, or above the circle of a point mark. */
function labelAnchor(v: View, j: MarkJudgement, size: number, original: ScanResult | null, s: number): Point {
  const region = 'regionId' in j.mark ? original?.regions.find((x) => x.id === (j.mark as { regionId: number }).regionId) : undefined;
  if (region) {
    const b = scaleRect(region.bbox, s);
    return { x: b.x + b.width / 2, y: b.y - 12 / v.scale };
  }
  return { x: j.at.x, y: j.at.y - (markRadius(v, size) + 12) / v.scale };
}

/** Draw a mark (shape by kind) and its label; with `verdict` the label shows the current verdict. */
function drawMark(v: View, j: MarkJudgement, size: number, original: ScanResult | null, s: number, verdict: boolean): void {
  const color = MARK_COLOR[j.mark.kind];
  const r = markRadius(v, size);
  if (j.mark.kind === 'missed') {
    v.circle(j.at, r, color, 3);
    v.cross(j.at, r * 0.35, color, 2, false);
  } else {
    const region = original?.regions.find((x) => x.id === (j.mark as { regionId: number }).regionId);
    if (region && !verdict) v.polygon(scaled(region.contour, s), color, 4);
    if (j.mark.kind === 'not_a_piece') v.cross(j.at, r * 0.6, color, 3);
  }
  const extra = j.mark.kind === 'wrong_place' && j.mark.correct ? ` (IS R${j.mark.correct.row}C${j.mark.correct.col})` : '';
  const text = verdict ? `M${j.index} ${j.verdict}` : `M${j.index} ${MARK_TEXT[j.mark.kind]}${extra}`;
  v.label(labelAnchor(v, j, size, original, s), text, COLORS.white, verdict ? verdictColor(j.fixed) : darker(color), TEXT);
}

function drawPlacement(v: View, p: PlacementJudgement, current: boolean): void {
  const ok = current ? p.ok : p.originalOk;
  const text = current ? (p.ok ? `P ${formatCells(p.cells)} OK` : `P ${formatCells(p.cells)} NOW ${formatCells(p.currentCells)}`) : `P ${formatCells(p.cells)}${p.originalOk ? '' : ` APP ${formatCells(p.originalCells)}`}`;
  v.label({ x: p.bbox.x + p.bbox.width / 2, y: p.bbox.y + p.bbox.height + 12 / v.scale }, text, COLORS.white, ok ? [20, 110, 40, 230] : [150, 20, 20, 230], TEXT);
}

function issuesText(q: QualityReport | undefined): string {
  if (!q) return '-';
  const list = q.issues.map((i) => `${i.code}${i.severity === 'info' ? '(i)' : i.severity === 'error' ? '(E)' : ''}${i.regionIds?.length ? ` #${i.regionIds.slice(0, 6).join(',')}${i.regionIds.length > 6 ? '..' : ''}` : ''}`);
  return list.length ? list.join('; ') : 'none';
}

/** Below low: black → blue → cyan; low..high: cyan → yellow; above high: yellow → red → white. */
function scoreColor(v: number, low: number, high: number): Color {
  const t = v < low ? 0.4 * (v / low) : v < high ? 0.4 + (0.2 * (v - low)) / (high - low) : 0.6 + 0.4 * Math.min(1, (v - high) / (3 * high));
  return heat(t);
}

function scoreImage(score: { width: number; height: number; data: Float32Array }, low: number, high: number): RGBAImage {
  const out = createRGBA(score.width, score.height);
  for (let i = 0; i < score.data.length; i++) {
    const c = scoreColor(score.data[i], low, high);
    out.data[i * 4] = c[0]; out.data[i * 4 + 1] = c[1]; out.data[i * 4 + 2] = c[2]; out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Photo dimmed, with colour foreground (white), texture-only pixels (cyan) and dropped specks (orange). */
function maskImage(photo: RGBAImage, colour: Mask | undefined, texture: Mask | undefined, removed: Mask | undefined): RGBAImage {
  const out = createRGBA(photo.width, photo.height);
  const d = photo.data, o = out.data;
  for (let i = 0; i < photo.width * photo.height; i++) {
    let r = d[i * 4] * 0.35, g = d[i * 4 + 1] * 0.35, b = d[i * 4 + 2] * 0.35;
    const c = removed?.data[i] ? MASK_COLOURS.removed : texture?.data[i] ? MASK_COLOURS.texture : colour?.data[i] ? MASK_COLOURS.colour : null;
    if (c) { r = 0.35 * r + 0.65 * c[0]; g = 0.35 * g + 0.65 * c[1]; b = 0.35 * b + 0.65 * c[2]; }
    o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b; o[i * 4 + 3] = 255;
  }
  return out;
}

/** Modelled table colour over the photo (sRGB rendering of the quadratic Lab model). */
function backgroundImage(r: FeedbackReplay, w: number, h: number): RGBAImage {
  const bg = r.background!;
  const lab = { width: w, height: h, channels: 3, data: new Float32Array(w * h * 3) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) lab.data.set(backgroundAt(bg, ((x + 0.5) / w) * bg.width - 0.5, ((y + 0.5) / h) * bg.height - 0.5), (y * w + x) * 3);
  }
  return labToRgba(lab);
}

function textPanel(lines: [string, Color][], width: number): RGBAImage {
  return withHeader(createRGBA(width, 2, [24, 24, 28, 255]), lines.map((l) => [l]), TEXT);
}

/** One zoom row: app | current | score | mask around a photo point. */
function zoomRow(r: FeedbackReplay, title: [string, Color][], at: Point, extent: number, draw: (v: View, panel: 'app' | 'current' | 'other') => void): RGBAImage {
  const photo = r.photo!;
  const d = r.diagnostics!;
  const crop = { x: at.x - extent / 2, y: at.y - extent / 2, width: extent, height: extent };
  const tiles: [string, RGBAImage, 'app' | 'current' | 'other'][] = [['APP (FILE)', photo, 'app'], ['CURRENT', photo, 'current']];
  if (d.score) tiles.push(['SCORE', scoreImage(cropScore(d.score, crop), d.low ?? 3, d.high ?? 6), 'other']);
  tiles.push(['MASK', maskImage(photo, d.colour, d.texture, d.removed), 'other']);
  const panels = tiles.map(([name, src, kind]) => {
    // The score tile is pre-cropped (cheap colouring); everything else is cropped by the view.
    const v = name === 'SCORE' ? new View(src, { offset: { x: Math.round(crop.x), y: Math.round(crop.y) }, maxSide: TILE }) : new View(src, { crop, maxSide: TILE });
    draw(v, kind);
    return v.render([[[name, COLORS.white]]]);
  });
  const row = hstack(panels, 6);
  return vstack([textPanel(title, row.width), row], 0);
}

function cropScore(score: { width: number; height: number; data: Float32Array }, c: Rect): { width: number; height: number; data: Float32Array } {
  const w = Math.max(1, Math.round(c.width)), h = Math.max(1, Math.round(c.height));
  const x0 = Math.round(c.x), y0 = Math.round(c.y);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= score.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx >= 0 && sx < score.width) data[y * w + x] = score.data[sy * score.width + sx];
    }
  }
  return { width: w, height: h, data };
}

/** Write all inspection images and the summary; returns the summary text and the written paths. */
export function writeInspection(r: FeedbackReplay, outDir: string): { summary: string; files: string[] } {
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const save = (name: string, img: RGBAImage) => {
    const p = resolve(outDir, name);
    savePng(p, img);
    files.push(p);
  };
  const size = pieceSize(r);
  const s = r.resultScale;
  const b = r.bundle;
  const d = r.diagnostics;

  if (r.photo && r.original && r.current) {
    const date = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    // 1) What the app showed, with the user's marks.
    let v = new View(r.photo, { maxSide: MAX_SIDE });
    drawRegions(v, r.original, s);
    for (const p of r.placements) drawPlacement(v, p, false);
    for (const j of r.marks) drawMark(v, j, size, r.original, s, false);
    save('1-original.png', v.render([
      [[`APP RESULT FROM THE FILE (APP ${b.app.version}, ${date}): ${r.original.regions.length} REGIONS, ${b.marks.length} MARKS, ${b.scan!.placements.length} PLACEMENTS`, COLORS.white]],
      OUTLINE_LEGEND,
      [...MARK_LEGEND, ['P = PLACED BY THE USER', COLORS.white]],
    ]));

    // 2) The current pipeline with verdicts.
    const fixed = r.marks.filter((j) => j.fixed === true).length, judged = r.marks.filter((j) => j.fixed !== null).length;
    const pOk = r.placements.filter((p) => p.ok).length;
    v = new View(r.photo, { maxSide: MAX_SIDE });
    drawRegions(v, r.current, 1, new Set(r.marks.flatMap((j) => j.currentIds)));
    for (const p of r.placements) drawPlacement(v, p, true);
    for (const j of r.marks) drawMark(v, j, size, r.original, s, true);
    save('2-current.png', v.render([
      [[`CURRENT PIPELINE: ${r.current.regions.length} REGIONS (APP ${r.original.regions.length})${r.matched ? '' : ', SEGMENTATION ONLY (NO REFERENCE IN THE FILE)'}`, COLORS.white]],
      [[`MARKS FIXED ${fixed}/${judged}`, fixed === judged ? COLORS.ok : COLORS.bad], [`PLACEMENTS TOP-1 ${pOk}/${r.placements.length}`, pOk === r.placements.length ? COLORS.ok : COLORS.bad]],
      [['LABELS: GREEN = FIXED', COLORS.ok], ['RED = STILL WRONG', COLORS.bad], ['GRAY = NOT JUDGED', [160, 160, 160, 255]], ['NUMBERS = CURRENT REGION IDS', COLORS.white]],
      OUTLINE_LEGEND,
    ]));
  }

  if (r.photo && d?.score && r.current) {
    // 3) Score map.
    const low = d.low ?? 3, high = d.high ?? 6;
    const v = new View(scoreImage(d.score, low, high), { maxSide: MAX_SIDE });
    for (const reg of r.current.regions) v.polygon(reg.contour, [255, 255, 255, 140], 1);
    for (const j of r.marks) {
      v.circle(j.at, markRadius(v, size), MARK_COLOR[j.mark.kind], 2);
      v.label({ x: j.at.x, y: j.at.y - (markRadius(v, size) + 12) / v.scale }, `M${j.index}`, COLORS.white, [0, 0, 0, 200], TEXT);
    }
    const lines: HeaderLines = [
      [['FOREGROUND SCORE = COLOUR DISTANCE TO THE TABLE MODEL, IN TABLE SIGMAS', COLORS.white]],
      [[`BLACK/BLUE < LOW ${low.toFixed(1)}: TABLE`, heat(0.3)], [`CYAN..YELLOW = LOW..HIGH ${high.toFixed(1)}: PIECE ONLY IF CONNECTED TO RED`, heat(0.55)], ['RED/WHITE > HIGH: PIECE', heat(0.8)]],
      [['THIN WHITE = CURRENT OUTLINES, CIRCLES = MARKS. SCALE BAR BELOW: 0 .. 4 X HIGH', COLORS.white]],
    ];
    const bar = createRGBA(v.image.width, 18, [24, 24, 28, 255]);
    const barW = Math.min(bar.width - 16, 600);
    for (let x = 0; x < barW; x++) fillRect(bar, 8 + x, 2, 1, 14, scoreColor((x / barW) * 4 * high, low, high));
    save('3-score.png', withHeader(vstack([bar, v.image], 0), lines, TEXT));

    // 4) Mask.
    const m = new View(maskImage(r.photo, d.colour, d.texture, d.removed), { maxSide: MAX_SIDE });
    drawRegions(m, r.current, 1);
    for (const j of r.marks) {
      m.circle(j.at, markRadius(m, size), MARK_COLOR[j.mark.kind], 2);
      m.label({ x: j.at.x, y: j.at.y - (markRadius(m, size) + 12) / m.scale }, `M${j.index}`, COLORS.white, [0, 0, 0, 200], TEXT);
    }
    save('4-mask.png', m.render([
      [['WHITE = FOREGROUND BY COLOUR', MASK_COLOURS.colour], ['CYAN = ADDED BY THE TEXTURE CUE', MASK_COLOURS.texture], [`ORANGE = SPECKS DROPPED (< ${d.minArea} PX)`, MASK_COLOURS.removed]],
      [[`EXPECTED PIECE: BODY ${Math.round(d.refBody ?? 0)} PX, AREA ${Math.round(d.refArea ?? 0)} PX (FRAGMENT < 35%, PATCH > 180%)`, COLORS.white]],
      OUTLINE_LEGEND,
    ]));
  }

  if (r.photo && r.background) {
    // 5) Background model + statistics + quality reports.
    const bg = r.background;
    const tw = 640, th = Math.max(1, Math.round((tw * r.photo.height) / r.photo.width));
    const thumb = new View(r.photo, { maxSide: tw }).render([[['PHOTO', COLORS.white]]]);
    const modelImg = backgroundImage(r, tw, th);
    // Further table colours (patterned cloth, floor) as swatches in the top-left corner.
    bg.palette.forEach((p, k) => {
      const c = labToRgba({ width: 1, height: 1, channels: 3, data: Float32Array.from(p.color) }).data;
      fillRect(modelImg, 8 + k * 64, 8, 56, 56, [255, 255, 255, 255]);
      fillRect(modelImg, 10 + k * 64, 10, 52, 52, [c[0], c[1], c[2], 255]);
    });
    const model = new View(modelImg, { maxSide: tw }).render([[[bg.palette.length ? 'TABLE MODEL + FURTHER TABLE COLOURS (SWATCHES)' : 'TABLE MODEL (QUADRATIC LAB SURFACE)', COLORS.white]]]);
    const top = hstack([thumb, model]);
    const f1 = (x: number) => x.toFixed(1);
    save('5-background.png', vstack([top, textPanel([
      [`TABLE COLOUR LAB (${bg.color.map(f1).join(', ')}), SPREAD SIGMA (${bg.sigma.map(f1).join(', ')})`, COLORS.white],
      [`LIGHTING RATIO ${bg.lightingRatio.toFixed(2)} (WARN > 3.5), NOISE ${f1(bg.noise)} GRAY LEVELS, PRE-SMOOTHING RADIUS ${bg.smoothing}`, COLORS.white],
      [`THRESHOLD HIGH ${f1(d?.high ?? bg.threshold)} LOW ${f1(d?.low ?? 0)}, SEPARABILITY ${bg.separability.toFixed(2)}, OUTLINE CONTRAST ${f1(bg.outlineContrast)} (LOW < 7.5), TABLE ${(100 * bg.coverage).toFixed(0)}% OF THE PHOTO`, COLORS.white],
      [`TABLE MODEL EXPLAINS ${(100 * bg.bandFit).toFixed(0)}% OF THE BORDER; FURTHER TABLE COLOURS: ${bg.palette.length ? bg.palette.map((p) => `LAB (${p.color.map(f1).join(', ')}) IN ${(100 * p.interior).toFixed(0)}% OF THE MIDDLE`).join('; ') : 'NONE'}`, COLORS.white],
      [`JPEG BLOCKINESS ${(d?.blockiness ?? 1).toFixed(2)} (OUTLINES SNAPPED TO BRIGHTNESS EDGES FROM 1.3)`, COLORS.white],
      [`QUALITY NOW: ${issuesText(r.current?.quality)}`, COLORS.ambiguous],
      [`QUALITY IN THE APP: ${issuesText(r.original?.quality)}`, COLORS.unmatched],
    ], top.width)], 4));
  }

  if (r.photo && d && r.original && r.current) {
    // 6) Zooms: every mark, and every placement that is not top-1 now.
    const rows: RGBAImage[] = [];
    const orig = r.original, cur = r.current;
    const extentOf = (ids: number[], res: ScanResult, sc: number) =>
      ids.reduce((e, id) => {
        const reg = res.regions.find((x) => x.id === id);
        return reg ? Math.max(e, reg.bbox.width * sc, reg.bbox.height * sc) : e;
      }, 0);
    for (const j of r.marks) {
      const ids = 'regionId' in j.mark ? [j.mark.regionId] : [];
      const extent = Math.max(2.4 * size, 1.4 * extentOf(ids, orig, s), 1.4 * extentOf(j.currentIds, cur, 1), 120);
      const title: [string, Color][] = [[`M${j.index} ${MARK_TEXT[j.mark.kind]}: ${j.verdict}`, verdictColor(j.fixed)], [`APP: ${j.original}`, COLORS.white], [`NOW: ${j.now}`, COLORS.white]];
      if (j.why) title.push([`WHY: ${j.why}`, COLORS.ambiguous]);
      rows.push(zoomRow(r, title, j.at, extent, (v, panel) => {
        if (panel === 'app') drawRegions(v, orig, s, ids.length ? new Set(ids) : undefined, true);
        else drawRegions(v, cur, 1, new Set(j.currentIds), true);
        v.circle(j.at, Math.max(10, 0.25 * size * v.scale), MARK_COLOR[j.mark.kind], 2);
      }));
    }
    for (const p of r.placements.filter((x) => !x.ok)) {
      rows.push(zoomRow(r, [
        [`PLACEMENT #${p.regionId} ${formatCells(p.cells)}: NOT TOP-1 NOW`, COLORS.bad],
        [`APP: ${formatCells(p.originalCells)}; NOW: ${formatCells(p.currentCells)} (REGIONS #${p.currentIds.join(',#') || '-'})`, COLORS.white],
      ], p.at, Math.max(2.4 * size, 1.4 * Math.max(p.bbox.width, p.bbox.height), 120), (v, panel) => {
        if (panel === 'app') drawRegions(v, orig, s, undefined, true);
        else drawRegions(v, cur, 1, new Set(p.currentIds), true);
      }));
    }
    const perPage = 4;
    for (let k = 0; k < rows.length; k += perPage) save(`6-marks-${k / perPage + 1}.png`, vstack(rows.slice(k, k + perPage), 16));
  }

  if (r.box && r.boxPhoto) {
    // 7) Box.
    const bx = r.box;
    const v = new View(r.boxPhoto, { maxSide: MAX_SIDE });
    for (const c of bx.detection.candidates.slice(1, 4)) v.polygon(c.quad, [170, 170, 170, 200], 1);
    v.polygon(bx.userQuad, COLORS.user, 3);
    v.polygon(bx.detection.quad, COLORS.detected, 2);
    const names = ['TL', 'TR', 'BR', 'BL'];
    const diag = Math.hypot(bx.userQuad[2].x - bx.userQuad[0].x, bx.userQuad[2].y - bx.userQuad[0].y);
    bx.userQuad.forEach((q, i) => {
      const e = Math.hypot(bx.detection.quad[i].x - q.x, bx.detection.quad[i].y - q.y);
      v.label(q, `${names[i]} ${Math.round(e)} PX`, COLORS.white, e > 0.02 * diag ? [150, 20, 20, 230] : [20, 110, 40, 230], TEXT);
    });
    save('7-box.png', v.render([
      [[`BOX: MAX CORNER ERROR ${(100 * bx.error).toFixed(1)}% OF THE DIAGONAL (${Math.round(bx.errorPx)} PX), CONFIDENCE ${bx.detection.confidence.toFixed(2)}`, bx.error < 0.02 ? COLORS.ok : COLORS.bad]],
      [['GREEN = USER QUAD', COLORS.user], ['CYAN = DETECTBOX NOW', COLORS.detected], ['GRAY = OTHER CANDIDATES', COLORS.unmatched]],
      [[`BOX QUALITY NOW: ${issuesText(bx.detection.quality)}`, COLORS.white]],
    ]));
  }

  const summary = formatSummary(r);
  writeFileSync(resolve(outDir, 'summary.txt'), summary + '\n');
  files.push(resolve(outDir, 'summary.txt'));
  const json = {
    name: r.name, app: b.app, puzzle: b.puzzle, comment: b.comment, notes: r.notes, metrics: feedbackMetrics(r), timings: r.timings,
    marks: r.marks,
    placements: r.placements,
    box: r.box ? { userQuad: r.box.userQuad, detected: r.box.detection.quad, confidence: r.box.detection.confidence, error: r.box.error, errorPx: r.box.errorPx } : null,
    background: r.background,
    regions: d?.regions,
    quality: { app: r.original?.quality, now: r.current?.quality },
  };
  writeFileSync(resolve(outDir, 'replay.json'), JSON.stringify(json, null, 2));
  files.push(resolve(outDir, 'replay.json'));
  return { summary, files };
}

function pad(t: string, n: number): string {
  return t.length >= n ? t.slice(0, n - 2) + '… ' : t + ' '.repeat(n - t.length);
}

/** Compact text summary (also written to summary.txt). */
export function formatSummary(r: FeedbackReplay): string {
  const b = r.bundle;
  const lines: string[] = [];
  const date = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`${r.name}  app ${b.app.version}  ${date}  ${b.puzzle.pieceCount} pieces (${b.puzzle.grid.rows}x${b.puzzle.grid.cols}, ${b.puzzle.cut})${b.comment ? `  "${b.comment}"` : ''}`);
  if (r.photo && r.original && r.current) {
    lines.push(`scan ${r.photo.width}x${r.photo.height}: regions app ${r.original.regions.length} -> now ${r.current.regions.length}${r.matched ? '' : ' (segmentation only: no reference in the file)'}`);
    lines.push(`  quality app: ${issuesText(r.original.quality)}`);
    lines.push(`  quality now: ${issuesText(r.current.quality)}`);
  } else lines.push('no scan in the file');
  if (r.background) {
    const bg = r.background;
    lines.push(`  table Lab (${bg.color.map((x) => x.toFixed(0)).join(',')}) sigma (${bg.sigma.map((x) => x.toFixed(1)).join(',')}) noise ${bg.noise.toFixed(1)} smoothing ${bg.smoothing} threshold ${bg.threshold.toFixed(1)} separability ${bg.separability.toFixed(2)} outline contrast ${bg.outlineContrast.toFixed(1)} lighting ${bg.lightingRatio.toFixed(2)}`);
    lines.push(`  table fit ${(100 * bg.bandFit).toFixed(0)}% of border, palette ${bg.palette.length ? bg.palette.map((p) => `Lab(${p.color.map((x) => x.toFixed(0)).join(',')}) ${(100 * p.interior).toFixed(0)}% inside`).join(', ') : 'none'}, jpeg blockiness ${(r.diagnostics?.blockiness ?? 1).toFixed(2)}`);
  }
  if (r.marks.length > 0) {
    lines.push('');
    lines.push(pad('mark', 5) + pad('kind', 13) + pad('target', 12) + pad('verdict', 16) + 'app -> now');
    for (const j of r.marks) {
      const target = j.mark.kind === 'missed' ? `(${Math.round(j.at.x)},${Math.round(j.at.y)})` : `#${j.mark.regionId}`;
      lines.push(pad(`M${j.index}`, 5) + pad(j.mark.kind, 13) + pad(target, 12) + pad(j.verdict, 16) + `${j.original} -> ${j.now}`);
      if (j.why) lines.push(' '.repeat(46) + `why: ${j.why}`);
    }
  }
  if (r.placements.length > 0) {
    const ok = r.placements.filter((p) => p.ok).length, okApp = r.placements.filter((p) => p.originalOk).length;
    lines.push('');
    lines.push(`placements: top-1 now ${ok}/${r.placements.length} (app ${okApp}/${r.placements.length})${r.matched ? '' : ' - not judged without reference'}`);
    for (const p of r.placements.filter((x) => !x.ok)) lines.push(`  #${p.regionId} ${formatCells(p.cells)}: app ${formatCells(p.originalCells)}, now ${formatCells(p.currentCells)} (regions #${p.currentIds.join(',#') || '-'})`);
  }
  if (r.box) lines.push(`box: corner error ${(100 * r.box.error).toFixed(1)}% (${Math.round(r.box.errorPx)} px), confidence ${r.box.detection.confidence.toFixed(2)}, ${Math.round(r.box.ms)} ms`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  const m = feedbackMetrics(r);
  lines.push('');
  lines.push('metrics: ' + Object.entries(m).filter(([k]) => k !== 'ms').map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(3)}`).join('  ') + `  (${Math.round(m.ms ?? 0)} ms)`);
  return lines.join('\n');
}

