/**
 * Visual building blocks shared by the item detail sheet and the guided placing mode:
 * - PickupView: the item in the scan photo with a few pieces of surroundings (to find it on the
 *   table), framed by corner marks that don't cover it; tap for an upright close-up
 * - TargetZoomView / TargetContext: the box picture around the target (about 7 × 7 cells, upright
 *   like the puzzle on the table), the target outlined thinly and the rest slightly dimmed, plus an
 *   overview of the whole picture with a crosshair on the spot. The zoom view can be pinched.
 * - TurnInstruction / ConfidenceBar
 */
import { useState } from 'react';
import type { CellRef, DetectedRegion, GridSpec } from '../../model/types';
import { blockRect, cellsOutlinePath, closeupSquare, cornerBrackets, insetCorner, itemPieceSize, outsideMaskPath, overviewMarker, pickupRect, shiftInside, targetContext } from '../lib/framing';
import type { CellBounds, ItemPlacement, ScanItem } from '../lib/items';
import { confidencePercent } from '../lib/pieces';
import { turnInstruction } from '../lib/rotation';
import { CropCanvas } from './CropCanvas';
import { IconZoom } from './Icons';
import { ZoomPanView } from './ZoomPanView';

export type ReferenceImage = { bitmap?: ImageBitmap; url?: string; width: number; height: number };

/** Upscaling limit for the box picture (screen px per picture px) – beyond this it gets blurry. */
const MAX_PICTURE_ZOOM = 2.5;

