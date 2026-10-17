/**
 * "Send feedback": packages a scan (or, from Settings, the box photo and puzzle picture) with the
 * user's corrections into one JSON file they can share or download and send to the developer.
 * Nothing leaves the device unless the user sends the file themselves.
 */
import { useMemo, useState } from 'react';
import { APP_VERSION } from '../../../appVersion';
import { buildFeedbackBundle, type ImageBytes } from '../../../feedback/build';
import { feedbackFileName, serializeFeedback, type FeedbackBundle, type FeedbackMark, type FeedbackMarkKind } from '../../../feedback/format';
import type { CellRef, Id, ScanRecord } from '../../../model/types';
import { describeCell } from '../../../pipeline/grid';
import { downloadBlob } from '../../../platform/imageio';
import type { PuzzleRepository } from '../../../storage';
import { EmptyState, ErrorState, errorText, Spinner } from '../../components/Feedback';
import { IconCheck, IconClose, IconDownload, IconInfo, IconShare } from '../../components/Icons';
import { ReferenceOverlay } from '../../components/ReferenceOverlay';
import { Sheet } from '../../components/Sheet';
import { TopBar } from '../../components/TopBar';
import { ZoomPanView } from '../../components/ZoomPanView';
import { usePuzzle, type ReferenceImage } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { useObjectUrl, useStoredBlob, useStoredBlobUrl } from '../../hooks/useObjectUrl';
import { formatBytes, formatDate, plural } from '../../lib/format';
import { addMissed, areaName, MARK_KINDS, markInfo, removeMark, setCorrectCell, toggleRegionMark } from '../../lib/feedbackMarks';
import { buildScanItems } from '../../lib/items';
import { cellAt, regionCenter } from '../../lib/overlay';
import { href } from '../../lib/routes';
import { FeedbackOverlay } from './FeedbackOverlay';

export const PRIVACY_NOTE = 'The file contains your photos. Nothing is sent automatically – you choose where to send it.';

export function SendFeedbackScreen({ scanId }: { scanId?: string }) {
  const repo = useRepo();
  const { puzzle } = usePuzzle();
  const scan = useAsync(() => (scanId ? repo.getScan(scanId) : Promise.resolve(undefined)), [repo, scanId]);
  const back = scanId ? href.scan(puzzle.id, scanId) : href.puzzle(puzzle.id, 'settings');

  if (scanId && (scan.loading || scan.error || !scan.data || scan.data.puzzleId !== puzzle.id)) {
    return (
      <>
        <TopBar title="Send feedback" back={back} />
        <main className="page">
          {scan.loading ? (
            <Spinner label="Loading scan…" />
          ) : scan.error ? (
            <ErrorState title="Could not open this scan" error={scan.error} onRetry={scan.reload} />
          ) : (
            <EmptyState title="Scan not found" actions={<a className="btn btn-primary" href={href.puzzle(puzzle.id, 'scan')}>Back to scanning</a>}>
              <p>It may have been deleted.</p>
            </EmptyState>
          )}
        </main>
      </>
    );
  }
  return <FeedbackForm scan={scan.data} back={back} />;
}

interface ReadyFile {
  /** Inputs the file was made from; a change makes it stale. */
  key: string;
  name: string;
  blob: Blob;
  /** The file handed to the share sheet, or undefined when this browser cannot share it. */
  shareFile?: File;
}

type SendStatus = { kind: 'none' } | { kind: 'shared' } | { kind: 'downloaded' } | { kind: 'shareFailed' };

async function readImage(repo: PuzzleRepository, blobId: Id, width: number, height: number): Promise<ImageBytes | undefined> {
  const blob = await repo.getBlob(blobId);
  if (!blob) return undefined;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type || 'image/jpeg', width, height };
}

function appInfo(): FeedbackBundle['app'] {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    version: APP_VERSION,
    userAgent: nav?.userAgent ?? '',
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    ...(nav?.language ? { language: nav.language } : {}),
  };
}

function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * The file to offer in the share sheet. Chrome on Android refuses to share .json files but shares
 * plain text, so fall back to the same content as .txt (the tooling reads files by content).
 */
function shareableFile(blob: Blob, name: string): File | undefined {
  const json = new File([blob], name, { type: 'application/json' });
  if (canShareFile(json)) return json;
  const text = new File([blob], name.replace(/\.json$/, '.txt'), { type: 'text/plain' });
  return canShareFile(text) ? text : undefined;
}

