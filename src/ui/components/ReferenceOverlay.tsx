/** SVG overlay on the reference picture: grid, placed cells, numbered markers, links, coverage. */
import type { Rect } from '../../cv/image';
import type { CellRef, GridSpec } from '../../model/types';
import type { CellBounds } from '../lib/items';
import { cellRect, gridPath, markerRadius, trimmedSegment } from '../lib/overlay';
import type { ItemTone } from './ScanOverlay';

export interface RefMarker {
  key: string;
  label: number;
  x: number;
  y: number;
  tone: ItemTone;
  /** Cells of an assembled grid – outlined as one block. */
  bounds?: CellBounds;
  cells?: CellRef[];
}

export function ReferenceOverlay({
  width,
  height,
  grid,
  showGrid = true,
  placed = [],
  markers = [],
  links = [],
  selectedKey,
  coverage = [],
  highlight,
  scale,
  onMarker,
}: {
  width: number;
  height: number;
  grid?: GridSpec;
  showGrid?: boolean;
  placed?: CellRef[];
  markers?: RefMarker[];
  /** Pairs of marker keys to connect (pieces that go next to each other). */
  links?: { a: string; b: string }[];
  selectedKey?: string;
  coverage?: { rect: Rect; ok: boolean; label?: string }[];
  /** Cells to highlight (the selected item's target). */
  highlight?: CellRef[];
  /** Screen px per reference px (keeps markers legible when zoomed out). */
  scale: number;
  onMarker?: (key: string) => void;
}) {
  const r = grid ? Math.max(markerRadius(grid, width, height), 11 / scale) : 12 / scale;
  const byKey = new Map(markers.map((m) => [m.key, m]));
  // With a selection, its links and the markers it joins stay, everything else fades.
  const selected = selectedKey && byKey.has(selectedKey) ? selectedKey : undefined;
  const linked = new Set(selected ? links.flatMap((l) => (l.a === selected ? [l.b] : l.b === selected ? [l.a] : [])) : []);
  const block = (b: CellBounds) => {
    const a = cellRect({ row: b.row0, col: b.col0 }, grid!, width, height);
    const z = cellRect({ row: b.row1, col: b.col1 }, grid!, width, height);
    return { x: a.x, y: a.y, width: z.x + z.width - a.x, height: z.y + z.height - a.y };
  };
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
      {grid &&
        highlight?.map((c) => {
          const rc = cellRect(c, grid, width, height);
          return <rect key={`h${c.row},${c.col}`} className="highlight-cell" x={rc.x} y={rc.y} width={rc.width} height={rc.height} vectorEffect="non-scaling-stroke" />;
        })}
      {grid &&
        markers.map((m) => {
          if (!m.bounds) return null;
          const b = block(m.bounds);
          return <rect key={`b${m.key}`} className={`marker-block st-${m.tone}`} x={b.x} y={b.y} width={b.width} height={b.height} vectorEffect="non-scaling-stroke" />;
        })}
      {links.map((l) => {
        const a = byKey.get(l.a);
        const b = byKey.get(l.b);
        const seg = a && b ? trimmedSegment(a, b, r) : null;
        if (!seg) return null;
        const active = !!selected && (l.a === selected || l.b === selected);
        return (
          <g key={`${l.a}-${l.b}`} className={`link${active ? ' active' : selected ? ' faded' : ''}`}>
            <line className="link-under" x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} vectorEffect="non-scaling-stroke" />
            <line className="link-line" x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      {markers.map((m) => (
        <g
          key={m.key}
          className={`marker st-${m.tone}${selected === m.key ? ' selected' : linked.has(m.key) ? ' linked' : selected ? ' faded' : ''}`}
          onClick={onMarker ? () => onMarker(m.key) : undefined}
          role={onMarker ? 'button' : undefined}
          aria-label={onMarker ? `Where ${m.label} goes` : undefined}
          data-testid={`marker-${m.key}`}
        >
          {onMarker && <circle className="hit" cx={m.x} cy={m.y} r={Math.max(r, 22 / scale)} />}
          <circle cx={m.x} cy={m.y} r={r} vectorEffect="non-scaling-stroke" />
          <text x={m.x} y={m.y} fontSize={r * 1.1} dy="0.36em" textAnchor="middle">
            {m.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
