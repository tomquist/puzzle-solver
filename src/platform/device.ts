/** Small, guarded device/platform helpers (browser-only). */

/** iPhone / iPad / iPod, including iPadOS which reports itself as a Mac with touch. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** True when the primary pointer is a finger (phones, tablets). */
export function isCoarsePointer(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}

/** A short vibration as tactile feedback (Android; silently ignored elsewhere). */
export function haptic(ms = 12): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    // Not allowed (e.g. no user activation) – ignore.
  }
}
