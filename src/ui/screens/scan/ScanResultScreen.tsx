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
import { FitAnimation } from '../../components/FitAnimation';
import { FullscreenView, leaveFullscreenView } from '../../components/FullscreenView';
import { IconCheck, IconChevron, IconClose, IconEye, IconEyeOff, IconFullscreen, IconPuzzle, IconScan } from '../../components/Icons';
import { ItemDetail } from '../../components/ItemDetail';
import { GridJobStrip, GridSuggestionCard } from '../../components/GridSuggestion';
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
import { usePrefersReducedMotion } from '../../hooks/usePieceCutout';
import { useBitmap, useObjectUrl, useStoredBlob } from '../../hooks/useObjectUrl';
import { usePrefs, useWakeLock } from '../../hooks/usePrefs';
import { cellItemOf, scaleAspect, type CellScale } from '../../lib/cellSpots';
import { fitDescription, fitPose, glidePath, type FitItem } from '../../lib/fit';
import { formatDate, plural } from '../../lib/format';
import {
  cellsText,
  connectionsOf,
  connectionTokens,
  itemCounts,
  itemKindText,
  itemTitle,
  linkedTo,
  placingOrder,
  type ConnectionToken,
  type ItemPlacement,
  type ScanItem,
} from '../../lib/items';
import { selectionLevels } from '../../lib/linkGraph';
import { cellSize, paddedBox, unionRect } from '../../lib/overlay';
import { confidencePercent } from '../../lib/pieces';
import { placeCells, unplaceCells } from '../../lib/progress';
import { turnBadge, turnInstruction } from '../../lib/rotation';
import { linkRoute } from '../../lib/route';
import { href } from '../../lib/routes';
import { Legend } from './Legend';
import { useScanModel } from './useScanModel';

type ViewMode = 'photo' | 'picture' | 'both';
const PLACING_HINT = 'placing-hint';

