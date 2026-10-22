/**
 * Detail sheet for one item (a piece or an assembled grid): where it lies in the photo, how to turn
 * it, which items it joins (in words), where it goes in the box picture (with context and an
 * overview), alternatives, notes, and Placed / Not this one.
 */
import type { CellRef, DetectedRegion, GridSpec, ScanResult } from '../../model/types';
import { describeCell } from '../../pipeline/grid';
import { cellsText, describeConnections, itemKindText, itemTitle, SIDE_PHRASE, type Connection, type ItemPlacement, type ScanItem } from '../lib/items';
import { cropAround } from '../lib/overlay';
import { certaintyLine, itemCertainty, spotCertainty, spotsToCompare, uncertaintyText } from '../lib/certainty';
import { borderText, localToPuzzleTurns, pieceKindLabel } from '../lib/pieces';
import { CropCanvas } from './CropCanvas';
import { IconCheck, IconChevron, IconClose } from './Icons';
import { PlacedConflictNote, UncertainNote } from './CertaintyNotes';
import { CertaintyMeter, PickupView, TargetContext, type ReferenceImage } from './ItemVisuals';
import { TurnGuide } from './TurnGuide';
import { PieceIcon } from './PieceIcon';
import { IssueList } from './Quality';
import { itemTone } from './ScanOverlay';
import { Sheet } from './Sheet';

