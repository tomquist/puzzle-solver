/**
 * Step 3: name, piece count, physical size, grid and cut style. The piece count may be exact (from
 * the box), approximate or unknown: the scans measure the grid either way (pipeline/gridBelief.ts),
 * and without a count the grid starts as an estimate from the picture's shape and a typical count.
 */
import { useMemo, useState } from 'react';
import type { CutStyle, GridSpec, PhysicalSize, PieceCountKind } from '../../../model/types';
import { estimateGrid } from '../../../pipeline/grid';
import { provisionalGrid } from '../../../pipeline/gridBelief';
import { Segmented } from '../../components/Segmented';
import { parsePositive } from '../../lib/format';
import type { PuzzleDetails } from './types';

export interface DetailsForm {
  name: string;
  pieces: string;
  /** How sure the count is ('unknown': no count, the grid is estimated). */
  countKind: PieceCountKind;
  physW: string;
  physH: string;
  unit: PhysicalSize['unit'];
  gridChoice: number | 'custom';
  rows: string;
  cols: string;
  cut: CutStyle;
}

export const EMPTY_DETAILS: DetailsForm = {
  name: '',
  pieces: '',
  countKind: 'exact',
  physW: '',
  physH: '',
  unit: 'cm',
  gridChoice: 0,
  rows: '',
  cols: '',
  cut: 'grid',
};

const PRESETS = [300, 500, 1000, 1500, 2000];

/** Physical aspect (width / height) if both sizes are given. */
export function physicalAspect(f: DetailsForm): number | undefined {
  const w = parsePositive(f.physW);
  const h = parsePositive(f.physH);
  return w && h ? w / h : undefined;
}

export function gridOptions(f: DetailsForm, quadAspect: number): { candidates: GridSpec[]; grid: GridSpec | undefined; estimated: boolean } {
  const pieces = f.countKind === 'unknown' ? undefined : parsePositive(f.pieces);
  const aspect = physicalAspect(f) ?? quadAspect;
  const estimated = f.countKind === 'unknown';
  const candidates = estimated ? [provisionalGrid(aspect)] : pieces ? estimateGrid(Math.round(pieces), aspect).candidates : [];
  let grid: GridSpec | undefined;
  if (f.gridChoice === 'custom') {
    const rows = parsePositive(f.rows);
    const cols = parsePositive(f.cols);
    grid = rows && cols ? { rows: Math.round(rows), cols: Math.round(cols) } : undefined;
  } else {
    grid = candidates[f.gridChoice] ?? candidates[0];
  }
  return { candidates, grid, estimated: estimated && f.gridChoice !== 'custom' };
}

export function toDetails(f: DetailsForm, grid: GridSpec): PuzzleDetails {
  const w = parsePositive(f.physW);
  const h = parsePositive(f.physH);
  const unknown = f.countKind === 'unknown';
  return {
    name: f.name.trim() || 'Untitled puzzle',
    pieceCount: Math.round((unknown ? undefined : parsePositive(f.pieces)) ?? grid.rows * grid.cols),
    pieceCountKind: f.countKind,
    physicalSize: w && h ? { width: w, height: h, unit: f.unit } : undefined,
    grid,
    // Without a count the grid is a guess that the scans replace; a chosen grid is the user's.
    gridStatus: unknown && f.gridChoice !== 'custom' ? 'estimated' : 'unconfirmed',
    cut: f.cut,
  };
}

const COUNT_KINDS: { value: PieceCountKind; label: string }[] = [
  { value: 'exact', label: 'From the box' },
  { value: 'about', label: 'About' },
  { value: 'unknown', label: 'I don’t know' },
];

