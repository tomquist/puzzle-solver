/** Settings tab: rename, piece count / grid (and what the scans measure) / cut, export, storage, reset progress, delete. */
import { useEffect, useMemo, useState } from 'react';
import type { CutStyle, GridSpec, PieceCountKind } from '../../../model/types';
import { estimateGrid } from '../../../pipeline/grid';
import { gridStateOf } from '../../../pipeline/gridBelief';
import { downloadBlob } from '../../../platform/imageio';
import { exportFileName } from '../../../storage';
import { Banner, errorText } from '../../components/Feedback';
import { IconDownload, IconTrash } from '../../components/Icons';
import { Segmented } from '../../components/Segmented';
import { ConfirmSheet } from '../../components/Sheet';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepository } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { usePrefs } from '../../hooks/usePrefs';
import { navigate } from '../../hooks/useHashRoute';
import { formatBytes, parsePositive } from '../../lib/format';
import { emptyProgress, placedCount } from '../../lib/progress';
import { referenceResolution } from '../../lib/quality';
import { href } from '../../lib/routes';
import { AppVersion } from '../../components/AppVersion';

export function SettingsTab() {
  const { repo, persistent, persisted, requestPersist } = useRepository();
  const { puzzle, savePuzzle, progress, saveProgress, grid: belief } = usePuzzle();
  const [name, setName] = useState(puzzle.name);
  const [pieces, setPieces] = useState(String(puzzle.pieceCount));
  const [countKind, setCountKind] = useState<PieceCountKind>(puzzle.pieceCountKind ?? 'exact');
  const [grid, setGrid] = useState<GridSpec>(puzzle.grid);
  const [custom, setCustom] = useState({ rows: String(puzzle.grid.rows), cols: String(puzzle.grid.cols) });
  const [cut, setCut] = useState<CutStyle>(puzzle.cut);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const [confirm, setConfirm] = useState<'delete' | 'reset'>();
  const [exporting, setExporting] = useState(false);
  const usage = useAsync(() => repo.estimateUsage(), [repo]);
  const [prefs, updatePrefs] = usePrefs();
  // The grid can change while this tab is open (an estimated grid measured by a scan): follow it.
  useEffect(() => {
    setGrid(puzzle.grid);
    setCustom({ rows: String(puzzle.grid.rows), cols: String(puzzle.grid.cols) });
  }, [puzzle.grid]);

  const aspect = puzzle.physicalSize ? puzzle.physicalSize.width / puzzle.physicalSize.height : puzzle.reference.width / puzzle.reference.height;
  const pieceCount = countKind === 'unknown' ? puzzle.grid.rows * puzzle.grid.cols : parsePositive(pieces);
  const candidates = useMemo(() => (pieceCount ? estimateGrid(Math.round(pieceCount), aspect).candidates : []), [pieceCount, aspect]);
  const isCandidate = candidates.some((g) => g.rows === grid.rows && g.cols === grid.cols);
  const res = referenceResolution(puzzle.reference.width, puzzle.reference.height, grid);
  const dirty =
    name.trim() !== puzzle.name ||
    Math.round(pieceCount ?? 0) !== puzzle.pieceCount ||
    countKind !== (puzzle.pieceCountKind ?? 'exact') ||
    grid.rows !== puzzle.grid.rows ||
    grid.cols !== puzzle.grid.cols ||
    cut !== puzzle.cut;
  const gridChanged = grid.rows !== puzzle.grid.rows || grid.cols !== puzzle.grid.cols;

  const save = async () => {
    if (!pieceCount) {
      setMessage({ tone: 'error', text: 'Enter the number of pieces.' });
      return;
    }
    try {
      const changes = { name: name.trim() || puzzle.name, pieceCount: countKind === 'unknown' ? grid.rows * grid.cols : Math.round(pieceCount), pieceCountKind: countKind, cut };
      // A new grid carries the scans' cells and the placed pieces over (useGridBelief).
      if (gridChanged) await belief.setGrid(grid, changes);
      else await savePuzzle({ ...puzzle, ...changes });
      setMessage({ tone: 'ok', text: 'Saved.' });
    } catch (e) {
      setMessage({ tone: 'error', text: errorText(e, 'Could not save.') });
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const blob = await repo.exportPuzzle(puzzle.id);
      downloadBlob(blob, exportFileName(puzzle.name));
    } catch (e) {
      setMessage({ tone: 'error', text: errorText(e, 'Export failed.') });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="stack settings">
      {message && (
        <Banner tone={message.tone} onDismiss={() => setMessage(undefined)}>
          {message.text}
        </Banner>
      )}
      <section className="card stack-sm">
        <h2 className="h3">Puzzle</h2>
        <label className="field">
          <span className="field-label">Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <label className="field-label" htmlFor="settings-pieces">
            Number of pieces
          </label>
          <Segmented
            label="How sure is the number of pieces"
            size="sm"
            value={countKind}
            options={[
              { value: 'exact', label: 'From the box' },
              { value: 'about', label: 'About' },
              { value: 'unknown', label: 'I don’t know' },
            ]}
            onChange={setCountKind}
          />
          {countKind !== 'unknown' && <input id="settings-pieces" type="number" inputMode="numeric" min={4} value={pieces} onChange={(e) => setPieces(e.target.value)} />}
        </div>
        <fieldset className="field">
          <legend className="field-label">Grid (columns × rows)</legend>
          <div className="chips">
            {candidates.map((g) => (
              <button
                type="button"
                key={`${g.rows}x${g.cols}`}
                className={`chip grid-chip${g.rows === grid.rows && g.cols === grid.cols ? ' active' : ''}`}
                onClick={() => {
                  setGrid(g);
                  setCustom({ rows: String(g.rows), cols: String(g.cols) });
                }}
              >
                <span>
                  {g.cols} × {g.rows}
                </span>
                <span className="chip-sub">{g.cols * g.rows} pcs</span>
              </button>
            ))}
          </div>
          <div className="row gap-sm size-row">
            <input
              aria-label="Columns"
              type="number"
              min={1}
              value={custom.cols}
              onChange={(e) => {
                setCustom({ ...custom, cols: e.target.value });
                const c = parsePositive(e.target.value);
                if (c) setGrid({ ...grid, cols: Math.round(c) });
              }}
            />
            <span className="muted">×</span>
            <input
              aria-label="Rows"
              type="number"
              min={1}
              value={custom.rows}
              onChange={(e) => {
                setCustom({ ...custom, rows: e.target.value });
                const r = parsePositive(e.target.value);
                if (r) setGrid({ ...grid, rows: Math.round(r) });
              }}
            />
            {!isCandidate && <span className="muted small">custom</span>}
          </div>
          <span className="field-help">
            {res.pxPerCell} px per piece in the reference{res.level === 'low' ? ' – low; matching may be unreliable.' : '.'}
          </span>
          <GridStatus />
        </fieldset>
        <div className="field">
          <span className="field-label">Cut style</span>
          <Segmented label="Cut style" value={cut} options={[{ value: 'grid', label: 'Classic grid' }, { value: 'irregular', label: 'Irregular' }]} onChange={setCut} />
        </div>
        {gridChanged && placedCount(progress, puzzle.grid) > 0 && (
          <Banner tone="info">Placed pieces and your scans move to the new grid with their positions.</Banner>
        )}
        <div className="row end">
          <button className="btn btn-primary" disabled={!dirty} onClick={() => void save()}>
            Save changes
          </button>
        </div>
      </section>

      <section className="card stack-sm">
        <h2 className="h3">While placing</h2>
        <label className="switch toggle-row">
          <span className="toggle-text">
            <span>Keep screen on while placing</span>
            <span className="muted xsmall">The screen stays on while results or the placing guide are shown.</span>
          </span>
          <input
            type="checkbox"
            checked={prefs.keepScreenOn}
            onChange={(e) => {
              const v = e.target.checked;
              updatePrefs((p) => ({ ...p, keepScreenOn: v }));
            }}
            data-testid="keep-screen-on"
          />
        </label>
      </section>

      <section className="card stack-sm">
        <h2 className="h3">Backup</h2>
        <p className="muted small">Export saves the puzzle with its photos, scans and progress to a single file. Import it on another device from the start page.</p>
        <div>
          <button className="btn" onClick={() => void doExport()} disabled={exporting}>
            <IconDownload size={18} />
            {exporting ? 'Exporting…' : 'Export puzzle'}
          </button>
        </div>
      </section>

      <section className="card stack-sm">
        <h2 className="h3">Storage</h2>
        <p className="small">
          {usage.data?.usage !== undefined
            ? `Using ${formatBytes(usage.data.usage)}${usage.data.quota ? ` of ${formatBytes(usage.data.quota)} available` : ''}.`
            : 'Storage usage is not available in this browser.'}
        </p>
        {!persistent ? (
          <Banner tone="warning">Storage is not available – puzzles are lost when this page is closed.</Banner>
        ) : persisted ? (
          <p className="muted small">The browser keeps your puzzles even when space runs low.</p>
        ) : (
          <div className="row wrap gap-sm">
            <span className="muted small grow">The browser may delete data when space runs low.</span>
            <button className="btn btn-sm" onClick={() => void requestPersist()}>
              Keep my data
            </button>
          </div>
        )}
      </section>

      <section className="card stack-sm">
        <h2 className="h3">Feedback</h2>
        <p className="muted small">Was the puzzle picture found badly? Send the box photo and picture so detection can be improved. For a scan, use “Send feedback” at the end of its result.</p>
        <div>
          <a className="btn btn-wrap" href={href.feedback(puzzle.id)} data-testid="settings-feedback">
            Send feedback about the box photo / picture
          </a>
        </div>
      </section>

      <section className="card stack-sm danger-zone">
        <h2 className="h3">Start over</h2>
        <div className="row wrap gap-sm">
          <button className="btn" onClick={() => setConfirm('reset')} disabled={placedCount(progress, puzzle.grid) === 0}>
            Clear placed pieces
          </button>
          <button className="btn btn-danger" onClick={() => setConfirm('delete')}>
            <IconTrash size={18} />
            Delete puzzle
          </button>
        </div>
      </section>

      <AppVersion />

      {confirm === 'delete' && (
        <ConfirmSheet
          title={`Delete “${puzzle.name}”?`}
          confirmLabel="Delete puzzle"
          danger
          onCancel={() => setConfirm(undefined)}
          onConfirm={async () => {
            setConfirm(undefined);
            await repo.deletePuzzle(puzzle.id);
            navigate(href.home(), true);
          }}
        >
          <p>The box photo, reference picture, all scans and your progress are removed from this device. Export first if you want a backup.</p>
        </ConfirmSheet>
      )}
      {confirm === 'reset' && (
        <ConfirmSheet
          title="Clear placed pieces?"
          confirmLabel="Clear"
          onCancel={() => setConfirm(undefined)}
          onConfirm={async () => {
            setConfirm(undefined);
            await saveProgress({ ...emptyProgress(puzzle.id), updatedAt: Date.now() });
          }}
        >
          <p>All cells go back to “not placed”. Scans are kept.</p>
        </ConfirmSheet>
      )}
    </div>
  );
}

/** Where the grid comes from and what the scans say about it. */
function GridStatus() {
  const { puzzle, grid } = usePuzzle();
  const st = gridStateOf(puzzle);
  const measured = Object.values(st.scans).filter((e) => e.sources.length > 0).length;
  const scans = (n: number) => (n === 1 ? '1 scan' : `${n} scans`);
  const fmt = (g: GridSpec) => `${g.cols} × ${g.rows}`;
  let kind: 'confirmed' | 'measured' | 'estimated' | 'count';
  let text: string;
  if (st.status === 'confirmed') {
    kind = 'confirmed';
    text = measured > 0 ? `Confirmed – your ${scans(measured)} agree with ${fmt(puzzle.grid)}.` : `Confirmed.`;
  } else if (st.status === 'estimated') {
    kind = 'estimated';
    text = 'Estimated – will be measured from your first scans.';
  } else if (measured > 0) {
    kind = 'measured';
    const v = grid.verdict;
    text = v && (v.best.rows !== puzzle.grid.rows || v.best.cols !== puzzle.grid.cols) ? `Measured from ${scans(measured)} – they lean towards ${fmt(v.best)}, not sure yet.` : `Measured from ${scans(measured)} – they agree so far.`;
  } else {
    kind = 'count';
    text = 'From the piece count – your scans will check it.';
  }
  return (
    <span className="grid-status" data-testid="grid-status" data-status={st.status}>
      <span className={`grid-status-dot ${kind}`} aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
