/**
 * Detail sheet for one item (a piece or an assembled grid): where it was in the photo, where it
 * goes (picture turned like the item lies), how to turn it, alternatives, neighbours, notes, and
 * Placed / Not this one.
 */
import type { DetectedRegion, GridSpec, ScanResult } from '../../model/types';
import { describeCell } from '../../pipeline/grid';
import { cellsText, itemTitle, type ItemPlacement, type ScanItem } from '../lib/items';
import { borderText, localToPuzzleTurns, pieceKindLabel, STATUS_LABEL } from '../lib/pieces';
import { CropCanvas } from './CropCanvas';
import { IconCheck, IconClose } from './Icons';
import { ConfidenceBar, PhotoItemCrop, TargetView, TurnInstruction } from './ItemVisuals';
import { PieceIcon } from './PieceIcon';
import { IssueList } from './Quality';
import { itemTone } from './ScanOverlay';
import { Sheet } from './Sheet';
import { cropAround } from '../lib/overlay';

export interface ItemDetailProps {
  item: ScanItem;
  /** Index of the candidate currently shown (after "Not this one"). */
  candidateIndex: number;
  result: ScanResult;
  grid: GridSpec;
  photo: CanvasImageSource | undefined;
  reference: { bitmap?: ImageBitmap; url?: string; width: number; height: number } | undefined;
  placed: boolean;
  /** Linked items (pieces that go next to this one). */
  neighbours: ScanItem[];
  onReject(): void;
  onChoose(candidateIndex: number): void;
  onPlace(placement: ItemPlacement): void;
  onUnplace(placement: ItemPlacement): void;
  onOpen(key: string): void;
  onClose(): void;
}

export function placementWhere(item: ScanItem, p: ItemPlacement, grid: GridSpec): string {
  return item.kind === 'assembled' ? cellsText(p) : describeCell(p.cells[0] ?? { row: p.bounds.row0, col: p.bounds.col0 }, grid);
}

export function ItemDetail(props: ItemDetailProps) {
  const { item, candidateIndex, result, grid, photo, reference, placed, neighbours } = props;
  const current: ItemPlacement | undefined = item.candidates[candidateIndex];
  const tone = itemTone(item);
  const members = result.regions.filter((r) => item.regionIds.includes(r.id));
  const single: DetectedRegion | undefined = item.kind === 'piece' ? members[0] : undefined;
  const sides = single?.shape?.sides.map((s) => s.kind);
  const iconTurn = single?.shape && current?.rotationDeg !== undefined ? localToPuzzleTurns(single.shape.angleDeg, current.rotationDeg) * 90 : (single?.shape?.angleDeg ?? 0);
  const border = single?.shape && current?.rotationDeg !== undefined ? borderText(single, current.rotationDeg) : '';
  const issues = members.flatMap((m) => m.issues).filter((v, i, a) => a.indexOf(v) === i);
  const heading = item.status === 'ambiguous' && candidateIndex === 0 ? 'Probably goes here' : 'Goes here';

  return (
    <Sheet
      title={
        <span className="row gap-sm">
          <span className={`num-badge st-${tone}`}>{item.label}</span>
          <span>{itemTitle(item)}</span>
        </span>
      }
      onClose={props.onClose}
      footer={
        current ? (
          <div className="row gap">
            {item.candidates.length > 1 && !placed && (
              <button className="btn grow" onClick={props.onReject} data-testid="not-this-one">
                <IconClose size={18} />
                Not this one
              </button>
            )}
            {placed ? (
              <button className="btn btn-ok grow" onClick={() => props.onUnplace(current)} aria-pressed="true">
                <IconCheck size={18} />
                Placed – undo
              </button>
            ) : (
              <button className="btn btn-primary grow" onClick={() => props.onPlace(current)} data-testid="mark-placed">
                Placed ✓
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="pd-top">
        <figure className="pd-piece">
          <PhotoItemCrop item={item} regions={result.regions} photo={photo} photoWidth={result.width} photoHeight={result.height} size={150} label={`${itemTitle(item)} in your photo`} />
          <figcaption>In your photo</figcaption>
        </figure>
        <div className="pd-facts">
          <div className="pd-kind">
            {sides && <PieceIcon sides={sides} rotationDeg={iconTurn} size={52} title="Piece shape (finished orientation)" />}
            <div>
              <div className="pd-kind-label">{item.kind === 'assembled' ? `Assembled grid · ${item.pieceCount} pieces` : single ? pieceKindLabel(single) : 'Piece'}</div>
              <div className={`status-chip st-${item.status}`}>{STATUS_LABEL[item.status]}</div>
            </div>
          </div>
          {item.kind === 'assembled' && current && (
            <div className="small" data-testid="group-summary">
              → {cellsText(current)}
            </div>
          )}
          {current && <TurnInstruction rotationDeg={current.rotationDeg} />}
          {border && <div className="small">{border}</div>}
        </div>
      </div>

      {current ? (
        <section className="pd-section">
          <h3>{heading}</h3>
          <div className="cand big">
            <TargetView placement={current} grid={grid} reference={reference} size={220} label={`Box picture where ${itemTitle(item)} goes, turned like it lies`} />
            <div className="cand-info">
              <div className="cand-where">{placementWhere(item, current, grid)}</div>
              <div className="muted small">Picture turned to match your {item.kind === 'assembled' ? 'grid' : 'piece'}.</div>
              <ConfidenceBar value={current.confidence} />
            </div>
          </div>
        </section>
      ) : (
        <div className="pd-none">
          <strong>No more suggestions.</strong>
          <p className="muted">All places were rejected. Pick one below again, or scan this piece in another photo.</p>
        </div>
      )}

      {item.candidates.length > 1 && (
        <section className="pd-section">
          <h3>Other possibilities</h3>
          <div className="cand-strip">
            {item.candidates.map((p, i) => {
              if (i === candidateIndex || !reference) return null;
              const c = cropAround(p.x, p.y, grid, reference.width, reference.height, 2.2);
              return (
                <button key={i} className="cand-mini" onClick={() => props.onChoose(i)} aria-label={`Use place ${i + 1}: ${cellsText(p)}`}>
                  <CropCanvas source={reference.bitmap} rotated={{ ...c, rotationDeg: -(p.rotationDeg ?? 0) }} size={96} label={`Picture around ${cellsText(p)}`} />
                  <span className="cand-mini-cell">
                    r{p.bounds.row0 + 1} · c{p.bounds.col0 + 1}
                  </span>
                  <ConfidenceBar value={p.confidence} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {neighbours.length > 0 && (
        <section className="pd-section">
          <h3>Goes next to</h3>
          <ul className="fit-list">
            {neighbours.map((n) => (
              <li key={n.key}>
                <button className="link-btn" onClick={() => props.onOpen(n.key)}>
                  {n.kind === 'assembled' ? `Assembled grid #${n.label}` : `Piece #${n.label}`}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {issues.length > 0 && (
        <section className="pd-section">
          <h3>Notes</h3>
          <IssueList issues={issues} />
        </section>
      )}
    </Sheet>
  );
}