export interface ItemDetailProps {
  item: ScanItem;
  /** Index of the candidate currently shown (after "Not this one"). */
  candidateIndex: number;
  result: ScanResult;
  grid: GridSpec;
  photo: CanvasImageSource | undefined;
  reference: ReferenceImage | undefined;
  placed: boolean;
  /** Items this one joins (shown ones only), with the side of this item they join. */
  connections: (Connection & { item: ScanItem })[];
  onReject(): void;
  onChoose(candidateIndex: number): void;
  onPlace(placement: ItemPlacement): void;
  onUnplace(placement: ItemPlacement): void;
  onOpen(key: string): void;
  onClose(): void;
  /** A spot marked as placed that this item seems to belong in (see PlacedConflictNote). */
  conflictCell?: CellRef;
  onUnmarkConflict?(): void;
  onKeepConflict?(): void;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function placementWhere(item: ScanItem, p: ItemPlacement, grid: GridSpec): string {
  return item.kind === 'assembled' ? cellsText(p) : describeCell(p.cells[0] ?? { row: p.bounds.row0, col: p.bounds.col0 }, grid);
}

export function ItemDetail(props: ItemDetailProps) {
  const { item, candidateIndex, result, grid, photo, reference, placed, connections } = props;
  const current: ItemPlacement | undefined = item.candidates[candidateIndex];
  const tone = itemTone(item);
  const members = result.regions.filter((r) => item.regionIds.includes(r.id));
  const single: DetectedRegion | undefined = item.kind === 'piece' ? members[0] : undefined;
  const sides = single?.shape?.sides.map((s) => s.kind);
  const iconTurn = single?.shape && current?.rotationDeg !== undefined ? localToPuzzleTurns(single.shape.angleDeg, current.rotationDeg) * 90 : (single?.shape?.angleDeg ?? 0);
  const border = single?.shape && current?.rotationDeg !== undefined ? borderText(single, current.rotationDeg) : '';
  const issues = members.flatMap((m) => m.issues).filter((v, i, a) => a.indexOf(v) === i);
  const certainty = itemCertainty(item);
  const spots = spotsToCompare(item);
  const unsure = certainty === 'unsure';
  const heading = unsure && spots.includes(candidateIndex) ? `Spot ${candidateIndex + 1} of ${spots.length}` : certainty === 'likely' && candidateIndex === 0 ? 'Probably goes here' : 'Goes here';
  const why = uncertaintyText(item);
  // Unsure: all the spots to compare side by side (the shown one marked), then the rest; otherwise
  // the other possibilities.
  const others = item.candidates.map((p, i) => ({ p, i })).filter(({ i }) => (unsure ? true : i !== candidateIndex));
  const joins = describeConnections(connections, (k) => connections.find((c) => c.key === k)?.item.label);

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
          <PickupView
            key={item.key}
            item={item}
            regions={result.regions}
            photo={photo}
            photoWidth={result.width}
            photoHeight={result.height}
            rotationDeg={current?.rotationDeg}
            size={200}
            label={`${itemTitle(item)} in your photo`}
          />
          <figcaption>In your photo</figcaption>
        </figure>
        <div className="pd-facts">
          <div className="pd-kind">
            {sides && <PieceIcon sides={sides} rotationDeg={iconTurn} size={52} title="Piece shape (finished orientation)" />}
            <div>
              <div className="pd-kind-label">{single ? pieceKindLabel(single) : itemKindText(item)}</div>
              <div className="pd-cert" data-testid="detail-certainty">
                <CertaintyMeter certainty={certainty} text={certaintyLine(item)} />
              </div>
            </div>
          </div>
          {item.kind === 'assembled' && current && (
            <div className="small" data-testid="group-summary">
              → {cellsText(current)}
            </div>
          )}
          {border && <div className="small">{border}</div>}
        </div>
      </div>

      {why && <UncertainNote reason={why} />}
      {props.conflictCell && props.onUnmarkConflict && props.onKeepConflict && (
        <PlacedConflictNote cell={props.conflictCell} onUnmark={props.onUnmarkConflict} onKeep={props.onKeepConflict} />
      )}

      {current?.rotationDeg !== undefined && (
        <section className="pd-section" data-testid="detail-turn">
          <h3>How to turn it</h3>
          <TurnGuide key={`${item.key}-${candidateIndex}`} item={item} regions={result.regions} photo={photo} rotationDeg={current.rotationDeg} layout="row" />
        </section>
      )}

      {connections.length > 0 && (
        <section className="pd-section" data-testid="detail-connections">
          <h3>Connections</h3>
          <p className="pd-joins">{joins}.</p>
          <ul className="fit-list">
            {connections.map((c) => (
              <li key={c.key}>
                <button className="fit-row" onClick={() => props.onOpen(c.key)}>
                  <span className={`num-badge st-${itemTone(c.item)}`}>{c.item.label}</span>
                  <span className="fit-row-text">{c.side ? capitalize(SIDE_PHRASE[c.side]) : 'Next to it'}</span>
                  <IconChevron size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {current ? (
        <section className="pd-section">
          <h3>{heading}</h3>
          <TargetContext key={`${item.key}-${candidateIndex}`} placement={current} grid={grid} reference={reference} size={360} label={`Box picture around where ${itemTitle(item)} goes`} />
          <div className="cand-info">
            <div className="cand-where">{placementWhere(item, current, grid)}</div>
            <CertaintyMeter certainty={spotCertainty(item, candidateIndex)} />
          </div>
        </section>
      ) : (
        <div className="pd-none">
          <strong>No more suggestions.</strong>
          <p className="muted">All places were rejected. Pick one below again, or scan this piece in another photo.</p>
        </div>
      )}

      {item.candidates.length > 1 && reference && (
        <section className="pd-section" data-testid="detail-spots">
          <h3>{unsure ? `One of these ${spots.length} spots` : 'Other possibilities'}</h3>
          {unsure && <p className="small muted pd-spots-hint">Compare each spot with your piece and pick the one that matches.</p>}
          <div className="cand-strip">
            {others.map(({ p, i }) => {
              const c = cropAround(p.x, p.y, grid, reference.width, reference.height, 3);
              const shown = i === candidateIndex;
              const name = unsure && spots.includes(i) ? `Spot ${i + 1}` : 'Less likely';
              return (
                <button
                  key={i}
                  className={`cand-mini${shown ? ' shown' : ''}`}
                  onClick={() => props.onChoose(i)}
                  aria-pressed={unsure ? shown : undefined}
                  aria-label={`${shown ? 'Shown: ' : 'Use '}${name.toLowerCase()}, ${cellsText(p)}`}
                  data-testid={`spot-${i}`}
                >
                  <CropCanvas source={reference.bitmap} rotated={{ ...c, rotationDeg: 0 }} size={96} label={`Picture around ${cellsText(p)}`} />
                  <span className="cand-mini-name">{shown ? `${name} · shown` : name}</span>
                  <span className="cand-mini-cell">
                    r{p.bounds.row0 + 1} · c{p.bounds.col0 + 1}
                  </span>
                </button>
              );
            })}
          </div>
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
