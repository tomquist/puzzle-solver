import { afterEach } from 'vitest';

// Vitest runs a file's tests back to back on microtasks. Long CV files (segment.test.ts runs for
// about a minute) then starve the worker's RPC channel and the run fails with "Timeout calling
// onTaskUpdate" although every test passed. A macrotask between tests lets the messages through.
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
