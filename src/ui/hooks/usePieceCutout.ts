import { useEffect, useState } from 'react';
import type { DetectedRegion } from '../../model/types';
import { context2d, drawImageClipped } from '../../platform/imageio';
import { closeupSquare } from '../lib/framing';
import type { ScanItem } from '../lib/items';

/**
 * The item cut out of the scan photo along its outline (the table around it transparent), drawn
 * once into a square image that holds it at any rotation (closeupSquare) – for turning it with a
 * CSS transform. Returns an object URL (revoked when no longer used), or undefined until ready.
 */
export function usePieceCutout(photo: CanvasImageSource | undefined, item: ScanItem, regions: DetectedRegion[], px = 360): string | undefined {
  const [url, setUrl] = useState<string>();
  const members = regions.filter((r) => item.regionIds.includes(r.id));
  const key = `${item.key}:${item.bbox.x},${item.bbox.y},${item.bbox.width},${item.bbox.height}`;
  useEffect(() => {
    if (!photo) return;
    let alive = true;
    let made: string | undefined;
    const sq = closeupSquare(item.bbox);
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = context2d(canvas);
    const k = px / sq.side;
    const x0 = sq.cx - sq.side / 2;
    const y0 = sq.cy - sq.side / 2;
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    const outlines = members.filter((m) => m.contour.length > 2);
    if (outlines.length) {
      ctx.beginPath();
      for (const m of outlines) {
        ctx.moveTo(m.contour[0].x, m.contour[0].y);
        for (let i = 1; i < m.contour.length; i++) ctx.lineTo(m.contour[i].x, m.contour[i].y);
        ctx.closePath();
      }
      ctx.clip();
    }
    ctx.imageSmoothingQuality = 'high';
    drawImageClipped(ctx, photo, x0, y0, sq.side, sq.side, x0, y0, sq.side, sq.side);
    canvas.toBlob((blob) => {
      if (!alive || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, 'image/png');
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(undefined);
    };
    // The cut-out only changes with the photo and the item (key), not with the members' identity.
  }, [photo, key, px]);
  return url;
}

/** Whether the user asked for reduced motion (follows changes). */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
