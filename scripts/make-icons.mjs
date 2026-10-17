#!/usr/bin/env node
/**
 * Renders the app icons (a cream jigsaw piece on the app's teal) into public/icons/ with pngjs.
 * Run: node scripts/make-icons.mjs   (the PNGs are committed; re-run only when the design changes)
 *
 * - icon-192.png / icon-512.png   purpose "any": rounded square, transparent corners
 * - icon-maskable-512.png         purpose "maskable": full-bleed, piece inside the 80 % safe zone
 * - apple-touch-icon.png (180)    opaque square (iOS rounds the corners itself)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG_TOP = [58, 128, 121];
const BG_BOTTOM = [40, 96, 91];
const PIECE = [247, 242, 230];
const SHADOW = [22, 60, 57];

/** Inside the rounded background square (unit coordinates)? */
function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

/** A classic jigsaw piece: square body, tabs on top and right, a blank on the left, flat bottom. */
function inPiece(x, y, scale, dx = 0, dy = 0) {
  // Map to piece space centred at (0.5, 0.5) with the given scale.
  // The piece's bounding box (tabs included) is centred at (0.5625, 0.4575) in piece space.
  const u = (x - 0.5 - dx) / scale + 0.5625;
  const v = (y - 0.5 - dy) / scale + 0.4575;
  const b0 = 0.25, b1 = 0.71, c0 = 0.31, c1 = 0.77; // body x / y extent
  const r = 0.095;
  const inBody = u >= b0 && u <= b1 && v >= c0 && v <= c1;
  const midX = (b0 + b1) / 2, midY = (c0 + c1) / 2;
  const topTab = (u - midX) ** 2 + (v - (c0 - 0.07)) ** 2 <= r * r || (Math.abs(u - midX) <= r * 0.55 && v >= c0 - 0.07 && v <= c0 + 0.01);
  const rightTab = (u - (b1 + 0.07)) ** 2 + (v - midY) ** 2 <= r * r || (Math.abs(v - midY) <= r * 0.55 && u >= b1 - 0.01 && u <= b1 + 0.07);
  const leftBlank = (u - (b0 + 0.07)) ** 2 + (v - midY) ** 2 <= (r * 0.95) ** 2 || (Math.abs(v - midY) <= r * 0.5 && u >= b0 - 0.01 && u <= b0 + 0.07);
  return ((inBody && !leftBlank) || topTab || rightTab);
}

function render(size, { rounded, pieceScale }) {
  const png = new PNG({ width: size, height: size });
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, piece = 0, shadow = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const inBg = rounded ? inRoundedSquare(x, y, 0.22) : true;
          if (!inBg) continue;
          bg++;
          if (inPiece(x, y, pieceScale)) piece++;
          else if (inPiece(x, y, pieceScale, 0.012, 0.02)) shadow++;
        }
      }
      const n = SS * SS;
      const t = py / size;
      const base = BG_TOP.map((c, i) => c + (BG_BOTTOM[i] - c) * t);
      const fb = bg / n, fp = piece / n, fs = shadow / n;
      const bgOnly = Math.max(0, fb - fp - fs);
      const total = Math.max(1e-9, fb);
      const o = (py * size + px) * 4;
      for (let i = 0; i < 3; i++) {
        const c = (base[i] * bgOnly + PIECE[i] * fp + (base[i] * 0.55 + SHADOW[i] * 0.45) * fs) / total;
        png.data[o + i] = Math.round(c);
      }
      png.data[o + 3] = Math.round(255 * fb);
    }
  }
  return PNG.sync.write(png);
}

mkdirSync(OUT, { recursive: true });
const files = {
  'icon-192.png': render(192, { rounded: true, pieceScale: 1 }),
  'icon-512.png': render(512, { rounded: true, pieceScale: 1 }),
  'icon-maskable-512.png': render(512, { rounded: false, pieceScale: 0.78 }),
  'apple-touch-icon.png': render(180, { rounded: false, pieceScale: 0.9 }),
};
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(join(OUT, name), buf);
  console.log(`wrote public/icons/${name} (${buf.length} bytes)`);
}
