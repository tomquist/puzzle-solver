/**
 * App preferences remembered on this device (localStorage, every access wrapped – storage can be
 * unavailable in private modes). Pure apart from the storage passed in.
 */
export interface ViewOptions {
  /** Small "up" notch on the number badges. */
  turnHints: boolean;
  /** Thin lines between pieces that end up next to each other. */
  connections: boolean;
  /** Show pieces whose place is uncertain. */
  unsure: boolean;
  /** Only edge and corner pieces. */
  edgesOnly: boolean;
}

export interface AppPrefs {
  view: ViewOptions;
  /** Keep the screen on while results / placing are shown. */
  keepScreenOn: boolean;
  /** One-time hints the user dismissed. */
  dismissed: string[];
}

export const DEFAULT_PREFS: AppPrefs = {
  view: { turnHints: true, connections: true, unsure: true, edgesOnly: false },
  keepScreenOn: true,
  dismissed: [],
};

export const PREFS_KEY = 'puzzle-solver:prefs';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Parse stored prefs, falling back to defaults field by field. */
export function parsePrefs(raw: string | null | undefined): AppPrefs {
  if (!raw) return structuredCloneSafe(DEFAULT_PREFS);
  try {
    const p = JSON.parse(raw) as Omit<Partial<AppPrefs>, 'view'> & { view?: Partial<ViewOptions> };
    const v: Partial<ViewOptions> = p.view ?? {};
    const d = DEFAULT_PREFS.view;
    return {
      view: {
        turnHints: bool(v.turnHints, d.turnHints),
        connections: bool(v.connections, d.connections),
        unsure: bool(v.unsure, d.unsure),
        edgesOnly: bool(v.edgesOnly, d.edgesOnly),
      },
      keepScreenOn: bool(p.keepScreenOn, DEFAULT_PREFS.keepScreenOn),
      dismissed: Array.isArray(p.dismissed) ? p.dismissed.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return structuredCloneSafe(DEFAULT_PREFS);
  }
}

function structuredCloneSafe(p: AppPrefs): AppPrefs {
  return { view: { ...p.view }, keepScreenOn: p.keepScreenOn, dismissed: [...p.dismissed] };
}

export function loadPrefs(storage: StorageLike | undefined): AppPrefs {
  try {
    return parsePrefs(storage?.getItem(PREFS_KEY));
  } catch {
    return structuredCloneSafe(DEFAULT_PREFS);
  }
}

export function savePrefs(storage: StorageLike | undefined, prefs: AppPrefs): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked – the preference just isn't remembered.
  }
}