export function ScanResultScreen({ scanId }: { scanId: string }) {
  const repo = useRepo();
  const { puzzle, cellsVersion } = usePuzzle();
  // Reloaded when a new grid re-derives the scans' cells (pipeline/remap.ts) – not when the scan's
  // cell size is measured after it is shown (that would reset the screen under the user).
  const scan = useAsync(() => repo.getScan(scanId), [repo, scanId, cellsVersion]);
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
  const fsView = useRef<ZoomPanHandle>(null);
  const { peeking, handlers: peekHandlers } = useHoldToPeek();

  const [view, setView] = useState<ViewMode>(() => (typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches ? 'both' : 'photo'));
  const [fullscreen, setFullscreen] = useState<'photo' | 'picture'>();
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
        return [{ key: item.key, label: item.label, x: p.x, y: p.y, tone: itemTone(item), bounds: item.kind === 'assembled' ? p.bounds : undefined, pieces: item.pieceCount }];
      }),
    [visible, placementOf],
  );

  // A selection that is no longer shown (view options changed) is dropped.
  const selected = selectedKey && visible.some((i) => i.key === selectedKey) ? byKey.get(selectedKey) : undefined;
  // How far its highlight reaches (the same levels as on the photo: ScanOverlay).
  const levels = useMemo(() => (selected ? selectionLevels(selected.key, links, visible.length) : undefined), [selected, links, visible.length]);
  const beyond = levels ? [...levels.values()].filter((lv) => lv >= 2).length : 0;
  const clearSelection = useCallback(() => setSelectedKey(undefined), []);

  // "Show the fit": the selected item and one of its connections (n restarts it). One at a time;
  // a new selection ends it.
  const reducedMotion = usePrefersReducedMotion();
  const [fit, setFit] = useState<{ a: string; b: string; n: number }>();
  useEffect(() => setFit(undefined), [selected?.key]);
  const regionById = useMemo(() => new Map(result.regions.map((r) => [r.id, r])), [result]);
  // Where a group's cells lie in the photo: from the box picture's cell size and the pieces' size
  // (the fit and the connection lines alike).
  const refW = reference?.width;
  const refH = reference?.height;
  const bodySize = result.quality.metrics.medianBodySize;
  const cellScale = useMemo<CellScale>(
    () => ({ refCell: refW && refH ? cellSize(puzzle.grid, refW, refH) : undefined, bodySize }),
    [puzzle.grid, refW, refH, bodySize],
  );
  const aspect = scaleAspect(cellScale);
  const fitItem = (key: string): FitItem | undefined => {
    const item = byKey.get(key);
    const p = item ? placementOf(item) : undefined;
    const cells = item && p ? cellItemOf(item, p, regionById, cellScale) : undefined;
    return item && cells ? { ...cells, key, label: item.label, pieces: item.pieceCount } : undefined;
  };
  const canFit = (key: string) => !!selected && !!fitItem(selected.key) && !!fitItem(key);
  const fitShow = useMemo(() => {
    if (!fit) return undefined;
    const a = fitItem(fit.a);
    const b = fitItem(fit.b);
    const pose = a && b ? fitPose(a, b, aspect) : undefined;
    if (!a || !b || !pose) return undefined;
    const moverKey = pose.mover === 'a' ? fit.a : fit.b;
    const anchorKey = pose.mover === 'a' ? fit.b : fit.a;
    const link = links.find((l) => (l.a === fit.a && l.b === fit.b) || (l.a === fit.b && l.b === fit.a));
    const ends = (k: string) => ({ item: byKey.get(k)!, placement: placementOf(byKey.get(k)!) });
    const route = link ? linkRoute(link, ends(link.a), ends(link.b), regionById, () => 10, cellScale) : null;
    const mover = byKey.get(moverKey)!;
    return {
      ...fit,
      pose,
      mover,
      path: glidePath(pose, route ?? undefined, link?.a === moverKey, 12),
      text: fitDescription(pose, { label: mover.label, pieces: mover.pieceCount }, { label: byKey.get(anchorKey)!.label }),
    };
    // fitItem reads the placements (placementOf) and the photo's regions.
  }, [fit, links, byKey, placementOf, regionById, cellScale, result]);
  const playFit = (partner: string) => {
    if (!selected) return;
    if (reducedMotion && fit?.b === partner) return setFit(undefined);
    if (view === 'picture' && !fullscreen) setView('both');
    setFit((f) => ({ a: selected.key, b: partner, n: (f?.n ?? 0) + 1 }));
    if (!fullscreen) photoFrame.current?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    // Frame both items and where the moving one docks, so the motion can be seen.
    const a = fitItem(selected.key);
    const b = fitItem(partner);
    const pose = a && b ? fitPose(a, b, aspect) : undefined;
    const handle = fullscreen === 'photo' ? fsView.current : fullscreen ? null : photoView.current;
    if (pose && handle) {
      const s = Math.max(a!.cellPx, b!.cellPx);
      const box = unionRect([selected.bbox, byKey.get(partner)!.bbox, { x: pose.docked.x - s, y: pose.docked.y - s, width: 2 * s, height: 2 * s }])!;
      const pad = Math.max(box.width, box.height) * 0.15;
      handle.focusRect(paddedBox({ x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad }, 0, result.width, result.height), 4);
    }
  };

  /**
   * Bring the selected item and the items it joins into view (from the list, the details or a
   * mention in the selection bar) – in the full-screen view when it is open.
   */
  const reveal = (key: string) => {
    const item = byKey.get(key);
    if (!item) return;
    const p = placementOf(item);
    const photoHandle = fullscreen === 'photo' ? fsView.current : !fullscreen && view !== 'picture' ? photoView.current : null;
    if (photoHandle) {
      const rects = [item.bbox, ...linkedTo(key, links).flatMap((k) => (byKey.get(k) ? [byKey.get(k)!.bbox] : []))];
      const box = unionRect(rects)!;
      const pad = Math.max(box.width, box.height) * 0.25 + Math.max(item.bbox.width, item.bbox.height);
      photoHandle.focusRect(paddedBox({ x: box.x - pad / 2, y: box.y - pad / 2, width: box.width + pad, height: box.height + pad }, 0, result.width, result.height), 2.5);
      if (!fullscreen) photoFrame.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    }
    const refHandle = fullscreen === 'picture' ? fsView.current : !fullscreen && view !== 'photo' ? refView.current : null;
    if (p && refHandle) refHandle.focus({ x: p.x, y: p.y }, 3);
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

  // The photo and the picture with their overlays – in the page and in the full-screen view.
  const photoContent = (scale: number, fitScale: number, inFullscreen = false) => (
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
        onLinkTap={(a, b) => selected && playFit(a === selected.key ? b : a)}
        fitPair={fitShow && (fullscreen === 'photo') === inFullscreen ? [fitShow.a, fitShow.b] : undefined}
        cellScale={cellScale}
      />
      {fitShow && (fullscreen === 'photo') === inFullscreen && (
        <FitAnimation
          key={`${fitShow.a}-${fitShow.b}-${fitShow.n}`}
          mover={fitShow.mover}
          regions={result.regions}
          photo={photoBitmap}
          width={result.width}
          height={result.height}
          pose={fitShow.pose}
          path={fitShow.path}
          reduced={reducedMotion}
          onDone={() => setFit((f) => (f && f.n === fitShow.n ? undefined : f))}
        />
      )}
    </>
  );
  const pictureContent = (scale: number) =>
    reference && (
      <>
        <img src={reference.url} alt="" className="fill" draggable={false} />
        <ReferenceOverlay
          width={reference.width}
          height={reference.height}
          grid={puzzle.grid}
          showGrid={false}
          markers={markers}
          links={links}
          showConnections={prefs.view.connections}
          selectedKey={selected?.key}
          levels={levels}
          highlight={selectedPlacement?.cells}
          scale={scale}
          onMarker={(key) => select(key)}
        />
      </>
    );
  const selectionBar = (variant: 'bar' | 'overlay') =>
    selected && (
      <SelectionBar
        variant={variant}
        item={selected}
        placement={selectedPlacement}
        placed={isPlacedItem(selected)}
        connections={connectionTokens(connectionsOf(selected.key, links), labelOf)}
        beyond={beyond}
        canFit={canFit}
        fitKey={fitShow?.b}
        fitText={fitShow?.text}
        onFit={playFit}
        onSelectKey={(key) => select(key, { reveal: true })}
        onDetails={() => {
          // The details are a sheet of the page: leave the full-screen view for them.
          if (fullscreen) leaveFullscreenView(() => setFullscreen(undefined));
          setOpenKey(selected.key);
        }}
        onClear={clearSelection}
      />
    );
  const toggleLabels = () => updatePrefs((p) => ({ ...p, view: { ...p.view, labels: !p.view.labels } }));
  const hintVisible = !prefs.dismissed.includes(PLACING_HINT) && toPlace.length > 0;
  const subtitle = `${formatDate(scan.createdAt)} · ${plural(counts.pieces, 'piece')} found`;

  if (all.items.length === 0) {
    return (
      <>
        <TopBar title="Scan result" subtitle={formatDate(scan.createdAt)} back={href.puzzle(puzzle.id, 'scan')} />
        <main className="page stack" data-testid="scan-result">
          <GridSuggestionCard />
          <GridJobStrip />
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
        <GridSuggestionCard />
        <GridJobStrip />
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
                    {(scale: number, fitScale: number) => photoContent(scale, fitScale)}
                  </ZoomPanView>
                ) : (
                  <Spinner label="Loading photo…" />
                )}
                <span className="viewer-label">{peeking ? 'Without labels' : 'Your photo'}</span>
                {photoUrl && <FullscreenButton onClick={() => setFullscreen('photo')} testId="open-fullscreen-photo" />}
              </div>
            )}
            {view !== 'photo' && (
              <div className="viewer-frame result-ref" style={reference ? { aspectRatio: `${reference.width} / ${reference.height}` } : undefined}>
                {reference ? (
                  <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} handle={refView} label="Box picture with where the pieces go" margin={14}>
                    {pictureContent}
                  </ZoomPanView>
                ) : (
                  <Spinner label="Loading picture…" />
                )}
                <span className="viewer-label">Box picture</span>
                {reference && <FullscreenButton onClick={() => setFullscreen('picture')} testId="open-fullscreen-picture" />}
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
              const badge = p?.rotationDeg !== undefined && !placed ? turnBadge(p.rotationDeg) : '';
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
                        {badge ? ` · ${badge}` : ''}
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

      {fullscreen ? null : selected ? (
        selectionBar('bar')
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
      {fullscreen && (
        <FullscreenView
          label={fullscreen === 'photo' ? 'Your photo, full screen' : 'Box picture, full screen'}
          title={fullscreen === 'photo' ? (peeking ? 'Without labels' : 'Your photo') : 'Box picture'}
          onClose={() => setFullscreen(undefined)}
          tools={
            fullscreen === 'photo' && (
              <button
                className="icon-btn glass"
                onClick={toggleLabels}
                aria-pressed={prefs.view.labels}
                aria-label="Labels"
                title={prefs.view.labels ? 'Hide labels' : 'Show labels'}
                data-testid="fullscreen-labels"
              >
                {prefs.view.labels ? <IconEye /> : <IconEyeOff />}
              </button>
            )
          }
          footer={
            selected ? (
              selectionBar('overlay')
            ) : (
              <p className="fs-hint">{fullscreen === 'photo' ? 'Tap a piece to see what it joins. Press and hold to see the photo without labels.' : 'Tap a number to see that piece.'}</p>
            )
          }
        >
          {(insets) =>
            fullscreen === 'photo' ? (
              <div className="fs-peek" data-peek={peeking ? 'true' : 'false'} {...peekHandlers}>
                <ZoomPanView
                  contentWidth={result.width}
                  contentHeight={result.height}
                  handle={fsView}
                  label="Your photo with the recognised pieces, full screen"
                  margin={8}
                  insets={insets}
                  alwaysPan
                >
                  {(scale: number, fitScale: number) => photoContent(scale, fitScale, true)}
                </ZoomPanView>
              </div>
            ) : (
              reference && (
                <ZoomPanView
                  contentWidth={reference.width}
                  contentHeight={reference.height}
                  handle={fsView}
                  label="Box picture with where the pieces go, full screen"
                  margin={14}
                  insets={insets}
                  alwaysPan
                >
                  {pictureContent}
                </ZoomPanView>
              )
            )
          }
        </FullscreenView>
      )}
      <Snackbar message={snack} onClose={closeSnack} />
    </>
  );
}

function FullscreenButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  return (
    <button className="icon-btn small glass frame-fullscreen" onClick={onClick} aria-label="Full screen" title="Full screen" data-testid={testId}>
      <IconFullscreen size={18} />
    </button>
  );
}

