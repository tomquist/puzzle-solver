/**
 * Service worker registration (production builds only). The worker lives next to index.html
 * (public/sw.js) and is registered with a relative URL so the app works under any sub-path, e.g.
 * GitHub Pages' /<repo>/. The build id (hashed entry file name) versions its cache.
 */
export function registerServiceWorker(buildId: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      .register(`./sw.js?v=${encodeURIComponent(buildId)}`, { scope: './' })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Hand over everything this page already fetched (incl. the pipeline worker script).
        const urls = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin));
        reg.active?.postMessage({ type: 'cache-urls', urls });
      })
      .catch((e: unknown) => console.warn('Service worker registration failed', e));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
