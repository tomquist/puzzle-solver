/**
 * SVG overlay on an analysed photo. Only items with a usable match are drawn (no-match regions are
 * hidden entirely). Each item: thin outline(s), one number badge (assembled grids: one badge for
 * the whole grid, outline emphasised), an optional small notch on the badge pointing to "up", and
 * optional thin connection lines between pieces that end up next to each other.
 */
import type { Rect } from '../../cv/image';
import type { ScanResult } from '../../model/types';
import type { ItemLink, ItemPlacement, ScanItem } from '../lib/items';
import { badgeNotch, polygonPath, trimmedSegment } from '../lib/overlay';

export interface OverlayItem {
  item: ScanItem;
  placement: ItemPlacement | undefined;
  placed: boolean;
}

export type ItemTone = 'confident' | 'ambiguous' | 'patch';

export function itemTone(item: ScanItem): ItemTone {
  return item.kind === 'assembled' ? 'patch' : item.status;
}

export function ScanOverlay({
  result,
  items,
  links,
  selectedKey,
  showTurnHints,
  showConnections,
  highlightRegionIds,
  highlightArea,
  scale,
  onSelect,
}: {
  result: ScanResult;
  items: OverlayItem[];
  links: ItemLink[];
  selectedKey?: string;
  showTurnHints: boolean;
  showConnections: boolean;
  highlightRegionIds?: number[];
  highlightArea?: Rect;
  /** Screen px per photo px (keeps badges legible at any zoom). */
  scale: number;
  onSelect: (key: string) => void;
}) {
  const { width, height } = result;
  const byId = new Map(result.regions.map((r) => [r.id, r]));
  const r = 11 / scale; // badge radius ≈ 11 screen px
  const hit = 22 / scale; // ≥ 44 px touch target
  const highlight = new Set(highlightRegionIds ?? []);
  const dim = highlight.size > 0;
  const centre = new Map(items.map((o) => [o.item.key, o.item.center]));

  return (
    <svg className="overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {/* Outlines and touch targets */}
      {items.map(({ item, placed }) => {
        const tone = itemTone(item);
        const lit = item.regionIds.some((id) => highlight.has(id));
        const cls = ['item', `st-${tone}`, item.kind === 'assembled' && 'assembled', selectedKey === item.key && 'selected', placed && 'placed', lit && 'highlighted', dim && !lit && 'dimmed']
          .filter(Boolean)
          .join(' ');
        return (
          <g
            key={item.key}
            className={cls}
            role="button"
            tabIndex={0}
            aria-label={`${item.kind === 'assembled' ? 'Assembled grid' : 'Piece'} ${item.label}`}
            data-testid={`item-${item.key}`}
            onClick={() => onSelect(item.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item.key);
              }
            }}
          >
            {item.regionIds.map((id) => {
              const reg = byId.get(id);
              if (!reg) return null;
              const d = polygonPath(reg.contour);
              return (
                <g key={id}>
                  {item.kind === 'assembled' && <path d={d} className="item-halo" vectorEffect="non-scaling-stroke" />}
                  <path d={d} className="item-fill" />
                  <path d={d} className="item-line" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
            <circle className="hit" cx={item.center.x} cy={item.center.y} r={hit} />
          </g>
        );
      })}

      {highlightArea && (
        <rect
          className="issue-area"
          x={highlightArea.x}
          y={highlightArea.y}
          width={highlightArea.width}
          height={highlightArea.height}
          rx={Math.min(highlightArea.width, highlightArea.height) * 0.06}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* Connections between pieces that end up next to each other */}
      {showConnections &&
        links.map((l) => {
          const a = centre.get(l.a);
          const b = centre.get(l.b);
          const seg = a && b ? trimmedSegment(a, b, r * 1.25) : null;
          if (!seg) return null;
          return (
            <g key={`${l.a}-${l.b}`} className="link" data-testid="link">
              <line className="link-under" x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} vectorEffect="non-scaling-stroke" />
              <line className="link-line" x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}

      {/* Number badges (visual only – taps go to the item's touch target underneath) */}
      {items.map(({ item, placement, placed }) => {
        const tone = itemTone(item);
        const notch = showTurnHints && !placed && placement?.rotationDeg !== undefined ? badgeNotch(item.center, r, placement.rotationDeg) : undefined;
        return (
          <g key={item.key} className={`badge st-${tone}${placed ? ' placed' : ''}${selectedKey === item.key ? ' selected' : ''}`} aria-hidden="true">
            {notch && <polygon className="badge-notch" points={notch.map((p) => `${p.x},${p.y}`).join(' ')} />}
            <circle cx={item.center.x} cy={item.center.y} r={r} />
            <text x={item.center.x} y={item.center.y} fontSize={r * 1.1} dy="0.36em" textAnchor="middle">
              {placed ? '✓' : item.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
