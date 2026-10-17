/**
 * Scan result: the photo with the recognised pieces (no-match regions hidden), the box picture
 * with where they go, a compact list, and one clear next step – "Start placing" (guided mode) or
 * "Scan more". The screen stays on while shown.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { QualityIssue, ScanRecord } from '../../../model/types';
import { describeCell } from '../../../pipeline/grid';
import { haptic } from '../../../platform/device';
import { Banner, EmptyState, ErrorState, Snackbar, Spinner, type SnackbarMessage } from '../../components/Feedback';
import { IconCheck, IconPuzzle, IconScan } from '../../components/Icons';
import { ItemDetail } from '../../components/ItemDetail';
import { QualityBanner } from '../../components/Quality';
import { ReferenceOverlay, type RefMarker } from '../../components/ReferenceOverlay';
import { itemTone, ScanOverlay, type OverlayItem } from '../../components/ScanOverlay';
import { Segmented } from '../../components/Segmented';
import { TopBar } from '../../components/TopBar';
import { ViewOptionsButton } from '../../components/ViewOptions';
import { ZoomPanView, type ZoomPanHandle } from '../../components/ZoomPanView';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { navigate } from '../../hooks/useHashRoute';
import { useBitmap, useObjectUrl, useStoredBlob } from '../../hooks/useObjectUrl';
import { usePrefs, useWakeLock } from '../../hooks/usePrefs';
import { formatDate, plural } from '../../lib/format';
import { cellsText, itemCounts, linkedTo, placingOrder, type ItemPlacement, type ScanItem } from '../../lib/items';
import { confidencePercent } from '../../lib/pieces';
import { placeCells, unplaceCells } from '../../lib/progress';
import { href } from '../../lib/routes';
import { Legend } from './Legend';
import { useScanModel } from './useScanModel';

type ViewMode = 'photo' | 'picture' | 'both';
const PLACING_HINT = 'placing-hint';

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
  const [prefs, updatePrefs] = usePrefs();
  useWakeLock(prefs.keepScreenOn);
  const result = scan.result;
  const { blob: photoBlob } = useStoredBlob(scan.photoBlobId);
  const photoUrl = useObjectUrl(photoBlob);
  const photoBitmap = useBitmap(photoBlob);
  const photoView = useRef<ZoomPanHandle>(null);
  const refView = useRef<ZoomPanHandle>(null);

  const [view, setView] = useState<ViewMode>(() => (typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches ? 'both' : 'photo'));
  const [openKey, setOpenKey] = useState<string>();
  const [focusKey, setFocusKey] = useState<string>();
  const [rejected, setRejected] = useState<Record<string, number>>({});
  const [issue, setIssue] = useState<QualityIssue>();
  const [snack, setSnack] = useState<SnackbarMessage>();
  const closeSnack = useCallback(() => setSnack(undefined), []);

  const model = useScanModel(result, puzzle.grid, prefs.view, rejected, progress, scan.id);
  const { all, visible, links, byKey, placementOf, isPlacedItem } = model;
  const counts = itemCounts(all.items);
  const toPlace = useMemo(() => placingOrder(visible, links, puzzle.grid, isPlacedItem, placementOf), [visible, links, puzzle.grid, isPlacedItem, placementOf]);

  const overlayItems: OverlayItem[] = visible.map((item) => ({ item, placement: placementOf(item), placed: isPlacedItem(item) }));
  const markers = useMemo<RefMarker[]>(
    () =>
      visible.flatMap((item) => {
        const p = placementOf(item);
        if (!p) return [];
        return [{ key: item.key, label: item.label, x: p.x, y: p.y, tone: itemTone(item), bounds: item.kind === 'assembled' ? p.bounds : undefined }];
      }),
    [visible, placementOf],
  );

  const focusItem = (key: string) => {
    setFocusKey(key);
    const item = byKey.get(key);
    const p = item && placementOf(item);
    if (item && view !== 'picture') photoView.current?.focus(item.center, 2.2);
    if (p && view !== 'photo') refView.current?.focus({ x: p.x, y: p.y }, 3);
  };
  const open = (key: string) => {
    setFocusKey(key);
    setOpenKey(key);
  };

  const place = async (item: ScanItem, p: ItemPlacement) => {
    haptic();
    const before = progress;
    await saveProgress(placeCells(progress, p.cells, { scanId: scan.id, regionId: item.label }));
    setSnack({ id: Date.now(), text: `#${item.label} placed`, actionLabel: 'Undo', onAction: () => void saveProgress(before) });
  };

  const confidentToPlace = toPlace.filter((i) => i.status === 'confident' && (rejected[i.key] ?? 0) === 0);
  const placeAllConfident = async () => {
    haptic();
    const before = progress;
    let next = progress;
    for (const item of confidentToPlace) next = placeCells(next, placementOf(item)!.cells, { scanId: scan.id, regionId: item.label });
    await saveProgress(next);
    setSnack({ id: Date.now(), text: `${plural(confidentToPlace.length, 'item')} marked as placed`, actionLabel: 'Undo', onAction: () => void saveProgress(before) });
  };

  const selectIssue = (i: QualityIssue | undefined) => {
    setIssue(i);
    if (!i) return;
    if (view === 'picture') setView('photo');
    if (i.area) photoView.current?.focus({ x: i.area.x + i.area.width / 2, y: i.area.y + i.area.height / 2 }, 1.8);
    else photoView.current?.reset();
  };

  const openItem = openKey ? byKey.get(openKey) : undefined;
  const focusPlacement = focusKey && byKey.get(focusKey) ? placementOf(byKey.get(focusKey)!) : undefined;
  const hintVisible = !prefs.dismissed.includes(PLACING_HINT) && toPlace.length > 0;
  const subtitle = `${formatDate(scan.createdAt)} · ${plural(counts.pieces, 'piece')} found`;

  if (all.items.length === 0) {
    return (
      <>
        <TopBar title="Scan result" subtitle={formatDate(scan.createdAt)} back={href.puzzle(puzzle.id, 'scan')} />
        <main className="page stack" data-testid="scan-result">
          <QualityBanner report={result.quality} hideWhenClean />
          <EmptyState
            icon={<IconPuzzle size={32} />}
            title="No pieces recognised"
            actions={
              <a className="btn btn-primary" href={href.puzzle(puzzle.id, 'scan')}>
                <IconScan size={18} />
                Try another photo
              </a>
            }
          >
            <p>Spread the pieces on a plain, contrasting background so they don’t touch, and shoot from directly above.</p>
          </EmptyState>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar title="Scan result" subtitle={subtitle} back={href.puzzle(puzzle.id, 'scan')} />
      <main className="page wide stack with-action-bar" data-testid="scan-result">
        <QualityBanner report={result.quality} selected={issue} onSelect={selectIssue} hideWhenClean />

        <div className="result-toolbar">
          <Segmented
            label="Show"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'photo', label: 'Photo' },
              { value: 'picture', label: 'Picture' },
              { value: 'both', label: 'Both' },
            ]}
          />
          <ViewOptionsButton />
        </div>

        {visible.length === 0 ? (
          <EmptyState title="Nothing to show with these view options">
            <p className="muted">Turn “Unsure pieces” on or “Edge pieces only” off in View.</p>
          </EmptyState>
        ) : (
          <div className={`result-views view-${view}`}>
            {view !== 'picture' && (
              <div className="viewer-frame result-photo" style={{ aspectRatio: `${result.width} / ${result.height}` }}>
                {photoUrl ? (
                  <ZoomPanView contentWidth={result.width} contentHeight={result.height} handle={photoView} label="Your photo with the recognised pieces" margin={6}>
                    {(scale) => (
                      <>
                        <img src={photoUrl} alt="" className="fill" draggable={false} />
                        <ScanOverlay
                          result={result}
                          items={overlayItems}
                          links={links}
                          selectedKey={focusKey}
                          showTurnHints={prefs.view.turnHints}
                          showConnections={prefs.view.connections}
                          highlightRegionIds={issue?.regionIds}
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
                  <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} handle={refView} label="Box picture with where the pieces go" margin={14}>
                    {(scale) => (
                      <>
                        <img src={reference.url} alt="" className="fill" draggable={false} />
                        <ReferenceOverlay
                          width={reference.width}
                          height={reference.height}
                          grid={puzzle.grid}
                          showGrid={false}
                          markers={markers}
                          links={prefs.view.connections ? links : []}
                          selectedKey={focusKey}
                          highlight={focusPlacement?.cells}
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
        )}

        {hintVisible && (
          <Banner
            tone="info"
            onDismiss={() => updatePrefs((p) => ({ ...p, dismissed: [...p.dismissed, PLACING_HINT] }))}
          >
            Tap <strong>Start placing</strong> and we’ll show you one piece at a time – where it goes and how to turn it.
          </Banner>
        )}

        <section>
          <div className="list-head">
            <h2 className="h3">
              {plural(visible.length, 'item')}
              {counts.unsure > 0 && prefs.view.unsure ? <span className="muted"> · {counts.unsure} unsure</span> : null}
            </h2>
            {confidentToPlace.length > 1 && (
              <button className="btn btn-sm btn-quiet" onClick={() => void placeAllConfident()} data-testid="place-all">
                <IconCheck size={16} />
                Mark {confidentToPlace.length} sure ones placed
              </button>
            )}
          </div>
          <ul className="piece-list">
            {visible.map((item) => {
              const p = placementOf(item);
              const placed = isPlacedItem(item);
              const tone = itemTone(item);
              return (
                <li key={item.key}>
                  <button
                    className={`piece-item${focusKey === item.key ? ' focused' : ''}${placed ? ' placed' : ''}`}
                    onClick={() => {
                      focusItem(item.key);
                      open(item.key);
                    }}
                    data-testid={`piece-item-${item.key}`}
                  >
                    <span className={`num-badge st-${tone}`}>{placed ? '✓' : item.label}</span>
                    <span className="piece-item-text">
                      <span className="piece-item-where">
                        {!p ? 'No place left' : item.kind === 'assembled' ? cellsText(p) : describeCell(p.cells[0], puzzle.grid)}
                      </span>
                      <span className="muted xsmall">
                        {item.kind === 'assembled' ? `Assembled grid · ${item.pieceCount} pieces` : item.edge ? 'Edge piece' : 'Piece'}
                        {item.status === 'ambiguous' ? ' · unsure' : ''}
                        {p && item.status === 'ambiguous' ? ` · ${confidencePercent(p.confidence)}%` : ''}
                        {placed ? ' · placed' : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Legend />
        </section>
      </main>

      <div className="action-bar" data-testid="action-bar">
        <div className="action-bar-inner">
          <a className="btn btn-lg" href={href.puzzle(puzzle.id, 'scan')}>
            <IconScan size={18} />
            Scan more
          </a>
          {toPlace.length > 0 ? (
            <button className="btn btn-primary btn-lg grow" onClick={() => navigate(href.place(puzzle.id, scan.id))} data-testid="start-placing">
              Start placing · {toPlace.length}
            </button>
          ) : (
            <span className="action-bar-done grow">
              <IconCheck size={18} /> All placed
            </span>
          )}
        </div>
      </div>

      {openItem && (
        <ItemDetail
          item={openItem}
          candidateIndex={rejected[openItem.key] ?? 0}
          result={result}
          grid={puzzle.grid}
          photo={photoBitmap}
          reference={reference}
          placed={isPlacedItem(openItem)}
          neighbours={linkedTo(openItem.key, links).map((k) => byKey.get(k)!).filter(Boolean)}
          onReject={() => setRejected((r) => ({ ...r, [openItem.key]: (r[openItem.key] ?? 0) + 1 }))}
          onChoose={(i) => setRejected((r) => ({ ...r, [openItem.key]: i }))}
          onPlace={(p) => void place(openItem, p)}
          onUnplace={(p) => void saveProgress(unplaceCells(progress, p.cells))}
          onOpen={(key) => {
            focusItem(key);
            setOpenKey(key);
          }}
          onClose={() => setOpenKey(undefined)}
        />
      )}
      <Snackbar message={snack} onClose={closeSnack} />
    </>
  );
}
