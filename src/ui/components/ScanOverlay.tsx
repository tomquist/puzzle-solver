/**
 * SVG overlay on an analysed photo, drawn so the pieces themselves stay visible: thin outlines
 * without fill, a small number label just outside each outline (its tail points at its piece), an
 * optional small tick outside the outline on the side that is "up" in the puzzle, and thin
 * connection lines between pieces that end up next to each other. Only items with a usable match
 * are drawn (no-match regions are hidden entirely).
 *
 * Selecting an item (tap it or its label) emphasises it, draws its connection lines strongly,
 * rings the items it joins and fades everything else; tapping it again or the empty photo clears
 * the selection. `peek` hides everything (to see the clean photo); with labels off only the
 * selection is drawn.
 */
import { useEffect, useId, useMemo, useRef, type MouseEvent } from 'react';
import type { Point } from '../../cv/geometry';
import type { Rect } from '../../cv/image';
import type { DetectedRegion, ScanResult } from '../../model/types';
import { itemTitle, linkedTo, type ItemLink, type ItemPlacement, type ScanItem } from '../lib/items';
import { labelCenter, labelTail, labelWidth, outwardTick, placeLabels, supportDistance } from '../lib/labels';
import { connectionCurve, groupCellCenter, groupCellSize, polygonPath, regionSize, sideVector, type CurveEnd } from '../lib/overlay';
import { upVector } from '../lib/rotation';

export interface OverlayItem {
  item: ScanItem;
  placement: ItemPlacement | undefined;
  placed: boolean;
}

export type ItemTone = 'confident' | 'ambiguous' | 'patch';

export function itemTone(item: ScanItem): ItemTone {
  return item.kind === 'assembled' ? 'patch' : item.status;
}

/** Label size in screen px (the font stays ≥ 12 px at any zoom). */
const LABEL_H = 20;
const LABEL_FONT = 12.5;
/** Space between an outline and its label (bridged by the label's tail), screen px. */
const LABEL_GAP = 4.5;
/** Touch target radius around an item's centre, screen px (≥ 44 px targets). */
const HIT = 22;
/** Wait this long before clearing on a tap, so a double-tap (zoom) keeps the selection. */
const CLEAR_DELAY = 260;
const MAX_OUTLINE_POINTS = 48;

