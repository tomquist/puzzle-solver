import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/** One id per benchmark run: the sharded benches' files meet under it (bench/shards.ts; CI sets it per workflow run). */
process.env.BENCH_RUN_ID ??= `${Date.now()}`;

/** Accuracy benchmark (see docs/TESTING.md). Run with `npm run bench`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/**/*.eval.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Scenarios are CPU-bound; run the suites in parallel processes, scenarios sequentially – one
    // process per core (vitest's default leaves one core to itself, which idles here).
    pool: 'forks',
    maxWorkers: availableParallelism(),
  },
});
