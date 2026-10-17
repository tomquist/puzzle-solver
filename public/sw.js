/*
 * Puzzle Solver service worker – makes the app work offline after the first visit.
 *
 * - Registered by the app (production builds only) as `sw.js?v=<build id>`; every build therefore
 *   installs a new worker with its own cache, and older caches are deleted on activation.
 * - Navigations / index.html: network-first (so a new deployment is picked up right away), falling
 *   back to the cached app shell when offline or when the network is too slow.
 * - Hashed build assets (assets/…): cache-first – their names change whenever their content does.
 * - Other same-scope files (manifest, icons): network-first with cache fallback.
 * Everything is relative to the registration scope, so the app works under a GitHub Pages sub-path.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'v0';
const PREFIX = 'puzzle-solver-';
const CACHE = PREFIX + VERSION;
const SCOPE = self.registration.scope;
const SHELL = SCOPE; // cache key of index.html
const NAV_TIMEOUT_MS = 4000;
const STATIC = ['manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

function inScope(url) {
  return url.origin === self.location.origin && url.href.startsWith(SCOPE);
}

async function cacheUrls(cache, urls) {
  await Promise.all(
    urls.map(async (u) => {
      try {
        const url = new URL(u, SCOPE);
        if (!inScope(url) || url.pathname.endsWith('/sw.js')) return;
        url.hash = '';
        if (await cache.match(url.href)) return;
        const res = await fetch(url.href, { cache: 'no-cache' });
        if (res.ok) await cache.put(url.href, res);
      } catch {
        // Best effort.
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(SHELL, { cache: 'no-cache' });
        if (res.ok) {
          const html = await res.clone().text();
          await cache.put(SHELL, res);
          const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
          await cacheUrls(cache, [...STATIC, ...refs]);
        }
      } catch {
        // Offline during install: runtime caching will fill the cache later.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

// The page reports the resources it already loaded (e.g. the pipeline worker) so they are
// available offline even though they were fetched before this worker took control.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'cache-urls' && Array.isArray(data.urls)) {
    event.waitUntil(caches.open(CACHE).then((cache) => cacheUrls(cache, data.urls)));
  }
});

async function networkFirst(request, key, timeoutMs) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const cachedLater = (ms) =>
    new Promise((resolve) => setTimeout(() => cache.match(key, { ignoreSearch: true }).then(resolve), ms));
  try {
    const res = await (timeoutMs ? Promise.race([network, cachedLater(timeoutMs).then((r) => r || network)]) : network);
    if (res) return res;
  } catch {
    // Offline – fall through.
  }
  const hit = await cache.match(key, { ignoreSearch: true });
  return hit || Response.error();
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!inScope(url) || url.pathname.endsWith('/sw.js')) return;
  const isShell = request.mode === 'navigate' || url.href.split(/[?#]/)[0] === SHELL || url.pathname.endsWith('/index.html');
  if (isShell) {
    event.respondWith(networkFirst(request, SHELL, NAV_TIMEOUT_MS));
  } else if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request, url.href.split('#')[0], 0));
  }
});