export function ScanOverlay({
  result,
  items,
  links,
  selectedKey,
  showLabels = true,
  showTurnHints,
  showConnections,
  peek = false,
  highlightRegionIds,
  highlightArea,
  scale,
  fitScale,
  onSelect,
  onClear,
}: {
  result: ScanResult;
  items: OverlayItem[];
  links: ItemLink[];
  selectedKey?: string;
  /** Numbers and outlines of all items (off: only the selected item and its connections). */
  showLabels?: boolean;
  showTurnHints: boolean;
  showConnections: boolean;
  /** Hide all annotations (press-and-hold on the photo). */
  peek?: boolean;
  highlightRegionIds?: number[];
  highlightArea?: Rect;
  /** Screen px per photo px (keeps labels legible at any zoom). */
  scale: number;
  /** Scale of the fitted photo – where labels are most crowded, so their sides are chosen there. */
  fitScale?: number;
  onSelect: (key: string) => void;
  onClear?: () => void;
}) {
  const { width, height } = result;
  const byId = useMemo(() => new Map(result.regions.map((r) => [r.id, r])), [result]);
  const overlayByKey = new Map(items.map((o) => [o.item.key, o]));
  const highlight = new Set(highlightRegionIds ?? []);
  const dim = highlight.size > 0;

  // Outline points (subsampled) and ring radius per item.
  const itemsKey = items.map((o) => o.item.key).join(',');
  const geo = useMemo(() => {
    const m = new Map<string, { outline: Point[]; ring: number }>();
    for (const { item } of items) {
      const pts: Point[] = [];
      for (const id of item.regionIds) {
        const c = byId.get(id)?.contour ?? [];
        const step = Math.max(1, Math.floor(c.length / MAX_OUTLINE_POINTS));
        for (let i = 0; i < c.length; i += step) pts.push(c[i]);
      }
      if (pts.length === 0) {
        const b = item.bbox;
        pts.push({ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height });
      }
      const ring = pts.reduce((mx, p) => Math.max(mx, Math.hypot(p.x - item.center.x, p.y - item.center.y)), 0);
      m.set(item.key, { outline: pts, ring });
    }
    return m;
    // The items' geometry only changes with the set of items (itemsKey), not with their state.
  }, [itemsKey, byId]);

  // "Up" of each item as it lies (for the turn tick), and the label sides, chosen at the fitted
  // zoom and away from the tick.
  const upOf = (o: OverlayItem) => (showTurnHints && o.placement?.rotationDeg !== undefined ? upVector(o.placement.rotationDeg) : undefined);
  const upKey = items
    .map((o) => {
      const u = upOf(o);
      return u ? `${u.x.toFixed(2)}:${u.y.toFixed(2)}` : '-';
    })
    .join(',');
  const placeScale = fitScale && fitScale > 0 ? fitScale : scale;
  const spots = useMemo(
    () =>
      placeLabels(
        items.map((o) => ({
          key: o.item.key,
          center: o.item.center,
          outline: geo.get(o.item.key)?.outline ?? [],
          radius: labelWidth(String(o.item.label), LABEL_H, LABEL_FONT) / 2 / placeScale,
          avoid: upOf(o),
        })),
        { width, height },
        LABEL_GAP / placeScale,
      ),
    // Recomputed when the items, the zoom to place for or the turn ticks change.
    [geo, placeScale, width, height, upKey],
  );

  // Selection.
  const selected = selectedKey && overlayByKey.has(selectedKey) ? selectedKey : undefined;
  const linked = new Set(selected ? linkedTo(selected, links) : []);
  const role = (key: string) => (key === selected ? 'selected' : linked.has(key) ? 'linked' : selected ? 'faded' : '');
  const marked = (key: string) => key === selected || linked.has(key);
  const isActive = (l: ItemLink) => !!selected && (l.a === selected || l.b === selected);
  const shownLinks = links.filter((l) => isActive(l) || (showConnections && showLabels));

  const maskId = `sel-mask-${useId().replace(/:/g, '')}`;
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  const cancelPending = () => window.clearTimeout(pending.current);
  const clearLater = () => {
    cancelPending();
    if (onClear) pending.current = window.setTimeout(onClear, CLEAR_DELAY);
  };
  const tap = (key: string, e: MouseEvent) => {
    if (e.detail > 1) return; // second tap of a double-tap: the viewer zooms
    if (key === selected) clearLater();
    else {
      cancelPending();
      onSelect(key);
    }
  };

  const hit = HIT / scale;
  const labelH = LABEL_H / scale;
  const gap = LABEL_GAP / scale;
  const svgCls = ['overlay', 'scan-overlay', selected && 'has-selection', !showLabels && 'labels-off', peek && 'peek'].filter(Boolean).join(' ');

  return (
    <svg
      className={svgCls}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      onDoubleClick={cancelPending}
      // One screen px in photo units, for dash patterns that must not shrink with the zoom.
      style={{ ['--u' as string]: `${1 / scale}px` }}
      data-testid="scan-overlay"
    >
      {/* Empty photo: clears the selection. */}
      <rect
        className="bg-hit"
        x={0}
        y={0}
        width={width}
        height={height}
        onClick={(e) => {
          if (e.detail <= 1 && selected) clearLater();
        }}
      />

      {/* With a selection, the photo darkens except for the selected item and the items it joins. */}
      {selected && (
        <>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
            <rect x={0} y={0} width={width} height={height} fill="#fff" />
            {[selected, ...linked].flatMap((key) =>
              (overlayByKey.get(key)?.item.regionIds ?? []).map((id) => {
                const reg = byId.get(id);
                return reg ? <path key={`${key}-${id}`} d={polygonPath(reg.contour)} fill="#000" stroke="#000" strokeWidth={8 / scale} strokeLinejoin="round" /> : null;
              }),
            )}
          </mask>
          <rect className="selection-scrim" x={0} y={0} width={width} height={height} mask={`url(#${maskId})`} data-testid="selection-scrim" />
        </>
      )}

      {/* Outlines, turn ticks and touch targets */}
      {items.map((o) => {
        const { item, placed } = o;
        const tone = itemTone(item);
        const up = !placed ? upOf(o) : undefined;
        const outline = geo.get(item.key)?.outline ?? [];
        const tick = up ? outwardTick(item.center, supportDistance(item.center, outline, up), up, 2 / scale, 6 / scale, 4.5 / scale) : undefined;
        const lit = item.regionIds.some((id) => highlight.has(id));
        const sel = role(item.key);
        const cls = [
          'item',
          `st-${tone}`,
          item.kind === 'assembled' && 'assembled',
          sel,
          !showLabels && !marked(item.key) && 'bare',
          placed && 'placed',
          lit && 'highlighted',
          dim && !lit && 'dimmed',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g
            key={item.key}
            className={cls}
            role="button"
            tabIndex={0}
            aria-label={itemTitle(item)}
            aria-pressed={item.key === selected}
            data-testid={`item-${item.key}`}
            onClick={(e) => tap(item.key, e)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (item.key === selected) onClear?.();
                else onSelect(item.key);
              }
            }}
          >
            <circle className="hit" cx={item.center.x} cy={item.center.y} r={hit} />
            {item.regionIds.map((id) => {
              const reg = byId.get(id);
              if (!reg) return null;
              const d = polygonPath(reg.contour);
              return (
                <g key={id}>
                  <path d={d} className="item-halo" vectorEffect="non-scaling-stroke" />
                  <path d={d} className="item-fill" />
                  <path d={d} className="item-line" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
            {tick && <polygon className="turn-tick" points={tick.map((p) => `${p.x},${p.y}`).join(' ')} />}
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
      {shownLinks.map((l) => {
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
          return { center: o.item.center, reach: (geo.get(key)?.ring ?? labelH) * 0.6 };
        };
        const a = end(l.a, l.sideA, l.cellA);
        const b = end(l.b, l.sideB, l.cellB);
        const curve = a && b ? connectionCurve(a, b) : null;
        if (!curve) return null;
        const active = isActive(l);
        return (
          <g
            key={`${l.a}-${l.b}`}
            className={`link${active ? ' active' : selected ? ' faded' : ''}`}
            data-testid="link"
            data-a={l.a}
            data-b={l.b}
            data-active={active ? 'true' : undefined}
          >
            <path className="link-under" d={curve.d} vectorEffect="non-scaling-stroke" />
            <path className="link-line" d={curve.d} vectorEffect="non-scaling-stroke" />
            <circle className="link-end" cx={curve.from.x} cy={curve.from.y} r={(active ? 4.5 : 3) / scale} />
            <circle className="link-end" cx={curve.to.x} cy={curve.to.y} r={(active ? 4.5 : 3) / scale} />
          </g>
        );
      })}

      {/* Rings around the selected item and the items it joins. */}
      {selected &&
        [selected, ...linked].map((key) => {
          const o = overlayByKey.get(key);
          if (!o) return null;
          const r = Math.max((geo.get(key)?.ring ?? 0) + 5 / scale, 14 / scale);
          const cls = key === selected ? 'ring selected' : 'ring linked';
          return (
            <g key={`ring-${key}`} className={cls} data-testid={`ring-${key}`}>
              <circle className="ring-under" cx={o.item.center.x} cy={o.item.center.y} r={r} vectorEffect="non-scaling-stroke" />
              <circle className="ring-line" cx={o.item.center.x} cy={o.item.center.y} r={r} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}

      {/* Number labels just outside the outlines (tapping one selects its item). */}
      {items.map(({ item, placed }) => {
        const sel = role(item.key);
        if (!showLabels && !marked(item.key)) return null;
        const spot = spots.get(item.key);
        if (!spot) return null;
        const text = placed ? '✓' : String(item.label);
        const w = labelWidth(String(item.label), LABEL_H, LABEL_FONT) / scale;
        const c = labelCenter(item.center, spot, w / 2, gap);
        const tail = labelTail(item.center, spot, w / 2, gap, 3.5 / scale);
        return (
          <g
            key={item.key}
            className={`label st-${itemTone(item)}${placed ? ' placed' : ''}${sel ? ` ${sel}` : ''}`}
            aria-hidden="true"
            data-testid={`label-${item.key}`}
            onClick={(e) => tap(item.key, e)}
          >
            <circle className="hit" cx={c.x} cy={c.y} r={Math.max(w / 2 + 3 / scale, 14 / scale)} />
            <polygon className="label-tail" points={tail.map((p) => `${p.x},${p.y}`).join(' ')} />
            <rect x={c.x - w / 2} y={c.y - labelH / 2} width={w} height={labelH} rx={labelH / 2} vectorEffect="non-scaling-stroke" />
            <text x={c.x} y={c.y} fontSize={LABEL_FONT / scale} dy="0.36em" textAnchor="middle">
              {text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
