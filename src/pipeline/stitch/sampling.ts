/**
 * Monomorphic RGB samplers for hot loops (typed output, no allocation). Integer coordinates are
 * pixel centers; coordinates outside the image are clamped to the border.
 */

/** Bilinear RGB sample at (u, v) (integer coordinates = pixel centers, clamped at the border). */
export function sampleLinear(data: Uint8ClampedArray, w: number, h: number, u: number, v: number, out: Float64Array): void {
  let x0 = Math.floor(u), y0 = Math.floor(v);
  let fx = u - x0, fy = v - y0;
  if (x0 < 0) { x0 = 0; fx = 0; } else if (x0 >= w - 1) { x0 = w - 1; fx = 0; }
  if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= h - 1) { y0 = h - 1; fy = 0; }
  const i00 = (y0 * w + x0) * 4;
  const i10 = fx > 0 ? i00 + 4 : i00;
  const i01 = fy > 0 ? i00 + w * 4 : i00;
  const i11 = fx > 0 ? i01 + 4 : i01;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  out[0] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
  out[2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
}

/** Catmull–Rom bicubic RGB sample at (u, v), clamped at the border (may overshoot 0..255 slightly). */
export function sampleCubic(data: Uint8ClampedArray, w: number, h: number, u: number, v: number, out: Float64Array): void {
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const tx = u - x0, ty = v - y0;
  const tx2 = tx * tx, tx3 = tx2 * tx, ty2 = ty * ty, ty3 = ty2 * ty;
  const a0 = 0.5 * (-tx3 + 2 * tx2 - tx), a1 = 0.5 * (3 * tx3 - 5 * tx2 + 2), a2 = 0.5 * (-3 * tx3 + 4 * tx2 + tx), a3 = 0.5 * (tx3 - tx2);
  const b0 = 0.5 * (-ty3 + 2 * ty2 - ty), b1 = 0.5 * (3 * ty3 - 5 * ty2 + 2), b2 = 0.5 * (-3 * ty3 + 4 * ty2 + ty), b3 = 0.5 * (ty3 - ty2);
  const stride = w * 4;
  let c0: number, c1: number, c2: number, c3: number, r0: number, r1: number, r2: number, r3: number;
  if (x0 >= 1 && x0 + 2 < w && y0 >= 1 && y0 + 2 < h) {
    c0 = (x0 - 1) * 4; c1 = c0 + 4; c2 = c0 + 8; c3 = c0 + 12;
    r0 = (y0 - 1) * stride; r1 = r0 + stride; r2 = r1 + stride; r3 = r2 + stride;
  } else {
    c0 = (x0 - 1 < 0 ? 0 : x0 - 1 >= w ? w - 1 : x0 - 1) * 4;
    c1 = (x0 < 0 ? 0 : x0 >= w ? w - 1 : x0) * 4;
    c2 = (x0 + 1 < 0 ? 0 : x0 + 1 >= w ? w - 1 : x0 + 1) * 4;
    c3 = (x0 + 2 < 0 ? 0 : x0 + 2 >= w ? w - 1 : x0 + 2) * 4;
    r0 = (y0 - 1 < 0 ? 0 : y0 - 1 >= h ? h - 1 : y0 - 1) * stride;
    r1 = (y0 < 0 ? 0 : y0 >= h ? h - 1 : y0) * stride;
    r2 = (y0 + 1 < 0 ? 0 : y0 + 1 >= h ? h - 1 : y0 + 1) * stride;
    r3 = (y0 + 2 < 0 ? 0 : y0 + 2 >= h ? h - 1 : y0 + 2) * stride;
  }
  for (let ch = 0; ch < 3; ch++) {
    const p0 = r0 + ch, p1 = r1 + ch, p2 = r2 + ch, p3 = r3 + ch;
    out[ch] =
      b0 * (data[p0 + c0] * a0 + data[p0 + c1] * a1 + data[p0 + c2] * a2 + data[p0 + c3] * a3) +
      b1 * (data[p1 + c0] * a0 + data[p1 + c1] * a1 + data[p1 + c2] * a2 + data[p1 + c3] * a3) +
      b2 * (data[p2 + c0] * a0 + data[p2 + c1] * a1 + data[p2 + c2] * a2 + data[p2 + c3] * a3) +
      b3 * (data[p3 + c0] * a0 + data[p3 + c1] * a1 + data[p3 + c2] * a2 + data[p3 + c3] * a3);
  }
}
