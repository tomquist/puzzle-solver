/**
 * Visual building blocks shared by the item detail sheet and the guided placing mode:
 * - PickupView: the item in the scan photo with a few pieces of surroundings (to find it on the
 *   table), framed by corner marks that don't cover it, its "top" edge marked; tap for a close-up
 * - TargetZoomView / TargetContext: the box picture around the target (about 7 × 7 cells, upright
 *   like the puzzle on the table), the target outlined thinly and the rest slightly dimmed, plus an
 *   overview of the whole picture with a crosshair on the spot. The zoom view can be pinched.
 * - CertaintyMeter: how sure a place is, in words
 * (How to turn the item: TurnGuide.)
 */
import { useState, type CSSProperties } from 'react';
import type { CellRef, DetectedRegion, GridSpec } from '../../model/types';
import { blockRect, cellsOutlinePath, closeupSquare, cornerBrackets, insetCorner, itemPieceSize, outsideMaskPath, overviewMarker, pickupRect, shiftInside, targetContext, topBarFor, topLabelSpot, type TopBar } from '../lib/framing';
import type { CellBounds, ItemPlacement, ScanItem } from '../lib/items';
import { CERTAINTY_STEPS, CERTAINTY_WORD, type Certainty } from '../lib/certainty';
import { CropCanvas } from './CropCanvas';
import { IconZoom } from './Icons';
import { ZoomPanView } from './ZoomPanView';

export type ReferenceImage = { bitmap?: ImageBitmap; url?: string; width: number; height: number };

/** Upscaling limit for the box picture (screen px per picture px) – beyond this it gets blurry. */
const MAX_PICTURE_ZOOM = 2.5;

/**
 * How sure a place is: a word and a three-step meter (no percentage – the matcher's confidence is
 * not calibrated; lib/certainty.ts).
 */
export function CertaintyMeter({ certainty, text }: { certainty: Certainty; text?: string }) {
  const steps = CERTAINTY_STEPS[certainty];
  return (
    <span className={`cert cert-${certainty}`} data-testid="certainty" data-certainty={certainty}>
      <span className="cert-steps" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i < steps ? 'on' : undefined} />
        ))}
      </span>
      <span className="cert-word">{text ?? CERTAINTY_WORD[certainty]}</span>
    </span>
  );
}

/**
 * The item in the scan photo, as it lies on the table: about 3–4 piece sizes of surroundings with
 * corner marks around it, or (tap) a close-up of just the item. A "top" bar marks the edge that
 * must end up on top (when the turn is known), so it can be found on the real piece. Give it a
 * `key` per item so a new item starts with the surroundings.
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
  const near = closeupSquare(item.bbox);
  const rect = closeup ? { x: near.cx - near.side / 2, y: near.cy - near.side / 2, width: near.side, height: near.side } : pickupRect(item.bbox, piece, photoWidth, photoHeight);
  const marks = cornerBrackets(item.bbox, piece * 0.4, piece * 0.12);
  const top = rotationDeg !== undefined ? topBarFor(item, regions, rotationDeg) : undefined;
  // The word "top" next to the bar (the CSS moves it by its own size along --ux/--uy).
  const labelAt = (t: TopBar) => {
    const s = topLabelSpot(t, rect);
    return { '--x': `${s.x}%`, '--y': `${s.y}%`, '--ux': s.dir.x.toFixed(3), '--uy': s.dir.y.toFixed(3) } as CSSProperties;
  };
  return (
    <button
      type="button"
      className={`pickup${closeup ? ' closeup' : ''}`}
      onClick={() => setCloseup((c) => !c)}
      aria-pressed={closeup}
      aria-label={`${label}${top ? ', the edge marked "top" goes on top' : ''}. ${closeup ? 'Tap to show its surroundings.' : 'Tap for a close-up.'}`}
      data-testid="pickup"
    >
      {closeup ? (
        <CropCanvas source={photo} rotated={{ ...near, rotationDeg: 0 }} size={size} label={`${label}, close-up`} />
      ) : (
        <CropCanvas source={photo} rect={rect} size={size} label={label} />
      )}
      <svg className="crop-overlay" viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} preserveAspectRatio="none" aria-hidden="true">
        {!closeup && (
          <>
            <path className="pick-marks-under" d={marks} vectorEffect="non-scaling-stroke" />
            <path className="pick-marks" d={marks} vectorEffect="non-scaling-stroke" />
          </>
        )}
        {top && (
          <g data-testid="top-bar">
            <line className="top-bar-under" x1={top.from.x} y1={top.from.y} x2={top.to.x} y2={top.to.y} vectorEffect="non-scaling-stroke" />
            <line className="top-bar" x1={top.from.x} y1={top.from.y} x2={top.to.x} y2={top.to.y} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      {top && (
        <span className="top-label" style={labelAt(top)} aria-hidden="true">
          top
        </span>
      )}
      <span className="pickup-chip" aria-hidden="true">
        {closeup ? 'Close-up' : <IconZoom size={18} />}
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
