/**
 * "Show the fit" on the scan photo: the moving item, cut out of the photo along its outline, lifts
 * off its spot (a faint dashed ghost stays there), glides along the connection line to its docked
 * pose next to the other item – turning on the way so it lies the way that one lies on the
 * table – clicks in with a pulse at the seam, holds, and fades back. About 2.5 s.
 *
 * One pre-drawn image moved by Web Animations transforms (compositor work, no React render or
 * repaint of the overlay per frame); paused while the view is panned or pinched (ZoomPanView's
 * data-moving). Reduced motion: no glide – a static ghost of the item already docked, with the
 * seam marked. Lives inside a ZoomPanView's content (photo coordinates = CSS px).
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import type { Point } from '../../cv/geometry';
import type { DetectedRegion } from '../../model/types';
import { usePieceCutout } from '../hooks/usePieceCutout';
import type { FitPose } from '../lib/fit';
import { closeupSquare } from '../lib/framing';
import type { ScanItem } from '../lib/items';
import { polygonPath } from '../lib/overlay';

export const FIT_MS = 2500;
/** Phases as fractions of FIT_MS: lift, glide, settle (click), hold, fade. */
const LIFT = 0.08;
const DOCK = 0.5;
const SETTLE = 0.55;
const HOLD = 0.9;

const easeInOut = (s: number) => (s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);

export function FitAnimation({
  mover,
  regions,
  photo,
  width,
  height,
  pose,
  path,
  reduced,
  onDone,
}: {
  mover: ScanItem;
  regions: DetectedRegion[];
  photo: CanvasImageSource | undefined;
  /** Photo size. */
  width: number;
  height: number;
  pose: FitPose;
  /** Where the pivot passes, from pose.pivot to pose.docked (glidePath). */
  path: Point[];
  reduced: boolean;
  onDone: () => void;
}) {
  const url = usePieceCutout(photo, mover, regions, mover.pieceCount > 1 ? 640 : 420);
  const moverEl = useRef<HTMLDivElement>(null);
  const seamEl = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const sq = closeupSquare(mover.bbox);
  const left = sq.cx - sq.side / 2;
  const top = sq.cy - sq.side / 2;
  const { pivot, docked, rotateDeg, seam } = pose;
  const docking = `translate(${docked.x - pivot.x}px, ${docked.y - pivot.y}px) rotate(${rotateDeg}deg)`;
  const outlines = mover.regionIds.flatMap((id) => {
    const r = regions.find((x) => x.id === id);
    return r && r.contour.length > 2 ? [polygonPath(r.contour)] : [];
  });
  const seamAngle = seam ? (Math.atan2(seam.along.y, seam.along.x) * 180) / Math.PI : 0;

  useEffect(() => {
    if (reduced || !url) return;
    const el = moverEl.current;
    if (!el) return;
    const at = (p: Point, s: number, scale: number) => `translate(${p.x - pivot.x}px, ${p.y - pivot.y}px) rotate(${rotateDeg * s}deg) scale(${scale})`;
    const n = path.length - 1;
    const frames: Keyframe[] = [
      { offset: 0, transform: at(pivot, 0, 1), opacity: 0 },
      { offset: LIFT * 0.5, opacity: 1 },
      { offset: LIFT, transform: at(pivot, 0, 1.05), opacity: 1 },
    ];
    // The glide: eased in time, along the path, turning as it goes.
    for (let k = 1; k <= n; k++) {
      const s = k / n;
      frames.push({ offset: LIFT + (DOCK - LIFT) * easeInvert(s), transform: at(path[k], s, 1.05), opacity: 1 });
    }
    frames.push(
      { offset: SETTLE, transform: at(docked, 1, 1), opacity: 1 },
      { offset: HOLD, transform: at(docked, 1, 1), opacity: 1 },
      { offset: 1, transform: at(docked, 1, 1), opacity: 0 },
    );
    const anims = [el.animate(frames, { duration: FIT_MS, fill: 'both' })];
    const seamNode = seamEl.current;
    if (seamNode) {
      anims.push(
        seamNode.animate(
          [
            { opacity: 0, transform: `rotate(${seamAngle}deg) scale(0.5, 1)` },
            { opacity: 1, transform: `rotate(${seamAngle}deg) scale(1.15, 1.6)`, offset: 0.35 },
            { opacity: 0, transform: `rotate(${seamAngle}deg) scale(1, 1)` },
          ],
          { duration: FIT_MS * 0.22, delay: FIT_MS * (DOCK + 0.01), fill: 'both' },
        ),
      );
    }
    anims[0].onfinish = () => doneRef.current();
    // Pause while the view is panned or pinched.
    const viewport = layer.current?.closest('.zoompan-viewport');
    const watch = new MutationObserver(() => {
      const moving = viewport?.hasAttribute('data-moving');
      for (const a of anims) {
        if (moving && a.playState === 'running') a.pause();
        else if (!moving && a.playState === 'paused') a.play();
      }
    });
    if (viewport) watch.observe(viewport, { attributes: true, attributeFilter: ['data-moving'] });
    return () => {
      watch.disconnect();
      for (const a of anims) a.cancel();
    };
    // The pose and path are fixed for one showing (the parent remounts for a replay).
  }, [reduced, url]);

  const boxStyle: CSSProperties = {
    left,
    top,
    width: sq.side,
    height: sq.side,
    transformOrigin: `${pivot.x - left}px ${pivot.y - top}px`,
  };
  return (
    <div className="fit-layer" ref={layer} aria-hidden="true" data-testid="fit" data-mode={reduced ? 'static' : 'animate'}>
      <svg className="overlay fit-marks" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {/* Its real spot: a faint dashed ghost while it is away. */}
        {outlines.map((d, i) => (
          <path key={`g${i}`} className="fit-ghost" d={d} />
        ))}
        {reduced &&
          outlines.map((d, i) => (
            <path
              key={`d${i}`}
              className="fit-docked"
              d={d}
              transform={`translate(${docked.x - pivot.x} ${docked.y - pivot.y}) rotate(${rotateDeg} ${pivot.x} ${pivot.y})`}
            />
          ))}
      </svg>
      <div
        ref={moverEl}
        className={`fit-mover${reduced ? ' static' : ''}`}
        style={reduced ? { ...boxStyle, transform: docking } : { ...boxStyle, opacity: 0 }}
        data-testid="fit-mover"
        data-docked-x={docked.x.toFixed(1)}
        data-docked-y={docked.y.toFixed(1)}
        data-rotate={rotateDeg.toFixed(1)}
      >
        {url && <img src={url} alt="" draggable={false} />}
        {/* The pivot (the touching cell's centre), to check where it lands. */}
        <i className="fit-pivot" style={{ left: pivot.x - left, top: pivot.y - top }} data-testid="fit-pivot" />
      </div>
      {seam && (
        <div
          ref={seamEl}
          className={`fit-seam${reduced ? ' static' : ''}`}
          style={{ left: seam.center.x - seam.length * 0.4, top: seam.center.y, width: seam.length * 0.8, transform: `rotate(${seamAngle}deg)`, opacity: reduced ? 1 : 0 }}
          data-testid="fit-seam"
        />
      )}
    </div>
  );
}

/** The time (0..1) at which the eased glide has covered `s` of its way (the inverse of easeInOut). */
function easeInvert(s: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (easeInOut(mid) < s) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
