import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from './platform/pwa';
import { App } from './ui/App';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD) {
  // The hashed entry file name changes with every build and versions the offline cache.
  registerServiceWorker(new URL(import.meta.url).pathname.split('/').pop() || 'app');
}
