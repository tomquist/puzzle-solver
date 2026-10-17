# Testing strategy

Goal: every part of the app – including the image-processing accuracy – is verified automatically,
so changes can be made and judged without manual photo-taking feedback loops.

## Layers

| Layer | Tool | What it proves | Runs |
|---|---|---|---|
| Unit tests | Vitest (Node) | Each primitive/algorithm behaves (geometry, contours, features, storage, …) | `npm test`, CI |
| Synthetic scenario tests | Vitest + `src/testing/synth.ts` | Each pipeline stage meets accuracy targets on generated photos with exact ground truth | `npm test`, CI |
| Quality-check tests | Vitest + degradations | Every quality warning fires on degraded photos and stays quiet on clean ones | `npm test`, CI |
| Accuracy benchmark | `npm run bench` | End-to-end metrics across many seeded scenes; compared against `bench/baseline.json` | CI (gate) |
| Browser end-to-end | Playwright (Chromium + WebKit) | Real app + real Web Worker + IndexedDB: setup wizard, persistence, scanning, results — on desktop and iPhone (WebKit) | `npm run test:e2e`, CI |
| Mobile audit | Playwright device matrix | No horizontal overflow, ≥ 44 px touch targets, ≥ 16 px inputs (no iOS zoom), readable text, reachable primary actions, safe areas — iPhone SE/13, iPad, small Android, Pixel 7, landscape | `npm run test:e2e`, CI |
| PWA / offline, slow phone | Playwright | Manifest, icons, service worker, offline reload of the production build; 4× CPU throttling keeps progress and taps responsive | `npm run test:e2e`, CI |
| Real-photo corpus | `npm run bench -- --corpus` | Real photos confirmed by the user still match | locally / CI when present |

## Synthetic ground truth

`src/testing/synth.ts` turns a real painting (`test-assets/`) into test data:

- `generateJigsaw` cuts the picture into a classic grid of pieces (tabs/blanks, wavy edges, flat
  borders) and records each piece's outline, corners, row/col and side types.
- `renderPiecesPhoto` scatters single pieces and assembled patches on a background with random
  rotation and scale, lighting gain/gradient, noise, blur, shadows and anti-aliased edges, and
  returns the photo plus truth (cell, rotation, corners, outline) for every region.
- `renderBoxPhoto` prints the picture on a box lid with a frame and logos, on a table, under
  perspective, and returns the true picture quad.
- `perturbReference` simulates the colour/sharpness differences between box print and piece print.

Because everything is seeded, failures are reproducible; because ground truth is exact, metrics are
objective.

## Metrics (benchmark)

- Box detection: max corner error (% of picture diagonal); rectified-image alignment error.
- Segmentation: piece recall/precision (IoU ≥ 0.8), patch detection, false fragments.
- Shape: corner error (% of body size), piece-kind accuracy (corner/edge/interior), side-kind accuracy.
- Matching: top-1 / top-3 cell accuracy, rotation accuracy, confidence calibration (confident ⇒
  correct rate), patch placement accuracy.
- Fits: precision/recall of neighbour hints.
- Timing per stage (budget per scan on Node, as a proxy for phones).

Each scenario family varies seeds, paintings, grid sizes (24 → 2000 pieces), scale, rotation, noise,
blur, lighting and reference perturbation. Thresholds live in `bench/baseline.json`; CI fails when a
metric regresses beyond tolerance. Failing cases write annotated overlays (`.debug/bench/…png`) so
problems can be inspected visually.

## Quality checks

Clean synthetic photos are degraded in controlled ways – Gaussian and motion blur, under/over
exposure, specular glare blobs, low background contrast, touching pieces, pieces cut by the photo
border, tiny pieces, strong perspective – and tests assert the expected `QualityCode` is raised (and
that clean photos raise none of them).

## Browser end-to-end

Playwright runs the production build in Chromium with the real worker:

1. Upload a generated box photo → auto-detected corners are within tolerance → wizard → save.
2. Reload → the puzzle is still listed (IndexedDB persistence).
3. Upload a generated pieces photo → the result view shows the expected number of pieces and the
   best placements match the ground truth.
4. Confirm a placement → progress updates and survives reload. Export → import round trip.
5. Camera path: Chromium's fake media stream (`--use-fake-device-for-media-stream`,
   `--use-file-for-fake-video-capture`) feeds a generated video so the live preview, quality meter
   and shutter are exercised.

Screenshots of key screens at phone and desktop sizes are kept as CI artifacts.

## Real-photo corpus (closing the reality gap)

Synthetic data is optimistic. Real photos enter the test suite without extra annotation work:
when the user marks a piece as "Placed ✓", that confirmation is a labelled example. A puzzle export
(Settings → Export) contains the reference, scans and confirmed placements. Dropping such a file
into `test-corpus/` makes the benchmark re-analyse every stored scan photo and check that each
confirmed piece is still matched to its confirmed cell (top-1/top-3), so real-world regressions are
caught automatically.
