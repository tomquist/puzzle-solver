import { defineConfig } from 'vitest/config';

/** One id per benchmark run: the placed-cell bench's shard files meet under it (bench/placedSuite.ts). */
process.env.BENCH_RUN_ID ??= `${Date.now()}`;

/** Accuracy benchmark (see docs/TESTING.md). Run with `npm run bench`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/**/*.eval.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Scenarios are CPU-bound; run the suites in parallel processes, scenarios sequentially.
    pool: 'forks',
  },
});
