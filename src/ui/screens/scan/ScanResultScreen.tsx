/**
 * Scan result: the analysed photo with outlines/numbers/arrows, the reference with numbered
 * markers, quality issues, filters, a piece list and the PieceDetail sheet.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CellRef, Placement, QualityIssue, ScanRecord } from '../../../model/types';
import { describeCell } from '../../../pipeline/grid';
import { haptic } from '../../../platform/device';
import { EmptyState, ErrorState, Snackbar, Spinner, type SnackbarMessage } from '../../components/Feedback';
import { IconCheck, IconScan } from '../../components/Icons';
import { PieceDetail } from '../../components/PieceDetail';
import { QualityBanner } from '../../components/Quality';
import { ReferenceOverlay, type RefMarker } from '../../components/ReferenceOverlay';
import { ScanOverlay } from '../../components/ScanOverlay';
import { Segmented } from '../../components/Segmented';
import { TopBar } from '../../components/TopBar';
import { ZoomPanView, type ZoomPanHandle } from '../../components/ZoomPanView';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { useBitmap, useObjectUrl, useStoredBlob } from '../../hooks/useObjectUrl';
import { formatDate, plural } from '../../lib/format';
import { regionCenter } from '../../lib/overlay';
import {
  cellsForPlacement,
  confidencePercent,
  currentPlacement,
  displayStatus,
  matchFor,
  regionPassesFilter,
  scanStats,
  type DisplayStatus,
  type RegionFilter,
} from '../../lib/pieces';
import { isPlaced, placeCells, unplaceCells } from '../../lib/progress';
import { href } from '../../lib/routes';
import { Legend } from './Legend';

type ViewMode = 'photo' | 'picture' | 'both';

export function ScanResultScreen({ scanId }: { scanId: string }) {
  const repo = useRepo();
  const { puzzle } = usePuzzle();
  const scan = useAsync(() => repo.getScan(scanId), [repo, scanId]);
  const back = href.puzzle(puzzle.id, 'scan');

  if (scan.loading && !scan.data) {
    return (
      <>
        <TopBar title="Scan result" back={back} />
        <main className="page">
          <Spinner label="Loading scan…" />
        </main>
      </>
    );
  }
  if (scan.error || !scan.data || scan.data.puzzleId !== puzzle.id) {
    return (
      <>
        <TopBar title="Scan result" back={back} />
        <main className="page">
          {scan.error ? (
            <ErrorState title="Could not open this scan" error={scan.error} onRetry={scan.reload} />
          ) : (
            <EmptyState title="Scan not found" actions={<a className="btn btn-primary" href={back}>Back to scanning</a>}>
              <p>It may have been deleted.</p>
            </EmptyState>
          )}
        </main>
      </>
    );
  }
  return <ScanResultView scan={scan.data} />;
}

function ScanResultView({ scan }: { scan: ScanRecord }) {
  const { puzzle, progress, saveProgress, reference } = usePuzzle();
  const result = scan.result;
  const { blob: photoBlob } = useStoredBlob(scan.photoBlobId);
  const photoUrl = useObjectUrl(photoBlob);
  const photoBitmap = useBitmap(photoBlob);
  const photoView = useRef<ZoomPanHandle>(null);
  const refView = useRef<ZoomPanHandle>(null);

  const [view, setView] = useState<ViewMode>(() => (typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches ? 'both' : 'photo'));
  const [filter, setFilter] = useState<RegionFilter>('all');
  const [openId, setOpenId] = useState<number>();
  const [focusId, setFocusId] = useState<number>();
  const [rejected, setRejected] = useState<Record<number, number>>({});
  const [issue, setIssue] = useState<QualityIssue>();
  const [snack, setSnack] = useState<SnackbarMessage>();
  const closeSnack = useCallback(() => setSnack(undefined), []);

  const stats = useMemo(() => scanStats(result), [result]);
  const visible = useMemo(
    () => new Set(result.regions.filter((r) => regionPassesFilter(r, matchFor(result, r.id), filter)).map((r) => r.id)),
    [result, filter],
  );

  const placementOf = useCallback((id: number) => currentPlacement(matchFor(result, id), rejected[id] ?? 0), [result, rejected]);
  const cellsOf = useCallback(
    (id: number, p: Placement): CellRef[] => {
      const m = matchFor(result, id);
      return m ? cellsForPlacement(m, p) : [{ row: p.row, col: p.col }];
    },
    [result],
  );

  const placedIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of result.regions) {
      const p = placementOf(r.id);
      if (p && cellsOf(r.id, p).every((c) => isPlaced(progress, c))) s.add(r.id);
    }
    return s;
  }, [result, placementOf, cellsOf, progress]);

  const markers = useMemo<RefMarker[]>(() => {
    const out: RefMarker[] = [];
    for (const r of result.regions) {
      if (!visible.has(r.id)) continue;
      const m = matchFor(result, r.id);
      const p = placementOf(r.id);
      if (!m || !p) continue;
      out.push({ id: r.id, x: p.x, y: p.y, status: displayStatus(r, m), cells: m.coveredCells ? cellsForPlacement(m, p) : undefined });
    }
    return out;
  }, [result, visible, placementOf]);

  const focusRegion = (id: number) => {
    setFocusId(id);
    const r = result.regions.find((x) => x.id === id);
    const p = placementOf(id);
    if (r && view !== 'picture') photoView.current?.focus(regionCenter(r), 2.2);
    if (p && view !== 'photo') refView.current?.focus({ x: p.x, y: p.y }, 3);
  };

  const open = (id: number) => {
    setFocusId(id);
    setOpenId(id);
  };

  const place = async (id: number, p: Placement) => {
    haptic();
    const before = progress;
    await saveProgress(placeCells(progress, cellsOf(id, p), { scanId: scan.id, regionId: id }));
    setSnack({ id: Date.now(), text: `Piece #${id} placed`, actionLabel: 'Undo', onAction: () => void saveProgress(before) });
  };

  const confidentToPlace = result.regions.filter((r) => {
    const m = matchFor(result, r.id);
    const p = placementOf(r.id);
    return m?.status === 'confident' && p && (rejected[r.id] ?? 0) === 0 && !placedIds.has(r.id);
  });

  const placeAllConfident = async () => {
    haptic();
    const before = progress;
    let next = progress;
    for (const r of confidentToPlace) {
      const p = placementOf(r.id)!;
      next = placeCells(next, cellsOf(r.id, p), { scanId: scan.id, regionId: r.id });
    }
    await saveProgress(next);
    setSnack({ id: Date.now(), text: `${plural(confidentToPlace.length, 'piece')} marked as placed`, actionLabel: 'Undo', onAction: () => void saveProgress(before) });
  };

  const selectIssue = (i: QualityIssue | undefined) => {
    setIssue(i);
    if (!i) return;
    if (view === 'picture') setView('photo');
    if (i.area) {
      photoView.current?.focus({ x: i.area.x + i.area.width / 2, y: i.area.y + i.area.height / 2 }, 1.8);
    } else if (i.regionIds?.length === 1) {
      const r = result.regions.find((x) => x.id === i.regionIds![0]);
      if (r) photoView.current?.focus(regionCenter(r), 2.2);
    } else {
      photoView.current?.reset();
    }
  };

  const openRegion = openId !== undefined ? result.regions.find((r) => r.id === openId) : undefined;
  const focusPlacement = focusId !== undefined ? placementOf(focusId) : undefined;
  const counts: Partial<Record<DisplayStatus, number>> = { confident: stats.confident, ambiguous: stats.ambiguous, unmatched: stats.unmatched, patch: stats.patches };
  const listed = result.regions.filter((r) => visible.has(r.id));

  return (
    <>
      <TopBar
        title="Scan result"
        subtitle={`${formatDate(scan.createdAt)} · ${plural(stats.regions, 'piece')}`}
        back={href.puzzle(puzzle.id, 'scan')}
        actions={
          <a className="btn btn-sm" href={href.puzzle(puzzle.id, 'scan')}>
            <IconScan size={18} />
            <span className="hide-narrow">New scan</span>
          </a>
        }
      />
      <main className="page wide stack" data-testid="scan-result">
        {result.regions.length === 0 ? (
          <>
            <QualityBanner report={result.quality} defaultOpen />
            <EmptyState title="No pieces found" actions={<a className="btn btn-primary" href={href.puzzle(puzzle.id, 'scan')}>Try another photo</a>}>
              <p>Spread the pieces on a plain, contrasting background so they don’t touch, and shoot from directly above.</p>
            </EmptyState>
          </>
        ) : (
          <>
            <QualityBanner report={result.quality} selected={issue} onSelect={selectIssue} hideWhenClean={false} />
            <div className="result-toolbar">
              <Segmented
                label="Show pieces"
                size="sm"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All', count: stats.regions },
                  { value: 'edges', label: 'Edges', count: stats.edges },
                  { value: 'unmatched', label: 'No match', count: stats.unmatched },
                ]}
              />
              <Segmented
                label="View"
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: 'photo', label: 'Photo' },
                  { value: 'picture', label: 'Picture' },
                  { value: 'both', label: 'Both' },
                ]}
              />
            </div>

            <div className={`result-views view-${view}`}>
              {view !== 'picture' && (
                <div className="viewer-frame result-photo" style={{ aspectRatio: `${result.width} / ${result.height}` }}>
                  {photoUrl ? (
                    <ZoomPanView contentWidth={result.width} contentHeight={result.height} handle={photoView} label="Your photo with detected pieces" margin={6}>
                      {(scale) => (
                        <>
                          <img src={photoUrl} alt="" className="fill" draggable={false} />
                          <ScanOverlay
                            result={result}
                            rejected={rejected}
                            visible={visible}
                            selectedId={focusId}
                            placedIds={placedIds}
                            highlightIds={issue?.regionIds}
                            highlightArea={issue?.area}
                            scale={scale}
                            onSelect={open}
                          />
                        </>
                      )}
                    </ZoomPanView>
                  ) : (
                    <Spinner label="Loading photo…" />
                  )}
                  <span className="viewer-label">Your photo</span>
                </div>
              )}
              {view !== 'photo' && (
                <div className="viewer-frame result-ref" style={reference ? { aspectRatio: `${reference.width} / ${reference.height}` } : undefined}>
                  {reference ? (
                    <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} handle={refView} label="Puzzle picture with piece locations" margin={14}>
                      {(scale) => (
                        <>
                          <img src={reference.url} alt="" className="fill" draggable={false} />
                          <ReferenceOverlay
                            width={reference.width}
                            height={reference.height}
                            grid={puzzle.grid}
                            showGrid={false}
                            placed={[]}
                            markers={markers}
                            selectedId={focusId}
                            highlightCell={focusPlacement ? { row: focusPlacement.row, col: focusPlacement.col } : undefined}
                            scale={scale}
                            onMarker={open}
                          />
                        </>
                      )}
                    </ZoomPanView>
                  ) : (
                    <Spinner label="Loading picture…" />
                  )}
                  <span className="viewer-label">Box picture</span>
                </div>
              )}
            </div>

            <div className="row between wrap gap-sm">
              <Legend counts={counts} />
              {confidentToPlace.length > 0 && (
                <button className="btn btn-sm" onClick={() => void placeAllConfident()} data-testid="place-all">
                  <IconCheck size={16} />
                  Mark {confidentToPlace.length} confident as placed
                </button>
              )}
            </div>

            <section>
              <h2 className="h3 list-title">
                {filter === 'all' ? 'Pieces' : filter === 'edges' ? 'Edge & corner pieces' : 'Pieces without a match'}
                <span className="muted"> · tap for details</span>
              </h2>
              {listed.length === 0 ? (
                <p className="muted">No pieces in this group.</p>
              ) : (
                <ul className="piece-list">
                  {listed.map((r) => {
                    const m = matchFor(result, r.id);
                    const st = displayStatus(r, m);
                    const p = placementOf(r.id);
                    const placed = placedIds.has(r.id);
                    return (
                      <li key={r.id}>
                        <button
                          className={`piece-item${focusId === r.id ? ' focused' : ''}${placed ? ' placed' : ''}`}
                          onClick={() => {
                            focusRegion(r.id);
                            open(r.id);
                          }}
                          data-testid={`piece-item-${r.id}`}
                        >
                          <span className={`num-badge st-${st}`}>{placed ? '✓' : r.id}</span>
                          <span className="piece-item-text">
                            <span className="piece-item-where">{!p ? 'No match' : st === 'unmatched' ? 'No reliable match' : describeCell(p, puzzle.grid)}</span>
                            <span className="muted xsmall">
                              {r.kind === 'patch' ? 'Patch' : r.shape?.kind === 'corner' ? 'Corner' : r.shape?.kind === 'edge' ? 'Edge' : 'Piece'}
                              {p ? ` · ${confidencePercent(p.confidence)}%` : ''}
                              {placed ? ' · placed' : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
      {openRegion && (
        <PieceDetail
          region={openRegion}
          result={result}
          grid={puzzle.grid}
          photo={photoBitmap}
          reference={reference}
          progress={progress}
          rejected={rejected[openRegion.id] ?? 0}
          onReject={() => setRejected((r) => ({ ...r, [openRegion.id]: (r[openRegion.id] ?? 0) + 1 }))}
          onChoose={(i) => setRejected((r) => ({ ...r, [openRegion.id]: i }))}
          onPlace={(p) => void place(openRegion.id, p)}
          onUnplace={(p) => void saveProgress(unplaceCells(progress, cellsOf(openRegion.id, p)))}
          onOpenRegion={(id) => {
            focusRegion(id);
            setOpenId(id);
          }}
          onClose={() => setOpenId(undefined)}
        />
      )}
      <Snackbar message={snack} onClose={closeSnack} />
    </>
  );
}
