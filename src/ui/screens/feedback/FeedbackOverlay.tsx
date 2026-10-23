/**
 * SVG overlay of the feedback screen: every detected region filled in its result-screen colour
 * (sure green, unsure amber, assembled blue; found-but-hidden grey hatched), so pieces the app did
 * not find are the ones left untouched, and the user's marks as numbered dots on top. In "Piece not
 * found" mode a tap anywhere reports the point (a tap on a point removes it); in the other modes a
 * tap on a region marks it. A pair that doesn't fit (noted on the result) is a dashed line between
 * the two pieces with its number in the middle.
 */
import { useId } from 'react';
import type { Point } from '../../../cv/geometry';
import type { FeedbackMark, FeedbackMarkKind } from '../../../feedback/format';
import type { ScanResult } from '../../../model/types';
import { isRegionMark, type DetectionTone, type MarkMode } from '../../lib/feedbackMarks';
import { polygonPath, regionCenter } from '../../lib/overlay';

export function FeedbackOverlay({
  result,
  tones,
  marks,
  mode,
  pendingRegionId,
  scale,
  onRegion,
  onPoint,
  onRemove,
}: {
  result: ScanResult;
  /** How each region is shown in the results ('hidden' = not shown). */
  tones: Map<number, DetectionTone>;
  marks: FeedbackMark[];
  mode: MarkMode;
  /** Region the "this piece was found" note is about. */
  pendingRegionId?: number;
  /** Screen px per photo px. */
  scale: number;
  onRegion: (regionId: number) => void;
  onPoint: (p: Point) => void;
  onRemove: (index: number) => void;
}) {
  const { width, height } = result;
  const pointMode = mode === 'missed';
  const r = 11 / scale;
  const hit = 22 / scale;
  const markOf = new Map<number, { kind: FeedbackMarkKind; index: number }>();
  marks.forEach((m, index) => {
    if (isRegionMark(m)) markOf.set(m.regionId, { kind: m.kind, index });
  });
  const centers = new Map(result.regions.map((reg) => [reg.id, regionCenter(reg)]));
  // Largest first, so smaller outlines (and their touch targets) are on top.
  const ordered = [...result.regions].sort((a, b) => b.area - a.area);
  const toneOf = (id: number): DetectionTone => tones.get(id) ?? 'hidden';
  const label = (id: number) => `${toneOf(id) === 'hidden' ? 'Found but not shown' : `Piece ${id}`}${markOf.has(id) ? ', marked' : ''}`;
  const hatch = `fb-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const step = 7 / scale;

  return (
    <svg
      className={`overlay fb-overlay ${pointMode ? 'mode-point' : 'mode-region'}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      data-testid="fb-photo"
      onClick={(e) => {
        if (!pointMode) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = ((e.clientX - rect.left) / rect.width) * width;
        const y = ((e.clientY - rect.top) / rect.height) * height;
        if (x < 0 || y < 0 || x > width || y > height) return;
        onPoint({ x, y });
      }}
    >
      <defs>
        <pattern id={hatch} patternUnits="userSpaceOnUse" width={step} height={step} patternTransform="rotate(45)">
          <rect width={step} height={step} fill="rgba(75, 85, 99, 0.45)" />
          <rect width={step * 0.4} height={step} fill="rgba(229, 231, 235, 0.85)" />
        </pattern>
      </defs>
      <rect className="fb-bg" x={0} y={0} width={width} height={height} />

      {ordered.map((reg) => {
        const mk = markOf.get(reg.id);
        const tone = toneOf(reg.id);
        const isHidden = tone === 'hidden';
        const d = polygonPath(reg.contour);
        const c = centers.get(reg.id)!;
        const cls = ['fb-region', isHidden ? 'is-hidden' : `st-${tone}`, mk && `marked mk-${mk.kind}`, pendingRegionId === reg.id && 'pending'].filter(Boolean).join(' ');
        return (
          <g
            key={reg.id}
            className={cls}
            data-testid={`fb-region-${reg.id}`}
            data-hidden={isHidden ? 'true' : 'false'}
            data-tone={tone}
            data-cx={Math.round(c.x)}
            data-cy={Math.round(c.y)}
            {...(pointMode
              ? {}
              : {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': label(reg.id),
                  onClick: (e: React.MouseEvent) => {
                    e.stopPropagation();
                    onRegion(reg.id);
                  },
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRegion(reg.id);
                    }
                  },
                })}
          >
            <path d={d} className="fb-under" vectorEffect="non-scaling-stroke" />
            {/* Inline style: beats the stylesheet's fill, which marks and the pending note override. */}
            <path d={d} className="fb-fill" style={isHidden && !mk && pendingRegionId !== reg.id ? { fill: `url(#${hatch})` } : undefined} />
            <path d={d} className="fb-line" vectorEffect="non-scaling-stroke" />
            {/* ≥ 44 px touch target, so small outlines are easy to hit. */}
            {!pointMode && <circle className="hit" cx={c.x} cy={c.y} r={hit} data-testid={`fb-hit-${reg.id}`} />}
          </g>
        );
      })}

      {/* Marks, numbered as in the list below the photo. */}
      {marks.map((m, i) => {
        if (m.kind === 'missed') {
          return (
            <g
              key={`m${i}`}
              className="fb-mark fb-missed mk-missed"
              data-testid={`fb-missed-${i}`}
              onClick={(e) => {
                if (!pointMode) return;
                e.stopPropagation();
                onRemove(i);
              }}
            >
              <circle className="fb-hit" cx={m.x} cy={m.y} r={hit} />
              <circle className="fb-ring" cx={m.x} cy={m.y} r={r * 1.75} vectorEffect="non-scaling-stroke" />
              <circle className="fb-dot" cx={m.x} cy={m.y} r={r} />
              <text x={m.x} y={m.y} fontSize={r * 1.1} dy="0.36em" textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        }
        if (m.kind === 'wrong_fit') {
          const a = centers.get(m.a);
          const b = centers.get(m.b);
          if (!a || !b) return null;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return (
            <g key={`m${i}`} className="fb-mark fb-fit mk-wrong_fit" aria-hidden="true" data-testid={`fb-fit-${i}`}>
              <line className="fb-fit-under" x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />
              <line className="fb-fit-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />
              <circle className="fb-fit-end" cx={a.x} cy={a.y} r={r * 0.45} />
              <circle className="fb-fit-end" cx={b.x} cy={b.y} r={r * 0.45} />
              <circle className="fb-dot" cx={mid.x} cy={mid.y} r={r} />
              <text x={mid.x} y={mid.y} fontSize={r * 1.1} dy="0.36em" textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        }
        const c = centers.get(m.regionId);
        if (!c) return null;
        return (
          <g key={`m${i}`} className={`fb-mark mk-${m.kind}`} aria-hidden="true">
            <circle className="fb-dot" cx={c.x} cy={c.y} r={r} />
            <text x={c.x} y={c.y} fontSize={r * 1.1} dy="0.36em" textAnchor="middle">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
