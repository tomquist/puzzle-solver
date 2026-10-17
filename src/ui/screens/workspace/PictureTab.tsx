/** Picture tab: zoomable reference with grid, placed cells and the latest scan's placements. */
import { useMemo, useState } from 'react';
import { Spinner } from '../../components/Feedback';
import { ReferenceOverlay, type RefMarker } from '../../components/ReferenceOverlay';
import { ZoomPanView } from '../../components/ZoomPanView';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { navigate } from '../../hooks/useHashRoute';
import { formatDate } from '../../lib/format';
import { itemTone } from '../../components/ScanOverlay';
import { usePrefs } from '../../hooks/usePrefs';
import { buildScanItems } from '../../lib/items';
import { visibleByView } from '../scan/useScanModel';
import { placedCells } from '../../lib/progress';
import { href } from '../../lib/routes';
import { Legend } from '../scan/Legend';

export function PictureTab() {
  const repo = useRepo();
  const { puzzle, progress, reference, scansVersion } = usePuzzle();
  const [showGrid, setShowGrid] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const latest = useAsync(() => repo.listScans(puzzle.id).then((s) => s[0]), [repo, puzzle.id, scansVersion]);
  const placed = useMemo(() => placedCells(progress, puzzle.grid), [progress, puzzle.grid]);

  const [prefs] = usePrefs();
  const scanModel = useMemo(() => {
    const scan = latest.data;
    if (!scan) return { markers: [] as RefMarker[], links: [] as { a: string; b: string }[] };
    const { items, links } = buildScanItems(scan.result, puzzle.grid);
    const visible = visibleByView(items, prefs.view);
    const keys = new Set(visible.map((i) => i.key));
    const markers: RefMarker[] = visible.map((item) => {
      const p = item.candidates[0];
      return { key: item.key, label: item.label, x: p.x, y: p.y, tone: itemTone(item), bounds: item.kind === 'assembled' ? p.bounds : undefined };
    });
    return { markers, links: prefs.view.connections ? links.filter((l) => keys.has(l.a) && keys.has(l.b)) : [] };
  }, [latest.data, puzzle.grid, prefs.view]);
  const markers = scanModel.markers;

  if (!reference) return <Spinner label="Loading the picture…" />;
  return (
    <>
      <div className="viewer-frame tall" style={{ aspectRatio: `${reference.width} / ${reference.height}` }}>
        <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} label={`Puzzle picture of ${puzzle.name}`} margin={14}>
          {(scale) => (
            <>
              <img src={reference.url} alt="" className="fill" draggable={false} />
              <ReferenceOverlay
                width={reference.width}
                height={reference.height}
                grid={puzzle.grid}
                showGrid={showGrid}
                placed={placed}
                markers={showMarkers ? markers : []}
                links={showMarkers ? scanModel.links : []}
                scale={scale}
                onMarker={latest.data ? () => navigate(href.scan(puzzle.id, latest.data!.id)) : undefined}
              />
            </>
          )}
        </ZoomPanView>
      </div>
      <div className="row between wrap gap-sm">
        <div className="row wrap gap">
          <label className="switch">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            <span>Grid</span>
          </label>
          {markers.length > 0 && (
            <label className="switch">
              <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
              <span>Latest scan</span>
            </label>
          )}
        </div>
        <span className="muted small">
          <span className="swatch placed" /> placed ({placed.length})
        </span>
      </div>
      {latest.data && showMarkers && (
        <p className="muted small">
          Numbers show where the pieces of your <a href={href.scan(puzzle.id, latest.data.id)}>latest scan</a> ({formatDate(latest.data.createdAt)}) go.
        </p>
      )}
      {markers.length > 0 && showMarkers && <Legend />}
    </>
  );
}
