/**
 * Report and gate the placed-cell bench over the records its shards left in
 * .debug/bench/placed-shards/ (bench/placedGate.ts), for shards that ran apart: in CI each shard
 * is a job of its own and this runs once their records are downloaded; locally after running the
 * shard files separately. `npm run bench` needs none of this (its last shard gates).
 *
 *   npm run bench:placed-gate             # the run BENCH_RUN_ID names, else the newest complete one
 *
 * Exits 1 when a shard's records are missing or the gate fails.
 */
import { gatePlaced, mergedPlacedRecords, PLACED_SHARDS, PLACED_SUITE } from '../bench/placedGate';
import { completeShardRuns, shardDir } from '../bench/shards';

const runId = process.env.BENCH_RUN_ID ?? completeShardRuns(PLACED_SUITE, PLACED_SHARDS)[0];
const all = runId === undefined ? null : mergedPlacedRecords(runId);
if (!all) {
  console.error(`placed gate: no complete set of ${PLACED_SHARDS} shard records${runId === undefined ? '' : ` for run ${runId}`} in ${shardDir(PLACED_SUITE)}`);
  process.exit(1);
}
const { table, problems } = gatePlaced(all);
console.log(`placed gate: run ${runId}\n\n${table}\n`);
if (problems.length > 0) {
  console.error(`placed gate failed:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('placed gate: passed');
