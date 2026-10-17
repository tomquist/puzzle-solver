/** Build identifier of the running app (git commit), "dev" outside Vite builds (e.g. Node tests). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
