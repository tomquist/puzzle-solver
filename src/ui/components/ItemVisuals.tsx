/**
 * Visual building blocks shared by the item detail sheet and the guided placing mode:
 * - PhotoItemCrop: the item cut out of the scan photo, its outline highlighted ("Pick up #4")
 * - TargetView: the box picture around the target, turned the way the piece lies, with the target
 *   cell(s) outlined and a small map of the whole picture showing where that is
 * - TurnInstruction / ConfidenceBar
 */
import type { DetectedRegion, GridSpec } from '../../model/types';
import type { ItemPlacement, ScanItem } from '../lib/items';
import { cellSize, paddedBox, polygonPath } from '../lib/overlay';
import { confidencePercent } from '../lib/pieces';
import { turnInstruction } from '../lib/rotation';
import { CropCanvas } from './CropCanvas';
import { itemTone } from './ScanOverlay';

export function ConfidenceBar({ value }: { value: number }) {
  const pct = confidencePercent(value);
  const tone = value >= 0.7 ? 'ok' : value >= 0.35 ? 'warn' : 'bad';
  return (
    <div className="conf" title={`${pct}% confidence`}>
      <div className="conf-track">
        <div className={`conf-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="conf-num tabular">{pct}%</span>
    </div>
  );
}

/** Square photo crop around an item (padded), with the member outlines drawn on top. */
export function PhotoItemCrop({
  item,
  regions,
  photo,
  photoWidth,
  photoHeight,
  size = 150,
  label,
}: {
  item: ScanItem;
  regions: DetectedRegion[];
  photo: CanvasImageSource | undefined;
  photoWidth: number;
  photoHeight: number;
  size?: number;
  label: string;
}) {
  const b = paddedBox(item.bbox, 0.18, photoWidth, photoHeight);
  const side = Math.max(b.width, b.height);
  const rect = { x: b.x + b.width / 2 - side / 2, y: b.y + b.height / 2 - side / 2, width: side, height: side };
  const members = regions.filter((r) => item.regionIds.includes(r.id));
  return (
    <div className="crop-wrap">
      <CropCanvas source={photo} rect={rect} size={size} label={label} />
      <svg className="crop-overlay" viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} preserveAspectRatio="none" aria-hidden="true">
        {members.map((m) => (
          <path key={m.id} d={polygonPath(m.contour)} className={`crop-outline st-${itemTone(item)}`} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </div>
  );
}

/**
 * The box picture around a placement, turned the way the item lies in the photo (so it can be
 * compared directly), with the target cells outlined, plus a minimap of the whole picture.
 */
export function TargetView({
  placement,
  grid,
  reference,
  size = 240,
  minimap = true,
  label,
}: {
  placement: ItemPlacement;
  grid: GridSpec;
  reference: { bitmap?: ImageBitmap; url?: string; width: number; height: number } | undefined;
  size?: number;
  minimap?: boolean;
  label: string;
}) {
  if (!reference) return <div className="target-view placeholder" style={{ aspectRatio: '1 / 1' }} />;
  const { w, h } = cellSize(grid, reference.width, reference.height);
  const { row0, col0, row1, col1 } = placement.bounds;
  const span = Math.max(row1 - row0 + 1, col1 - col0 + 1);
  const side = (span + 1.4) * Math.max(w, h);
  const cx = placement.x;
  const cy = placement.y;
  const rot = -(placement.rotationDeg ?? 0);
  const cells = placement.cells.length ? placement.cells : [{ row: row0, col: col0 }];
  const bx = col0 * w;
  const by = row0 * h;
  const bw = (col1 - col0 + 1) * w;
  const bh = (row1 - row0 + 1) * h;
  return (
    <div className="target-view">
      <CropCanvas source={reference.bitmap} rotated={{ cx, cy, side, rotationDeg: rot }} size={size} label={label} />
      <svg className="crop-overlay" viewBox={`${cx - side / 2} ${cy - side / 2} ${side} ${side}`} preserveAspectRatio="none" aria-hidden="true">
        <g transform={`rotate(${rot} ${cx} ${cy})`}>
          {cells.map((c) => (
            <rect key={`${c.row},${c.col}`} className="target-cell" x={c.col * w} y={c.row * h} width={w} height={h} vectorEffect="non-scaling-stroke" />
          ))}
          <rect className="target-bounds" x={bx} y={by} width={bw} height={bh} rx={Math.min(w, h) * 0.06} vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
      {minimap && reference.url && (
        <svg className="minimap" viewBox={`0 0 ${reference.width} ${reference.height}`} style={{ aspectRatio: `${reference.width} / ${reference.height}` }} aria-hidden="true">
          <image href={reference.url} x={0} y={0} width={reference.width} height={reference.height} preserveAspectRatio="none" />
          <rect className="minimap-dim" x={0} y={0} width={reference.width} height={reference.height} />
          <rect className="minimap-target" x={bx - w * 0.5} y={by - h * 0.5} width={bw + w} height={bh + h} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

/** "Turn ↻ 90°" with the exact angle underneath (or "Already upright"). */
export function TurnInstruction({ rotationDeg, compact = false }: { rotationDeg: number | undefined; compact?: boolean }) {
  if (rotationDeg === undefined) return null;
  const t = turnInstruction(rotationDeg);
  return (
    <div className={compact ? 'turn compact' : 'turn'}>
      <div className="turn-main">{t.short}</div>
      {t.exact && !compact && <div className="muted small">{t.exact}</div>}
    </div>
  );
}
