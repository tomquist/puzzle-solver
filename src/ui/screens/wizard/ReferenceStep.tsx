/** Step 4: the straightened reference with grid, resolution hint and optional close-ups. */
import { useState } from 'react';
import type { GridSpec } from '../../../model/types';
import { CameraCapture } from '../../components/CameraCapture';
import { Banner, ProgressBar, Spinner } from '../../components/Feedback';
import { IconCamera, IconCheck, IconError, IconLayers, IconTrash, IconUpload } from '../../components/Icons';
import { QualityBanner } from '../../components/Quality';
import { ReferenceOverlay } from '../../components/ReferenceOverlay';
import { Sheet } from '../../components/Sheet';
import { ZoomPanView } from '../../components/ZoomPanView';
import { referenceResolution } from '../../lib/quality';
import type { Closeup, EncodedImage } from './types';

export function ReferenceStep({
  reference,
  baseWidth,
  grid,
  closeups,
  composing,
  composedStale,
  onAddCloseups,
  onRemoveCloseup,
  onCompose,
  onNext,
}: {
  reference: EncodedImage;
  /** Width of the rectified base the close-ups were registered against. */
  baseWidth: number;
  grid: GridSpec;
  closeups: Closeup[];
  composing: boolean;
  /** True when the high-res picture does not include the latest close-ups yet. */
  composedStale: boolean;
  onAddCloseups: (files: Blob[]) => void;
  onRemoveCloseup: (id: string) => void;
  onCompose: () => void;
  onNext: () => void;
}) {
  const [showGrid, setShowGrid] = useState(true);
  const [camera, setCamera] = useState(false);
  const res = referenceResolution(reference.width, reference.height, grid);
  const k = reference.width / baseWidth;
  const ok = closeups.filter((c) => c.status === 'ok');
  const pending = closeups.some((c) => c.status === 'reading' || c.status === 'registering');
  const coverage = closeups
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.status === 'ok' && c.registration)
    .map(({ c, i }) => {
      const r = c.registration!.coverage;
      return { rect: { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }, ok: true, label: `${i + 1}` };
    });

  return (
    <div className="stack">
      <p className="lead">This is your reference picture. Check that it shows the whole puzzle picture, straight and uncropped.</p>
      <div className="viewer-frame wizard-ref" style={{ aspectRatio: `${reference.width} / ${reference.height}` }}>
        <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} label="Reference picture">
          {(scale) => (
            <>
              <img src={reference.url} alt="" className="fill" draggable={false} />
              <ReferenceOverlay width={reference.width} height={reference.height} grid={grid} showGrid={showGrid} coverage={coverage} scale={scale} />
            </>
          )}
        </ZoomPanView>
      </div>
      <div className="row between wrap gap-sm">
        <span className="muted small tabular" data-testid="ref-size">
          {reference.width} × {reference.height} px · {res.pxPerCell} px per piece
        </span>
        <label className="switch">
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          <span>Grid</span>
        </label>
      </div>
      {res.issue ? (
        <QualityBanner issues={[res.issue]} subject="reference" defaultOpen />
      ) : (
        <div className="quality quality-ok">
          <span className="issue-icon sev-ok">
            <IconCheck size={18} />
          </span>
          <span>Sharp enough: {res.pxPerCell} px per piece.</span>
        </div>
      )}

      <section className="card stack-sm">
        <div className="row between">
          <h2 className="h3">Close-ups {res.level === 'low' ? '(recommended)' : '(optional)'}</h2>
          <IconLayers size={20} className="muted" />
        </div>
        <p className="muted small">
          Photograph parts of the box picture up close. They are matched to the reference and merged into a sharper picture – useful for big puzzles or small boxes.
        </p>
        <div className="row wrap gap-sm">
          <label className="btn">
            <IconUpload size={18} />
            Add close-ups
            <input
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              data-testid="closeup-upload"
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                if (files.length) onAddCloseups(files);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <button className="btn" onClick={() => setCamera(true)}>
            <IconCamera size={18} />
            Camera
          </button>
        </div>
        {closeups.length > 0 && (
          <ul className="closeup-list">
            {closeups.map((c, i) => (
              <li key={c.id} className={`closeup st-${c.status}`}>
                <img src={c.previewUrl} alt="" />
                <div className="closeup-body">
                  <strong>Close-up {i + 1}</strong>
                  {c.status === 'reading' && <Spinner inline label="Reading photo…" />}
                  {c.status === 'registering' && <Spinner inline label="Matching to the picture…" />}
                  {c.status === 'ok' && c.registration && (
                    <span className="small ok-text">
                      <IconCheck size={14} /> Matched · {c.registration.scaleGain.toFixed(1)}× more detail
                    </span>
                  )}
                  {c.status === 'failed' && (
                    <span className="small bad-text">
                      <IconError size={14} /> {c.error ?? 'Could not find this part in the picture. Use a sharp photo of the same box picture without glare.'}
                    </span>
                  )}
                </div>
                <button className="icon-btn small" onClick={() => onRemoveCloseup(c.id)} aria-label={`Remove close-up ${i + 1}`}>
                  <IconTrash size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {ok.length > 0 && (
          <>
            {composing ? (
              <ProgressBar value={0.6} label="Building a sharper picture…" detail="" />
            ) : (
              <button className="btn btn-primary" onClick={onCompose} disabled={pending || !composedStale}>
                <IconLayers size={18} />
                {composedStale ? `Build sharper picture (${ok.length})` : 'Sharper picture built'}
              </button>
            )}
            {!composedStale && !composing && <Banner tone="ok">The reference now uses your close-ups.</Banner>}
          </>
        )}
      </section>

      <div className="wizard-actions">
        <button className="btn btn-primary btn-lg grow" onClick={onNext} disabled={composing || pending} data-testid="save-puzzle">
          Save puzzle
        </button>
      </div>

      {camera && (
        <Sheet title="Close-up" onClose={() => setCamera(false)}>
          <CameraCapture
            context="closeup"
            onCapture={(b) => {
              setCamera(false);
              onAddCloseups([b]);
            }}
          />
        </Sheet>
      )}
    </div>
  );
}
