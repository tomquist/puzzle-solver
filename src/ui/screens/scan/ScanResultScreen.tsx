/**
 * Scan result: the photo with the recognised pieces (no-match regions hidden), the box picture
 * with where they go, a compact list, and one clear next step – "Start placing" (guided mode) or
 * "Scan more". The screen stays on while shown.
 *
 * Tapping a piece (on the photo, the picture or in the list) selects it: the photo emphasises it,
 * its connections and the pieces it joins, and a compact bar at the bottom says where it goes and
 * what it joins, with the full details one tap away – the photo stays visible. Press and hold the
 * photo to see it without any annotations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QualityIssue, ScanRecord } from '../../../model/types';
import { describeCell } from '../../../pipeline/grid';
import { haptic } from '../../../platform/device';
import { Banner, EmptyState, ErrorState, Snackbar, Spinner, type SnackbarMessage } from '../../components/Feedback';
import { IconCheck, IconChevron, IconClose, IconPuzzle, IconScan } from '../../components/Icons';
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
import { useHoldToPeek } from '../../hooks/useHoldToPeek';
import { useBitmap, useObjectUrl, useStoredBlob } from '../../hooks/useObjectUrl';
import { usePrefs, useWakeLock } from '../../hooks/usePrefs';
import { formatDate, plural } from '../../lib/format';
import {
  cellsText,
  connectionsOf,
  describeConnections,
  itemCounts,
  itemKindText,
  itemTitle,
  linkedTo,
  placingOrder,
  type ItemPlacement,
  type ScanItem,
} from '../../lib/items';
import { paddedBox, unionRect } from '../../lib/overlay';
import { confidencePercent } from '../../lib/pieces';
import { placeCells, unplaceCells } from '../../lib/progress';
import { turnInstruction } from '../../lib/rotation';
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

const scrollBehavior = (): ScrollBehavior => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

function ScanResultView({ scan }: { scan: ScanRecord }) {
  const { puzzle, progress, updateProgress, reference } = usePuzzle();
  const [prefs, updatePrefs] = usePrefs();
  useWakeLock(prefs.keepScreenOn);
  const result = scan.result;
  const { blob: photoBlob } = useStoredBlob(scan.photoBlobId);
  const photoUrl = useObjectUrl(photoBlob);
  const photoBitmap = useBitmap(photoBlob);
  const photoView = useRef<ZoomPanHandle>(null);
  const refView = useRef<ZoomPanHandle>(null);
  const photoFrame = useRef<HTMLDivElement>(null);
  const { peeking, handlers: peekHandlers } = useHoldToPeek();

  const [view, setView] = useState<ViewMode>(() => (typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches ? 'both' : 'photo'));
  const [openKey, setOpenKey] = useState<string>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [rejected, setRejected] = useState<Record<string, number>>({});
  const [issue, setIssue] = useState<QualityIssue>();
  const [snack, setSnack] = useState<SnackbarMessage>();
  const closeSnack = useCallback(() => setSnack(undefined), []);

  const model = useScanModel(result, puzzle.grid, prefs.view, rejected, progress, scan.id);
  const { all, visible, links, byKey, placementOf, isPlacedItem } = model;
  const counts = itemCounts(all.items);
  const toPlace = useMemo(() => placingOrder(visible, links, puzzle.grid, isPlacedItem, placementOf), [visible, links, puzzle.grid, isPlacedItem, placementOf]);

  const overlayItems = useMemo<OverlayItem[]>(() => visible.map((item) => ({ item, placement: placementOf(item), placed: isPlacedItem(item) })), [visible, placementOf, isPlacedItem]);
  const markers = useMemo<RefMarker[]>(
    () =>
      visible.flatMap((item) => {
        const p = placementOf(item);
        if (!p) return [];
        return [{ key: item.key, label: item.label, x: p.x, y: p.y, tone: itemTone(item), bounds: item.kind === 'assembled' ? p.bounds : undefined }];
      }),
    [visible, placementOf],
  );

  // A selection that is no longer shown (view options changed) is dropped.
  const selected = selectedKey && visible.some((i) => i.key === selectedKey) ? byKey.get(selectedKey) : undefined;
  const clearSelection = useCallback(() => setSelectedKey(undefined), []);

  /** Bring the selected item and the items it joins into view (from the list or the details). */
  const reveal = (key: string) => {
    const item = byKey.get(key);
    if (!item) return;
    const p = placementOf(item);
    if (view !== 'picture') {
      const rects = [item.bbox, ...linkedTo(key, links).flatMap((k) => (byKey.get(k) ? [byKey.get(k)!.bbox] : []))];
      const box = unionRect(rects)!;
      const pad = Math.max(box.width, box.height) * 0.25 + Math.max(item.bbox.width, item.bbox.height);
      photoView.current?.focusRect(paddedBox({ x: box.x - pad / 2, y: box.y - pad / 2, width: box.width + pad, height: box.height + pad }, 0, result.width, result.height), 2.5);
      photoFrame.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    }
    if (p && view !== 'photo') refView.current?.focus({ x: p.x, y: p.y }, 3);
  };
  const select = (key: string, opts: { reveal?: boolean } = {}) => {
    setSelectedKey(key);
    if (opts.reveal) reveal(key);
  };

  // Esc clears the selection (the details sheet and the View popover handle Esc themselves).
  useEffect(() => {
    if (!selectedKey || openKey) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && clearSelection();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedKey, openKey, clearSelection]);

  const place = async (item: ScanItem, p: ItemPlacement) => {
    haptic();
    await updateProgress((current) => placeCells(current, p.cells, { scanId: scan.id, regionId: item.label }));
    setSnack({ id: Date.now(), text: `#${item.label} placed`, actionLabel: 'Undo', onAction: () => void updateProgress((current) => unplaceCells(current, p.cells)) });
  };

  const confidentToPlace = toPlace.filter((i) => i.status === 'confident' && (rejected[i.key] ?? 0) === 0);
  const placeAllConfident = async () => {
    haptic();
    const placements = confidentToPlace.map((item) => ({ item, cells: placementOf(item)!.cells }));
    await updateProgress((current) => placements.reduce((acc, { item, cells }) => placeCells(acc, cells, { scanId: scan.id, regionId: item.label }), current));
    setSnack({
      id: Date.now(),
      text: `${plural(confidentToPlace.length, 'item')} marked as placed`,
      actionLabel: 'Undo',
      onAction: () => void updateProgress((current) => placements.reduce((acc, { cells }) => unplaceCells(acc, cells), current)),
    });
  };

  const selectIssue = (i: QualityIssue | undefined) => {
    setIssue(i);
    if (!i) return;
    if (view === 'picture') setView('photo');
    if (i.area) photoView.current?.focus({ x: i.area.x + i.area.width / 2, y: i.area.y + i.area.height / 2 }, 1.8);
    else photoView.current?.reset();
  };

  const openItem = openKey ? byKey.get(openKey) : undefined;
  const selectedPlacement = selected ? placementOf(selected) : undefined;
  const labelOf = (key: string) => (visible.some((i) => i.key === key) ? byKey.get(key)?.label : undefined);
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
          <FeedbackLink puzzleId={puzzle.id} scanId={scan.id} />
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar title="Scan result" subtitle={subtitle} back={href.puzzle(puzzle.id, 'scan')} />
      <main className={`page wide stack with-action-bar${selected ? ' with-selection' : ''}`} data-testid="scan-result">
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
              <div
                ref={photoFrame}
                className={`viewer-frame result-photo${peeking ? ' peeking' : ''}`}
                style={{ aspectRatio: `${result.width} / ${result.height}` }}
                data-testid="result-photo"
                data-peek={peeking ? 'true' : 'false'}
                {...peekHandlers}
              >
                {photoUrl ? (
                  <ZoomPanView contentWidth={result.width} contentHeight={result.height} handle={photoView} label="Your photo with the recognised pieces" margin={6}>
                    {(scale, fitScale) => (
                      <>
                        <img src={photoUrl} alt="" className="fill" draggable={false} />
                        <ScanOverlay
                          result={result}
                          items={overlayItems}
                          links={links}
                          selectedKey={selected?.key}
                          showLabels={prefs.view.labels}
                          showTurnHints={prefs.view.turnHints}
                          showConnections={prefs.view.connections}
                          peek={peeking}
                          highlightRegionIds={issue?.regionIds}
                          highlightArea={issue?.area}
                          scale={scale}
                          fitScale={fitScale}
                          onSelect={(key) => select(key)}
                          onClear={clearSelection}
                        />
                      </>
                    )}
                  </ZoomPanView>
                ) : (
                  <Spinner label="Loading photo…" />
                )}
                <span className="viewer-label">{peeking ? 'Without labels' : 'Your photo'}</span>
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
                          links={prefs.view.connections ? links : links.filter((l) => l.a === selected?.key || l.b === selected?.key)}
                          selectedKey={selected?.key}
                          highlight={selectedPlacement?.cells}
                          scale={scale}
                          onMarker={(key) => select(key)}
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
            {view !== 'picture' && (
              <p className="photo-hint muted xsmall" data-testid="photo-hint">
                Tap a piece to see what it joins. Press and hold the photo to see it without labels.
              </p>
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
                    className={`piece-item${selected?.key === item.key ? ' selected' : ''}${placed ? ' placed' : ''}`}
                    onClick={() => select(item.key, { reveal: true })}
                    data-testid={`piece-item-${item.key}`}
                  >
                    <span className={`num-badge st-${tone}`}>{placed ? '✓' : item.label}</span>
                    <span className="piece-item-text">
                      <span className="piece-item-where">
                        {!p ? 'No place left' : item.kind === 'assembled' ? cellsText(p) : describeCell(p.cells[0], puzzle.grid)}
                      </span>
                      <span className="muted xsmall">
                        {itemKindText(item)}
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
        <FeedbackLink puzzleId={puzzle.id} scanId={scan.id} />
      </main>

      {selected ? (
        <SelectionBar
          item={selected}
          placement={selectedPlacement}
          placed={isPlacedItem(selected)}
          connections={describeConnections(connectionsOf(selected.key, links), labelOf)}
          onDetails={() => setOpenKey(selected.key)}
          onClear={clearSelection}
        />
      ) : (
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
      )}

      {openItem && (
        <ItemDetail
          item={openItem}
          candidateIndex={rejected[openItem.key] ?? 0}
          result={result}
          grid={puzzle.grid}
          photo={photoBitmap}
          reference={reference}
          placed={isPlacedItem(openItem)}
          connections={connectionsOf(openItem.key, links).flatMap((c) => (labelOf(c.key) !== undefined ? [{ ...c, item: byKey.get(c.key)! }] : []))}
          onReject={() => setRejected((r) => ({ ...r, [openItem.key]: (r[openItem.key] ?? 0) + 1 }))}
          onChoose={(i) => setRejected((r) => ({ ...r, [openItem.key]: i }))}
          onPlace={(p) => void place(openItem, p)}
          onUnplace={(p) => void updateProgress((current) => unplaceCells(current, p.cells))}
          onOpen={(key) => {
            select(key, { reveal: true });
            setOpenKey(key);
          }}
          onClose={() => setOpenKey(undefined)}
        />
      )}
      <Snackbar message={snack} onClose={closeSnack} />
    </>
  );
}

