/** Step 3: name, piece count, physical size, grid and cut style. */
import { useMemo, useState } from 'react';
import type { CutStyle, GridSpec, PhysicalSize } from '../../../model/types';
import { estimateGrid } from '../../../pipeline/grid';
import { Segmented } from '../../components/Segmented';
import { parsePositive } from '../../lib/format';
import type { PuzzleDetails } from './types';

export interface DetailsForm {
  name: string;
  pieces: string;
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

export function gridOptions(f: DetailsForm, quadAspect: number): { candidates: GridSpec[]; grid: GridSpec | undefined } {
  const pieces = parsePositive(f.pieces);
  const aspect = physicalAspect(f) ?? quadAspect;
  const candidates = pieces ? estimateGrid(Math.round(pieces), aspect).candidates : [];
  let grid: GridSpec | undefined;
  if (f.gridChoice === 'custom') {
    const rows = parsePositive(f.rows);
    const cols = parsePositive(f.cols);
    grid = rows && cols ? { rows: Math.round(rows), cols: Math.round(cols) } : undefined;
  } else {
    grid = candidates[f.gridChoice] ?? candidates[0];
  }
  return { candidates, grid };
}

export function toDetails(f: DetailsForm, grid: GridSpec): PuzzleDetails {
  const w = parsePositive(f.physW);
  const h = parsePositive(f.physH);
  return {
    name: f.name.trim() || 'Untitled puzzle',
    pieceCount: Math.round(parsePositive(f.pieces) ?? grid.rows * grid.cols),
    physicalSize: w && h ? { width: w, height: h, unit: f.unit } : undefined,
    grid,
    cut: f.cut,
  };
}

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
  const { candidates, grid } = useMemo(() => gridOptions(form, quadAspect), [form, quadAspect]);
  const set = (patch: Partial<DetailsForm>) => onChange({ ...form, ...patch });
  const pieces = parsePositive(form.pieces);
  const piecesError = touched && !pieces ? 'Enter the number of pieces from the box.' : undefined;
  const aspect = physicalAspect(form);

  return (
    <form
      className="stack form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (pieces && grid) onNext(toDetails(form, grid));
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
        <input
          id="pieces"
          name="pieces"
          type="number"
          inputMode="numeric"
          min={4}
          max={50000}
          value={form.pieces}
          placeholder="e.g. 1000"
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
          <span className="field-help">Enter the number of pieces to get a suggestion.</span>
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
                <span className="chip-sub">{i === 0 ? 'best fit' : `${g.cols * g.rows} pcs`}</span>
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
        {grid && (
          <span className="field-help">
            {grid.cols} pieces across, {grid.rows} down = {grid.cols * grid.rows} pieces.
          </span>
        )}
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
