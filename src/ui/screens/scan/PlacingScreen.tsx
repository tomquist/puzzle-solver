/**
 * Guided placing mode for one scan: one item at a time – assembled grids first, then sure pieces
 * in a sweep across the picture (neighbours back to back), then unsure ones. Each step shows the
 * item in the photo with its surroundings so it can be found on the table ("Pick up #4"; tap for
 * an upright close-up), one instruction line, what it joins, and where it goes: the box picture
 * around the target with a few cells of context (pinch to zoom) and an overview of the whole
 * picture. Placed ✓ records progress and moves on; Skip / Not here / swipe / arrow keys navigate.
 * The screen stays on.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cellKey, type ScanRecord } from '../../../model/types';
import { describeCell } from '../../../pipeline/grid';
import { haptic, isCoarsePointer } from '../../../platform/device';
import { EmptyState, ErrorState, Spinner } from '../../components/Feedback';
import { IconBack, IconCheck, IconChevron, IconScan } from '../../components/Icons';
import { PickupView, TargetZoomView } from '../../components/ItemVisuals';
import { itemTone } from '../../components/ScanOverlay';
import { TopBar } from '../../components/TopBar';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { useBitmap, useStoredBlob } from '../../hooks/useObjectUrl';
import { usePrefs, useWakeLock } from '../../hooks/usePrefs';
import { plural } from '../../lib/format';
import { cellsText, connectionsOf, describeConnections, itemKindText, nextFreeCandidate, placingOrder, type ItemPlacement, type ScanItem } from '../../lib/items';
import { placeCells } from '../../lib/progress';
import { turnInstruction } from '../../lib/rotation';
import { href } from '../../lib/routes';
import { useScanModel } from './useScanModel';

export function PlacingScreen({ scanId }: { scanId: string }) {
  const repo = useRepo();
  const { puzzle } = usePuzzle();
  const scan = useAsync(() => repo.getScan(scanId), [repo, scanId]);
  const back = href.scan(puzzle.id, scanId);
  if (scan.loading && !scan.data) {
    return (
      <>
        <TopBar title="Placing" back={back} />
        <main className="page">
          <Spinner label="Loading…" />
        </main>
      </>
    );
  }
  if (scan.error || !scan.data || scan.data.puzzleId !== puzzle.id) {
    return (
      <>
        <TopBar title="Placing" back={href.puzzle(puzzle.id, 'scan')} />
        <main className="page">
          {scan.error ? <ErrorState title="Could not open this scan" error={scan.error} onRetry={scan.reload} /> : <EmptyState title="Scan not found" />}
        </main>
      </>
    );
  }
  return <PlacingView scan={scan.data} />;
}

/** "Turn ↻ 90° · row 5, column 12" */
export function instructionLine(item: ScanItem, p: ItemPlacement, rows: number, cols: number): string {
  const where = item.kind === 'assembled' ? cellsText(p) : describeCell(p.cells[0] ?? { row: p.bounds.row0, col: p.bounds.col0 }, { rows, cols }).replace(/ \(.*\)$/, '');
  return p.rotationDeg === undefined ? where : `${turnInstruction(p.rotationDeg).short} · ${where}`;
}

