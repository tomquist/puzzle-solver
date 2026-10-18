/**
 * SVG overlay on an analysed photo. Only items with a usable match are drawn (no-match regions are
 * hidden entirely). Each item: thin outline(s), one number badge (assembled grids: one badge for
 * the whole grid, outline emphasised), an optional small notch on the badge pointing to "up", and
 * optional thin connection lines between pieces that end up next to each other.
 */
import type { Rect } from '../../cv/image';
import type { DetectedRegion, ScanResult } from '../../model/types';
import type { ItemLink, ItemPlacement, ScanItem } from '../lib/items';
import { badgeNotch, connectionCurve, groupCellCenter, groupCellSize, polygonPath, regionSize, sideVector, type CurveEnd } from '../lib/overlay';

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
  const overlayByKey = new Map(items.map((o) => [o.item.key, o]));

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

      {/* Connections between pieces that end up next to each other: curves from the joining edge
          of one piece to the matching edge of the other. */}
      {showConnections &&
        links.map((l) => {
          const end = (key: string, side: ItemLink['sideA'], cell: ItemLink['cellA']): CurveEnd | undefined => {
            const o = overlayByKey.get(key);
            if (!o) return undefined;
            const rot = o.placement?.rotationDeg;
            if (side && rot !== undefined) {
              const dir = sideVector(side, rot);
              if (o.item.kind === 'piece') {
                const region = byId.get(o.item.regionIds[0]);
                if (region) return { center: o.item.center, reach: regionSize(region) / 2, dir };
              } else if (cell && o.placement && o.placement.cells.length > 0) {
                // An assembled group: from the member piece that touches the other item.
                const members = o.item.regionIds.map((id) => byId.get(id)).filter((m): m is DetectedRegion => !!m);
                const px = groupCellSize(members, o.placement.cells.length);
                return { center: groupCellCenter(o.item.center, o.placement.cells, cell, rot, px), reach: px / 2, dir };
              }
            }
            return { center: o.item.center, reach: r * 1.25 };
          };
          const a = end(l.a, l.sideA, l.cellA);
          const b = end(l.b, l.sideB, l.cellB);
          const curve = a && b ? connectionCurve(a, b) : null;
          if (!curve) return null;
          return (
            <g key={`${l.a}-${l.b}`} className="link" data-testid="link">
              <path className="link-under" d={curve.d} vectorEffect="non-scaling-stroke" />
              <path className="link-line" d={curve.d} vectorEffect="non-scaling-stroke" />
              <circle className="link-end" cx={curve.from.x} cy={curve.from.y} r={2.6 / scale} />
              <circle className="link-end" cx={curve.to.x} cy={curve.to.y} r={2.6 / scale} />
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
