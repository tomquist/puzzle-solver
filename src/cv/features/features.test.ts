import { describe, expect, it } from 'vitest';
import { rgbaToGray } from '../color';
import { applyMat3, similarityAbout, type Mat3, type Point } from '../geometry';
import { createGray, createRGBA, type GrayImage } from '../image';
import { drawLine } from '../raster';
import { resizeRGBA } from '../resize';
import { warpRGBA } from '../warp';
import { DEBUG_IMAGES, loadTestAsset, savePng } from '../../testing/nodeImageIO';
import { createRng, detectFast, detectFeatures, hammingDistance, matchFeatures, ransacHomography } from '.';

function painting(width: number): GrayImage {
  const p = loadTestAsset('starry-night');
  return rgbaToGray(resizeRGBA(p, width, Math.round((p.height * width) / p.width)));
}

describe('detectFast', () => {
  it('finds the corners of a bright square and nothing on flat areas', () => {
    const g = createGray(60, 60, 50);
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) g.data[y * 60 + x] = 200;
    const f = detectFast(g, 20, 3);
    expect(f.count).toBeGreaterThanOrEqual(4);
    const near = (cx: number, cy: number) => Array.from(f.x).some((x, i) => Math.abs(x - cx) <= 2 && Math.abs(f.y[i] - cy) <= 2);
    expect(near(20, 20) && near(39, 20) && near(39, 39) && near(20, 39)).toBe(true);
    for (let i = 0; i < f.count; i++) {
      const onCorner = [20, 39].some((c) => Math.abs(f.x[i] - c) <= 2) && [20, 39].some((c) => Math.abs(f.y[i] - c) <= 2);
      expect(onCorner).toBe(true);
    }
  });
});

describe('detectFeatures', () => {
  const img = painting(640);
  const feats = detectFeatures(img, { maxFeatures: 1500 });

  it('respects the budget, image bounds and descriptor layout', () => {
    const { keypoints, descriptors } = feats;
    expect(keypoints.length).toBeGreaterThan(1200);
    expect(keypoints.length).toBeLessThanOrEqual(1500);
    expect(descriptors.length).toBe(keypoints.length * 32);
    for (const k of keypoints) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.y).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThan(img.width);
      expect(k.y).toBeLessThan(img.height);
      expect(k.size).toBeGreaterThanOrEqual(31);
      expect(Math.abs(k.angle)).toBeLessThanOrEqual(Math.PI);
    }
    expect(new Set(keypoints.map((k) => k.octave)).size).toBe(8);
  });

  it('spreads keypoints over the image (grid bucketing)', () => {
    const cells = new Set(feats.keypoints.map((k) => `${Math.floor((k.x / img.width) * 8)},${Math.floor((k.y / img.height) * 8)}`));
    expect(cells.size).toBeGreaterThanOrEqual(60); // of 64
    if (DEBUG_IMAGES) {
      const vis = createRGBA(img.width, img.height);
      for (let i = 0; i < img.data.length; i++) vis.data.set([img.data[i], img.data[i], img.data[i], 255], i * 4);
      for (const k of feats.keypoints) {
        const r = k.size / 6;
        const c: [number, number, number, number] = [255, (k.octave * 32) & 255, 0, 255];
        drawLine(vis, { x: k.x, y: k.y }, { x: k.x + r * Math.cos(k.angle), y: k.y + r * Math.sin(k.angle) }, c);
      }
      savePng('.debug/stitch/features-spread.png', vis);
    }
  });

  it('is deterministic', () => {
    const again = detectFeatures(img, { maxFeatures: 1500 });
    expect(again.keypoints).toEqual(feats.keypoints);
    expect(again.descriptors).toEqual(feats.descriptors);
  });

  it('has no keypoints on a flat image', () => {
    const flat = createGray(300, 200, 128);
    const f = detectFeatures(flat);
    expect(f.keypoints.length).toBe(0);
    expect(f.descriptors.length).toBe(0);
  });

  it('matches across rotation and scale', () => {
    const rgba = resizeRGBA(loadTestAsset('great-wave'), 640, 430);
    for (const deg of [35, 180]) {
      const T: Mat3 = similarityAbout({ x: 320, y: 215 }, { x: 350, y: 300 }, (deg * Math.PI) / 180, 1.4);
      const warped = warpRGBA(rgba, T, 700, 600, { supersample: 2, fill: [0, 0, 0, 255] });
      const fa = detectFeatures(rgbaToGray(rgba), { maxFeatures: 1500 });
      const fb = detectFeatures(rgbaToGray(warped), { maxFeatures: 1500 });
      const m = matchFeatures(fa.descriptors, fb.descriptors);
      const good = m.filter((x) => {
        const p = applyMat3(T, fa.keypoints[x.queryIdx]);
        const q = fb.keypoints[x.trainIdx];
        return Math.hypot(p.x - q.x, p.y - q.y) < 3;
      });
      expect(good.length).toBeGreaterThan(150);
      expect(good.length / m.length).toBeGreaterThan(0.6);
    }
  });
});