/**
 * The selected item in a compact bar where the action bar is (the photo stays visible), or laid
 * over the bottom of the full-screen view: where it goes, how to turn it and what it joins – each
 * joined item a link that moves the selection there. Tap the card for the details, × (or the
 * empty photo) to clear.
 */
function SelectionBar({
  variant,
  item,
  placement,
  placed,
  connections,
  beyond,
  canFit,
  fitKey,
  fitText,
  onFit,
  onSelectKey,
  onDetails,
  onClear,
}: {
  variant: 'bar' | 'overlay';
  item: ScanItem;
  placement: ItemPlacement | undefined;
  placed: boolean;
  connections: ConnectionToken[];
  /** Items highlighted beyond the direct connections (their connections in turn). */
  beyond: number;
  /** Whether "show the fit" works for a joined item (both turns known). */
  canFit: (key: string) => boolean;
  /** The item whose fit is shown, and the fit in words (read out). */
  fitKey?: string;
  fitText?: string;
  onFit: (key: string) => void;
  onSelectKey: (key: string) => void;
  onDetails: () => void;
  onClear: () => void;
}) {
  const where = placement ? cellsText(placement) : 'No place left';
  const fitKeys = connections.flatMap((t) => ('key' in t && canFit(t.key) ? [{ key: t.key, label: t.label }] : []));
  const turn = placement?.rotationDeg !== undefined ? turnInstruction(placement.rotationDeg).text : undefined;
  return (
    <div className={variant === 'bar' ? 'action-bar selection-bar' : 'selection-bar overlay'} data-testid="selection-bar" role="region" aria-label={`Selected: ${itemTitle(item)}`}>
      <div className="action-bar-inner">
        {/* The whole card opens the details for touch; the Details button is the accessible way. */}
        <div className="selection-main" onClick={onDetails} data-testid="selection-card">
          <span className={`num-badge st-${itemTone(item)}`}>{placed ? '✓' : item.label}</span>
          <span className="selection-text">
            <span className="selection-where">
              {where}
              {placed ? ' · placed' : ''}
            </span>
            <span className="muted xsmall">{[itemKindText(item), turn].filter(Boolean).join(' · ')}</span>
            {connections.length > 0 && (
              <span className="selection-links small" data-testid="selection-links">
                {connections.map((t, i) =>
                  'text' in t ? (
                    <span key={i}>{t.text}</span>
                  ) : (
                    <button
                      key={i}
                      className="mention"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectKey(t.key);
                      }}
                      aria-label={`Select #${t.label}`}
                      data-testid={`mention-${t.key}`}
                    >
                      #{t.label}
                    </button>
                  ),
                )}
                {beyond > 0 && (
                  <span className="muted" data-testid="selection-beyond">
                    {' '}
                    · {beyond} more beyond
                  </span>
                )}
                <span className="visually-hidden" aria-live="polite" data-testid="fit-live">
                  {fitText ?? ''}
                </span>
              </span>
            )}
          </span>
          <button
            className="selection-more"
            onClick={(e) => {
              e.stopPropagation();
              onDetails();
            }}
            data-testid="selection-details"
          >
            <span className="selection-more-text">Details</span>
            <IconChevron size={18} />
          </button>
        </div>
        <button className="icon-btn" onClick={onClear} aria-label="Clear selection" data-testid="selection-clear">
          <IconClose />
        </button>
      </div>
      {/* "Show the fit": one big button per connection, in a row that scrolls sideways when they
          don't fit (the card stays one row taller at most). */}
      {fitKeys.length > 0 && (
        <div className="fit-row" role="group" aria-label="Show how they fit" data-testid="fit-row">
          {fitKeys.map((c) => (
            <button
              key={c.key}
              className={`fit-pill${fitKey === c.key ? ' on' : ''}`}
              onClick={() => onFit(c.key)}
              aria-pressed={fitKey === c.key}
              data-testid={`fit-play-${c.key}`}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1.5 0.8 9 5 1.5 9.2Z" />
              </svg>
              Show fit with #{c.label}
            </button>
          ))}
        </div>
      )}
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
