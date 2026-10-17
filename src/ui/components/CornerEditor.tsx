/**
 * Shows a photo with an editable quadrilateral: four large draggable corner handles (pointer events,
 * touch friendly, arrow keys for fine-tuning) and a magnifier loupe while dragging.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Point, Quad } from '../../cv/geometry';
import { useElementSize } from '../hooks/useElementSize';
import { polygonPath } from '../lib/overlay';

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
const LOUPE = 132; // CSS px
const LOUPE_ZOOM = 3; // relative to the displayed photo

/** True when the quad is convex and clockwise (a valid picture outline). */
export function isConvexQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign > 0;
}

export function CornerEditor({
  src,
  source,
  width,
  height,
  quad,
  onChange,
}: {
  /** URL of the photo for display. */
  src: string;
  /** Drawable copy of the photo for the loupe. */
  source?: CanvasImageSource;
  width: number;
  height: number;
  quad: Quad;
  onChange: (q: Quad) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const { width: dispW } = useElementSize(box);
  const scale = dispW > 0 ? dispW / width : 1;
  const [drag, setDrag] = useState<{ index: number; pointerId: number; offset: Point } | null>(null);

  const toImage = (clientX: number, clientY: number): Point => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * width, y: ((clientY - r.top) / r.height) * height };
  };

  const clampPt = (p: Point): Point => ({ x: Math.max(0, Math.min(width - 1, p.x)), y: Math.max(0, Math.min(height - 1, p.y)) });

  const move = (index: number, p: Point) => {
    const next = quad.map((q, i) => (i === index ? clampPt(p) : q)) as Quad;
    onChange(next);
  };

  const onHandleDown = (index: number) => (e: ReactPointerEvent<SVGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    setDrag({ index, pointerId: e.pointerId, offset: { x: quad[index].x - p.x, y: quad[index].y - p.y } });
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = toImage(e.clientX, e.clientY);
    move(drag.index, { x: p.x + drag.offset.x, y: p.y + drag.offset.y });
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag && e.pointerId === drag.pointerId) setDrag(null);
  };

  const onKey = (index: number) => (e: KeyboardEvent) => {
    const step = (e.shiftKey ? 10 : 1) / scale;
    const d: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    move(index, { x: quad[index].x + v.x, y: quad[index].y + v.y });
  };

  // Draw the loupe.
  const active = drag ? quad[drag.index] : undefined;
  useEffect(() => {
    const c = loupe.current;
    if (!c || !active || !source) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = LOUPE * dpr;
    c.height = LOUPE * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const side = LOUPE / (scale * LOUPE_ZOOM);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, active.x - side / 2, active.y - side / 2, side, side, 0, 0, c.width, c.height);
    // Quad edges through the active corner.
    const k = c.width / side;
    const toL = (p: Point) => ({ x: (p.x - active.x) * k + c.width / 2, y: (p.y - active.y) * k + c.height / 2 });
    const i = drag!.index;
    const prev = toL(quad[(i + 3) % 4]);
    const next = toL(quad[(i + 1) % 4]);
    const mid = { x: c.width / 2, y: c.height / 2 };
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(mid.x, mid.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    // Crosshair.
    ctx.strokeStyle = 'rgba(255, 196, 0, 0.95)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(mid.x - 14 * dpr, mid.y);
    ctx.lineTo(mid.x + 14 * dpr, mid.y);
    ctx.moveTo(mid.x, mid.y - 14 * dpr);
    ctx.lineTo(mid.x, mid.y + 14 * dpr);
    ctx.stroke();
  });

  const r = 13 / scale; // handle radius in image px (constant on screen)
  const hit = 26 / scale;
  const outside = `M0 0H${width}V${height}H0Z` + polygonPath(quad);
  const convex = isConvexQuad(quad);

  let loupeStyle: React.CSSProperties | undefined;
  if (active) {
    const sx = active.x * scale;
    const sy = active.y * scale;
    const above = sy - LOUPE - 48 >= 0;
    const left = Math.max(0, Math.min(dispW - LOUPE, sx - LOUPE / 2));
    loupeStyle = { left, top: above ? sy - LOUPE - 48 : sy + 48 };
  }

  return (
    <div className="corner-editor" ref={box} style={{ aspectRatio: `${width} / ${height}` }}>
      <img src={src} alt="Box photo" draggable={false} />
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className={drag ? 'dragging' : ''}
      >
        <path d={outside} fillRule="evenodd" className="ce-shade" />
        <path d={polygonPath(quad)} className={convex ? 'ce-outline' : 'ce-outline bad'} vectorEffect="non-scaling-stroke" />
        {quad.map((p, i) => (
          <g
            key={i}
            className={`ce-handle${drag?.index === i ? ' active' : ''}`}
            onPointerDown={onHandleDown(i)}
            tabIndex={0}
            role="slider"
            aria-label={`Move ${CORNER_NAMES[i]} corner`}
            aria-valuetext={`${Math.round(p.x)}, ${Math.round(p.y)}`}
            onKeyDown={onKey(i)}
            data-testid={`corner-${i}`}
          >
            <circle cx={p.x} cy={p.y} r={hit} className="ce-hit" />
            <circle cx={p.x} cy={p.y} r={r} className="ce-ring" vectorEffect="non-scaling-stroke" />
            <circle cx={p.x} cy={p.y} r={r * 0.28} className="ce-dot" />
          </g>
        ))}
      </svg>
      {active && source && <canvas ref={loupe} className="loupe" style={{ ...loupeStyle, width: LOUPE, height: LOUPE }} aria-hidden="true" />}
    </div>
  );
}
