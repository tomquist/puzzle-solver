import { STATUS_LABEL, type DisplayStatus } from '../../lib/pieces';

const ORDER: DisplayStatus[] = ['confident', 'ambiguous', 'unmatched', 'patch'];

export function Legend({ counts }: { counts?: Partial<Record<DisplayStatus, number>> }) {
  return (
    <ul className="legend" aria-label="Colour key">
      {ORDER.map((s) => (
        <li key={s}>
          <span className={`swatch st-${s}`} />
          {STATUS_LABEL[s]}
          {counts?.[s] !== undefined && <span className="muted tabular"> {counts[s]}</span>}
        </li>
      ))}
    </ul>
  );
}
