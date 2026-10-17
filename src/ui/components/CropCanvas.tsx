/** A square canvas that draws a crop of an image source (re-draws when inputs change). */
import { useEffect, useRef } from 'react';
import type { Rect } from '../../cv/image';
import { drawCrop, drawRotatedCrop } from '../../platform/imageio';

export function CropCanvas({
  source,
  rect,
  rotated,
  size = 160,
  label,
  className = '',
}: {
  source: CanvasImageSource | undefined;
  /** Axis-aligned crop (letterboxed into the square). */
  rect?: Rect;
  /** Square crop around a point, rotated clockwise by rotationDeg. */
  rotated?: { cx: number; cy: number; side: number; rotationDeg: number };
  size?: number;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify({ rect, rotated, size });
  useEffect(() => {
    const c = ref.current;
    if (!c || !source) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(size * dpr);
    c.height = Math.round(size * dpr);
    if (rotated) drawRotatedCrop(c, source, { ...rotated, background: '#1a1a1a' });
    else if (rect) drawCrop(c, source, rect, '#1a1a1a');
  }, [source, key, rect, rotated, size]);
  return (
    <canvas
      ref={ref}
      className={`crop ${className}`}
      role="img"
      aria-label={label}
      style={{ width: '100%', aspectRatio: '1 / 1' }}
    />
  );
}
