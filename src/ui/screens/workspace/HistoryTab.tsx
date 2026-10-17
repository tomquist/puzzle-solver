/** History tab: past scans → open / delete. */
import { useState } from 'react';
import type { ScanRecord } from '../../../model/types';
import { EmptyState, ErrorState, Spinner } from '../../components/Feedback';
import { IconChevron, IconHistory, IconTrash } from '../../components/Icons';
import { ConfirmSheet } from '../../components/Sheet';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { useStoredBlobUrl } from '../../hooks/useObjectUrl';
import { formatDate, plural } from '../../lib/format';
import { scanStats } from '../../lib/pieces';
import { href } from '../../lib/routes';

export function HistoryTab() {
  const repo = useRepo();
  const { puzzle, scansVersion, scansChanged } = usePuzzle();
  const scans = useAsync(() => repo.listScans(puzzle.id), [repo, puzzle.id, scansVersion]);
  const [toDelete, setToDelete] = useState<ScanRecord>();

  if (scans.loading && !scans.data) return <Spinner label="Loading scans…" />;
  if (scans.error) return <ErrorState title="Could not load scans" error={scans.error} onRetry={scans.reload} />;
  const list = scans.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        icon={<IconHistory size={32} />}
        title="No scans yet"
        actions={
          <a className="btn btn-primary" href={href.puzzle(puzzle.id, 'scan')}>
            Scan pieces
          </a>
        }
      >
        <p>Every photo of loose pieces you analyse is kept here, so you can look at it again later.</p>
      </EmptyState>
    );
  }
  return (
    <>
      <h2 className="h3">{plural(list.length, 'scan')}</h2>
      <ul className="scan-list">
        {list.map((s) => (
          <ScanRow key={s.id} scan={s} puzzleId={puzzle.id} onDelete={() => setToDelete(s)} />
        ))}
      </ul>
      {toDelete && (
        <ConfirmSheet
          title="Delete this scan?"
          confirmLabel="Delete"
          danger
          onCancel={() => setToDelete(undefined)}
          onConfirm={async () => {
            const id = toDelete.id;
            setToDelete(undefined);
            await repo.deleteScan(id);
            scansChanged();
          }}
        >
          <p>The photo and its results are removed. Pieces you marked as placed stay placed.</p>
        </ConfirmSheet>
      )}
    </>
  );
}

function ScanRow({ scan, puzzleId, onDelete }: { scan: ScanRecord; puzzleId: string; onDelete: () => void }) {
  const url = useStoredBlobUrl(scan.photoBlobId);
  const st = scanStats(scan.result);
  return (
    <li className="scan-row">
      <a href={href.scan(puzzleId, scan.id)} className="scan-row-main" data-testid="scan-row">
        <div className="scan-thumb">{url && <img src={url} alt="" loading="lazy" />}</div>
        <div className="scan-row-text">
          <strong>{formatDate(scan.createdAt)}</strong>
          <span className="small muted">
            {plural(st.regions, 'piece')} · {st.confident} confident
            {st.unmatched > 0 ? ` · ${st.unmatched} unmatched` : ''}
          </span>
          <span className="dots" aria-hidden="true">
            <span className="dot st-confident" style={{ flexGrow: st.confident }} />
            <span className="dot st-ambiguous" style={{ flexGrow: st.ambiguous }} />
            <span className="dot st-unmatched" style={{ flexGrow: st.unmatched }} />
          </span>
        </div>
        <IconChevron className="muted" />
      </a>
      <button className="icon-btn" onClick={onDelete} aria-label="Delete scan">
        <IconTrash size={20} />
      </button>
    </li>
  );
}
