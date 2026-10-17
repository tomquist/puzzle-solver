/**
 * SVG overlay of the feedback screen: every detected outline – also the ones the results hide
 * (dashed, dimmed) – and the user's marks as numbered dots. In "missed piece" mode a tap anywhere
 * adds a point (a tap on a point removes it); in the other modes a tap on an outline marks it.
 */
import type { Point } from '../../../cv/geometry';
import type { FeedbackMark, FeedbackMarkKind } from '../../../feedback/format';
import type { ScanResult } from '../../../model/types';
import { isRegionMark } from '../../lib/feedbackMarks';
import { polygonPath, regionCenter } from '../../lib/overlay';

export function FeedbackOverlay({
  result,
  hidden,
  marks,
  mode,
  scale,
  onRegion,
  onPoint,
  onRemove,
}: {
  result: ScanResult;
  /** Regions the result screens don't show. */
  hidden: Set<number>;
  marks: FeedbackMark[];
  mode: FeedbackMarkKind;
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
  const label = (id: number) => `${hidden.has(id) ? 'Outline not shown in results' : `Piece ${id}`}${markOf.has(id) ? ', marked' : ''}`;

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
      <rect className="fb-bg" x={0} y={0} width={width} height={height} />

      {ordered.map((reg) => {
        const mk = markOf.get(reg.id);
        const d = polygonPath(reg.contour);
        const cls = ['fb-region', hidden.has(reg.id) && 'is-hidden', mk && `marked mk-${mk.kind}`].filter(Boolean).join(' ');
        return (
          <g
            key={reg.id}
            className={cls}
            data-testid={`fb-region-${reg.id}`}
            data-hidden={hidden.has(reg.id) ? 'true' : 'false'}
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
            <path d={d} className="fb-fill" />
            <path d={d} className="fb-line" vectorEffect="non-scaling-stroke" />
            {/* ≥ 44 px touch target, so small outlines are easy to hit. */}
            {!pointMode && <circle className="hit" cx={centers.get(reg.id)!.x} cy={centers.get(reg.id)!.y} r={hit} data-testid={`fb-hit-${reg.id}`} />}
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
