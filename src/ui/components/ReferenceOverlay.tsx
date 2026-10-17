/** SVG overlay on the reference picture: grid, placed cells, numbered markers, coverage rects. */
import type { Rect } from '../../cv/image';
import type { CellRef, GridSpec } from '../../model/types';
import { cellRect, gridPath, markerRadius } from '../lib/overlay';
import type { DisplayStatus } from '../lib/pieces';

export interface RefMarker {
  id: number;
  x: number;
  y: number;
  status: DisplayStatus;
  /** Cells covered (patches) – drawn as an outline. */
  cells?: CellRef[];
}

export function ReferenceOverlay({
  width,
  height,
  grid,
  showGrid = true,
  placed = [],
  markers = [],
  selectedId,
  coverage = [],
  highlightCell,
  scale,
  onMarker,
}: {
  width: number;
  height: number;
  grid?: GridSpec;
  showGrid?: boolean;
  placed?: CellRef[];
  markers?: RefMarker[];
  selectedId?: number;
  coverage?: { rect: Rect; ok: boolean; label?: string }[];
  highlightCell?: CellRef;
  /** Screen px per reference px (keeps markers legible when zoomed out). */
  scale: number;
  onMarker?: (id: number) => void;
}) {
  const r = grid ? Math.max(markerRadius(grid, width, height), 11 / scale) : 12 / scale;
  return (
    <svg className="overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {grid &&
        placed.map((c) => {
          const rc = cellRect(c, grid, width, height);
          return <rect key={`${c.row},${c.col}`} className="placed-cell" x={rc.x} y={rc.y} width={rc.width} height={rc.height} />;
        })}
      {grid && showGrid && <path d={gridPath(grid, width, height)} className="grid-lines" vectorEffect="non-scaling-stroke" />}
      {coverage.map((c, i) => (
        <g key={i} className={c.ok ? 'coverage' : 'coverage bad'}>
          <rect x={c.rect.x} y={c.rect.y} width={c.rect.width} height={c.rect.height} vectorEffect="non-scaling-stroke" />
          {c.label && (
            <text x={c.rect.x + 8 / scale} y={c.rect.y + 20 / scale} fontSize={14 / scale}>
              {c.label}
            </text>
          )}
        </g>
      ))}
      {grid && highlightCell && (() => {
        const rc = cellRect(highlightCell, grid, width, height);
        return <rect className="highlight-cell" x={rc.x} y={rc.y} width={rc.width} height={rc.height} vectorEffect="non-scaling-stroke" />;
      })()}
      {markers.map((m) => (
        <g
          key={m.id}
          className={`marker st-${m.status}${selectedId === m.id ? ' selected' : ''}`}
          onClick={onMarker ? () => onMarker(m.id) : undefined}
          role={onMarker ? 'button' : undefined}
          aria-label={`Piece ${m.id} goes here`}
          data-testid={`marker-${m.id}`}
        >
          {grid &&
            m.cells?.map((c) => {
              const rc = cellRect(c, grid, width, height);
              return <rect key={`${c.row},${c.col}`} className="marker-cell" x={rc.x} y={rc.y} width={rc.width} height={rc.height} vectorEffect="non-scaling-stroke" />;
            })}
          {onMarker && <circle className="hit" cx={m.x} cy={m.y} r={Math.max(r, 22 / scale)} />}
          <circle cx={m.x} cy={m.y} r={r} vectorEffect="non-scaling-stroke" />
          <text x={m.x} y={m.y} fontSize={r * 1.1} dy="0.36em" textAnchor="middle">
            {m.id}
          </text>
        </g>
      ))}
    </svg>
  );
}
