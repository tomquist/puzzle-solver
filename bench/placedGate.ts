/**
 * The placed-cell bench's report and gate over the records of all its shards (bench/placedSuite.ts):
 * run by the last shard to finish, or by scripts/bench-placed-gate.ts when the shards ran elsewhere
 * (CI). No vitest here, so the script can run it.
 */
import { average, report, type MetricRecord } from './lib';
import { PLACED_PRECISION_TOLERANCE, PLACED_TOLERANCE } from './placed';
import { readShardRecords } from './shards';

/** Shards of the scan scenes (one bench file each: bench/placed.eval.ts, placed-2, placed-3). */
export const PLACED_SHARDS = 3;
export const PLACED_SUITE = 'placed';

const COLUMNS = ['top1', 'top3', 'rotationOk', 'confidentPrecision', 'confidentTurnPrecision', 'confidentShare', 'confidentWrong', 'markedTop1', 'marked', 'conflicts', 'gaps', 'gapTop1', 'gapTop1None', 'gapTop3', 'gapTop3None', 'marks', 'wrong'];
/** Metrics gated against the no-marks run. */
const GATED = ['top1', 'top3', 'confidentPrecision'];

/** One shard's records: per setting, one record per scene (JSON: NaN as null). */
export type PlacedShardRecords = Record<string, Record<string, number | null>[]>;

/** Per setting: every shard's scene records, in shard order (null while a shard's records are missing). */
export function mergedPlacedRecords(runId?: string): Map<string, MetricRecord[]> | null {
  const shards = readShardRecords<PlacedShardRecords>(PLACED_SUITE, PLACED_SHARDS, runId);
  if (!shards) return null;
  const all = new Map<string, MetricRecord[]>();
  for (const recs of shards) {
    for (const [name, list] of Object.entries(recs)) all.set(name, [...(all.get(name) ?? []), ...list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? NaN])))]);
  }
  return all;
}

/**
 * Report the settings (table printed and written to .debug/bench/placed.{md,json}) and gate them:
 * with marks (wrong ones included) top1 and top3 at least the no-marks result minus
 * PLACED_TOLERANCE, confidentPrecision at least it minus PLACED_PRECISION_TOLERANCE, on the
 * averages over all scenes. Returns the table and the gate's problems (empty = pass).
 */
export function gatePlaced(all: Map<string, MetricRecord[]>): { table: string; problems: string[] } {
  const results = summary(all);
  const table = report(PLACED_SUITE, results, COLUMNS);
  const none = results.none;
  const problems: string[] = [];
  for (const [name, rec] of Object.entries(results)) {
    if (name === 'none') continue;
    for (const k of GATED) {
      const tol = k === 'confidentPrecision' ? PLACED_PRECISION_TOLERANCE : PLACED_TOLERANCE;
      if (rec[k] < none[k] - tol - 1e-9) problems.push(`${name}.${k}: ${rec[k].toFixed(3)} < none ${none[k].toFixed(3)} - ${tol}`);
    }
  }
  return { table, problems };
}

/** Per setting: metrics averaged over the scenes (markedTop1 and the gap rates over the scenes' such pieces; counts summed). */
function summary(perSetting: Map<string, MetricRecord[]>): Record<string, MetricRecord> {
  const out: Record<string, MetricRecord> = {};
  for (const [name, recs] of perSetting) {
    if (recs.length === 0) continue;
    const avg = average(recs);
    const withMarked = recs.filter((r) => r.marked > 0);
    avg.markedTop1 = withMarked.length > 0 ? withMarked.reduce((a, r) => a + r.markedTop1 * r.marked, 0) / withMarked.reduce((a, r) => a + r.marked, 0) : NaN;
    avg.marked = recs.reduce((a, r) => a + r.marked, 0);
    avg.conflicts = recs.reduce((a, r) => a + r.conflicts, 0);
    avg.confidentWrong = recs.reduce((a, r) => a + r.confidentWrong, 0);
    const sum = (k: string) => recs.reduce((a, r) => a + r[k], 0);
    avg.gaps = sum('gaps');
    for (const k of ['gapTop1', 'gapTop3', 'gapTop1None', 'gapTop3None']) avg[k] = avg.gaps > 0 ? sum(k) / avg.gaps : NaN;
    out[name] = avg;
  }
  return out;
}
