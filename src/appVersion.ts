/** Build identifier of the running app (git commit), "dev" outside Vite builds (e.g. Node tests). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** When the running app was built (ISO 8601), undefined outside Vite builds. */
export const BUILD_TIME: string | undefined = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : undefined;

/** "Version 323c025 · built 21 Oct 2026, 08:42" in the user's locale ("Version dev" outside builds). */
export function versionLabel(locale?: string): string {
  const built = BUILD_TIME ? new Date(BUILD_TIME) : undefined;
  if (!built || Number.isNaN(built.getTime())) return `Version ${APP_VERSION}`;
  return `Version ${APP_VERSION} · built ${built.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`;
}
