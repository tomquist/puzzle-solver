/** SVG overlay on an analysed photo: outlines, numbers, "up" arrows, issue highlights. */
import type { Rect } from '../../cv/image';
import type { DetectedRegion, ScanResult } from '../../model/types';
import { polygonPath, regionCenter, regionSize, upArrow } from '../lib/overlay';
import { currentPlacement, displayStatus, matchFor } from '../lib/pieces';
import { nearestQuarterTurn } from '../lib/rotation';

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
  const minLabel = 13 / scale; // label radius at least ~13 screen px
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
  onSelect: (id: number) => void;
}) {
  const match = matchFor(result, region.id);
  const status = displayStatus(region, match);
  const placement = currentPlacement(match, rejected);
  const c = regionCenter(region);
  const size = regionSize(region);
  const labelR = Math.max(minLabel, size * 0.16);
  const arrow = placement ? upArrow(c, placement.rotationDeg, size * 0.42) : undefined;
  const turn = placement ? nearestQuarterTurn(placement.rotationDeg) : 0;
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
      <path d={polygonPath(region.contour)} className="region-fill" />
      <path d={polygonPath(region.contour)} className="region-line" vectorEffect="non-scaling-stroke" />
      {arrow && !placed && (
        <g className="region-arrow">
          <line x1={arrow.from.x} y1={arrow.from.y} x2={arrow.to.x} y2={arrow.to.y} strokeWidth={Math.max(labelR * 0.28, size * 0.045)} />
          <polygon points={arrow.head.map((p) => `${p.x},${p.y}`).join(' ')} />
        </g>
      )}
      <g className="region-label">
        <circle cx={c.x} cy={c.y} r={labelR} />
        <text x={c.x} y={c.y} fontSize={labelR * 1.15} dy="0.36em" textAnchor="middle">
          {placed ? '✓' : region.id}
        </text>
      </g>
      {turn !== 0 && !placed && placement && (
        <text className="region-turn" x={c.x} y={c.y + labelR * 2.3} fontSize={labelR * 0.95} textAnchor="middle">
          {turn === 90 ? '↻' : turn === 270 ? '↺' : '↻↻'}
        </text>
      )}
    </g>
  );
}
