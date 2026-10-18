# 🧩 Puzzle Solver

A jigsaw puzzle assistant that runs entirely in your browser. Photograph the box once, then
photograph handfuls of loose pieces: the app finds every piece, shows where it belongs in the
picture and which way to turn it, points out pieces that fit together, and tells you when a photo
isn't good enough. Nothing is uploaded – all image processing happens on your device, and your
puzzles are stored in the browser (IndexedDB).

## How to use it

1. **New puzzle → photograph the box.** The app finds the picture on the box automatically; drag the
   corners if needed (a magnifier helps). Wrong guess? Tap *Next candidate* (whole lid vs. picture
   inside the printed frame).
2. **Enter the details.** Number of pieces and, optionally, the finished size printed on the box.
   The size straightens the picture to the exact shape and, with the piece count, gives the grid
   (e.g. 1000 pieces at 70 × 50 cm → 37 × 27). Pick another suggestion or enter a custom grid if your
   puzzle differs.
3. **Optional: sharper picture.** If the photo has too few pixels per piece, add close-up photos of
   parts of the box; they are aligned automatically and merged into a higher-resolution reference.
4. **Scan pieces.** Spread 10–40 pieces on a plain background that contrasts with them, not touching,
   and take one photo from directly above. Already assembled patches can be in the photo too.
5. **Read the result.** Every piece gets a thin outline and a small number next to it (so the piece
   itself stays visible): green = confident, amber = unsure, blue = assembled grid; a short pink
   bar marks the edge that goes on top, and lines connect pieces that go together. Tap a piece to select
   it: its connection lines turn thick and bright, the pieces it joins are outlined, the rest of the
   photo darkens, and a bar at the bottom says where it goes and what it joins ("Joins #9 on its
   right side, #14 below" – tap a number to jump there); *Details* compares it with the box picture
   and marks it as placed. Press and hold the photo to see it without any labels. The corner button
   opens the photo (or the box picture) in full screen; pinch to zoom, one finger pans. On the page,
   a one-finger drag on a picture scrolls the page until you zoom in.
6. **Place them.** *Start placing* walks through the pieces one by one: the piece in your photo
   with its surroundings as it lies on the table (tap for a close-up; the pink "top" bar marks the
   edge that goes on top), how to turn it – the piece itself turns upright on screen, with plain
   words like "Turn it a quarter to the right" and the exact angle in small print – and where it
   goes: the box picture around the spot (pinch to zoom) with an overview of the whole picture.
7. **Come back any time.** Puzzles, scans and progress stay in your browser. Use *Settings → Export*
   to back up or move a puzzle to another device.

It is built for phones: open the page on your phone and use *Add to Home Screen* to install it as
an app – it works offline after the first visit. On iPhone, *Take photo* uses the native camera for
the sharpest pictures.

Tips for good scans – the app checks these and tells you what to fix:
- Even light without reflections (glossy pieces and boxes reflect lamps).
- Hold still; blurry photos lose the piece outlines.
- Get close enough that each piece is at least ~60 px wide in the photo.
- Use a background colour that differs from the pieces (dark cloth for light puzzles, etc.).

## Development

Requires Node 22.

```bash
npm install
npm run dev          # Vite dev server
npm test             # unit + scenario tests (Vitest, Node)
npm run bench        # accuracy benchmark, gated by bench/baseline.json
npm run test:e2e     # Playwright (Chromium) end-to-end tests
npm run build        # typecheck + production build into dist/
```

URL switches for development: `?pipeline=mock` uses a deterministic fake pipeline (UI work),
`?pipeline=local` runs the real pipeline on the main thread (easier debugging).

Documentation:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – flows, module map, conventions, algorithms.
- [docs/TESTING.md](docs/TESTING.md) – how everything is verified automatically (synthetic ground
  truth, accuracy benchmark, quality-check tests, browser e2e, real-photo corpus).

### Project layout

| Path | What |
|---|---|
| `src/cv/` | Pure-TypeScript computer vision primitives (no DOM): images, colour, filters, geometry, warping, contours, morphology, Canny/Hough, ORB-style features, RANSAC |
| `src/pipeline/` | Box detection, close-up stitching, piece segmentation/shape/quality, matching, scan orchestration |
| `src/worker/` | Web Worker exposing the pipeline (Comlink) + mock |
| `src/storage/` | IndexedDB repository, export/import |
| `src/ui/`, `src/platform/` | React UI, camera and image I/O |
| `src/testing/` | Synthetic jigsaw generator used by tests and the benchmark |
| `bench/` | Accuracy benchmark and baseline |
| `tests/e2e/` | Playwright tests |

### Improving accuracy with your own photos

Export a puzzle you have worked on (pieces confirmed with *Placed ✓*), save the file in
`test-corpus/`, and run `npm run bench`: the benchmark re-analyses your scans and checks that the
confirmed pieces are still found in the right place. See [test-corpus/README.md](test-corpus/README.md).

## Deployment

`.github/workflows/deploy.yml` runs on every push and pull request: typecheck, unit tests, build,
accuracy benchmark and browser tests. Pushes to `main` that pass everything are deployed to GitHub
Pages.

One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

## Credits

Test images: public-domain paintings from Wikimedia Commons (see `test-assets/README.md`).
