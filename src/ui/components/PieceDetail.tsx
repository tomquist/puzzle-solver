/**
 * Detail sheet for one detected piece/patch: crop, kind, how to turn it, candidate locations with
 * reference crops rotated to match the piece as it lies, fit hints and the Placed / Not this one
 * actions.
 */
import { describeCell } from '../../pipeline/grid';
import type { DetectedRegion, GridSpec, Placement, ProgressRecord, ScanResult } from '../../model/types';
import { cropAround, paddedBox } from '../lib/overlay';
import {
  borderText,
  cellsForPlacement,
  confidencePercent,
  currentPlacement,
  displayStatus,
  fitHintTexts,
  localToPuzzleTurns,
  matchFor,
  pieceKindLabel,
  STATUS_LABEL,
} from '../lib/pieces';
import { isPlaced } from '../lib/progress';
import { turnInstruction } from '../lib/rotation';
import { CropCanvas } from './CropCanvas';
import { IconCheck, IconClose } from './Icons';
import { PieceIcon } from './PieceIcon';
import { IssueList } from './Quality';
import { Sheet } from './Sheet';

export interface PieceDetailProps {
  region: DetectedRegion;
  result: ScanResult;
  grid: GridSpec;
  photo: CanvasImageSource | undefined;
  reference: { bitmap?: ImageBitmap; width: number; height: number } | undefined;
  progress: ProgressRecord;
  rejected: number;
  onReject(): void;
  onChoose(candidateIndex: number): void;
  onPlace(placement: Placement): void;
  onUnplace(placement: Placement): void;
  onOpenRegion(id: number): void;
  onClose(): void;
}

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

function squareAround(region: DetectedRegion, width: number, height: number) {
  const b = paddedBox(region.bbox, 0.1, width, height);
  const side = Math.max(b.width, b.height);
  return { x: b.x + b.width / 2 - side / 2, y: b.y + b.height / 2 - side / 2, width: side, height: side };
}

