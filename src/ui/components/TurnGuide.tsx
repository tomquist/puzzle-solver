/**
 * How to turn a piece, shown with the piece itself: its cut-out (masked by its outline, so the
 * table doesn't turn with it) starts as it lies on the table and turns upright the short way –
 * ease in-out over 1.2 s, hold 1 s, fade back, three loops, tap to replay – with an arc arrow for
 * the direction and the sweep that grows with the turn. One pre-drawn image turned by a CSS
 * transform (no per-frame drawing or re-render).
 * Reduced motion: "now → then" side by side with the arc between them, no motion.
 * Already the right way up: the piece and "✓ right way up".
 */
import { useState, type CSSProperties } from 'react';
import type { DetectedRegion } from '../../model/types';
import { usePieceCutout, usePrefersReducedMotion } from '../hooks/usePieceCutout';
import { closeupSquare, topBarFor } from '../lib/framing';
import type { ScanItem } from '../lib/items';
import { turnArc, turnInstruction, type TurnInstruction } from '../lib/rotation';

export function TurnGuide({
  item,
  regions,
  photo,
  rotationDeg,
  layout = 'stage',
}: {
  item: ScanItem;
  regions: DetectedRegion[];
  photo: CanvasImageSource | undefined;
  rotationDeg: number;
  /** 'stage': just the picture (the words are shown elsewhere); 'row': picture and words side by side. */
  layout?: 'stage' | 'row';
}) {
  const t = turnInstruction(rotationDeg);
  const url = usePieceCutout(photo, item, regions);
  const reduced = usePrefersReducedMotion();
  const mode = t.band === 'upright' ? 'upright' : reduced ? 'frames' : 'animate';
  // The "top" bar on the cut-out (same mark as in the pick-up view), in % of the cut-out square:
  // it turns with the piece and ends on top.
  const sq = closeupSquare(item.bbox);
  const bar = topBarFor(item, regions, rotationDeg, 0.5);
  const pct = (v: number, c: number) => Math.round(((v - (c - sq.side / 2)) / sq.side) * 1000) / 10;
  const top: Bar = { x1: pct(bar.from.x, sq.cx), y1: pct(bar.from.y, sq.cy), x2: pct(bar.to.x, sq.cx), y2: pct(bar.to.y, sq.cy) };
  const visual = <TurnVisual t={t} url={url} mode={mode} top={top} />;
  if (layout === 'stage') return visual;
  return (
    <div className="turn-row" data-testid="turn-guide-row">
      <div className="turn-row-visual">{visual}</div>
      <TurnWords t={t} />
    </div>
  );
}

/** The instruction in plain words with the exact angle as small print. */
export function TurnWords({ t }: { t: TurnInstruction }) {
  return (
    <div className="turn-words">
      <div className="turn-main" data-testid="turn-words">
        {t.text}
      </div>
      {t.exact && <div className="muted small">{t.exact}</div>}
    </div>
  );
}

interface Bar {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function TurnVisual({ t, url, mode, top }: { t: TurnInstruction; url: string | undefined; mode: 'upright' | 'frames' | 'animate'; top: Bar }) {
  const [play, setPlay] = useState(0);
  const label = `${t.text}${t.exact ? ` (${t.exact})` : ''}`;
  const piece = (upright: boolean) => (
    <span className="turn-piece" style={upright ? { transform: `rotate(${t.degrees}deg)` } : undefined}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="turn-piece-wait" />}
      <svg className="turn-top" viewBox="0 0 100 100" aria-hidden="true">
        <line className="top-bar-under" {...top} vectorEffect="non-scaling-stroke" />
        <line className="top-bar" {...top} vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );

  if (mode === 'upright') {
    return (
      <div className="turn-stage upright" role="img" aria-label={label} data-testid="turn-guide" data-mode="upright">
        <div className="turn-spin static">{piece(true)}</div>
        <span className="turn-ok">✓ right way up</span>
      </div>
    );
  }

  if (mode === 'frames') {
    const icon = turnArc(t.degrees, { x: 20, y: 20 }, 13, 7);
    return (
      <div className="turn-frames" role="img" aria-label={label} data-testid="turn-guide" data-mode="frames">
        <span className="turn-frame">
          <span className="turn-frame-pic">{piece(false)}</span>
          <span className="turn-frame-cap">Now</span>
        </span>
        <svg className="turn-arc-icon" viewBox="0 0 40 40" aria-hidden="true">
          <path className="turn-arc-line" d={icon.d} vectorEffect="non-scaling-stroke" />
          <polygon className="turn-arc-head" points={icon.head.map((p) => `${p.x},${p.y}`).join(' ')} />
        </svg>
        <span className="turn-frame">
          <span className="turn-frame-pic">{piece(true)}</span>
          <span className="turn-frame-cap">Then</span>
        </span>
      </div>
    );
  }

  const arc = turnArc(t.degrees, { x: 50, y: 50 }, 40, 10);
  const head = arc.head.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <button
      type="button"
      className="turn-stage"
      onClick={() => setPlay((n) => n + 1)}
      aria-label={`${label}. Tap to show again.`}
      data-testid="turn-guide"
      data-mode="animate"
      style={{ ['--turn' as string]: `${t.degrees}deg` } as CSSProperties}
    >
      {/* key: a tap restarts the animation */}
      <div className="turn-spin" key={`spin${play}`}>
        {piece(false)}
      </div>
      <svg className="turn-arc" viewBox="0 0 100 100" aria-hidden="true" key={`arc${play}`}>
        <path className="turn-arc-track" d={arc.d} />
        {/* No non-scaling-stroke here: it breaks pathLength dashes (widths are in viewBox units). */}
        <path className="turn-arc-grow" d={arc.d} pathLength={1} />
        <polygon className="turn-arc-head" points={head} />
      </svg>
    </button>
  );
}
