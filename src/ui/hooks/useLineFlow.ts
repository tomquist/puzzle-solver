import { useEffect, type RefObject } from 'react';

/** How the dots of a connection line move: one screen px per beat, `period` px per dash + gap. */
const FLOW = {
  /** The selection's own lines: every beat (10 a second). */
  active: { every: 1, period: 11 },
  /** Their connections in turn, and every line without a selection: every other beat. */
  calm: { every: 2, period: 8.5 },
  base: { every: 2, period: 7.5 },
};
const BEAT_MS = 100;

/**
 * The flowing dots of the connection lines in `svg` (`.link` groups; "rev" flows back towards
 * the path's start). Driven from a timer at 5–10 steps a second that sets `--o` (the dash offset
 * in screen px) on each moving line's group – no per-frame animation, so the browser only
 * restyles and repaints those lines when they step, never on the frames between, and nothing at
 * all while panning or scrolling over a resting view.
 *
 * The dots rest after `restMs` (they restart when `restartKey` changes, e.g. a new selection);
 * they hold still while the view moves (ZoomPanView's data-moving) or the page scrolls, while a
 * fit is shown next to them, while the page is hidden or covered by the full-screen view, and with
 * reduced motion.
 */
export function useLineFlow(svg: RefObject<SVGSVGElement | null>, restartKey: string, restMs: number): void {
  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewport = root.closest('.zoompan-viewport');
    const inPage = !!root.closest('.result-photo, .result-ref');
    const steps = new WeakMap<Element, number>();
    let beat = 0;
    const start = performance.now();
    // Hold still while the page scrolls, too (a step repaints the overlay mid-scroll).
    let scrolled = 0;
    const onScroll = () => (scrolled = performance.now());
    window.addEventListener('scroll', onScroll, { passive: true });
    const timer = window.setInterval(() => {
      if (performance.now() - start > restMs) {
        window.clearInterval(timer);
        return;
      }
      if (performance.now() - scrolled < 250) return;
      // A fit is being shown ("show the fit"): it has the stage.
      if (root.parentElement?.querySelector('.fit-layer')) return;
      if (reduced() || document.hidden || viewport?.hasAttribute('data-moving') || (inPage && document.querySelector('.fs-view'))) return;
      beat++;
      for (const g of root.querySelectorAll<SVGGElement>('.link:not(.faded)')) {
        const f = g.classList.contains('active') ? FLOW.active : g.matches('.level-2, .level-3') ? FLOW.calm : FLOW.base;
        if (beat % f.every) continue;
        const n = (steps.get(g) ?? 0) + 1;
        steps.set(g, n);
        const o = n % f.period;
        g.style.setProperty('--o', String(g.classList.contains('rev') ? o : -o));
      }
    }, BEAT_MS);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [svg, restartKey, restMs]);
}