function FeedbackForm({ scan, back }: { scan?: ScanRecord; back: string }) {
  const repo = useRepo();
  const { puzzle, progress, reference } = usePuzzle();
  const box = puzzle.sources.find((s) => s.role === 'overview' && s.quad);
  const boxUrl = useStoredBlobUrl(box?.blobId);

  const [mode, setMode] = useState<FeedbackMarkKind>('missed');
  const [marks, setMarks] = useState<FeedbackMark[]>([]);
  const [comment, setComment] = useState('');
  const [includeReference, setIncludeReference] = useState(true);
  const [includeBox, setIncludeBox] = useState(true);
  const [correcting, setCorrecting] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [file, setFile] = useState<ReadyFile>();
  const [status, setStatus] = useState<SendStatus>({ kind: 'none' });

  const key = JSON.stringify([marks, comment.trim(), includeReference, includeBox && !!box]);
  const ready = file && file.key === key ? file : undefined;
  const canCreate = !!scan || (includeReference || (includeBox && !!box) || comment.trim().length > 0);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    setStatus({ kind: 'none' });
    try {
      const createdAt = Date.now();
      const [refImage, boxImage, scanImage] = await Promise.all([
        includeReference ? readImage(repo, puzzle.reference.blobId, puzzle.reference.width, puzzle.reference.height) : undefined,
        includeBox && box ? readImage(repo, box.blobId, box.width, box.height) : undefined,
        scan ? readImage(repo, scan.photoBlobId, scan.result.width, scan.result.height) : undefined,
      ]);
      if (scan && !scanImage) throw new Error('The scan photo is missing on this device.');
      const bundle = buildFeedbackBundle({
        createdAt,
        app: appInfo(),
        puzzle,
        reference: refImage,
        box: boxImage && box?.quad ? { ...boxImage, quad: box.quad } : undefined,
        scan: scan && scanImage ? { record: scan, photo: scanImage } : undefined,
        progress,
        marks,
        comment,
      });
      const name = feedbackFileName(createdAt);
      const blob = new Blob([serializeFeedback(bundle)], { type: 'application/json' });
      setFile({ key, name, blob, shareFile: shareableFile(blob, name) });
    } catch (e) {
      setError(errorText(e, 'Could not create the file.'));
    } finally {
      setBusy(false);
    }
  };

  const share = async (f: ReadyFile) => {
    try {
      if (!f.shareFile) return;
      await navigator.share({ files: [f.shareFile], title: 'Puzzle feedback' });
      setStatus({ kind: 'shared' });
    } catch (e) {
      // Closing the share sheet is not an error.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setStatus({ kind: 'shareFailed' });
    }
  };

  const download = (f: ReadyFile) => {
    downloadBlob(f.blob, f.name);
    setStatus({ kind: 'downloaded' });
  };

  const commentField = (
    <label className="field fb-comment">
      <span className="field-label">
        Comment <span className="muted">(optional)</span>
      </span>
      <textarea
        rows={3}
        maxLength={2000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={scan ? 'What went wrong? E.g. dark table, pieces touching…' : 'What went wrong?'}
        data-testid="fb-comment"
      />
    </label>
  );

  return (
    <>
      <TopBar title="Send feedback" subtitle={scan ? `Scan of ${formatDate(scan.createdAt)}` : 'Box photo and puzzle picture'} back={back} />
      <main className="page stack fb-page" data-testid="send-feedback">
        {scan ? (
          <ScanMarking scan={scan} marks={marks} setMarks={setMarks} mode={mode} setMode={setMode} onCorrect={setCorrecting} />
        ) : (
          <p className="muted small">If the puzzle picture was found badly – wrong corners, parts cut off, blurry – send us the box photo and the picture the app made from it.</p>
        )}

        {scan && commentField}
        <section className="stack-sm">
          <h2 className="h3">Include</h2>
          <IncludeRow
            label="Puzzle picture"
            help="The straightened picture used for matching."
            thumb={reference?.url}
            checked={includeReference}
            onChange={setIncludeReference}
            testId="fb-include-reference"
          />
          {box && (
            <IncludeRow
              label="Box photo"
              help="The photo of the box with the corners you set."
              thumb={boxUrl}
              checked={includeBox}
              onChange={setIncludeBox}
              testId="fb-include-box"
            />
          )}
        </section>
        {!scan && commentField}

        <p className="fb-privacy small" data-testid="fb-privacy">
          <IconInfo size={16} />
          <span>{PRIVACY_NOTE}</span>
        </p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </main>

      <div className="action-bar" data-testid="action-bar">
        <div className={`action-bar-inner${ready ? ' fb-bar' : ''}`}>
          {ready ? (
            <>
              <p className="fb-file" role="status">
                {status.kind === 'shared' ? (
                  <span className="fb-done">
                    <IconCheck size={16} /> Shared – thank you!
                  </span>
                ) : status.kind === 'downloaded' ? (
                  <span className="fb-done">
                    <IconCheck size={16} /> Saved – attach it to an email or message. Thank you!
                  </span>
                ) : status.kind === 'shareFailed' ? (
                  <span>Sharing didn’t work here – use Download instead.</span>
                ) : (
                  <>
                    <span className="fb-file-name">{ready.name}</span>
                    <span className="muted" data-testid="fb-file-size">
                      {formatBytes(ready.blob.size)}
                    </span>
                  </>
                )}
              </p>
              <div className="fb-bar-buttons">
                <button className={ready.shareFile ? 'btn btn-lg' : 'btn btn-primary btn-lg grow'} onClick={() => download(ready)} data-testid="fb-download">
                  <IconDownload size={18} />
                  Download
                </button>
                {ready.shareFile && (
                  <button className="btn btn-primary btn-lg grow" onClick={() => void share(ready)} data-testid="fb-share">
                    <IconShare size={18} />
                    Share file
                  </button>
                )}
              </div>
            </>
          ) : (
            <button className="btn btn-primary btn-lg grow" disabled={busy || !canCreate} onClick={() => void create()} data-testid="fb-create">
              {busy ? 'Creating file…' : 'Create feedback file'}
            </button>
          )}
        </div>
      </div>

      {scan && correcting !== undefined && marks[correcting]?.kind === 'wrong_place' && reference && (
        <CorrectPlaceSheet
          reference={reference}
          regionId={(marks[correcting] as Extract<FeedbackMark, { kind: 'wrong_place' }>).regionId}
          initial={(marks[correcting] as Extract<FeedbackMark, { kind: 'wrong_place' }>).correct}
          onDone={(cell) => {
            setMarks((m) => setCorrectCell(m, correcting, cell));
            setCorrecting(undefined);
          }}
          onClose={() => setCorrecting(undefined)}
        />
      )}
    </>
  );
}