export function ConfidenceBar({ value }: { value: number }) {
  const pct = confidencePercent(value);
  const tone = value >= 0.7 ? 'ok' : value >= 0.35 ? 'warn' : 'bad';
  return (
    <div className="conf" title={`${pct}% confidence`}>
      <div className="conf-track">
        <div className={`conf-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="conf-num tabular">{pct}%</span>
    </div>
  );
}

/**
 * The item in the scan photo with about 3–4 piece sizes of surroundings, corner marks around it.
 * Tapping toggles a close-up of just the item, turned upright (`rotationDeg`) like it will lie in
 * the puzzle. Give it a `key` per item so a new item starts with the surroundings.
 */
export function PickupView({
  item,
  regions,
  photo,
  photoWidth,
  photoHeight,
  rotationDeg,
  size = 240,
  label,
}: {
  item: ScanItem;
  regions: DetectedRegion[];
  photo: CanvasImageSource | undefined;
  photoWidth: number;
  photoHeight: number;
  rotationDeg: number | undefined;
  size?: number;
  label: string;
}) {
  const [closeup, setCloseup] = useState(false);
  const piece = itemPieceSize(item, regions);
  const rect = pickupRect(item.bbox, piece, photoWidth, photoHeight);
  const marks = cornerBrackets(item.bbox, piece * 0.4, piece * 0.12);
  const upright = rotationDeg !== undefined;
  return (
    <button
      type="button"
      className={`pickup${closeup ? ' closeup' : ''}`}
      onClick={() => setCloseup((c) => !c)}
      aria-pressed={closeup}
      aria-label={closeup ? `${label}: close-up${upright ? ', turned upright' : ''}. Tap to show its surroundings.` : `${label}. Tap for a close-up.`}
      data-testid="pickup"
    >
      {closeup ? (
        <CropCanvas source={photo} rotated={{ ...closeupSquare(item.bbox), rotationDeg: rotationDeg ?? 0 }} size={size} label={`${label}, close-up`} />
      ) : (
        <>
          <CropCanvas source={photo} rect={rect} size={size} label={label} />
          <svg className="crop-overlay" viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} preserveAspectRatio="none" aria-hidden="true">
            <path className="pick-marks-under" d={marks} vectorEffect="non-scaling-stroke" />
            <path className="pick-marks" d={marks} vectorEffect="non-scaling-stroke" />
          </svg>
        </>
      )}
      <span className="pickup-chip" aria-hidden="true">
        {closeup ? (upright ? 'Turned upright' : 'Close-up') : <IconZoom size={18} />}
      </span>
    </button>
  );
}

/** Target outline (white with a dark halo) and a light dim over the rest of the picture. */
function TargetMarks({ cells, grid, width, height }: { cells: CellRef[]; grid: GridSpec; width: number; height: number }) {
  const outline = cellsOutlinePath(cells, grid, width, height);
  return (
    <>
      <path className="target-dim" d={outsideMaskPath(cells, grid, width, height)} fillRule="evenodd" />
      <path className="target-outline-under" d={outline} vectorEffect="non-scaling-stroke" />
      <path className="target-outline" d={outline} vectorEffect="non-scaling-stroke" data-testid="target-outline" />
    </>
  );
}

const targetCells = (p: ItemPlacement): CellRef[] => (p.cells.length ? p.cells : [{ row: p.bounds.row0, col: p.bounds.col0 }]);

/**
 * The whole box picture with a crosshair and a small box on the target – readable on light and
 * dark pictures (white lines with a dark halo).
 */
export function Overview({ reference, grid, bounds, className = '' }: { reference: ReferenceImage; grid: GridSpec; bounds: CellBounds; className?: string }) {
  if (!reference.url) return null;
  const { width: W, height: H } = reference;
  const m = overviewMarker(blockRect(bounds, grid, W, H), W, H);
  // Tall pictures get a narrower inset so it never covers too much of the view (see CSS).
  const style = { aspectRatio: `${W} / ${H}`, ['--ov-w' as string]: `${Math.round(Math.min(1, W / H) * 100)}%`, ['--ov-ar' as string]: (W / H).toFixed(4) };
  return (
    <div className={`overview ${className}`} style={style} data-testid="overview">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Where it goes in the whole picture">
        <image href={reference.url} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
        <path className="ov-cross-under" d={m.cross} vectorEffect="non-scaling-stroke" />
        <path className="ov-cross" d={m.cross} vectorEffect="non-scaling-stroke" />
        <rect className="ov-box-under" x={m.box.x} y={m.box.y} width={m.box.width} height={m.box.height} vectorEffect="non-scaling-stroke" />
        <rect className="ov-box" x={m.box.x} y={m.box.y} width={m.box.width} height={m.box.height} vectorEffect="non-scaling-stroke" data-testid="overview-marker" />
      </svg>
    </div>
  );
}

/**
 * Where the item goes, for the placing mode: the box picture (pinch / double-tap to zoom) starting
 * on about 7 × 7 cells around the target, never blown up past MAX_PICTURE_ZOOM, with the overview
 * inset in the top corner away from the target. Give it a `key` per placement.
 */
export function TargetZoomView({ placement, grid, reference, label }: { placement: ItemPlacement; grid: GridSpec; reference: ReferenceImage | undefined; label: string }) {
  if (!reference?.url) return <div className="target-frame viewer-frame placeholder" data-testid="target-view" />;
  const { width: W, height: H } = reference;
  const context = targetContext(placement.bounds, grid, W, H);
  const corner = insetCorner(blockRect(placement.bounds, grid, W, H), context, W, H);
  return (
    <div className="target-frame viewer-frame" data-testid="target-view">
      <ZoomPanView contentWidth={W} contentHeight={H} start={context} maxZoom={MAX_PICTURE_ZOOM} label={label} startLabel="Back to the spot">
        <img src={reference.url} alt="" className="fill" draggable={false} />
        <svg className="overlay target-overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <TargetMarks cells={targetCells(placement)} grid={grid} width={W} height={H} />
        </svg>
      </ZoomPanView>
      <Overview reference={reference} grid={grid} bounds={placement.bounds} className={`overview-inset ${corner}`} />
    </div>
  );
}

/** Static version of TargetZoomView (inside the scrolling details sheet). */
export function TargetContext({ placement, grid, reference, size = 360, label }: { placement: ItemPlacement; grid: GridSpec; reference: ReferenceImage | undefined; size?: number; label: string }) {
  if (!reference) return <div className="target-context placeholder" style={{ aspectRatio: '1 / 1' }} />;
  const { width: W, height: H } = reference;
  const context = targetContext(placement.bounds, grid, W, H, { minWidth: size / MAX_PICTURE_ZOOM });
  const rect = shiftInside(context, W, H);
  const corner = insetCorner(blockRect(placement.bounds, grid, W, H), context, W, H);
  return (
    <div className="target-context" data-testid="target-context">
      <CropCanvas source={reference.bitmap} rect={rect} size={size} label={label} />
      <svg className="crop-overlay" viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} preserveAspectRatio="none" aria-hidden="true">
        <TargetMarks cells={targetCells(placement)} grid={grid} width={W} height={H} />
      </svg>
      <Overview reference={reference} grid={grid} bounds={placement.bounds} className={`overview-inset ${corner}`} />
    </div>
  );
}

/** "Turn ↻ 90°" with the exact angle underneath (or "Already upright"). */
export function TurnInstruction({ rotationDeg, compact = false }: { rotationDeg: number | undefined; compact?: boolean }) {
  if (rotationDeg === undefined) return null;
  const t = turnInstruction(rotationDeg);
  return (
    <div className={compact ? 'turn compact' : 'turn'}>
      <div className="turn-main">{t.short}</div>
      {t.exact && !compact && <div className="muted small">{t.exact}</div>}
    </div>
  );
}
