/**
 * Page scroll lock for modal views (sheets, the full-screen view), counted: the page scrolls again
 * once every lock is released, whatever the order. (Each view saving and restoring the body's
 * overflow itself left the page locked when they closed out of order, e.g. Details opened from the
 * full-screen view: the sheet saw the full-screen lock and put it back when it closed.)
 */
let locks = 0;
let saved = '';

/** Lock the page's scrolling; returns the release (calling it again does nothing). */
export function lockPageScroll(body: { style: { overflow: string } } = document.body): () => void {
  if (locks++ === 0) {
    saved = body.style.overflow;
    body.style.overflow = 'hidden';
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) body.style.overflow = saved;
  };
}
