/**
 * A full-viewport view (e.g. the annotated scan photo): a fixed layer over the whole page, in the
 * browser's real full screen where the Fullscreen API allows it (Android Chrome, desktop; not
 * iPhone Safari, where the fixed layer alone hides the page). Closes with its × button, Esc, the
 * back gesture (it adds a history entry) or when the browser leaves full screen.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import type { Insets } from '../lib/overlay';
import { IconClose } from './Icons';

const STATE_KEY = 'fullscreenView';

/**
 * Leave the open full-screen view from outside (e.g. to show a sheet of the page): goes back over
 * its history entry, so its own close handling runs; `close` is the fallback without one.
 */
export function leaveFullscreenView(close: () => void): void {
  if ((history.state as Record<string, unknown> | null)?.[STATE_KEY]) history.back();
  else close();
}

export function FullscreenView({
  label,
  title,
  tools,
  footer,
  onClose,
  children,
  testId = 'fullscreen',
}: {
  /** Accessible name of the view. */
  label: string;
  /** Short caption shown at the top. */
  title: ReactNode;
  /** Extra buttons next to the close button. */
  tools?: ReactNode;
  /** Overlaid at the bottom (e.g. the selected piece). */
  footer?: ReactNode;
  onClose: () => void;
  /** The content, or a function of the insets it should keep fitted content clear of (the footer). */
  children: ReactNode | ((insets: Insets) => ReactNode);
  testId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const { height: footH } = useElementSize(foot);
  const insets = useMemo<Insets>(() => ({ top: 0, right: 0, bottom: Math.round(footH), left: 0 }), [footH]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closing = useRef(false);

  /** Close once: through the history entry when it is still there, else directly. */
  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if ((history.state as Record<string, unknown> | null)?.[STATE_KEY]) history.back();
    else closeRef.current();
  }, []);

  useEffect(() => {
    const el = root.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closing.current = false;

    // A history entry so the back gesture closes the view (once, also under StrictMode).
    const state = (history.state as Record<string, unknown> | null) ?? {};
    if (!state[STATE_KEY]) history.pushState({ ...state, [STATE_KEY]: true }, '');
    const onPop = () => {
      if ((history.state as Record<string, unknown> | null)?.[STATE_KEY]) return;
      closing.current = true;
      closeRef.current();
    };

    // The browser's full screen, where available (needs the user's tap that opened the view).
    let entered = false;
    if (el && document.fullscreenEnabled && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => (entered = true),
        () => undefined,
      );
    }
    const onFullscreenChange = () => {
      if (entered && document.fullscreenElement !== el) requestClose();
    };
    // On the document, so it runs before (and can stop) the page's own Esc handling.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      requestClose();
    };

    window.addEventListener('popstate', onPop);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKey);
    el?.focus();
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (document.fullscreenElement && document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
    };
  }, [requestClose]);

  return (
    <div className="fs-view" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={root} data-testid={testId}>
      <div className="fs-stage">{typeof children === 'function' ? children(insets) : children}</div>
      <div className="fs-top">
        <span className="fs-title">{title}</span>
        <div className="fs-tools">
          {tools}
          <button className="icon-btn glass" onClick={requestClose} aria-label="Close full screen" data-testid="fullscreen-close">
            <IconClose />
          </button>
        </div>
      </div>
      <div className="fs-foot" ref={foot}>
        {footer}
      </div>
    </div>
  );
}
