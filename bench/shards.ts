/**
 * Records of benchmark suites split over several files ("shards") that run in parallel: each shard
 * writes its records to .debug/bench/<suite>-shards/<run id>-<shard>.json, and whoever finds all
 * shards of a run there merges them – the last shard to finish when they run together
 * (`npm run bench`), or a separate step once the shards ran elsewhere (CI: one job per shard, the
 * records passed on as artifacts; see scripts/bench-placed-gate.ts).
 *
 * The run id is BENCH_RUN_ID (set once per `npm run bench` in vitest.bench.config.ts; CI sets it
 * to the workflow run).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../src/testing/nodeImageIO';

/** This run's id (see the module documentation). */
export const BENCH_RUN_ID = process.env.BENCH_RUN_ID ?? `pid${process.ppid}`;

export function shardDir(suite: string): string {
  return resolve(REPO_ROOT, `.debug/bench/${suite}-shards`);
}

const shardFile = (suite: string, runId: string, shard: number) => resolve(shardDir(suite), `${runId}-${shard}.json`);

/** Write this shard's records (atomically: readers never see half a file). */
export function writeShardRecords(suite: string, shard: number, data: unknown, runId = BENCH_RUN_ID): void {
  mkdirSync(shardDir(suite), { recursive: true });
  const file = shardFile(suite, runId, shard);
  writeFileSync(`${file}.tmp`, JSON.stringify(data));
  renameSync(`${file}.tmp`, file);
}

/** Every shard's records of the run, in shard order, or null while some are missing. */
export function readShardRecords<T>(suite: string, shards: number, runId = BENCH_RUN_ID): T[] | null {
  const files = Array.from({ length: shards }, (_, k) => shardFile(suite, runId, k));
  if (!files.every(existsSync)) return null;
  return files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as T);
}

/** Run ids with records of every shard in .debug/bench/<suite>-shards/, highest (newest) first. */
export function completeShardRuns(suite: string, shards: number): string[] {
  const dir = shardDir(suite);
  if (!existsSync(dir)) return [];
  const runs = new Set<string>();
  for (const f of readdirSync(dir)) {
    const m = /^(.*)-(\d+)\.json$/.exec(f);
    if (m) runs.add(m[1]);
  }
  return [...runs].filter((r) => readShardRecords(suite, shards, r) !== null).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
