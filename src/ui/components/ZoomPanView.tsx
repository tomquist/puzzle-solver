/**
 * Zoom & pan viewport for an image plus overlays (pinch, wheel, drag, double-tap, +/- buttons).
 * Children are laid out in content coordinates (contentWidth × contentHeight CSS px before scaling).
 * Optionally it starts on a part of the content (`start`) and offers a button back to it.
 *
 * Touch: while the content is at its fit zoom, a one-finger vertical drag scrolls the page
 * (touch-action: pan-y) – the image only takes two fingers (pinch). Once zoomed in, one finger
 * pans the image. `alwaysPan` (a full-screen view) gives one finger to the image at any zoom.
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Point } from '../../cv/geometry';
import type { Rect } from '../../cv/image';
import { useElementSize } from '../hooks/useElementSize';
import { centerOn, clampPan, fitTransform, insetArea, shiftTransform, transformForRect, zoomAt, type Insets, type ViewTransform } from '../lib/overlay';
import { IconExpand, IconPlus, IconTarget } from './Icons';

export interface ZoomPanHandle {
  /** Center the view on a content point, zooming to `zoom` × the fit scale (default 3). */
  focus(p: Point, zoom?: number): void;
  /** Show a content rectangle as large as it fits, zoomed in at most `maxZoom` × the fit scale. */
  focusRect(r: Rect, maxZoom?: number): void;
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
  start,
  startLabel = 'Back to the spot',
  maxZoom,
  alwaysPan = false,
  insets,
}: {
  contentWidth: number;
  contentHeight: number;
  /** Content, or a render function receiving the current scale (screen px per content px) and the fit scale. */
  children: ReactNode | ((scale: number, fitScale: number) => ReactNode);
  className?: string;
  handle?: Ref<ZoomPanHandle>;
  label?: string;
  /** Free space (CSS px) around the content when fitted, e.g. for markers on the edges. */
  margin?: number;
  /** Content rectangle to show first (and again with the "back" button) instead of the whole content. */
  start?: Rect;
  startLabel?: string;
  /** Upper limit for the scale (screen px per content px), e.g. to avoid a blurry blow-up. */
  maxZoom?: number;
  /** One finger pans the image even at the fit zoom (no page to scroll, e.g. full screen). */
  alwaysPan?: boolean;
  /** Bars laid over the viewport (CSS px): the fitted content stays clear of them. */
  insets?: Insets;
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
  /** The user (or the app) moved the view since the start view was shown. */
  const interacted = useRef(false);
  const startKey = start ? `${start.x},${start.y},${start.width},${start.height}` : '';
  const lastStartKey = useRef(startKey);

  // Fitting, centring and clamping happen in the area not covered by `insets` (e.g. a bar laid over
  // the bottom): fitted content stays clear of it, zoomed content can still be panned under it.
  const area = insetArea(vw, vh, insets);
  const { w: aw, h: ah, dx, dy } = area;
  const toView = (x: ViewTransform) => shiftTransform(x, dx, dy);
  const clamp = (x: ViewTransform) => toView(clampPan(shiftTransform(x, -dx, -dy), contentWidth, contentHeight, aw, ah));
  const fit = toView(fitTransform(contentWidth, contentHeight, aw, ah, Math.min(margin, Math.min(aw, ah) / 8)));
  const minScale = fit.scale;
  const maxScale = Math.max(fit.scale, Math.min(Math.max(fit.scale * 6, 2.5), maxZoom ?? Infinity));
  const startT = start && vw && vh ? toView(transformForRect(start, contentWidth, contentHeight, aw, ah, minScale, maxScale)) : undefined;
  /**
   * The transform on screen. During a gesture it runs ahead of `t`: it is written straight to the
   * content element (no React render, no change of --u, so no style recalc of the overlays per
   * move) and committed to `t` – one render, strokes and labels re-sized – when the gesture ends.
   */
  const tRef = useRef(t);
  const live = useRef(false);
  if (!live.current) tRef.current = t;
  const content = useRef<HTMLDivElement>(null);
  const clampRef = useRef(clamp);
  clampRef.current = clamp;

  // While the view moves (and briefly after), `data-moving` is set on the viewport: overlays pause
  // their animations (the flowing connection lines) so a pan or pinch only moves pixels. Set on
  // the element directly – no re-render per gesture frame.
  const movingTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(movingTimer.current), []);
  const markMoving = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    el.dataset.moving = '';
    window.clearTimeout(movingTimer.current);
    movingTimer.current = window.setTimeout(() => delete el.dataset.moving, 200);
  }, []);

  const settle = useCallback((next: ViewTransform) => {
    const fitScale = lastFit.current?.scale ?? 0;
    // At (or below) the fit scale the content simply stays fitted and centered.
    return next.scale <= fitScale * 1.001 && lastFit.current ? lastFit.current : clampRef.current(next);
  }, []);
  const apply = useCallback(
    (next: ViewTransform) => {
      interacted.current = true;
      markMoving();
      live.current = false;
      setT(settle(next));
    },
    [markMoving, settle],
  );
  /** A gesture step: move the content now, render later (commitLive). */
  const applyLive = useCallback(
    (next: ViewTransform) => {
      interacted.current = true;
      markMoving();
      const v = settle(next);
      tRef.current = v;
      live.current = true;
      if (content.current) content.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    },
    [markMoving, settle],
  );
  const commitLive = useCallback(() => {
    if (!live.current) return;
    live.current = false;
    setT(tRef.current);
  }, []);

  // Fit (or show the start rectangle) on first layout; on resize keep the zoom only if the user
  // had zoomed in.
  useLayoutEffect(() => {
    if (!vw || !vh) return;
    const prev = lastFit.current;
    lastFit.current = fit;
    if (lastStartKey.current !== startKey) {
      lastStartKey.current = startKey;
      interacted.current = false;
    }
    if (startT && !interacted.current) {
      setT(startT);
      return;
    }
    const zoomed = prev && tRef.current.scale > prev.scale * 1.02;
    if (!zoomed) setT(fit);
    else setT((cur) => clampRef.current(cur));
    // startT and fit follow from startKey and the sizes listed here.
  }, [vw, vh, contentWidth, contentHeight, fit.scale, fit.x, fit.y, startKey]);

  useImperativeHandle(
    handle,
    () => ({
      focus(p: Point, zoom = 3) {
        const scale = Math.min(maxScale, Math.max(fit.scale, fit.scale * zoom));
        apply(toView(centerOn(p, scale, aw, ah)));
      },
      focusRect(r: Rect, maxZoom = 3) {
        apply(toView(transformForRect(r, contentWidth, contentHeight, aw, ah, fit.scale, Math.min(maxScale, fit.scale * maxZoom))));
      },
      reset() {
        interacted.current = true;
        setT(fit);
      },
    }),
    // toView follows from dx / dy.
    [apply, fit, maxScale, aw, ah, dx, dy, contentWidth, contentHeight],
  );

  // Wheel zoom needs a non-passive listener.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      applyLive(zoomAt(tRef.current, factor, { x: e.clientX - r.left, y: e.clientY - r.top }, minScale, maxScale));
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(commitLive, 160);
    };
    let wheelTimer: number | undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(wheelTimer);
    };
  }, [applyLive, commitLive, minScale, maxScale]);

  /** Whether one finger pans the image (zoomed in, or always) rather than scrolling the page. */
  const oneFingerPans = () => alwaysPan || tRef.current.scale > (lastFit.current?.scale ?? Infinity) * 1.05;

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
      applyLive(next);
      g.pinchDist = dist;
      g.pinchMid = mid;
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < TAP_SLOP) return;
    if (e.pointerType === 'touch' && !oneFingerPans()) {
      // At the fit zoom one finger belongs to the page (it scrolls): this is no tap, no pan.
      g.moved = true;
      return;
    }
    if (!g.moved) {
      g.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const cur = tRef.current;
    applyLive({ scale: cur.scale, x: cur.x + p.x - g.last.x, y: cur.y + p.y - g.last.y });
    g.last = p;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) commitLive();
    if (gesture.current.moved) suppressClick.current = true;
    if (pointers.current.size < 2) gesture.current.pinchDist = undefined;
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      gesture.current.last = p;
    }
  };

  const zoomBy = (factor: number) => {
    apply(zoomAt(tRef.current, factor, { x: dx + aw / 2, y: dy + ah / 2 }, minScale, maxScale));
  };

  const zoomedIn = t.scale > fit.scale * 1.05;
  const atStart = !startT || (Math.abs(t.scale / startT.scale - 1) < 0.02 && Math.abs(t.x - startT.x) < 2 && Math.abs(t.y - startT.y) < 2);

  return (
    <div className={`zoompan ${className}`}>
      <div
        ref={viewport}
        className={`zoompan-viewport${alwaysPan || zoomedIn ? '' : ' scroll-through'}`}
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
          if (zoomedIn) {
            interacted.current = true;
            setT(fit);
          } else apply(zoomAt(tRef.current, 2.5, local(e), minScale, maxScale));
        }}
      >
        <div
          ref={content}
          className="zoompan-content"
          style={{
            width: contentWidth,
            height: contentHeight,
            // (Mid-gesture renders keep the live transform; --u follows only when it is committed.)
            transform: live.current ? `translate(${tRef.current.x}px, ${tRef.current.y}px) scale(${tRef.current.scale})` : `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
            // One screen px in content units: overlay strokes are sized with it, because
            // vector-effect: non-scaling-stroke does not undo this CSS scale (Blink, WebKit).
            ['--u' as string]: `${1 / t.scale}px`,
          }}
        >
          {typeof children === 'function' ? children(t.scale, fit.scale) : children}
        </div>
      </div>
      <div className="zoompan-controls">
        <button className="icon-btn small glass zoom-step" onClick={() => zoomBy(1.6)} aria-label="Zoom in">
          <IconPlus size={18} />
        </button>
        <button className="icon-btn small glass zoom-step" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">
          <span className="minus" aria-hidden="true" />
        </button>
        {startT && !atStart && (
          <button className="icon-btn small glass" onClick={() => apply(startT)} aria-label={startLabel} data-testid="zoom-to-start">
            <IconTarget size={18} />
          </button>
        )}
        {zoomedIn && (
          <button
            className="icon-btn small glass"
            onClick={() => {
              interacted.current = true;
              setT(fit);
            }}
            aria-label="Show whole picture"
          >
            <IconExpand size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
