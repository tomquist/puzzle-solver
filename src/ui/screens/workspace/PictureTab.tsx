/** Picture tab: zoomable reference with grid, placed cells and the latest scan's placements. */
import { useMemo, useState } from 'react';
import { Spinner } from '../../components/Feedback';
import { ReferenceOverlay, type RefMarker } from '../../components/ReferenceOverlay';
import { ZoomPanView } from '../../components/ZoomPanView';
import { usePuzzle } from '../../context/PuzzleContext';
import { useRepo } from '../../context/RepositoryContext';
import { useAsync } from '../../hooks/useAsync';
import { formatDate } from '../../lib/format';
import { cellsForPlacement, displayStatus } from '../../lib/pieces';
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

  const markers = useMemo<RefMarker[]>(() => {
    const scan = latest.data;
    if (!scan) return [];
    const out: RefMarker[] = [];
    for (const m of scan.result.matches) {
      const region = scan.result.regions.find((r) => r.id === m.regionId);
      const best = m.candidates[0];
      if (!region || !best) continue;
      out.push({ id: region.id, x: best.x, y: best.y, status: displayStatus(region, m), cells: m.coveredCells ? cellsForPlacement(m, best) : undefined });
    }
    return out;
  }, [latest.data]);

  if (!reference) return <Spinner label="Loading the picture…" />;
  return (
    <>
      <div className="viewer-frame tall">
        <ZoomPanView contentWidth={reference.width} contentHeight={reference.height} label={`Puzzle picture of ${puzzle.name}`}>
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
                scale={scale}
                onMarker={latest.data ? () => (location.hash = href.scan(puzzle.id, latest.data!.id)) : undefined}
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