function PlacingView({ scan }: { scan: ScanRecord }) {
  const { puzzle, progress, updateProgress, reference } = usePuzzle();
  const [prefs] = usePrefs();
  useWakeLock(prefs.keepScreenOn);
  const [coarse] = useState(isCoarsePointer);
  const result = scan.result;
  const { blob: photoBlob } = useStoredBlob(scan.photoBlobId);
  const photo = useBitmap(photoBlob);
  const [rejected, setRejected] = useState<Record<string, number>>({});
  const { visible, links, byKey, placementOf, isPlacedItem } = useScanModel(result, puzzle.grid, prefs.view, rejected, progress, scan.id);

  // The sequence is fixed when placing starts (placing an item must not reshuffle the rest).
  const [sequence, setSequence] = useState<string[]>(() => placingOrder(visible, links, puzzle.grid, isPlacedItem, placementOf).map((i) => i.key));
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [placedHere, setPlacedHere] = useState<string[]>([]);

  const done = index >= sequence.length;
  const item = !done ? byKey.get(sequence[index]) : undefined;
  const p = item ? placementOf(item) : undefined;

  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(sequence.length, i))), [sequence.length]);
  const next = useCallback(() => go(index + 1), [go, index]);
  const prev = useCallback(() => go(index - 1), [go, index]);

  // One action per step: ignore further taps until the step has changed.
  const acting = useRef(false);
  useEffect(() => {
    acting.current = false;
  }, [index]);
  const markPlaced = () => {
    if (!item || !p || acting.current) return;
    acting.current = true;
    haptic();
    setPlacedHere((l) => (l.includes(item.key) ? l : [...l, item.key]));
    setSkipped((l) => l.filter((k) => k !== item.key));
    next();
    void updateProgress((current) => placeCells(current, p.cells, { scanId: scan.id, regionId: item.label }));
  };
  const skip = () => {
    if (!item || acting.current) return;
    acting.current = true;
    setSkipped((l) => (l.includes(item.key) || placedHere.includes(item.key) ? l : [...l, item.key]));
    next();
  };
  const notHere = () => {
    if (!item) return;
    // Cells other items of this scan point at are not offered as alternatives.
    const claimed = new Set<string>();
    for (const other of visible) {
      if (other.key === item.key) continue;
      for (const c of placementOf(other)?.cells ?? []) claimed.add(cellKey(c));
    }
    const k = nextFreeCandidate(item, Math.max(0, item.candidates.indexOf(p!)), progress, scan.id, claimed);
    if (k >= 0) setRejected((r) => ({ ...r, [item.key]: k }));
    else skip();
  };
  const reviewSkipped = () => {
    setSequence(skipped);
    setSkipped([]);
    setIndex(0);
  };

  // Keyboard: ← / → step through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);

  // Swipe left / right on the step (not on the box picture: there it pans).
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    swipe.current = e.target instanceof Element && e.target.closest('.zoompan') ? null : { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) next();
      else prev();
    }
  };

  const joins = item ? describeConnections(connectionsOf(item.key, links), (k) => byKey.get(k)?.label) : '';
  const placedNow = item ? isPlacedItem(item) : false;
  const total = sequence.length;
  const back = href.scan(puzzle.id, scan.id);

  if (total === 0) {
    return (
      <>
        <TopBar title="Placing" back={back} />
        <main className="page">
          <EmptyState
            icon={<IconCheck size={32} />}
            title="Nothing left to place"
            actions={
              <a className="btn btn-primary" href={href.puzzle(puzzle.id, 'scan')}>
                <IconScan size={18} />
                Scan the next handful
              </a>
            }
          >
            <p>All pieces from this photo are placed.</p>
          </EmptyState>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar title="Placing" subtitle={done ? 'Done' : `${index + 1} of ${total}`} back={back} backLabel="Back to the result">
        <div className="place-progress" aria-hidden="true">
          <span style={{ width: `${(Math.min(index, total) / total) * 100}%` }} />
        </div>
      </TopBar>
      <main className="page narrow place-page with-action-bar" data-testid="placing">
        {done ? (
          <div className="finish-card" data-testid="placing-done">
            <div className="empty-icon">
              <IconCheck size={32} />
            </div>
            <h2>{skipped.length ? 'Done for now' : 'All placed'}</h2>
            <p className="muted">
              {plural(placedHere.length, 'item')} placed{skipped.length ? ` · ${skipped.length} skipped` : ''}. Scan the next handful of pieces when you’re ready.
            </p>
            <div className="capture-actions">
              <a className="btn btn-primary btn-lg" href={href.puzzle(puzzle.id, 'scan')} data-testid="scan-next">
                <IconScan size={18} />
                Scan the next handful
              </a>
              {skipped.length > 0 && (
                <button className="btn btn-lg" onClick={reviewSkipped}>
                  Review {plural(skipped.length, 'skipped item')}
                </button>
              )}
              <a className="btn btn-lg btn-quiet" href={back}>
                Back to the result
              </a>
            </div>
          </div>
        ) : item && p ? (
          <div className="place-step" onPointerDown={onPointerDown} onPointerUp={onPointerUp} data-testid={`step-${item.key}`}>
            <div className="place-pick">
              <PickupView
                key={item.key}
                item={item}
                regions={result.regions}
                photo={photo}
                photoWidth={result.width}
                photoHeight={result.height}
                rotationDeg={p.rotationDeg}
                size={260}
                label={`#${item.label} in your photo`}
              />
              <div className="place-pick-text">
                <span className="eyebrow">Pick up</span>
                <div className="place-title">
                  <span className={`num-badge st-${itemTone(item)}`}>{item.label}</span>
                  <span data-testid="place-kind">{itemKindText(item)}</span>
                </div>
                {item.status === 'ambiguous' && <span className="status-chip st-ambiguous">Unsure – check the picture</span>}
                {placedNow && <span className="status-chip st-confident">Placed</span>}
                <span className="muted xsmall">Tap the photo to zoom in on it.</span>
              </div>
            </div>
            <p className="place-line" data-testid="instruction">
              {instructionLine(item, p, puzzle.grid.rows, puzzle.grid.cols)}
            </p>
            {joins && (
              <p className="muted small place-next-to" data-testid="place-joins">
                {joins}
              </p>
            )}
            <TargetZoomView key={`${item.key}:${p.x},${p.y}`} placement={p} grid={puzzle.grid} reference={reference} label={`Box picture around where #${item.label} goes`} />
            <div className="step-nav">
              <button className="icon-btn" onClick={prev} disabled={index === 0} aria-label="Previous">
                <IconBack />
              </button>
              <span className="muted small">{coarse ? 'Swipe to go back or forward' : 'Use ← → to go back or forward'}</span>
              <button className="icon-btn" onClick={next} aria-label="Next">
                <IconChevron />
              </button>
            </div>
          </div>
        ) : (
          <Spinner />
        )}
      </main>
      {!done && item && (
        <div className="action-bar" data-testid="action-bar">
          <div className="action-bar-inner">
            <button className="btn btn-lg" onClick={skip} data-testid="skip">
              Skip
            </button>
            {item.status === 'ambiguous' && item.candidates.length > 1 && (
              <button className="btn btn-lg" onClick={notHere} data-testid="not-here">
                Not here
              </button>
            )}
            <button className="btn btn-primary btn-lg grow" onClick={markPlaced} data-testid="placed">
              <IconCheck size={18} />
              Placed
            </button>
          </div>
        </div>
      )}
    </>
  );
}
