/** Brute-force Hamming matching of 256-bit binary descriptors with ratio test and cross-check. */
import { DESCRIPTOR_BYTES } from './orb';

export interface FeatureMatch {
  /** Index into the first (query) descriptor set. */
  queryIdx: number;
  /** Index into the second (train) descriptor set. */
  trainIdx: number;
  /** Hamming distance in bits (0..256). */
  distance: number;
}

export interface MatchOptions {
  /** Lowe ratio: best distance must be < ratio * second-best distance (default 0.8; >= 1 disables). */
  ratio?: number;
  /** Keep only mutual nearest neighbours (default true). */
  crossCheck?: boolean;
  /** Reject matches with a larger Hamming distance (default 80). */
  maxDistance?: number;
}

const WORDS = DESCRIPTOR_BYTES / 4;

/** View descriptors as 32-bit words (copies when the byte offset is unaligned). */
function asWords(d: Uint8Array): Uint32Array {
  if (d.length % DESCRIPTOR_BYTES !== 0) throw new Error(`descriptors: length must be a multiple of ${DESCRIPTOR_BYTES}`);
  if (d.byteOffset % 4 === 0) return new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
  return new Uint32Array(new Uint8Array(d).buffer);
}

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** Hamming distance between descriptor `i` of `a` and descriptor `j` of `b`. */
export function hammingDistance(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  let d = 0;
  for (let k = 0; k < DESCRIPTOR_BYTES; k++) {
    let v = a[i * DESCRIPTOR_BYTES + k] ^ b[j * DESCRIPTOR_BYTES + k];
    v = v - ((v >>> 1) & 0x55);
    v = (v & 0x33) + ((v >>> 2) & 0x33);
    d += (v + (v >>> 4)) & 0x0f;
  }
  return d;
}

/**
 * Match every descriptor of `a` (query) to its nearest neighbour in `b` (train). Both arrays hold
 * 32 bytes per descriptor. A match is kept when it passes the ratio test, the distance limit and,
 * if enabled, the cross-check (the query is also the train descriptor's nearest neighbour).
 * Result is ordered by query index.
 */
export function matchFeatures(a: Uint8Array, b: Uint8Array, opts: MatchOptions = {}): FeatureMatch[] {
  const ratio = opts.ratio ?? 0.8;
  const crossCheck = opts.crossCheck ?? true;
  const maxDistance = opts.maxDistance ?? 80;
  const A = asWords(a), B = asWords(b);
  const n = A.length / WORDS, m = B.length / WORDS;
  if (n === 0 || m === 0) return [];
  const bestJ = new Int32Array(n);
  const bestD = new Int32Array(n);
  const secondD = new Int32Array(n);
  const revD = new Int32Array(m).fill(1 << 30);
  const revI = new Int32Array(m).fill(-1);
  for (let i = 0; i < n; i++) {
    const o = i * WORDS;
    const a0 = A[o], a1 = A[o + 1], a2 = A[o + 2], a3 = A[o + 3];
    const a4 = A[o + 4], a5 = A[o + 5], a6 = A[o + 6], a7 = A[o + 7];
    let d1 = 1 << 30, d2 = 1 << 30, j1 = -1;
    for (let j = 0, q = 0; j < m; j++, q += WORDS) {
      const d =
        popcount32(a0 ^ B[q]) + popcount32(a1 ^ B[q + 1]) + popcount32(a2 ^ B[q + 2]) + popcount32(a3 ^ B[q + 3]) +
        popcount32(a4 ^ B[q + 4]) + popcount32(a5 ^ B[q + 5]) + popcount32(a6 ^ B[q + 6]) + popcount32(a7 ^ B[q + 7]);
      if (d < d1) { d2 = d1; d1 = d; j1 = j; }
      else if (d < d2) d2 = d;
      if (d < revD[j]) { revD[j] = d; revI[j] = i; }
    }
    bestJ[i] = j1;
    bestD[i] = d1;
    secondD[i] = d2;
  }
  const out: FeatureMatch[] = [];
  for (let i = 0; i < n; i++) {
    const j = bestJ[i], d = bestD[i];
    if (d > maxDistance) continue;
    if (ratio < 1 && m > 1 && !(d < ratio * secondD[i])) continue;
    if (crossCheck && revI[j] !== i) continue;
    out.push({ queryIdx: i, trainIdx: j, distance: d });
  }
  return out;
}
