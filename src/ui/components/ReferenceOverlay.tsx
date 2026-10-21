/** SVG overlay on the reference picture: grid, placed cells, numbered markers, links, coverage. */
import type { Rect } from '../../cv/image';
import type { CellRef, GridSpec } from '../../model/types';
import { useRef } from 'react';
import { useLineFlow } from '../hooks/useLineFlow';
import type { CellBounds } from '../lib/items';
import { flowDirections, linkId, linkLevel, SELECTION_REACH, selectionLevels } from '../lib/linkGraph';
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
  /** Pieces in the item (an assembled grid > 1): the lines flow toward the biggest. */
  pieces?: number;
}

export function ReferenceOverlay({
  width,
  height,
  grid,
  showGrid = true,
  placed = [],
  markers = [],
  links = [],
  showConnections = true,
  selectedKey,
  levels,
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
  /** Draw all links (off: only those of the selection). */
  showConnections?: boolean;
  selectedKey?: string;
  /** The selection's reach by level (selectionLevels); default: the selection and its links. */
  levels?: Map<string, number>;
  coverage?: { rect: Rect; ok: boolean; label?: string }[];
  /** Cells to highlight (the selected item's target). */
  highlight?: CellRef[];
  /** Screen px per reference px (keeps markers legible when zoomed out). */
  scale: number;
  onMarker?: (key: string) => void;
}) {
  const r = grid ? Math.max(markerRadius(grid, width, height), 11 / scale) : 12 / scale;
  const byKey = new Map(markers.map((m) => [m.key, m]));
  // With a selection, its links and the markers it reaches stay, everything else fades.
  const selected = selectedKey && byKey.has(selectedKey) ? selectedKey : undefined;
  const reach = levels ?? (selected ? selectionLevels(selected, links, markers.length, { ...SELECTION_REACH, maxDepth: 1 }) : new Map<string, number>());
  const role = (key: string) => {
    const lv = reach.get(key);
    return lv === 0 ? ' selected' : lv === 1 ? ' linked' : lv !== undefined ? ' linked2' : selected ? ' faded' : '';
  };
  // The lines flow toward the biggest item of their cluster, as on the photo.
  const flow = flowDirections(
    markers.map((m) => ({ key: m.key, pieceCount: m.pieces ?? 1 })),
    links,
  );
  const svgRef = useRef<SVGSVGElement>(null);
  useLineFlow(svgRef, `${selected ?? ''}|${links.length}|${showConnections}`, selected ? 18000 : 13000);
  const block = (b: CellBounds) => {
    const a = cellRect({ row: b.row0, col: b.col0 }, grid!, width, height);
    const z = cellRect({ row: b.row1, col: b.col1 }, grid!, width, height);
    return { x: a.x, y: a.y, width: z.x + z.width - a.x, height: z.y + z.height - a.y };
  };
  return (
    <svg ref={svgRef} className="overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
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
        const lv = selected ? linkLevel(reach, l) : undefined;
        if (lv === undefined && !showConnections) return null;
        const cls = ['link', lv === undefined ? selected && 'faded' : `level-${lv}`, lv === 1 && 'active', flow.get(linkId(l)) === 'a' && 'rev'].filter(Boolean).join(' ');
        return (
          <g key={linkId(l)} className={cls}>
            <line className="link-under" x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} vectorEffect="non-scaling-stroke" />
            <line className="link-line" x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      {markers.map((m) => (
        <g
          key={m.key}
          className={`marker st-${m.tone}${role(m.key)}`}
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
