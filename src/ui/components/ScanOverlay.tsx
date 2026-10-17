/** SVG overlay on an analysed photo: outlines, numbers, "up" arrows, issue highlights. */
import type { Rect } from '../../cv/image';
import type { DetectedRegion, ScanResult } from '../../model/types';
import { polygonPath, regionCenter, regionSize, upArrow } from '../lib/overlay';
import { currentPlacement, displayStatus, matchFor } from '../lib/pieces';
import { turnBadge, upVector } from '../lib/rotation';

export function ScanOverlay({
  result,
  rejected,
  visible,
  selectedId,
  placedIds,
  highlightIds,
  highlightArea,
  scale,
  onSelect,
}: {
  result: ScanResult;
  /** Per region: how many candidates were rejected with "Not this one". */
  rejected: Record<number, number>;
  /** Regions passing the current filter. */
  visible: Set<number>;
  selectedId?: number;
  placedIds: Set<number>;
  highlightIds?: number[];
  highlightArea?: Rect;
  /** Current zoom (screen px per photo px) to keep labels legible. */
  scale: number;
  onSelect: (id: number) => void;
}) {
  const { width, height } = result;
  const minLabel = 10.5 / scale; // label radius at least ~10 screen px (12 px numbers)
  const highlight = new Set(highlightIds ?? []);
  const dimOthers = highlight.size > 0;
  return (
    <svg className="overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {result.regions.map((region) => (
        <RegionMark
          key={region.id}
          region={region}
          result={result}
          rejected={rejected[region.id] ?? 0}
          hidden={!visible.has(region.id)}
          selected={selectedId === region.id}
          placed={placedIds.has(region.id)}
          highlighted={highlight.has(region.id)}
          dimmed={dimOthers && !highlight.has(region.id)}
          minLabel={minLabel}
          minHit={22 / scale}
          onSelect={onSelect}
        />
      ))}
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
    </svg>
  );
}

function RegionMark({
  region,
  result,
  rejected,
  hidden,
  selected,
  placed,
  highlighted,
  dimmed,
  minLabel,
  minHit,
  onSelect,
}: {
  region: DetectedRegion;
  result: ScanResult;
  rejected: number;
  hidden: boolean;
  selected: boolean;
  placed: boolean;
  highlighted: boolean;
  dimmed: boolean;
  minLabel: number;
  /** Radius (photo px) of the invisible touch target around the number: ≥ 44 screen px across. */
  minHit: number;
  onSelect: (id: number) => void;
}) {
  const match = matchFor(result, region.id);
  const status = displayStatus(region, match);
  const placement = currentPlacement(match, rejected);
  const c = regionCenter(region);
  const size = regionSize(region);
  const labelR = Math.max(minLabel, size * 0.13);
  // The arrow sticks out of the number badge like a compass needle.
  const tip = Math.max(size * 0.62, labelR * 2.6);
  const arrow = placement ? upArrow(c, placement.rotationDeg, tip, { start: labelR * 0.6, head: Math.max(labelR * 0.95, size * 0.12) }) : undefined;
  const badge = placement ? turnBadge(placement.rotationDeg) : '';
  const u = placement ? upVector(placement.rotationDeg) : { x: 0, y: -1 };
  // Turn hint on the side opposite the arrow.
  const badgeH = Math.max(labelR * 1.15, minHit * 0.76); // text ≥ 12 screen px
  const badgeW = badgeH * 2.4;
  const bc = { x: c.x - u.x * (labelR + badgeH * 0.9), y: c.y - u.y * (labelR + badgeH * 0.9) };
  const cls = [
    'region',
    `st-${status}`,
    hidden && 'hidden',
    selected && 'selected',
    placed && 'placed',
    highlighted && 'highlighted',
    dimmed && 'dimmed',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <g
      className={cls}
      onClick={() => onSelect(region.id)}
      role="button"
      tabIndex={hidden ? -1 : 0}
      aria-label={`Piece ${region.id}`}
      data-testid={`region-${region.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(region.id);
        }
      }}
    >
      <circle className="hit" cx={c.x} cy={c.y} r={Math.max(minHit, labelR)} />
      <path d={polygonPath(region.contour)} className="region-fill" />
      <path d={polygonPath(region.contour)} className="region-line" vectorEffect="non-scaling-stroke" />
      {arrow && !placed && (
        <g className="region-arrow">
          <line className="arrow-halo" x1={arrow.from.x} y1={arrow.from.y} x2={arrow.to.x} y2={arrow.to.y} strokeWidth={labelR * 0.62} />
          <polygon className="arrow-halo" points={arrow.head.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={labelR * 0.3} />
          <line className="arrow-body" x1={arrow.from.x} y1={arrow.from.y} x2={arrow.to.x} y2={arrow.to.y} strokeWidth={labelR * 0.3} />
          <polygon className="arrow-body" points={arrow.head.map((p) => `${p.x},${p.y}`).join(' ')} />
        </g>
      )}
      <g className="region-label">
        <circle cx={c.x} cy={c.y} r={labelR} />
        <text x={c.x} y={c.y} fontSize={labelR * 1.15} dy="0.36em" textAnchor="middle">
          {placed ? '✓' : region.id}
        </text>
      </g>
      {badge && !placed && (
        <g className="region-turn" aria-hidden="true">
          <rect x={bc.x - badgeW / 2} y={bc.y - badgeH / 2} width={badgeW} height={badgeH} rx={badgeH / 2} />
          <text x={bc.x} y={bc.y} fontSize={badgeH * 0.72} dy="0.35em" textAnchor="middle">
            {badge}
          </text>
        </g>
      )}
    </g>
  );
}
