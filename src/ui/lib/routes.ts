/**
 * Hash routes (GitHub Pages friendly):
 *   #/                         home
 *   #/new                      new-puzzle wizard
 *   #/puzzle/:id               workspace (scan tab)
 *   #/puzzle/:id/:tab          workspace tab (scan | picture | history | settings)
 *   #/puzzle/:id/scan/:scanId  scan result
 *   #/puzzle/:id/scan/:scanId/place  guided placing mode for a scan
 */

export const PUZZLE_TABS = ['scan', 'picture', 'history', 'settings'] as const;
export type PuzzleTab = (typeof PUZZLE_TABS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'puzzle'; id: string; tab: PuzzleTab }
  | { name: 'scan'; id: string; scanId: string }
  | { name: 'place'; id: string; scanId: string }
  | { name: 'notFound'; path: string };

function isTab(s: string): s is PuzzleTab {
  return (PUZZLE_TABS as readonly string[]).includes(s);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse `location.hash` (with or without the leading '#'). */
export function parseRoute(hash: string): Route {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  const parts = path.split('/').filter(Boolean).map(decode);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'new' && parts.length === 1) return { name: 'new' };
  if (parts[0] === 'puzzle' && parts[1]) {
    const id = parts[1];
    if (parts.length === 2) return { name: 'puzzle', id, tab: 'scan' };
    if (parts.length === 3 && isTab(parts[2])) return { name: 'puzzle', id, tab: parts[2] };
    if (parts.length === 4 && parts[2] === 'scan' && parts[3]) return { name: 'scan', id, scanId: parts[3] };
    if (parts.length === 5 && parts[2] === 'scan' && parts[3] && parts[4] === 'place') return { name: 'place', id, scanId: parts[3] };
  }
  return { name: 'notFound', path: '/' + parts.join('/') };
}

/** The hash (including '#') for a route. */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'new':
      return '#/new';
    case 'puzzle':
      return `#/puzzle/${encodeURIComponent(route.id)}${route.tab === 'scan' ? '' : `/${route.tab}`}`;
    case 'scan':
      return `#/puzzle/${encodeURIComponent(route.id)}/scan/${encodeURIComponent(route.scanId)}`;
    case 'place':
      return `#/puzzle/${encodeURIComponent(route.id)}/scan/${encodeURIComponent(route.scanId)}/place`;
    case 'notFound':
      return `#${route.path}`;
  }
}

export const href = {
  home: () => routeToHash({ name: 'home' }),
  newPuzzle: () => routeToHash({ name: 'new' }),
  puzzle: (id: string, tab: PuzzleTab = 'scan') => routeToHash({ name: 'puzzle', id, tab }),
  scan: (id: string, scanId: string) => routeToHash({ name: 'scan', id, scanId }),
  place: (id: string, scanId: string) => routeToHash({ name: 'place', id, scanId }),
};

/** Puzzle id of routes that live inside a puzzle (workspace and scan results). */
export function routePuzzleId(route: Route): string | undefined {
  return route.name === 'puzzle' || route.name === 'scan' || route.name === 'place' ? route.id : undefined;
}