export function PieceDetail(props: PieceDetailProps) {
  const { region, result, grid, photo, reference, progress, rejected } = props;
  const match = matchFor(result, region.id);
  const status = displayStatus(region, match);
  const candidates = match?.candidates ?? [];
  const current = currentPlacement(match, rejected);
  const turn = current ? turnInstruction(current.rotationDeg) : undefined;
  const placedNow = !!current && !!match && cellsForPlacement(match, current).every((c) => isPlaced(progress, c));
  const fits = fitHintTexts(region.id, result);
  const sides = region.shape?.sides.map((s) => s.kind);
  const across = (() => {
    if (!match?.coveredCells?.length) return 2.2;
    const rows = match.coveredCells.map((c) => c.row);
    const cols = match.coveredCells.map((c) => c.col);
    return Math.max(Math.max(...rows) - Math.min(...rows), Math.max(...cols) - Math.min(...cols)) + 2.2;
  })();
  const crop = (p: Placement) => {
    if (!reference) return undefined;
    const c = cropAround(p.x, p.y, grid, reference.width, reference.height, across);
    return { ...c, rotationDeg: -p.rotationDeg };
  };
  const border = current && region.shape ? borderText(region, current.rotationDeg) : '';
  const iconTurn = current && region.shape ? localToPuzzleTurns(region.shape.angleDeg, current.rotationDeg) * 90 : (region.shape?.angleDeg ?? 0);

  return (
    <Sheet
      title={
        <span className="row gap-sm">
          <span className={`num-badge st-${status}`}>{region.id}</span>
          <span>{region.kind === 'patch' ? 'Patch' : 'Piece'} #{region.id}</span>
        </span>
      }
      onClose={props.onClose}
      footer={
        current ? (
          <div className="row gap">
            <button className="btn grow" onClick={props.onReject} disabled={!current} data-testid="not-this-one">
              <IconClose size={18} />
              Not this one
            </button>
            {placedNow ? (
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
          <CropCanvas
            source={photo}
            rect={squareAround(region, result.width, result.height)}
            size={150}
            label={`Photo of piece ${region.id}`}
          />
          <figcaption>In your photo</figcaption>
        </figure>
        <div className="pd-facts">
          <div className="pd-kind">
            {sides && <PieceIcon sides={sides} rotationDeg={iconTurn} size={52} title="Piece shape (finished orientation)" />}
            <div>
              <div className="pd-kind-label">{pieceKindLabel(region)}</div>
              <div className={`status-chip st-${status}`}>{STATUS_LABEL[status]}</div>
            </div>
          </div>
          {turn && (
            <div className="pd-turn">
              <div className="pd-turn-main">{turn.short}</div>
              {turn.exact && <div className="muted small">{turn.exact}</div>}
            </div>
          )}
          {border && <div className="small">{border}</div>}
        </div>
      </div>

      {candidates.length === 0 && (
        <div className="pd-none">
          <strong>No good match found.</strong>
          <p className="muted">Try this piece again in a sharper, evenly lit photo – or it may belong to a different puzzle.</p>
        </div>
      )}

      {current && (
        <section className="pd-section">
          <h3>{status === 'unmatched' ? 'Best guess – low confidence' : status === 'ambiguous' && rejected === 0 ? 'Probably goes here' : 'Goes here'}</h3>
          <CandidateCard
            placement={current}
            grid={grid}
            reference={reference}
            crop={crop(current)}
            across={across}
            big
            regionId={region.id}
          />
        </section>
      )}
      {candidates.length > 0 && !current && (
        <div className="pd-none">
          <strong>No more suggestions.</strong>
          <p className="muted">All candidates were rejected. Pick one below again, or scan this piece in another photo.</p>
        </div>
      )}

      {candidates.length > 1 && (
        <section className="pd-section">
          <h3>Other possibilities</h3>
          <div className="cand-strip">
            {candidates.map((p, i) =>
              p === current ? null : (
                <button key={i} className="cand-mini" onClick={() => props.onChoose(i)} aria-label={`Use candidate ${i + 1}`}>
                  <CropCanvas source={reference?.bitmap} rotated={crop(p)} size={96} label={`Picture around ${describeCell(p, grid)}`} />
                  <span className="cand-mini-cell">
                    r{p.row + 1} · c{p.col + 1}
                  </span>
                  <ConfidenceBar value={p.confidence} />
                </button>
              ),
            )}
          </div>
        </section>
      )}

      {fits.length > 0 && (
        <section className="pd-section">
          <h3>Fits with</h3>
          <ul className="fit-list">
            {fits.map((f) => (
              <li key={f.text}>
                <button className="link-btn" onClick={() => props.onOpenRegion(f.other)}>
                  {f.text}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {region.issues.length > 0 && (
        <section className="pd-section">
          <h3>Notes</h3>
          <IssueList issues={region.issues} />
        </section>
      )}
    </Sheet>
  );
}

function CandidateCard({
  placement,
  grid,
  reference,
  crop,
  across,
  big,
  regionId,
}: {
  placement: Placement;
  grid: GridSpec;
  reference: { bitmap?: ImageBitmap } | undefined;
  crop: { cx: number; cy: number; side: number; rotationDeg: number } | undefined;
  across: number;
  big?: boolean;
  regionId: number;
}) {
  const cellFrac = 100 / across;
  return (
    <div className={big ? 'cand big' : 'cand'}>
      <div className="cand-img">
        <CropCanvas source={reference?.bitmap} rotated={crop} size={big ? 220 : 120} label={`Box picture where piece ${regionId} goes, turned like the piece`} />
        <div
          className="cand-cell"
          style={{
            width: `${cellFrac}%`,
            height: `${cellFrac}%`,
            transform: `translate(-50%, -50%) rotate(${crop?.rotationDeg ?? 0}deg)`,
          }}
          aria-hidden="true"
        />
      </div>
      <div className="cand-info">
        <div className="cand-where">{describeCell(placement, grid)}</div>
        <div className="muted small">Picture turned to match your piece.</div>
        <ConfidenceBar value={placement.confidence} />
      </div>
    </div>
  );
}