describe('matchFeatures', () => {
  const rng = createRng(11);
  const randomDescriptors = (n: number) => {
    const d = new Uint8Array(n * 32);
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(rng() * 256);
    return d;
  };

  it('finds noisy copies and rejects unrelated descriptors', () => {
    const train = randomDescriptors(300);
    const perm = Array.from({ length: 100 }, (_, i) => (i * 37) % 300);
    const query = new Uint8Array(150 * 32);
    perm.forEach((j, i) => {
      query.set(train.subarray(j * 32, j * 32 + 32), i * 32);
      for (let f = 0; f < 12; f++) {
        const bit = Math.floor(rng() * 256);
        query[i * 32 + (bit >> 3)] ^= 1 << (bit & 7);
      }
    });
    query.set(randomDescriptors(50), 100 * 32);
    const matches = matchFeatures(query, train);
    const truth = new Map(perm.map((j, i) => [i, j]));
    expect(matches.filter((m) => truth.get(m.queryIdx) === m.trainIdx).length).toBe(100);
    expect(matches.length).toBe(100); // random queries (distance ~128) are rejected
    for (const m of matches) {
      expect(m.distance).toBe(hammingDistance(query, m.queryIdx, train, m.trainIdx));
      expect(m.distance).toBeLessThanOrEqual(12);
    }
  });

  it('applies the ratio test and cross-check', () => {
    const train = randomDescriptors(3);
    train.set(train.subarray(0, 32), 32); // descriptors 0 and 1 identical
    const query = new Uint8Array(train.subarray(0, 32));
    expect(matchFeatures(query, train)).toEqual([]); // ambiguous: best == second best
    expect(matchFeatures(query, train, { ratio: 1 })).toEqual([{ queryIdx: 0, trainIdx: 0, distance: 0 }]);
    // Two queries want the same train descriptor: cross-check keeps only the closer one.
    const q2 = new Uint8Array(64);
    q2.set(train.subarray(64, 96), 0);
    q2.set(train.subarray(64, 96), 32);
    q2[32] ^= 1;
    expect(matchFeatures(q2, train, { ratio: 1 })).toEqual([{ queryIdx: 0, trainIdx: 2, distance: 0 }]);
    expect(matchFeatures(q2, train, { ratio: 1, crossCheck: false }).length).toBe(2);
  });

  it('accepts unaligned views', () => {
    const train = randomDescriptors(20);
    const buf = new Uint8Array(32 * 20 + 1);
    buf.set(train, 1);
    const m = matchFeatures(buf.subarray(1), train);
    expect(m.length).toBe(20);
    expect(m.every((x) => x.queryIdx === x.trainIdx && x.distance === 0)).toBe(true);
  });
});

describe('ransacHomography', () => {
  const H: Mat3 = [1.1, 0.25, 40, -0.2, 0.95, 25, 3e-4, -2e-4, 1];
  function synth(nIn: number, nOut: number, noise: number, seed: number): { src: Point[]; dst: Point[]; isIn: boolean[] } {
    const rng = createRng(seed);
    const src: Point[] = [], dst: Point[] = [], isIn: boolean[] = [];
    for (let i = 0; i < nIn + nOut; i++) {
      const p = { x: rng() * 600, y: rng() * 400 };
      const inlier = i % (nIn + nOut) < nIn;
      const q = inlier ? applyMat3(H, p) : { x: rng() * 800, y: rng() * 600 };
      const g = () => (rng() + rng() + rng() - 1.5) * noise * 2;
      src.push(p);
      dst.push({ x: q.x + (inlier ? g() : 0), y: q.y + (inlier ? g() : 0) });
      isIn.push(inlier);
    }
    return { src, dst, isIn };
  }

  it('recovers a homography from data with 50% outliers', () => {
    const { src, dst, isIn } = synth(150, 150, 0.5, 3);
    const r = ransacHomography(src, dst, { threshold: 3, seed: 1 })!;
    expect(r).not.toBeNull();
    let maxErr = 0;
    for (let y = 0; y <= 400; y += 50) {
      for (let x = 0; x <= 600; x += 50) {
        const a = applyMat3(H, { x, y }), b = applyMat3(r.H, { x, y });
        maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(maxErr).toBeLessThan(0.6);
    const truePos = r.inliers.filter((v, i) => v && isIn[i]).length;
    const falsePos = r.inliers.filter((v, i) => v && !isIn[i]).length;
    expect(truePos).toBeGreaterThanOrEqual(145);
    expect(falsePos).toBeLessThanOrEqual(3);
    expect(r.inlierCount).toBe(truePos + falsePos);
  });

  it('is deterministic for a seed', () => {
    const { src, dst } = synth(60, 140, 1, 9);
    const a = ransacHomography(src, dst, { seed: 5 })!;
    const b = ransacHomography(src, dst, { seed: 5 })!;
    expect(a.H).toEqual(b.H);
    expect(a.inliers).toEqual(b.inliers);
  });

  it('returns null for degenerate or mirrored input', () => {
    expect(ransacHomography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
    const line = Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: i * 5 }));
    expect(ransacHomography(line, line.map((p) => ({ x: p.x + 3, y: p.y })))).toBeNull();
    // A mirror image cannot come from photographing the same print.
    const rng = createRng(4);
    const pts = Array.from({ length: 40 }, () => ({ x: rng() * 300, y: rng() * 300 }));
    expect(ransacHomography(pts, pts.map((p) => ({ x: 400 - p.x, y: p.y })))).toBeNull();
  });
});