function IncludeRow({
  label,
  help,
  thumb,
  checked,
  onChange,
  testId,
}: {
  label: string;
  help: string;
  thumb?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <label className="switch toggle-row fb-include">
      <span className="fb-thumb" aria-hidden="true">
        {thumb && <img src={thumb} alt="" />}
      </span>
      <span className="toggle-text grow">
        <span>{label}</span>
        <span className="muted xsmall">{help}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
    </label>
  );
}

function ScanMarking({
  scan,
  marks,
  setMarks,
  mode,
  setMode,
  onCorrect,
}: {
  scan: ScanRecord;
  marks: FeedbackMark[];
  setMarks: (fn: (m: FeedbackMark[]) => FeedbackMark[]) => void;
  mode: FeedbackMarkKind;
  setMode: (m: FeedbackMarkKind) => void;
  onCorrect: (index: number) => void;
}) {
  const { puzzle } = usePuzzle();
  const result = scan.result;
  const { blob } = useStoredBlob(scan.photoBlobId);
  const photoUrl = useObjectUrl(blob);
  const hidden = useMemo(() => new Set(buildScanItems(result, puzzle.grid).hiddenRegionIds), [result, puzzle.grid]);
  const regions = useMemo(() => new Map(result.regions.map((r) => [r.id, r])), [result]);

  const describe = (m: FeedbackMark): string => {
    if (m.kind === 'missed') return areaName(m.x, m.y, result.width, result.height);
    const reg = regions.get(m.regionId);
    const where = reg ? areaName(regionCenter(reg).x, regionCenter(reg).y, result.width, result.height) : '';
    const what = hidden.has(m.regionId) ? 'outline not shown in results' : `#${m.regionId}`;
    const right = m.kind === 'wrong_place' && m.correct ? ` · goes to ${describeCell(m.correct, puzzle.grid)}` : '';
    return `${where} · ${what}${right}`;
  };

  return (
    <>
      <p className="muted small">Mark what the app got wrong on your photo – every mark helps improve piece detection. All optional.</p>

      <section className="stack-sm">
        <div className="fb-modes" role="radiogroup" aria-label="What’s wrong?">
          {MARK_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={mode === k.kind}
              className={`fb-mode mk-${k.kind}${mode === k.kind ? ' active' : ''}`}
              onClick={() => setMode(k.kind)}
              data-testid={`fb-mode-${k.kind}`}
            >
              <span className="mk-dot" aria-hidden="true" />
              <span className="fb-mode-label">{k.label}</span>
            </button>
          ))}
        </div>
        <p className="small fb-help" aria-live="polite">
          {markInfo(mode).help}
        </p>
        <div className="viewer-frame tall fb-viewer" style={{ aspectRatio: `${result.width} / ${result.height}` }}>
          {photoUrl ? (
            <ZoomPanView contentWidth={result.width} contentHeight={result.height} label="Your photo with all detected outlines" margin={6}>
              {(scale) => (
                <>
                  <img src={photoUrl} alt="" className="fill" draggable={false} />
                  <FeedbackOverlay
                    result={result}
                    hidden={hidden}
                    marks={marks}
                    mode={mode}
                    scale={scale}
                    onRegion={(id) => {
                      if (mode !== 'missed') setMarks((m) => toggleRegionMark(m, mode, id));
                    }}
                    onPoint={(p) => setMarks((m) => addMissed(m, p.x, p.y))}
                    onRemove={(i) => setMarks((m) => removeMark(m, i))}
                  />
                </>
              )}
            </ZoomPanView>
          ) : (
            <Spinner label="Loading photo…" />
          )}
        </div>
        <p className="xsmall muted fb-key">
          <span className="fb-key-item">
            <svg width="22" height="10" aria-hidden="true">
              <line x1="1" y1="5" x2="21" y2="5" className="solid" />
            </svg>
            shown in results
          </span>
          <span className="fb-key-item">
            <svg width="22" height="10" aria-hidden="true">
              <line x1="1" y1="5" x2="21" y2="5" className="dashed" />
            </svg>
            found, but not shown
          </span>
        </p>
      </section>

      <section>
        <h2 className="h3">{marks.length ? plural(marks.length, 'mark') : 'No marks yet'}</h2>
        {marks.length === 0 ? (
          <p className="muted small">Choose what’s wrong above, then tap the photo.</p>
        ) : (
          <ul className="fb-marks" data-testid="fb-marks">
            {marks.map((m, i) => (
              <li key={i} className={`fb-mark-row mk-${m.kind}`} data-testid={`fb-mark-${i}`} data-kind={m.kind}>
                <span className="fb-num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="fb-mark-text">
                  <span>{markInfo(m.kind).label}</span>
                  <span className="muted xsmall">{describe(m)}</span>
                  {m.kind === 'wrong_place' && (
                    <button type="button" className="link-btn small" onClick={() => onCorrect(i)} data-testid={`fb-correct-${i}`}>
                      {m.correct ? 'Change the right place' : 'Show the right place (optional)'}
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setMarks((list) => removeMark(list, i))}
                  aria-label={`Remove mark ${i + 1}`}
                  data-testid={`fb-remove-${i}`}
                >
                  <IconClose size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Pick the cell where a wrongly placed piece really goes (tap on the box picture). */
function CorrectPlaceSheet({
  reference,
  regionId,
  initial,
  onDone,
  onClose,
}: {
  reference: ReferenceImage;
  regionId: number;
  initial?: CellRef;
  onDone: (cell: CellRef | undefined) => void;
  onClose: () => void;
}) {
  const { puzzle } = usePuzzle();
  const [cell, setCell] = useState<CellRef | undefined>(initial);
  return (
    <Sheet
      title={`Where does #${regionId} go?`}
      onClose={onClose}
      footer={
        <div className="row gap end">
          <button className="btn" onClick={() => onDone(undefined)}>
            Clear
          </button>
          <button className="btn btn-primary" onClick={() => onDone(cell)} disabled={!cell} data-testid="fb-correct-done">
            Done
          </button>
        </div>
      }
    >
      <p className="small muted">Tap the right place on the box picture{cell ? ` – ${describeCell(cell, puzzle.grid)}` : ''}.</p>
      <div className="viewer-frame fb-correct-view" style={{ aspectRatio: `${reference.width} / ${reference.height}` }}>
        <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} label="Box picture">
          {(scale) => (
            <>
              <img src={reference.url} alt="" className="fill" draggable={false} />
              <ReferenceOverlay width={reference.width} height={reference.height} grid={puzzle.grid} highlight={cell ? [cell] : undefined} scale={scale} />
              <svg
                className="overlay fb-cell-picker"
                viewBox={`0 0 ${reference.width} ${reference.height}`}
                preserveAspectRatio="none"
                data-testid="fb-correct-picture"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = ((e.clientX - rect.left) / rect.width) * reference.width;
                  const y = ((e.clientY - rect.top) / rect.height) * reference.height;
                  setCell(cellAt(x, y, puzzle.grid, reference.width, reference.height));
                }}
              >
                <rect className="fb-bg" x={0} y={0} width={reference.width} height={reference.height} />
                {cell && (
                  <g className="fb-cell-mark mk-wrong_place" data-testid="fb-correct-cell">
                    <circle cx={((cell.col + 0.5) / puzzle.grid.cols) * reference.width} cy={((cell.row + 0.5) / puzzle.grid.rows) * reference.height} r={9 / scale} />
                  </g>
                )}
              </svg>
            </>
          )}
        </ZoomPanView>
      </div>
    </Sheet>
  );
}
