/**
 * Calibration report (report only): how well the placements' confidences say how often they are
 * right. The scan, private and Puzzle-Map benchmarks save one (confidence, right cell, right turn)
 * pair per single piece to .debug/bench/calibration/<suite>.json; `npm run bench:calibration`
 * pools them (scripts/calibration-report.ts) after `npm run bench`.
 *   bins                 reliability: per confidence tenth, count, mean confidence and share right
 *   brier                mean squared difference of confidence and right cell (0 = perfect)
 *   ece                  expected calibration error: count-weighted |confidence − share right| over the bins
 *   unsureAccuracy       'ambiguous' placements whose best cell is right…
 *   unsureTop3           …and whose right cell is among the best three
 *   confidentPrecision   'confident' placements whose cell is right
 *   confidentTurnRate    of those, turned right (within 10°)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../src/testing/nodeImageIO';
import type { CalibrationPair } from './lib';

const DIR = resolve(REPO_ROOT, '.debug/bench/calibration');
const BINS = 10;

/** Save a suite's pairs (replacing what an earlier run saved for it). */
export function saveCalibrationPairs(suite: string, pairs: readonly CalibrationPair[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(resolve(DIR, `${suite}.json`), JSON.stringify(pairs));
}

/** Every suite's saved pairs. */
export function loadCalibrationPairs(): Record<string, CalibrationPair[]> {
  if (!existsSync(DIR)) return {};
  const out: Record<string, CalibrationPair[]> = {};
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(resolve(DIR, f), 'utf8'));
  return out;
}

export interface CalibrationSummary {
  n: number;
  brier: number;
  ece: number;
  confident: number;
  confidentPrecision: number;
  confidentTurnRate: number;
  unsure: number;
  unsureAccuracy: number;
  unsureTop3: number;
  bins: { lo: number; hi: number; n: number; meanConfidence: number; accuracy: number }[];
}

export function summarizeCalibration(pairs: readonly CalibrationPair[]): CalibrationSummary {
  const rate = (xs: readonly CalibrationPair[], f: (p: CalibrationPair) => boolean) => (xs.length === 0 ? NaN : xs.filter(f).length / xs.length);
  const bins: CalibrationSummary['bins'] = [];
  let ece = 0;
  for (let b = 0; b < BINS; b++) {
    const lo = b / BINS, hi = (b + 1) / BINS;
    const xs = pairs.filter((p) => p.confidence >= lo && (p.confidence < hi || (b === BINS - 1 && p.confidence <= hi)));
    const meanConfidence = xs.length === 0 ? NaN : xs.reduce((a, p) => a + p.confidence, 0) / xs.length;
    const accuracy = rate(xs, (p) => p.cell);
    if (xs.length > 0) ece += (xs.length / pairs.length) * Math.abs(meanConfidence - accuracy);
    bins.push({ lo, hi, n: xs.length, meanConfidence, accuracy });
  }
  const confident = pairs.filter((p) => p.status === 'confident');
  const unsure = pairs.filter((p) => p.status === 'ambiguous');
  const rightConfident = confident.filter((p) => p.cell);
  return {
    n: pairs.length,
    brier: pairs.length === 0 ? NaN : pairs.reduce((a, p) => a + (p.confidence - (p.cell ? 1 : 0)) ** 2, 0) / pairs.length,
    ece,
    confident: confident.length,
    confidentPrecision: rate(confident, (p) => p.cell),
    confidentTurnRate: rate(rightConfident, (p) => p.turn),
    unsure: unsure.length,
    unsureAccuracy: rate(unsure, (p) => p.cell),
    unsureTop3: rate(unsure, (p) => p.top3),
    bins,
  };
}

const f3 = (v: number) => (Number.isNaN(v) ? '' : v.toFixed(3));

/** Markdown tables: one summary row per source (and all pooled), then the pooled reliability bins. */
export function calibrationReport(bySuite: Record<string, CalibrationPair[]>): string {
  const rows = Object.entries(bySuite).filter(([, p]) => p.length > 0);
  const all = rows.flatMap(([, p]) => p);
  const lines = [
    '| calibration | n | brier | ece | confident | confidentPrecision | confidentTurnRate | unsure | unsureAccuracy | unsureTop3 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [name, pairs] of [...rows, ['all', all] as [string, CalibrationPair[]]]) {
    const s = summarizeCalibration(pairs);
    lines.push(`| ${name} | ${s.n} | ${f3(s.brier)} | ${f3(s.ece)} | ${s.confident} | ${f3(s.confidentPrecision)} | ${f3(s.confidentTurnRate)} | ${s.unsure} | ${f3(s.unsureAccuracy)} | ${f3(s.unsureTop3)} |`);
  }
  const s = summarizeCalibration(all);
  lines.push('', '| confidence (all) | n | mean confidence | share right |', '|---|---:|---:|---:|');
  for (const b of s.bins) lines.push(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${f3(b.meanConfidence)} | ${f3(b.accuracy)} |`);
  // Unsure placements by the reason given for them.
  const unsure = all.filter((p) => p.status === 'ambiguous');
  const reasons = [...new Set(unsure.map((p) => p.reason ?? '(none)'))].sort();
  lines.push('', '| unsure reason (all) | n | share right | right in top 3 |', '|---|---:|---:|---:|');
  for (const r of reasons) {
    const xs = unsure.filter((p) => (p.reason ?? '(none)') === r);
    lines.push(`| ${r} | ${xs.length} | ${f3(xs.filter((p) => p.cell).length / xs.length)} | ${f3(xs.filter((p) => p.top3).length / xs.length)} |`);
  }
  return lines.join('\n');
}
