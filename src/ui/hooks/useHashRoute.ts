import { useEffect, useState } from 'react';
import { parseRoute, type Route } from '../lib/routes';

function current(): Route {
  return parseRoute(typeof location === 'undefined' ? '' : location.hash);
}

/** The current hash route; re-renders on navigation. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const onChange = () => setRoute(current());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** Navigate to a hash (e.g. href.puzzle(id)). `replace` avoids a history entry. */
export function navigate(hash: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (location.hash !== hash) {
    location.hash = hash;
  }
  window.scrollTo({ top: 0 });
}
