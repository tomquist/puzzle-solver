import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

const HOLD_MS = 380;
/** Movement (CSS px) that turns a press into a pan instead of a hold. */
const SLOP = 8;

/**
 * Press-and-hold to peek, e.g. at the photo without its annotations: `peeking` turns true when one
 * finger (or the mouse button) rests on the element for a moment without moving, and false when it
 * is lifted. Moving or a second finger (pan, pinch) before that cancels it, so it never gets in the
 * way of zooming; panning while peeking is fine. The click that ends a peek is swallowed (it must
 * not select or clear anything). Spread `handlers` on the element.
 */
export function useHoldToPeek(holdMs = HOLD_MS) {
  const [peeking, setPeeking] = useState(false);
  const s = useRef({ timer: 0, start: { x: 0, y: 0 }, pointers: new Set<number>(), active: false, swallowClick: false });

  useEffect(() => {
    const st = s.current;
    const end = (pointerId?: number) => {
      if (pointerId === undefined) st.pointers.clear();
      else st.pointers.delete(pointerId);
      if (st.pointers.size > 0) return;
      window.clearTimeout(st.timer);
      if (!st.active) return;
      st.active = false;
      st.swallowClick = true;
      window.setTimeout(() => (st.swallowClick = false), 400);
      setPeeking(false);
    };
    // On the window: the finger may be lifted anywhere.
    const onUp = (e: PointerEvent) => end(e.pointerId);
    const onBlur = () => end();
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', onBlur);
      window.clearTimeout(st.timer);
    };
  }, []);

  const handlers = {
    onPointerDownCapture(e: ReactPointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Holding a button on the element (e.g. zoom controls) is not a peek.
      if (e.target instanceof Element && e.target.closest('button')) return;
      const st = s.current;
      st.swallowClick = false;
      st.pointers.add(e.pointerId);
      window.clearTimeout(st.timer);
      if (st.pointers.size === 1 && !st.active) {
        st.start = { x: e.clientX, y: e.clientY };
        st.timer = window.setTimeout(() => {
          st.active = true;
          setPeeking(true);
        }, holdMs);
      }
    },
    onPointerMoveCapture(e: ReactPointerEvent) {
      const st = s.current;
      if (!st.active && st.pointers.size === 1 && Math.hypot(e.clientX - st.start.x, e.clientY - st.start.y) > SLOP) window.clearTimeout(st.timer);
    },
    onClickCapture(e: ReactMouseEvent) {
      if (!s.current.swallowClick) return;
      s.current.swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    // A long press must not open the browser's context menu.
    onContextMenu(e: ReactMouseEvent) {
      e.preventDefault();
    },
  };
  return { peeking, handlers };
}