/**
 * The selected item in a compact bar where the action bar is (the photo stays visible): where it
 * goes, how to turn it and what it joins; tap for the details, × (or the empty photo) to clear.
 */
function SelectionBar({
  item,
  placement,
  placed,
  connections,
  onDetails,
  onClear,
}: {
  item: ScanItem;
  placement: ItemPlacement | undefined;
  placed: boolean;
  connections: string;
  onDetails: () => void;
  onClear: () => void;
}) {
  const where = placement ? cellsText(placement) : 'No place left';
  const turn = placement?.rotationDeg !== undefined ? turnInstruction(placement.rotationDeg).short : undefined;
  return (
    <div className="action-bar selection-bar" data-testid="selection-bar" role="region" aria-label={`Selected: ${itemTitle(item)}`}>
      <div className="action-bar-inner">
        <button className="selection-main" onClick={onDetails} data-testid="selection-details">
          <span className={`num-badge st-${itemTone(item)}`}>{placed ? '✓' : item.label}</span>
          <span className="selection-text">
            <span className="selection-where">
              {where}
              {placed ? ' · placed' : ''}
            </span>
            <span className="muted xsmall">{[itemKindText(item), turn].filter(Boolean).join(' · ')}</span>
            {connections && (
              <span className="selection-links small" data-testid="selection-links">
                {connections}
              </span>
            )}
          </span>
          <span className="selection-more">
            <span className="selection-more-text">Details</span>
            <IconChevron size={18} />
          </span>
        </button>
        <button className="icon-btn" onClick={onClear} aria-label="Clear selection" data-testid="selection-clear">
          <IconClose />
        </button>
      </div>
    </div>
  );
}

/** Quiet way to report a bad detection (at the very end of the result). */
function FeedbackLink({ puzzleId, scanId }: { puzzleId: string; scanId: string }) {
  return (
    <p className="feedback-link small">
      <a href={href.feedback(puzzleId, scanId)} data-testid="scan-feedback-link">
        Something wrong with this scan? Send feedback
      </a>
    </p>
  );
}
