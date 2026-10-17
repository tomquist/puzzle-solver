/**
 * Zoom & pan viewport for an image plus overlays (pinch, wheel, drag, double-tap, +/- buttons).
 * Children are laid out in content coordinates (contentWidth × contentHeight CSS px before scaling).
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Point } from '../../cv/geometry';
import { useElementSize } from '../hooks/useElementSize';
import { centerOn, clampPan, fitTransform, zoomAt, type ViewTransform } from '../lib/overlay';
import { IconExpand, IconPlus } from './Icons';

export interface ZoomPanHandle {
  /** Center the view on a content point, zooming to `zoom` × the fit scale (default 3). */
  focus(p: Point, zoom?: number): void;
  reset(): void;
}

const TAP_SLOP = 6;

export function ZoomPanView({
  contentWidth,
  contentHeight,
  children,
  className = '',
  handle,
  label,
  margin = 0,
}: {
  contentWidth: number;
  contentHeight: number;
  /** Content, or a render function receiving the current scale (screen px per content px). */
  children: ReactNode | ((scale: number) => ReactNode);
  className?: string;
  handle?: Ref<ZoomPanHandle>;
  label?: string;
  /** Free space (CSS px) around the content when fitted, e.g. for markers on the edges. */
  margin?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const { width: vw, height: vh } = useElementSize(viewport);
  const [t, setT] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const lastFit = useRef<ViewTransform | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ moved: boolean; start: Point; last: Point; pinchDist?: number; pinchMid?: Point }>({
    moved: false,
    start: { x: 0, y: 0 },
    last: { x: 0, y: 0 },
  });
  const suppressClick = useRef(false);

  const fit = fitTransform(contentWidth, contentHeight, vw, vh, Math.min(margin, Math.min(vw, vh) / 8));
  const minScale = fit.scale;
  const maxScale = Math.max(fit.scale * 6, 2.5);
  const tRef = useRef(t);
  tRef.current = t;

  const apply = useCallback(
    (next: ViewTransform) => {
      const fitScale = lastFit.current?.scale ?? 0;
      // At (or below) the fit scale the content simply stays fitted and centered.
      setT(next.scale <= fitScale * 1.001 && lastFit.current ? lastFit.current : clampPan(next, contentWidth, contentHeight, vw, vh));
    },
    [contentWidth, contentHeight, vw, vh],
  );

  // Fit on first layout; on resize keep the zoom only if the user had zoomed in.
  useLayoutEffect(() => {
    if (!vw || !vh) return;
    const prev = lastFit.current;
    lastFit.current = fit;
    const zoomed = prev && tRef.current.scale > prev.scale * 1.02;
    if (!zoomed) setT(fit);
    else setT((cur) => clampPan(cur, contentWidth, contentHeight, vw, vh));
  }, [vw, vh, contentWidth, contentHeight, fit.scale]);

  useImperativeHandle(
    handle,
    () => ({
      focus(p: Point, zoom = 3) {
        const scale = Math.min(maxScale, Math.max(fit.scale, fit.scale * zoom));
        apply(centerOn(p, scale, vw, vh));
      },
      reset() {
        setT(fit);
      },
    }),
    [apply, fit, maxScale, vw, vh],
  );

  // Wheel zoom needs a non-passive listener.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      apply(zoomAt(tRef.current, factor, { x: e.clientX - r.left, y: e.clientY - r.top }, minScale, maxScale));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply, minScale, maxScale]);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = viewport.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      gesture.current = { moved: false, start: p, last: p };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture.current.moved = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (pointers.current.size >= 2 && g.pinchDist && g.pinchMid) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let next = zoomAt(tRef.current, dist / g.pinchDist, mid, minScale, maxScale);
      next = { ...next, x: next.x + mid.x - g.pinchMid.x, y: next.y + mid.y - g.pinchMid.y };
      apply(next);
      g.pinchDist = dist;
      g.pinchMid = mid;
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < TAP_SLOP) return;
    if (!g.moved) {
      g.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const cur = tRef.current;
    apply({ scale: cur.scale, x: cur.x + p.x - g.last.x, y: cur.y + p.y - g.last.y });
    g.last = p;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (gesture.current.moved) suppressClick.current = true;
    if (pointers.current.size < 2) gesture.current.pinchDist = undefined;
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      gesture.current.last = p;
    }
  };

  const zoomBy = (factor: number) => {
    apply(zoomAt(tRef.current, factor, { x: vw / 2, y: vh / 2 }, minScale, maxScale));
  };

  const zoomedIn = t.scale > fit.scale * 1.05;

  return (
    <div className={`zoompan ${className}`}>
      <div
        ref={viewport}
        className="zoompan-viewport"
        role="group"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.stopPropagation();
            e.preventDefault();
            suppressClick.current = false;
          }
        }}
        onDoubleClick={(e) => {
          if (zoomedIn) setT(fit);
          else apply(zoomAt(tRef.current, 2.5, local(e), minScale, maxScale));
        }}
      >
        <div
          className="zoompan-content"
          style={{
            width: contentWidth,
            height: contentHeight,
            transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          }}
        >
          {typeof children === 'function' ? children(t.scale) : children}
        </div>
      </div>
      <div className="zoompan-controls">
        <button className="icon-btn small glass zoom-step" onClick={() => zoomBy(1.6)} aria-label="Zoom in">
          <IconPlus size={18} />
        </button>
        <button className="icon-btn small glass zoom-step" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">
          <span className="minus" aria-hidden="true" />
        </button>
        {zoomedIn && (
          <button
            className="icon-btn small glass"
            onClick={() => setT(fit)}
            aria-label="Show whole picture"
          >
            <IconExpand size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
