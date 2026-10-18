/**
 * "Send feedback": packages a scan (or, from Settings, the box photo and puzzle picture) with the
 * user's corrections into one JSON file they can share or download and send to the developer.
 * Nothing leaves the device unless the user sends the file themselves.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { usePrefs } from '../../hooks/usePrefs';
import { formatBytes, formatDate, plural } from '../../lib/format';
import {
  addMissed,
  alternativesFor,
  areaName,
  detectionTones,
  foundText,
  looksLikeSeveral,
  MARK_KINDS,
  hintKinds,
  markHint,
  markIndexForRegion,
  markInfo,
  regionAt,
  removeMark,
  setCorrectCell,
  setRegionMark,
  toggleRegionMark,
  typicalPieceArea,
  type DetectionTone,
  type MarkHint,
} from '../../lib/feedbackMarks';
import { cellAt, regionCenter } from '../../lib/overlay';
import { setDismissed } from '../../lib/prefs';
import { href } from '../../lib/routes';
import { FeedbackOverlay } from './FeedbackOverlay';
import { MarkPictogram } from './MarkPictogram';

export const PRIVACY_NOTE = 'The file contains your photos. Nothing is sent automatically – you choose where to send it.';

/** Prefs key: the "How to mark" help was seen (it then starts collapsed). */
const HOW_TO_KEY = 'feedback-how-to';

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
  const tones = useMemo(() => detectionTones(result, puzzle.grid), [result, puzzle.grid]);
  const toneOf = (id: number): DetectionTone => tones.get(id) ?? 'hidden';
  const regions = useMemo(() => new Map(result.regions.map((r) => [r.id, r])), [result]);
  const pieceArea = useMemo(() => typicalPieceArea(result), [result]);

  // "How to mark": open on the first visit; once closed (or once marks were placed with it open)
  // it starts collapsed, one tap away.
  const [prefs, updatePrefs] = usePrefs();
  const [howTo, setHowTo] = useState(() => !prefs.dismissed.includes(HOW_TO_KEY));
  const rememberHowToSeen = () => {
    if (!prefs.dismissed.includes(HOW_TO_KEY)) updatePrefs((p) => setDismissed(p, HOW_TO_KEY, true));
  };
  const closeHowTo = () => {
    setHowTo(false);
    rememberHowToSeen();
  };
  const hasMarks = marks.length > 0;
  useEffect(() => {
    if (hasMarks) rememberHowToSeen();
  }, [hasMarks]); // only when the first mark appears

  // A "Piece not found" tap inside a region the app did find: ask before adding it.
  const [pending, setPending] = useState<{ regionId: number; x: number; y: number }>();
  // A second opinion on the region mark just added (see markHint); a hint the user dismissed is not
  // offered again on this visit, the one about joined pieces only once.
  const [hintFor, setHint] = useState<{ regionId: number; kind: MarkHint }>();
  // Hidden once its mark is gone (e.g. removed in the list below).
  const hint = hintFor && markIndexForRegion(marks, hintFor.regionId) >= 0 ? hintFor : undefined;
  const quietHints = useRef(new Set<MarkHint>());
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending || hint) note.current?.scrollIntoView({ block: 'nearest' });
  }, [pending, hint]);
  const chooseMode = (m: FeedbackMarkKind) => {
    setPending(undefined);
    setHint(undefined);
    setMode(m);
  };
  const tapPoint = (x: number, y: number) => {
    const reg = regionAt(result, x, y);
    if (reg) setPending({ regionId: reg.id, x, y });
    else {
      setPending(undefined);
      setMarks((m) => addMissed(m, x, y));
    }
  };
  const tapRegion = (id: number) => {
    if (mode === 'missed') return;
    const i = markIndexForRegion(marks, id);
    // Tapping the same kind again removes the mark; no hint then.
    const added = i < 0 || marks[i].kind !== mode;
    setMarks((m) => toggleRegionMark(m, mode, id));
    const reg = regions.get(id);
    const kind = added && reg ? markHint(mode, reg, toneOf(id), pieceArea) : undefined;
    setHint(kind && !quietHints.current.has(kind) ? { regionId: id, kind } : undefined);
    if (kind === 'assembled') quietHints.current.add(kind);
  };
  const dismissHint = () => {
    if (hint) quietHints.current.add(hint.kind);
    setHint(undefined);
  };
  const pendingRegion = pending && regions.get(pending.regionId);
  const pendingAlternatives = pending ? alternativesFor(toneOf(pending.regionId), !!pendingRegion && looksLikeSeveral(pendingRegion, pieceArea)) : [];
  const info = markInfo(mode);

  const describe = (m: FeedbackMark): string => {
    if (m.kind === 'missed') return areaName(m.x, m.y, result.width, result.height);
    const reg = regions.get(m.regionId);
    const where = reg ? areaName(regionCenter(reg).x, regionCenter(reg).y, result.width, result.height) : '';
    const what = toneOf(m.regionId) === 'hidden' ? 'found but not shown' : `#${m.regionId}`;
    const right = m.kind === 'wrong_place' && m.correct ? ` · goes to ${describeCell(m.correct, puzzle.grid)}` : '';
    return `${where} · ${what}${right}`;
  };

  return (
    <>
      <section className="stack-sm">
        <div className="fb-modes-head">
          <h2 className="h3" id="fb-modes-title">
            What’s wrong?
          </h2>
          <button
            type="button"
            className={`btn btn-sm btn-quiet fb-howto-toggle${howTo ? ' active' : ''}`}
            aria-expanded={howTo}
            aria-controls="fb-howto"
            onClick={() => (howTo ? closeHowTo() : setHowTo(true))}
            data-testid="fb-howto-toggle"
          >
            <IconInfo size={18} />
            How to mark
          </button>
        </div>
        <p className="muted small">Mark what the app got wrong – as many or as few as you like. Every mark helps improve piece detection.</p>
        {howTo && <HowToMark onClose={closeHowTo} />}
        <div className="fb-modes" role="radiogroup" aria-labelledby="fb-modes-title">
          {MARK_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={mode === k.kind}
              className={`fb-mode mk-${k.kind}${mode === k.kind ? ' active' : ''}`}
              onClick={() => chooseMode(k.kind)}
              data-testid={`fb-mode-${k.kind}`}
            >
              <MarkPictogram kind={k.kind} />
              <span className="fb-mode-label">{k.label}</span>
            </button>
          ))}
        </div>
        <p className={`small fb-help mk-${mode}`} aria-live="polite" data-testid="fb-help">
          {info.what} <strong>{info.how}</strong>
        </p>
        <div className="viewer-frame tall fb-viewer" style={{ aspectRatio: `${result.width} / ${result.height}` }}>
          {photoUrl ? (
            <ZoomPanView contentWidth={result.width} contentHeight={result.height} label="Your photo with all detected outlines" margin={6}>
              {(scale) => (
                <>
                  <img src={photoUrl} alt="" className="fill" draggable={false} />
                  <FeedbackOverlay
                    result={result}
                    tones={tones}
                    marks={marks}
                    mode={mode}
                    pendingRegionId={pending?.regionId}
                    scale={scale}
                    onRegion={tapRegion}
                    onPoint={(p) => tapPoint(p.x, p.y)}
                    onRemove={(i) => {
                      setPending(undefined);
                      setMarks((m) => removeMark(m, i));
                    }}
                  />
                </>
              )}
            </ZoomPanView>
          ) : (
            <Spinner label="Loading photo…" />
          )}
        </div>
        {pending && (
          <div className="fb-note" ref={note} role="status" data-testid="fb-found-note">
            <div className="fb-note-head">
              <p className="small">
                This piece was {foundText(toneOf(pending.regionId))} – use{' '}
                {pendingAlternatives
                  .slice(0, 2)
                  .map((k) => markInfo(k).label)
                  .join(' or ')}{' '}
                instead?
              </p>
              <button type="button" className="icon-btn small" onClick={() => setPending(undefined)} aria-label="Dismiss" data-testid="fb-found-dismiss">
                <IconClose size={16} />
              </button>
            </div>
            <div className="fb-note-actions">
              {pendingAlternatives.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`btn btn-sm fb-note-kind mk-${k}`}
                  onClick={() => {
                    setMarks((m) => setRegionMark(m, k, pending.regionId));
                    setPending(undefined);
                  }}
                  data-testid={`fb-found-${k}`}
                >
                  <span className="mk-dot" aria-hidden="true" />
                  {markInfo(k).label}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                onClick={() => {
                  setMarks((m) => addMissed(m, pending.x, pending.y));
                  setPending(undefined);
                }}
                data-testid="fb-found-missed"
              >
                Mark as not found anyway
              </button>
            </div>
          </div>
        )}
        {hint && (
          <div className="fb-note is-hint" ref={note} role="status" data-testid="fb-hint" data-hint={hint.kind}>
            <div className="fb-note-head">
              <p className="small">
                {hint.kind === 'several'
                  ? `Bigger than one piece – ${markInfo('merged').label}? If there’s no piece inside: ${markInfo('not_a_piece').label}.`
                  : 'Blue = pieces you joined: one outline around them is right. Keep this mark only if the outline itself is off.'}
              </p>
              <button type="button" className="icon-btn small" onClick={dismissHint} aria-label="Dismiss" data-testid="fb-hint-dismiss">
                <IconClose size={16} />
              </button>
            </div>
            <div className="fb-note-actions">
              {hintKinds(hint.kind, toneOf(hint.regionId)).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`btn btn-sm fb-note-kind mk-${k}`}
                  onClick={() => {
                    setMarks((m) => setRegionMark(m, k, hint.regionId));
                    setHint(undefined);
                  }}
                  data-testid={`fb-hint-${k}`}
                >
                  <span className="mk-dot" aria-hidden="true" />
                  {hint.kind === 'several' ? `Change to ${markInfo(k).label}` : markInfo(k).label}
                </button>
              ))}
              {hint.kind === 'assembled' && (
                <button
                  type="button"
                  className="btn btn-sm btn-quiet"
                  onClick={() => {
                    setMarks((m) => {
                      const i = markIndexForRegion(m, hint.regionId);
                      return i < 0 ? m : removeMark(m, i);
                    });
                    setHint(undefined);
                  }}
                  data-testid="fb-hint-remove"
                >
                  Remove mark
                </button>
              )}
            </div>
          </div>
        )}
        <p className="xsmall muted fb-key" data-testid="fb-key">
          <span className="fb-key-item">
            <span className="fb-swatch st-confident" aria-hidden="true" />
            Found
          </span>
          <span className="fb-key-item">
            <span className="fb-swatch st-ambiguous" aria-hidden="true" />
            Unsure
          </span>
          <span className="fb-key-item">
            <span className="fb-swatch st-patch" aria-hidden="true" />
            Assembled (pieces you joined)
          </span>
          <span className="fb-key-item">
            <span className="fb-swatch is-hidden" aria-hidden="true" />
            Found but not shown
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

