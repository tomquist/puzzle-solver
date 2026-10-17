const ENTRIES = [
  { tone: 'confident', label: 'Sure place' },
  { tone: 'ambiguous', label: 'Unsure' },
  { tone: 'patch', label: 'Assembled grid' },
] as const;

/** Colour key for the result overlays. */
export function Legend() {
  return (
    <ul className="legend" aria-label="Colour key">
      {ENTRIES.map((e) => (
        <li key={e.tone}>
          <span className={`swatch st-${e.tone}`} />
          {e.label}
        </li>
      ))}
    </ul>
  );
}
