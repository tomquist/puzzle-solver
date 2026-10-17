/** Scan tab: photograph loose pieces → analyse (job in PuzzleContext) → open the result. */
import { CameraCapture } from '../../components/CameraCapture';
import { ErrorState, ProgressBar } from '../../components/Feedback';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { formatDate, plural } from '../../lib/format';
import { scanStats } from '../../lib/pieces';
import { href } from '../../lib/routes';

export function ScanTab() {
  const repo = useRepo();
  const { puzzle, matcher, scansVersion, scanJob, startScan, cancelScan } = usePuzzle();
  const latest = useAsync(() => repo.listScans(puzzle.id).then((s) => s[0]), [repo, puzzle.id, scansVersion]);

  if (scanJob?.kind === 'running') {
    return (
      <div className="busy-card stack" data-testid="analysing">
        <h2 className="h3">Analysing your pieces</h2>
        <ProgressBar value={scanJob.progress} label={scanJob.message} />
        <p className="muted small">This takes a few seconds. Keep the pieces where they are – you can look at other tabs meanwhile.</p>
        <button className="btn" onClick={cancelScan}>
          Cancel
        </button>
      </div>
    );
  }

  if (scanJob?.kind === 'error') {
    const photo = scanJob.photo;
    return (
      <ErrorState
        title={scanJob.title}
        error={scanJob.message}
        onRetry={photo ? () => startScan(photo) : undefined}
        actions={
          <button className="btn" onClick={cancelScan}>
            Take another photo
          </button>
        }
      />
    );
  }

  const last = latest.data;
  const stats = last ? scanStats(last.result) : undefined;
  return (
    <>
      {matcher.kind === 'loading' && <p className="muted small center-text">Preparing the puzzle picture for matching…</p>}
      <CameraCapture context="pieces" onCapture={startScan} uploadLabel="Upload pieces photo" />
      {last && stats && (
        <a className="card link-card" href={href.scan(puzzle.id, last.id)}>
          <div>
            <div className="small muted">Latest scan · {formatDate(last.createdAt)}</div>
            <strong>
              {plural(stats.regions, 'piece')} · {stats.confident} confident
            </strong>
          </div>
          <span className="btn btn-sm">Open</span>
        </a>
      )}
    </>
  );
}