/** Which mark to choose when several seem to fit, and how to place marks. */
function HowToMark({ onClose }: { onClose: () => void }) {
  const name = (k: FeedbackMarkKind) => <strong>{markInfo(k).label}</strong>;
  return (
    <div className="fb-howto" id="fb-howto" data-testid="fb-howto">
      <h3 className="fb-howto-title">Which one? Look inside the outline</h3>
      <ul className="fb-rules" data-testid="fb-rules">
        <li>
          <MarkPictogram kind="not_a_piece" />
          <span>No piece inside → {name('not_a_piece')}, even if the outline is odd.</span>
        </li>
        <li>
          <MarkPictogram kind="merged" />
          <span>Two or more loose pieces inside → {name('merged')}, even if the outline is off too.</span>
        </li>
        <li>
          <MarkPictogram kind="bad_outline" />
          <span>One piece, but the outline is off → {name('bad_outline')}.</span>
        </li>
        <li>
          <MarkPictogram kind="assembled" />
          <span>
            <strong>Blue</strong> = pieces you’ve already joined: one outline around them is right. Mark it only if they are really loose or the outline is off.
          </span>
        </li>
      </ul>
      <h3 className="fb-howto-title">How to place</h3>
      <ul className="fb-steps">
        <li>Zoom with two fingers or the + / − buttons.</li>
        <li>Tap inside the outline – for {name('missed')}, on the middle of the piece.</li>
        <li>Tap a mark again to remove it.</li>
      </ul>
      <button type="button" className="btn btn-sm fb-howto-close" onClick={onClose} data-testid="fb-howto-close">
        Got it
      </button>
    </div>
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