export function DetailsStep({
  form,
  onChange,
  quadAspect,
  busy,
  onNext,
}: {
  form: DetailsForm;
  onChange: (f: DetailsForm) => void;
  quadAspect: number;
  busy: boolean;
  onNext: (details: PuzzleDetails) => void;
}) {
  const [touched, setTouched] = useState(false);
  const { candidates, grid, estimated } = useMemo(() => gridOptions(form, quadAspect), [form, quadAspect]);
  const set = (patch: Partial<DetailsForm>) => onChange({ ...form, ...patch });
  const unknown = form.countKind === 'unknown';
  const pieces = unknown ? undefined : parsePositive(form.pieces);
  const piecesError = touched && !unknown && !pieces ? 'Enter the number of pieces, or choose “I don’t know”.' : undefined;
  const aspect = physicalAspect(form);

  return (
    <form
      className="stack form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if ((unknown || pieces) && grid) onNext(toDetails(form, grid));
      }}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={form.name} placeholder="e.g. The Great Wave" onChange={(e) => set({ name: e.target.value })} autoComplete="off" name="name" />
      </label>

      <div className="field">
        <label className="field-label" htmlFor="pieces">
          Number of pieces
        </label>
        <Segmented
          label="How sure is the number of pieces"
          size="sm"
          value={form.countKind}
          options={COUNT_KINDS}
          onChange={(countKind) => set({ countKind, gridChoice: form.gridChoice === 'custom' ? 'custom' : 0 })}
        />
        {!unknown && (
          <>
            <input
              id="pieces"
              name="pieces"
              type="number"
              inputMode="numeric"
              min={4}
              max={50000}
              value={form.pieces}
              placeholder={form.countKind === 'about' ? 'e.g. about 1000' : 'e.g. 1000'}
              aria-invalid={!!piecesError}
              onChange={(e) => set({ pieces: e.target.value, gridChoice: form.gridChoice === 'custom' ? 'custom' : 0 })}
            />
            <div className="chips">
              {PRESETS.map((n) => (
                <button type="button" key={n} className={`chip${pieces === n ? ' active' : ''}`} onClick={() => set({ pieces: String(n), gridChoice: form.gridChoice === 'custom' ? 'custom' : 0 })}>
                  {n}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="field-help" data-testid="count-help">
          {unknown
            ? 'No problem: your first scans measure the pieces and set the grid.'
            : form.countKind === 'about'
              ? 'A rough number is enough – your scans measure the exact grid.'
              : 'Boxes round the count (“1500” can be 45 × 34 = 1530); your scans check the grid.'}
        </span>
        {piecesError && <span className="field-error">{piecesError}</span>}
      </div>

      <fieldset className="field">
        <legend className="field-label">
          Finished size <span className="muted">(optional – from the box)</span>
        </legend>
        <div className="row gap-sm size-row">
          <input aria-label="Width" type="text" inputMode="decimal" value={form.physW} placeholder="Width" onChange={(e) => set({ physW: e.target.value, gridChoice: form.gridChoice === 'custom' ? 'custom' : 0 })} />
          <span className="muted">×</span>
          <input aria-label="Height" type="text" inputMode="decimal" value={form.physH} placeholder="Height" onChange={(e) => set({ physH: e.target.value, gridChoice: form.gridChoice === 'custom' ? 'custom' : 0 })} />
          <Segmented label="Unit" size="sm" value={form.unit} options={[{ value: 'cm', label: 'cm' }, { value: 'in', label: 'in' }]} onChange={(unit) => set({ unit })} />
        </div>
        <span className="field-help">{aspect ? 'The picture will be straightened to exactly this shape.' : 'Helps to straighten the picture and to find the grid.'}</span>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">Grid (columns × rows)</legend>
        {candidates.length === 0 && form.gridChoice !== 'custom' ? (
          <span className="field-help">Enter the number of pieces to get a suggestion, or choose “I don’t know”.</span>
        ) : (
          <div className="chips">
            {candidates.map((g, i) => (
              <button
                type="button"
                key={`${g.rows}x${g.cols}`}
                className={`chip grid-chip${form.gridChoice === i ? ' active' : ''}`}
                onClick={() => set({ gridChoice: i })}
                aria-pressed={form.gridChoice === i}
              >
                <span>
                  {g.cols} × {g.rows}
                </span>
                <span className="chip-sub">{unknown ? 'estimated' : i === 0 ? 'best fit' : `${g.cols * g.rows} pcs`}</span>
              </button>
            ))}
            <button type="button" className={`chip${form.gridChoice === 'custom' ? ' active' : ''}`} onClick={() => set({ gridChoice: 'custom', cols: form.cols || String(grid?.cols ?? ''), rows: form.rows || String(grid?.rows ?? '') })}>
              Custom
            </button>
          </div>
        )}
        {form.gridChoice === 'custom' && (
          <div className="row gap-sm size-row">
            <input aria-label="Columns" type="number" inputMode="numeric" min={1} value={form.cols} placeholder="Columns" onChange={(e) => set({ cols: e.target.value })} />
            <span className="muted">×</span>
            <input aria-label="Rows" type="number" inputMode="numeric" min={1} value={form.rows} placeholder="Rows" onChange={(e) => set({ rows: e.target.value })} />
          </div>
        )}
        {grid && estimated ? (
          <span className="field-help grid-estimated" data-testid="grid-estimated">
            Estimated – will be measured from your first scans.
          </span>
        ) : grid ? (
          <span className="field-help">
            {grid.cols} pieces across, {grid.rows} down = {grid.cols * grid.rows} pieces.
          </span>
        ) : null}
      </fieldset>

      <div className="field">
        <span className="field-label">Cut style</span>
        <Segmented
          label="Cut style"
          value={form.cut}
          options={[
            { value: 'grid', label: 'Classic grid' },
            { value: 'irregular', label: 'Irregular' },
          ]}
          onChange={(cut) => set({ cut })}
        />
        <span className="field-help">{form.cut === 'grid' ? 'Rows and columns of similar pieces – most puzzles.' : 'Random or whimsy shapes; locations are less precise.'}</span>
      </div>

      <div className="wizard-actions">
        <button type="submit" className="btn btn-primary btn-lg grow" disabled={busy}>
          {busy ? 'Straightening the picture…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
