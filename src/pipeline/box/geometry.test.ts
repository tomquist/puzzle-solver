import { describe, expect, it } from 'vitest';
import { applyMat3, type Point, type Quad } from '../../cv/geometry';
import { createRGBA, type RGBAImage } from '../../cv/image';
import { rectifyQuad } from '../../cv/warp';
import { Rng } from '../../testing/synth';
import { estimateQuadAspect, quadArea, rotateQuad, suggestRectifiedSize, unitSquareToQuad } from './geometry';

/** Pinhole projection of a w×h rectangle (centred at the origin of plane z = 0) seen by a tilted camera. */
function projectRectangle(aspect: number, rng: Rng, maxTiltDeg: number, offCentre: number): Quad {
  const W = 4000, H = 3000, f = 0.75 * W; // typical phone: ~67° horizontal field of view
  const deg = Math.PI / 180;
  const ax = rng.uniform(-maxTiltDeg, maxTiltDeg) * deg, ay = rng.uniform(-maxTiltDeg, maxTiltDeg) * deg, az = rng.uniform(-8, 8) * deg;
  const rx = [[1, 0, 0], [0, Math.cos(ax), -Math.sin(ax)], [0, Math.sin(ax), Math.cos(ax)]];
  const ry = [[Math.cos(ay), 0, Math.sin(ay)], [0, 1, 0], [-Math.sin(ay), 0, Math.cos(ay)]];
  const rz = [[Math.cos(az), -Math.sin(az), 0], [Math.sin(az), Math.cos(az), 0], [0, 0, 1]];
  const mul = (a: number[][], b: number[][]) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  const R = mul(rz, mul(ry, rx));
  const h = 1, w = aspect;
  // Distance so the rectangle fills ~70 % of the photo; small off-centre shift.
  const dist = (f * Math.max(w / W, h / H)) / 0.7;
  const t = [rng.uniform(-offCentre, offCentre) * dist * (W / f) * 0.5, rng.uniform(-offCentre, offCentre) * dist * (H / f) * 0.5, dist];
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return corners.map(([x, y]) => {
    const X = R[0][0] * x + R[0][1] * y + t[0];
    const Y = R[1][0] * x + R[1][1] * y + t[1];
    const Z = R[2][0] * x + R[2][1] * y + t[2];
    return { x: W / 2 + (f * X) / Z, y: H / 2 + (f * Y) / Z };
  }) as Quad;
}

function rotateImage90cw(img: RGBAImage): RGBAImage {
  const out = createRGBA(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = (x * out.width + (img.height - 1 - y)) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = img.data[s + c];
    }
  }
  return out;
}

describe('rotateQuad', () => {
  const q: Quad = [{ x: 10, y: 12 }, { x: 90, y: 8 }, { x: 95, y: 70 }, { x: 5, y: 66 }];

  it('relabels corners cyclically and composes', () => {
    expect(rotateQuad(q, 0)).toEqual(q);
    expect(rotateQuad(q, 1)).toEqual([q[3], q[0], q[1], q[2]]);
    expect(rotateQuad(q, -1)).toEqual([q[1], q[2], q[3], q[0]]);
    expect(rotateQuad(rotateQuad(q, 1), 1)).toEqual(rotateQuad(q, 2));
    expect(rotateQuad(q, 4)).toEqual(q);
    expect(rotateQuad(q, -3)).toEqual(rotateQuad(q, 1));
  });

  it('rotates the rectified output by 90° clockwise per quarter turn', () => {
    const img = createRGBA(100, 80);
    const rng = new Rng(5);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = rng.int(256);
      img.data[i + 1] = (i / 4) % 256;
      img.data[i + 2] = Math.floor(i / 400) % 256;
      img.data[i + 3] = 255;
    }
    const a = rectifyQuad(img, q, 60, 40, 1);
    const b = rectifyQuad(img, rotateQuad(q, 1), 40, 60, 1);
    const ra = rotateImage90cw(a);
    let diff = 0;
    for (let i = 0; i < ra.data.length; i++) diff += Math.abs(ra.data[i] - b.data[i]);
    expect(diff / ra.data.length).toBeLessThan(0.5);
  });
});

describe('estimateQuadAspect / suggestRectifiedSize', () => {
  it('is exact for rectangles and parallelograms', () => {
    const r: Quad = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }];
    expect(estimateQuadAspect(r)).toBeCloseTo(1.5, 6);
    expect(estimateQuadAspect(rotateQuad(r, 1))).toBeCloseTo(1 / 1.5, 6);
    const H = unitSquareToQuad(r)!;
    expect(applyMat3(H, { x: 1, y: 1 }).x).toBeCloseTo(300, 6);
  });

  it('estimates the true aspect of perspective-projected rectangles within ~3 %', () => {
    // Hand-held phone photos: tilt up to 20°, box roughly centred (±5 % of the half-width).
    const rng = new Rng(17);
    const errs: number[] = [], naiveErrs: number[] = [];
    const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    for (let i = 0; i < 100; i++) {
      const aspect = rng.uniform(0.6, 1.7);
      const q = projectRectangle(aspect, rng, 20, 0.05);
      errs.push(Math.abs(estimateQuadAspect(q) / aspect - 1));
      // Naive mean-of-opposite-sides estimate for comparison.
      const naive = (d(q[0], q[1]) + d(q[3], q[2])) / (d(q[0], q[3]) + d(q[1], q[2]));
      naiveErrs.push(Math.abs(naive / aspect - 1));
    }
    const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor(p * (v.length - 1))];
    console.log(`aspect error: median ${(100 * pct(errs, 0.5)).toFixed(2)} %, p90 ${(100 * pct(errs, 0.9)).toFixed(2)} % (mean-of-sides: ${(100 * pct(naiveErrs, 0.5)).toFixed(2)} / ${(100 * pct(naiveErrs, 0.9)).toFixed(2)} %)`);
    expect(pct(errs, 0.5)).toBeLessThan(0.015);
    expect(pct(errs, 0.9)).toBeLessThan(0.03);
    expect(pct(errs, 0.9)).toBeLessThan(pct(naiveErrs, 0.9));
    // Exact when the box is centred on the optical axis.
    const r2 = new Rng(3);
    for (let i = 0; i < 20; i++) {
      const aspect = r2.uniform(0.6, 1.7);
      expect(Math.abs(estimateQuadAspect(projectRectangle(aspect, r2, 25, 0)) / aspect - 1)).toBeLessThan(0.002);
    }
  });

  it('honours a given aspect exactly, keeps about the quad area and caps the long side', () => {
    const q: Quad = [{ x: 100, y: 100 }, { x: 1100, y: 120 }, { x: 1080, y: 820 }, { x: 90, y: 800 }];
    const s = suggestRectifiedSize(q, 1.4);
    expect(Math.abs(s.width / s.height - 1.4)).toBeLessThan(0.003);
    expect(s.width * s.height).toBeGreaterThan(0.9 * quadArea(q));
    expect(s.width * s.height).toBeLessThan(1.1 * quadArea(q));
    const capped = suggestRectifiedSize(q, 0.5, 600);
    expect(capped.height).toBe(600);
    expect(capped.width).toBe(300);
    const est = suggestRectifiedSize(q);
    expect(Math.abs(est.width / est.height - estimateQuadAspect(q))).toBeLessThan(0.01);
    const big = suggestRectifiedSize([{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 4000 }, { x: 0, y: 4000 }]);
    expect(big).toEqual({ width: 3000, height: 1500 });
  });
});
