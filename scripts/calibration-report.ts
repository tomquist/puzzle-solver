/**
 * Calibration report over the pairs the last `npm run bench` saved (bench/calibration.ts): scan,
 * private and Puzzle-Map single pieces, per source and pooled, with the reliability bins.
 *
 *   npm run bench && npm run bench:calibration
 */
import { calibrationReport, loadCalibrationPairs } from '../bench/calibration';

const pairs = loadCalibrationPairs();
if (Object.keys(pairs).length === 0) {
  console.log('No calibration pairs: run `npm run bench` first.');
} else {
  console.log(calibrationReport(pairs));
}
