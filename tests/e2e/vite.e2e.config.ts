/**
 * Dev-server config for e2e tests: the project config without a file watcher, so edits made while
 * the tests run (other work in the same checkout) can't hot-reload a page mid-test. Dependencies
 * (including the pipeline worker's) are pre-bundled up front so Vite never needs to re-optimise and
 * reload pages during a run.
 */
import { mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(base, {
  server: { watch: null },
  optimizeDeps: {
    entries: ['index.html', 'src/worker/pipeline.worker.ts'],
    include: ['comlink', 'idb', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
});
