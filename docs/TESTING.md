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
| Feedback replay | `npm run bench` (`bench/feedback.eval.ts`) | Users' feedback files (`test-corpus/feedback/`): reviewed marks stay fixed; answer keys score found / separate / false regions | CI (gate) |
| Private placement truth | `npm run bench` (`bench/private.eval.ts`) | Full feedback files of the user's own puzzle (with its commercial picture) in the ignored `test-corpus/private/`, each with a `<file>.truth.json` of true cells and turns: top-1 / top-3 cell, rotation, confident share and precision, found / merged — report only | locally when present (skipped otherwise) |
| Grid convergence | `npm run bench` (`bench/grid.eval.ts`) | Synthetic puzzles at known grids (square and long cells, few pieces): from the right grid no question, from a neighbouring grid, no count or a wrong count at most one question and the right final grid | CI (gate) |
| Grid replay on real scans | `npx vite-node scripts/grid-replay.ts -- --dir <full feedback files>` | The scans of one real puzzle replayed through the grid belief from the right grid, wrong neighbours, no count and a wrong count, in the order taken and shuffled: when it first asks, whether right, how often, final grid – report only | locally |
| Other puzzles | `npm run corpus:fetch-puzzlemap`, then `npm run bench` (`bench/puzzlemap.eval.ts`) | Real photos of 643 labelled pieces of other puzzles (Puzzle-Map dataset, 7 reference pictures) are placed in their reference: top-1 / top-3 cell and turn | locally when fetched (skipped otherwise) |

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
- Segmentation: piece recall/precision (IoU ≥ 0.8), patch detection, false fragments; outline
  accuracy of the matched regions (mask IoU and boundary F-score at 2 px, report only).
- Shape: corner error (% of body size), piece-kind accuracy (corner/edge/interior), side-kind accuracy.
- Matching: top-1 / top-3 cell accuracy, rotation accuracy, confidence calibration (confident ⇒
  correct rate), patch placement accuracy.
- Fits: precision/recall of neighbour hints.
- Side retrieval (`bench/sides.eval.ts`): for every true pair of mating sides, how often the partner
  is the closest (top-1) or among the five closest (top-5) complementary sides of the scan, per side
  comparison (shape RMS / DTW, colour strips, combined) – with the detected corners and with every
  corner moved 2–5 % of the side along the outline (simulated real-photo corner error).
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

### Feedback files

"Send feedback" in the app packages a scan photo with what the app found and the user's
corrections. Committed in scan-only form (`npm run feedback:strip`, no publisher artwork), they are
replayed by `npm run feedback:inspect` and the benchmark. The user's marks are input, not ground
truth: every mark is checked by eye first and the verdicts go into `<file>.review.json`
(test-corpus/feedback/README.md). Where the pieces can be told apart, the review also holds an
answer key: one by-eye point per piece or assembled group (optionally for part of the photo). It
catches mistakes nobody marked, such as a regression that drops pieces on an easy photo.
Freely licensed table photos of other puzzles (`feedback/flickr-*.json`, test-corpus/CREDITS.md)
are wrapped into the same format with `npm run feedback:from-photo` and carry only an answer key:
stress tests for other tables, motifs, oblique views and small pieces.

### Private placement truth

Matching on the user's own puzzle can only be measured with its picture, which is a publisher's
artwork: full feedback files (reference included) stay in `test-corpus/private/`, which is ignored
by version control and must never be committed, copied elsewhere in the repository or attached to
an issue. Next to each file, `<file>.truth.json` (format in `scripts/feedback/truth.ts` and
test-corpus/private/README.md) says where every piece really belongs: a point in the photo, the
true cell and the turn to upright (`Placement.rotationDeg` convention), or the cells of an
assembled block; doubtful items are marked `unsure` and count neither way. Truth comes from the
photos themselves, never from the app's placements — e.g. a block placed and checked by eye, then
taken apart ("exploded" photo) and each loose piece identified in the block photo by its print and
outline. `bench/private.eval.ts` replays every such file through the current pipeline and prints
its scores next to those of the result stored in the file, plus every misplaced piece; it gates
nothing.

### Other puzzles: Puzzle-Map

Matching on real photos is otherwise only measured on one puzzle. `bench/puzzlemap.eval.ts`
places the labelled pieces of the Puzzle-Map dataset (CC BY 4.0; fetched by
`npm run corpus:fetch-puzzlemap` into `test-corpus/puzzle-map/`, which is not committed because
the pictures show publishers' artwork) in their puzzles' reference pictures: once from the
labelled piece body alone (appearance matching) and once through our segmentation of the photo.
The suite is skipped without the data and takes about 15 minutes with it (`PUZZLEMAP_LIMIT=<n>`
for a quick, ungated run).
