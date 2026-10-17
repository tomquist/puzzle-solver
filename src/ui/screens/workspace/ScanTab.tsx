/** Scan tab: photograph loose pieces → analyse → save the scan → open its result. */
import { useRef, useState } from 'react';
import type { ScanRecord } from '../../../model/types';
import { blobToRGBA, isQuotaError, rgbaToBlob } from '../../../platform/imageio';
import { newId } from '../../../storage/types';
import { CameraCapture } from '../../components/CameraCapture';
import { ErrorState, errorText, ProgressBar } from '../../components/Feedback';
import { usePipeline } from '../../context/PipelineContext';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { navigate } from '../../hooks/useHashRoute';
import { formatDate, plural } from '../../lib/format';
import { scanStats } from '../../lib/pieces';
import { placedCells } from '../../lib/progress';
import { href } from '../../lib/routes';

type Phase =
  | { kind: 'capture' }
  | { kind: 'working'; progress: number; message: string }
  | { kind: 'error'; title: string; message: string; photo?: Blob };

const STAGE_LABEL: Record<string, string> = {
  prepare: 'Preparing photo…',
  quality: 'Checking photo quality…',
  segment: 'Finding pieces…',
  shape: 'Analysing shapes…',
  match: 'Matching pieces to the picture…',
  fits: 'Looking for pieces that fit together…',
  done: 'Done',
};

export function ScanTab() {
  const pipeline = usePipeline();
  const repo = useRepo();
  const { puzzle, progress, matcher, ensureMatcher, scansVersion, scansChanged } = usePuzzle();
  const [phase, setPhase] = useState<Phase>({ kind: 'capture' });
  const run = useRef(0);
  const latest = useAsync(() => repo.listScans(puzzle.id).then((s) => s[0]), [repo, puzzle.id, scansVersion]);

  const analyse = async (photo: Blob) => {
    const myRun = ++run.current;
    const alive = () => run.current === myRun;
    const working = (progress: number, message: string) => alive() && setPhase({ kind: 'working', progress, message });
    working(0.01, 'Reading photo…');
    let stage = 'read';
    try {
      const rgba = await blobToRGBA(photo, 4096);
      stage = 'prepare';
      working(0.02, 'Preparing the puzzle picture…');
      await ensureMatcher();
      stage = 'analyse';
      const resp = await pipeline.analyzeScan(puzzle.id, rgba, { placedCells: placedCells(progress, puzzle.grid) }, (e) =>
        working(0.03 + e.progress * 0.9, e.message ?? STAGE_LABEL[e.stage] ?? 'Analysing…'),
      );
      if (!alive()) return;
      stage = 'save';
      working(0.95, 'Saving scan…');
      const jpeg = await rgbaToBlob(resp.analysedImage, 'image/jpeg', 0.9);
      const photoBlobId = await repo.putBlob(jpeg);
      const scan: ScanRecord = {
        id: newId(),
        puzzleId: puzzle.id,
        createdAt: Date.now(),
        photoBlobId,
        width: resp.result.width,
        height: resp.result.height,
        result: resp.result,
      };
      await repo.saveScan(scan);
      scansChanged();
      if (alive()) navigate(href.scan(puzzle.id, scan.id));
    } catch (e) {
      if (!alive()) return;
      if (stage === 'save') {
        setPhase({
          kind: 'error',
          title: 'Could not save the scan',
          message: isQuotaError(e) ? 'Your browser’s storage is full. Delete old scans in History and try again.' : errorText(e),
          photo,
        });
      } else if (stage === 'read') {
        setPhase({ kind: 'error', title: 'Could not read this photo', message: errorText(e, 'Try another photo.') });
      } else {
        setPhase({ kind: 'error', title: 'Analysis failed', message: errorText(e, 'Something went wrong while analysing the photo.'), photo });
      }
    }
  };

  if (phase.kind === 'working') {
    return (
      <div className="busy-card stack" data-testid="analysing">
        <h2 className="h3">Analysing your pieces</h2>
        <ProgressBar value={phase.progress} label={phase.message} />
        <p className="muted small">This takes a few seconds. Keep the pieces where they are.</p>
        <button
          className="btn"
          onClick={() => {
            run.current++;
            setPhase({ kind: 'capture' });
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (phase.kind === 'error') {
    const photo = phase.photo;
    return (
      <ErrorState
        title={phase.title}
        error={phase.message}
        onRetry={photo ? () => void analyse(photo) : undefined}
        actions={
          <button className="btn" onClick={() => setPhase({ kind: 'capture' })}>
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
      <CameraCapture context="pieces" onCapture={(b) => void analyse(b)} uploadLabel="Upload pieces photo" />
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
