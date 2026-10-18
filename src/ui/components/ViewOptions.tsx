/** "View" button with a small popover of display toggles (remembered on this device). */
import { useEffect, useRef, useState } from 'react';
import { usePrefs } from '../hooks/usePrefs';
import type { ViewOptions as Options } from '../lib/prefs';
import { IconSettings } from './Icons';

const TOGGLES: { key: keyof Options; label: string; hint: string }[] = [
  { key: 'labels', label: 'Labels', hint: 'Numbers and outlines on the photo. Hold the photo to peek without them.' },
  { key: 'turnHints', label: 'Top marks', hint: 'A short pink bar on the edge of each piece that goes on top' },
  { key: 'connections', label: 'Connections', hint: 'Lines between pieces that go together' },
  { key: 'unsure', label: 'Unsure pieces', hint: 'Show pieces whose place is uncertain' },
  { key: 'edgesOnly', label: 'Edge pieces only', hint: 'Hide interior pieces' },
];

export function ViewOptionsButton() {
  const [prefs, update] = usePrefs();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // handled: Esc closes only this popover
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const changed = TOGGLES.filter((t) => prefs.view[t.key] !== (t.key === 'edgesOnly' ? false : true)).length;
  return (
    <div className="popover-anchor" ref={box}>
      <button className="btn btn-sm" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)} data-testid="view-options">
        <IconSettings size={16} />
        View
        {changed > 0 && <span className="dot-count">{changed}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-modal="false" aria-label="View options">
          {TOGGLES.map((t) => (
            <label key={t.key} className="switch toggle-row">
              <span className="toggle-text">
                <span>{t.label}</span>
                <span className="muted xsmall">{t.hint}</span>
              </span>
              <input
                type="checkbox"
                checked={prefs.view[t.key]}
                onChange={(e) => {
                  const v = e.target.checked;
                  update((p) => ({ ...p, view: { ...p.view, [t.key]: v } }));
                }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
