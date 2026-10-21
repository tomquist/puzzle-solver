/** List of puzzles, new / import, empty state, storage warnings. */
import { useState } from 'react';
import type { ProgressRecord, PuzzleRecord } from '../../model/types';
import { Banner, EmptyState, ErrorState, errorText, Spinner } from '../components/Feedback';
import { IconCamera, IconPlus, IconPuzzle, IconScan, IconUpload } from '../components/Icons';
import { TopBar } from '../components/TopBar';
import { useRepository } from '../context/RepositoryContext';
import { useAsync } from '../hooks/useAsync';
import { navigate } from '../hooks/useHashRoute';
import { useStoredBlobUrl } from '../hooks/useObjectUrl';
import { formatDate } from '../lib/format';
import { progressPercent } from '../lib/progress';
import { href } from '../lib/routes';
import { AppVersion } from '../components/AppVersion';

export function HomeScreen() {
  const { repo, persistent } = useRepository();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>();
  const list = useAsync(async () => {
    const puzzles = await repo.listPuzzles();
    const progress = await Promise.all(puzzles.map((p) => repo.getProgress(p.id)));
    return puzzles.map((p, i) => ({ puzzle: p, progress: progress[i] }));
  }, [repo]);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportError(undefined);
    try {
      const p = await repo.importPuzzle(file);
      navigate(href.puzzle(p.id));
    } catch (e) {
      setImportError(errorText(e, 'This file could not be imported.'));
    } finally {
      setImporting(false);
    }
  };

  const importButton = (
    <label className={`btn${importing ? ' disabled' : ''}`}>
      <IconUpload size={18} />
      <span>{importing ? 'Importing…' : 'Import'}</span>
      <input
        type="file"
        accept=".json,.puzzle,application/json"
        className="visually-hidden"
        data-testid="import-file"
        disabled={importing}
        onChange={(e) => {
          void onImport(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
    </label>
  );

  const items = list.data ?? [];
  return (
    <>
      <TopBar title="Puzzle Solver" subtitle="Your jigsaw assistant" actions={items.length > 0 ? importButton : undefined} />
      <main className="page stack">
        {!persistent && (
          <Banner tone="warning" title="Puzzles won’t be saved">
            This browser doesn’t allow storage here (private mode?). Everything is lost when the page is closed – use Export to keep a puzzle.
          </Banner>
        )}
        {importError && (
          <Banner tone="error" title="Import failed" onDismiss={() => setImportError(undefined)}>
            {importError}
          </Banner>
        )}
        {list.loading && !list.data ? (
          <Spinner label="Loading puzzles…" />
        ) : list.error ? (
          <ErrorState title="Could not load your puzzles" error={list.error} onRetry={list.reload} />
        ) : items.length === 0 ? (
          <Welcome importButton={importButton} />
        ) : (
          <>
            <div className="section-head">
              <h2>My puzzles</h2>
              <a className="btn btn-primary" href={href.newPuzzle()}>
                <IconPlus size={18} />
                New puzzle
              </a>
            </div>
            <ul className="puzzle-grid">
              {items.map(({ puzzle, progress }) => (
                <li key={puzzle.id}>
                  <PuzzleCard puzzle={puzzle} progress={progress} />
                </li>
              ))}
            </ul>
          </>
        )}
        <AppVersion />
      </main>
    </>
  );
}

function Welcome({ importButton }: { importButton: React.ReactNode }) {
  return (
    <EmptyState
      icon={<IconPuzzle size={36} />}
      title="Find where every piece goes"
      actions={
        <>
          <a className="btn btn-primary btn-lg" href={href.newPuzzle()}>
            <IconPlus />
            New puzzle
          </a>
          {importButton}
        </>
      }
    >
      <ol className="steps">
        <li>
          <span className="step-icon"><IconCamera size={20} /></span>
          <span><strong>Photograph the box.</strong> The picture becomes your reference.</span>
        </li>
        <li>
          <span className="step-icon"><IconScan size={20} /></span>
          <span><strong>Photograph loose pieces</strong> on a plain table – a handful at a time.</span>
        </li>
        <li>
          <span className="step-icon"><IconPuzzle size={20} /></span>
          <span><strong>See where each piece goes</strong> and which way to turn it.</span>
        </li>
      </ol>
      <p className="muted small">Everything stays on this device – nothing is uploaded.</p>
    </EmptyState>
  );
}

function PuzzleCard({ puzzle, progress }: { puzzle: PuzzleRecord; progress: ProgressRecord }) {
  const thumb = useStoredBlobUrl(puzzle.thumbnailBlobId);
  const pct = progressPercent(progress, puzzle.grid);
  return (
    <a className="puzzle-card" href={href.puzzle(puzzle.id)} data-testid="puzzle-card">
      <div className="puzzle-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <IconPuzzle size={28} />}</div>
      <div className="puzzle-card-body">
        <h3>{puzzle.name}</h3>
        <div className="muted small">
          {puzzle.pieceCount} pieces · {puzzle.grid.cols} × {puzzle.grid.rows}
        </div>
        <div className="mini-progress" aria-label={`${pct}% placed`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="small tabular">{pct}%</span>
        </div>
        <div className="muted xsmall">Updated {formatDate(Math.max(puzzle.updatedAt, progress.updatedAt))}</div>
      </div>
    </a>
  );
}
