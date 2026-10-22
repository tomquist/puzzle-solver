# Technical and feature head-to-head: Puzzle Solver vs competitors

Collected 2026-10-22. Evidence types are labelled throughout:
- **[measured]**: a number produced by a test or benchmark in a repository. Where marked "re-run today", I ran it myself on 2026-10-22.
- **[claimed]**: a statement in a store listing or on a developer site. Not verified.
- **[inferred]**: my own reasoning from the evidence.

Local sources are cited by absolute file path. I did not open any file in `test-corpus/private/`. I also left `bench/private.eval.ts` out of my benchmark run (`--exclude`), so the private files were not read. Neither repository was modified. `npm ci` created `node_modules/` in /home/user/puzzle-solver, which git ignores, so `git status` is still clean. I did not install or run anything in jellojm/puzzle-helper.

## 1. Puzzle Solver: actual capabilities and measured accuracy

### Takeaway
Puzzle Solver is a still-photo, batch tool: one box photo, then photos of 10 to 40 loose pieces or assembled patches. Its accuracy is measured more rigorously than any competitor's.

- **Synthetic scenes** (37 scenarios, 24 to 1000 pieces, two paintings): mean top-1 cell accuracy 86.8%. Rotation is 100% correct whenever the cell is right. "Confident" labels are 99.9% precise.
- **Real hand-held single-piece photos** (Puzzle-Map, 643 pieces from 6- to 120-piece puzzles): 93.9% top-1 when the piece outline is given. Only 22.9% when the app must find the piece itself in a photo with fingers and a desk.
- **Weak cases** (low texture, grey regions, rim shadow on light tables, glare, edge-of-board patches) drop to 19 to 67% top-1.
- **Not measured in the repository:** placement accuracy on real 1000+ piece puzzles. That number exists only in the private, git-ignored corpus, which I did not read.

### Cited Findings
**Workflow and features (from the docs and code):**
- Flow: photograph the box once (auto-detected picture quad, several candidates, draggable corners with a magnifier) → enter piece count and optional physical size (gives the grid, e.g. 1000 pieces at 70 × 50 cm → 37 × 27) → optional close-up photos of the box, merged into a higher-resolution reference → "Spread 10–40 pieces on a plain background … not touching, and take one photo from directly above. Already assembled patches can be in the photo too." — [README.md](/home/user/puzzle-solver/README.md)
- Each scan result shows:
  - every piece outlined and colour-coded (green = confident, amber = unsure, blue = assembled);
  - a pink bar on the edge that goes on top;
  - dotted links between pieces that go together, and "Joins #9 on its right side" text;
  - an animated "show the fit" that glides one piece into place beside another;
  - a guided "Start placing" mode that walks through the pieces one by one, with turn instructions in words ("Turn it a quarter to the right") and the box picture around the target.
  — [README.md](/home/user/puzzle-solver/README.md); [docs/ARCHITECTURE.md](/home/user/puzzle-solver/docs/ARCHITECTURE.md)
- Other features: offline PWA, IndexedDB storage, export/import, progress tracking (placed cells are shaded and de-prioritised), edge/corner detection with an "edge pieces only" filter, shape-based fit hints for ambiguous content (sky, water), and a live camera quality meter. — [docs/ARCHITECTURE.md §1.3](/home/user/puzzle-solver/docs/ARCHITECTURE.md)
- Algorithms. Everything is pure TypeScript computer vision with no OpenCV and no ML. The only runtime dependencies are react, react-dom, comlink and idb.
  - Box detection: Canny, colour segmentation, Hough.
  - Segmentation: Lab background model from the photo border, then Otsu.
  - Matching: masked zero-mean NCC over every grid cell in 4 orientations, refined at a higher resolution, with confidence from the margin over the best distinct alternative.
  - One-cell-one-piece claims.
  - Fits: adjacency of placements plus DTW of side profiles.
  — [docs/ARCHITECTURE.md §5](/home/user/puzzle-solver/docs/ARCHITECTURE.md); [package.json](/home/user/puzzle-solver/package.json)
- Quality checks with actionable hints, 16 codes: blurry, motion_blur, too_dark, too_bright, glare, low_contrast, uneven_lighting, low_resolution, perspective, touching_pieces, cut_off, fragment, shape_uncertain, no_pieces, box_not_found, reference_low_resolution. — [src/model/types.ts](/home/user/puzzle-solver/src/model/types.ts)
- Minimum pixels per piece:
  - The README advises "each piece is at least ~60 px wide in the photo".
  - The code warns below a 50 px piece body and raises an error below 28 px (`lowResolution: 50`, `lowResolutionError: 28`).
  - The box reference warns below 32 px per cell (`refCellWarn: 32`).
  — [README.md](/home/user/puzzle-solver/README.md); [src/pipeline/pieces/quality.ts](/home/user/puzzle-solver/src/pipeline/pieces/quality.ts); [src/pipeline/box/quality.ts](/home/user/puzzle-solver/src/pipeline/box/quality.ts)
- A "Not this one" button in the piece detail sheet steps to the next candidate. It appears only when there is more than one candidate. It is a local UI counter: it is not saved and the app does not learn from it. "Send feedback" packages a scan plus the user's corrections into a file for the developer. — [src/ui/components/ItemDetail.tsx](/home/user/puzzle-solver/src/ui/components/ItemDetail.tsx); [src/ui/screens/scan/ScanResultScreen.tsx](/home/user/puzzle-solver/src/ui/screens/scan/ScanResultScreen.tsx); [docs/TESTING.md](/home/user/puzzle-solver/docs/TESTING.md)
- Codebase:
  - About 31,000 lines of non-test TS/TSX under `src/`, and 73 unit-test files.
  - English only: `<html lang="en">`, no i18n library, about 290 hard-coded string literals in UI and pipeline code, about 90 JSX text nodes, and quality messages written inline in the pipeline.
  - No barcode code.
  - Development started 2026-10-17 by a single author (git log).
  — [index.html](/home/user/puzzle-solver/index.html); repository inspection

**Accuracy benchmark (`npm run bench`, re-run today, 75 tests passed, 2 skipped because the data is not present, 178 s wall time; results match `bench/baseline.json`):**
- **Synthetic scan suite** (37 scenarios). Built from Starry Night and The Great Wave only. Grids 16×20 (320), 20×30 (600), 25×40 (1000) and 6×3 (18). 6 to 30 items per photo, seeded renders with noise, blur, lighting, textured tables and shadows. — [bench/scan.eval.ts](/home/user/puzzle-solver/bench/scan.eval.ts); [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json)
  - Mean top-1 cell accuracy **0.868** (17 of 37 scenarios at 1.0). Mean top-3 **0.895**. Mean segmentation recall **0.973**.
  - **rotationOk = 1.0 in all 37**. Defined as top-1 placements whose turn is within 10° of the truth.
  - confidentPrecision mean **0.999** (minimum 0.953, starry-dense-touching): when the app says "confident", it is almost always right.
  - Fit (neighbour) precision 1.0 everywhere. Fit recall mean 0.846.
  - Clean or easy: starry-320-dark, wave-1000-dark (1000 pieces), starry-patches, wave-edges and the assembled-grid scenarios are all at top-1 = 1.0.
- **Weak cases (top-1)**, from [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json), re-run today with identical values:
  - starry-board-edge-patches 0.194
  - wave-rim-shadow-light 0.30 (segmentation recall 0.60)
  - starry-portrait-18-lone-block 0.50
  - starry-grey-neighbors (lower half flat grey, "as plain as a table") 0.586
  - wave-glare-uneven 0.65
  - wave-dark-grey-two-surfaces 0.667
  - starry-wood-tiles-real 0.688
  - wave-neighbors-wood 0.765
  - wave-wood-table 0.833
  - wave-woodgrain and wave-gingham 0.85
- **Processing time** (Node, as a proxy for phones):
  - About 0.5 to 4.2 s per synthetic scan.
  - 1.2 to 5.1 s per real photo in the feedback replay.
  - Box detection about 0.3 to 0.5 s per scene.
  - No on-phone timings are in the repository. The e2e suite checks that the UI stays responsive under 4× CPU throttling.
  — benchmark log, re-run today; [docs/TESTING.md](/home/user/puzzle-solver/docs/TESTING.md)
- **Box detection** (4 families × 12 scenes): success rate 1.0, mean corner error 0.001 of the diagonal, no false warnings (synthetic). — [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json)
- **Real third-party photos (Puzzle-Map, CC BY 4.0).** 643 labelled pieces across 7 reference pictures of 6-, 100- and 120-piece puzzles. Mostly single pieces held between fingers in front of a desk. Baseline values (data not fetched locally, so not re-run today):
  - Annotated (ideal outline): overall top-1 **0.939**, top-3 **0.972**, rotationOk 0.939, confidentPrecision 0.991. The 100-piece puzzle scored 0.846 top-1 and the 120-piece Avengers puzzle 0.946.
  - Through the app's own segmentation: segFound 0.927 but **segTop1 only 0.229** and segTop3 0.331. The eval notes this is because "Most photos show fingers and a desk around the piece, which segmentation is not made for."
  — [bench/puzzlemap.eval.ts](/home/user/puzzle-solver/bench/puzzlemap.eval.ts); [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json)
- **Real photos of the owner's 1500-piece puzzle, the 18-piece HABA puzzle and 5 Flickr table photos** (feedback replay, re-run today). These measure **detection only**, not placement, because the box art is stripped.
  - objectRecall is 1.0 on most of the owner's photos.
  - Precision is weak on cluttered or oblique tables: closeup-shadow-board 0.50, blue-table-block 0.333.
  - The Flickr stress photos are poor: sunlit wood recall 0.219 and precision 0.067; birds on oak 0.5 / 0.083; oblique map 0.5 / 0.333.
  - Peacock on white cloth (1000 pieces) scored 1.0 / 0.892.
  — [bench/feedback.eval.ts](/home/user/puzzle-solver/bench/feedback.eval.ts); [test-corpus/feedback/README.md](/home/user/puzzle-solver/test-corpus/feedback/README.md)
- **Side retrieval** (finding a piece's mating side among a scan's sides, synthetic, 870 queries). With detected corners:
  - best top-1 **0.576** and top-5 0.740 (DTW plus colour);
  - the default 'dtw-levelled' shape-only comparison: top-1 0.245.
  - With 2 to 5% corner jitter (simulating real photos), shape-only top-1 drops to 0.05 to 0.11. Colour holds up at about 0.42.
  - So shape-only partner finding is weak. Location-based fits (adjacent placements) carry the fit feature.
  — benchmark log, re-run today; [bench/sides.eval.ts](/home/user/puzzle-solver/bench/sides.eval.ts)
- **Test corpus.** `test-corpus/` holds no `*.json` puzzle exports, so the "Placed ✓" corpus suite was skipped. — [test-corpus/README.md](/home/user/puzzle-solver/test-corpus/README.md); benchmark log

### Inferences
- The headline accuracy numbers come from synthetic scenes using two famous, high-texture paintings. They should not be quoted as real-world accuracy. The only real-photo placement number in the repository (Puzzle-Map, 93.9% top-1) comes from small puzzles (at most 120 pieces) and ideal outlines.
- The strongest verifiable claims are:
  - rotation is right whenever the cell is right (100% in every synthetic scenario);
  - "confident" labels are reliable (≥ 95% precise in every scenario, 99% on Puzzle-Map).
  "When we say we're sure, we're right" is a defensible, evidence-backed message. No competitor publishes such a number.
- Low-texture, grey or "plain" regions are a measured weakness (58.6% top-1 on the grey-half scenario). This is the same weakness every competitor admits to.
- Segmentation of a hand-held single piece (fingers, desk) is poor (22.9% top-1). Any "quick single-piece mode" needs a "lay it on the table" capture, not "hold it up".

### Gaps
- No public real-photo placement accuracy on 500 to 2000 piece commercial puzzles. That data exists only in `test-corpus/private/` (not read, by instruction). The owner should run `bench/private.eval.ts` locally and quote that number if it can be published.
- No measured on-phone processing time. Node timings are only a proxy.
- Bundle size and first-load download size were not measured, because I did not run the build (it would have written `dist/`).

## 2. jellojm/puzzle-helper: algorithms, measured accuracy, workflow, rigor

### Takeaway
puzzle-helper is a different kind of product. It is a **live-camera sweep** that builds a persistent catalogue of every piece on the table, with a table "Map", calibrated edge-to-edge matching, border tracking and "open spot" detection late in a puzzle. It is aimed at iPhone Safari and built on a 13 MB OpenCV.js WASM build.

Its headline numbers ("right piece first 74 of 80", "next along the border 108 of 120") are **synthetic** results on small generated puzzles (63 to 80 cells). Its real-data measurements cover cataloguing, identity and pair joins on the owner's own videos and photos. It has **no real-photo box-placement accuracy figure**.

It shares no code with Puzzle Solver. It is plain JavaScript plus OpenCV.js, while Puzzle Solver is pure TypeScript with its own computer vision. It has no LICENSE file.

### Cited Findings
**Identity and stack:**
- "An iPhone web app (no App Store) for jigsaw puzzles. Point the camera at pieces spread on a table." The code is in `js/vision/` as "plain JavaScript + OpenCV.js, runs in a Web Worker". It uses "our own build of OpenCV with WebAssembly SIMD … falling back to the standard build". "The first launch downloads the vision library (about 10 MB)." — [README.md](/home/user/jellojm/puzzle-helper/README.md)
- The bundled `vendor/opencv-4.10.0-simd-em3174.js` is 13,042,575 bytes. The last commit is v0.28.0 (2026-10-11, author jellojm). The repository has no LICENSE file, so it is source-available on GitHub but not formally open source [inferred from the missing file]. The live deployment at jellojm.github.io/puzzle-helper/ returned HTTP 200 on 2026-10-22. — repository inspection; [git log](/home/user/jellojm/puzzle-helper)
- **No shared code:**
  - I compared all unique trimmed lines longer than 50 characters: 13,762 in Puzzle Solver's `src/` and 6,159 in puzzle-helper's `js/`.
  - Only 6 lines match, all generic boilerplate (`const now = () => (typeof performance …`, bounding-box initialisers, loop headers).
  - Puzzle Solver's only "OpenCV" mentions are comments about conventions ("as OpenCV's ORB").
  - The histories are disjoint: Puzzle Solver starts 2026-10-17 (tomquist), puzzle-helper is jellojm's.
  — repository inspection

**Workflow and UX (claimed in the README; much of it backed by tests):**
- **Scan:**
  - Sweep the phone slowly over the table. Each piece gets a catalogue entry and a dot that goes grey → blue (shape read) → green (placed on the box picture).
  - Dots follow the camera between readings, using a motion tracker on a 96 px thumbnail.
  - Gold dashed lines link pieces that "very likely fit together".
  - "Catalog from a photo" adds every piece from one full-resolution still.
- **Find:** tap a piece to see its box spot and its best partners for each edge. Verdicts are Strong match / Likely / Maybe / Look-alike / Unlikely, with "calibrated" percentages that "keep learning from your **Fits / No** answers on your own puzzle". There is a plain-piece warning when "its spot is only a rough guess".
- **Which way up:** an arrow on the piece and an upright thumbnail.
- **Mark as in the puzzle:** excludes that box cell from other pieces' candidates, with progress and undo.
- **Finders:** Border (corners orange, edges teal, with arrows to off-screen pieces), Corners/Edges, Unplaced, "Matches" (whole-catalogue pair search with no box needed, stepped through with Fits/No), Area search (drag across a region of the box picture), "Fill this spot", "Next along the border", and Zones (six areas A–F for sorting into trays).
- **Map:** a camera-off top-down view of every scanned piece, drawn as its own picture at its table position, so several people can share one iPad.
- **Open spots:** builds up the assembled part from close-up views, finds holes and pockets, recognises a finished border by itself, and reads cells against the box picture.
- **Capture coach, Teach background, and auto-pause** for battery.
— [README.md](/home/user/jellojm/puzzle-helper/README.md)

**Algorithms:**
- Per-frame segmentation at 640 px, picking a background model from candidates (dominant colour, taught colours, box palette).
- Shape reading: outline → 4 corners → 4 edges typed tab/blank/flat, with 32 shape points and 32 colour points per edge.
- Box placement: corners fix the rotation to 4 options and the grid fixes the scale; a colour pre-filter runs over every cell, then a pixel comparison over the top ~20.
- Matching: tab↔blank only; Procrustes shape distance plus colour across the seam plus a box-adjacency bonus, turned into a softmax probability with a "partner not scanned yet" option.
- Calibration: logistic model with mutual-best and 2×2 loop features, refit from the user's Fits/No answers once there are 12 or more.
- Cell assignment: one piece per cell via a sparse auction.
— [README.md "How it works"](/home/user/jellojm/puzzle-helper/README.md); [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)

**Measured numbers, and what they are measured on:**
- "Fill this spot": right piece first **74/80 vs 64/80 by the picture alone** [measured, synthetic]. The test (`test/solve-aids.js`) builds two synthetic puzzles (10×8 and 9×7, 48 px cells, seeds 41 and 43) and sets `PH.CLOSE_SIDE = 40` because "synthetic pieces are small". Raw edge scores used as the fit signal made it worse (16/80). — [test/solve-aids.js](/home/user/jellojm/puzzle-helper/test/solve-aids.js); [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- "Next along the border": **108/120 right**, from the same synthetic test. — [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- Box placement top-1 rose from **84.2% to 87.0%** (optimal 87.3%) with one-piece-per-cell assignment, on 292 synthetic pieces. — [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- Rotation hint: **37/37 within 20°** of the truth, synthetic (`test/trust.js`). Its tolerance is looser than Puzzle Solver's 10°. — [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- Answer key: 82/84 top suggestions right and 80/80 at ≥ 0.95 probability, synthetic. Loops of loops (2×3): 103/132 right, and 98/98 with mutual best. Calibration: held-out synthetic log-loss 0.236 → 0.12, calibration error 0.048 → 0.02. — [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- Capture coach: synthetic pale pieces on white read 0/48 right; the same pieces on dark cloth 48/48. — [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- **Real data** (the owner's videos and photos; only the answer keys are in git):
  - `real-50` on video IMG_3593 (50 pieces), v0.23.3, model clock: 48 checked, 47 identity matches, map error within tolerance for 45/47 (median 0.01 piece side), 47 edge codes right.
  - On IMG_3605 (38 pieces, a counter with lamp light): 29 to 34 checked, with 54 to 70 entries, which means duplicates and junk.
  - `real-joins` on the owner's labelled photos: 28 join sides, partner top-1 **19/28** (68%), top-3 23/28, shape-only top-1 12/28. The known-weak photos scored top-1 8/30 and top-3 14/30.
  — [test/results/history.jsonl](/home/user/jellojm/puzzle-helper/test/results/history.jsonl); [test/README.md](/home/user/jellojm/puzzle-helper/test/README.md)
- Known open problems in its own handoff:
  - the glass table (IMG_3609) is "still 0 checked";
  - joined pairs are not cut apart;
  - test timing does not match the phone ("Phone reports: `seg` 74–116 ms, `total` 145–212 ms a frame at 3.5–6 fps, against `budgetMs` 45");
  - many features are "unverified on the phone".
  — [HANDOFF-2026-10-07-v0.22.md](/home/user/jellojm/puzzle-helper/HANDOFF-2026-10-07-v0.22.md)
- Its own research notes: "Placement on the box picture is 'right region, not exact cell' at 300–1000 pieces", citing a WPI study in which SIFT placement falls from 91% to 54% between 24 and 96 pieces. — [RESEARCH-ai-puzzle.md](/home/user/jellojm/puzzle-helper/RESEARCH-ai-puzzle.md)

**Test rigor compared:**
- puzzle-helper:
  - `npm test` runs 28+ node scripts, stops at the first failure and takes about 10 minutes.
  - Real-data tests print PASS/FAIL against floors ("what the last release reaches, less the run-to-run spread") and keep a results history (113 runs logged from 2026-10-07 to 10-08).
  - It has an A/B tool against older commits and a phone-paced "model" clock.
  — [test/README.md](/home/user/jellojm/puzzle-helper/test/README.md)
- Puzzle Solver:
  - A CI-gated benchmark compared against `bench/baseline.json` with a 0.03 tolerance.
  - Exact synthetic ground truth across 37 + 4 + 8 scenario families.
  - A third-party real-photo dataset (Puzzle-Map, 643 pieces).
  - Answer-key replay of real and Flickr photos.
  - A private placement-truth harness.
  - Playwright e2e on Chromium and WebKit, with a mobile audit, PWA/offline and throttling tests.
  — [docs/TESTING.md](/home/user/puzzle-solver/docs/TESTING.md); [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json)

### Inferences
- **Rigor.** Both are unusually well measured for hobby apps. Puzzle Solver's measurement is broader and more reproducible: CI-gated, includes a public third-party real-photo dataset, and scores placement on real photos. puzzle-helper's real data is deeper on live tracking and pair joins, but limited to one owner's table and videos, and it reports no real box-placement accuracy. Neither publishes real placement accuracy on a large commercial puzzle.
- **The quoted numbers cannot be compared directly.** "74 of 80" is a fill-a-spot ranking task on 63 to 80 cell synthetic puzzles where neighbours are already placed. Puzzle Solver's 86.8% is top-1 cell placement from scratch, over 320 to 1000 cell synthetic puzzles. Puzzle-helper's 87.0% placement top-1 on 292 synthetic pieces is the closest like-for-like figure, and it is in the same range as Puzzle Solver's synthetic mean.
- **Where puzzle-helper is ahead on features:**
  - a persistent catalogue of every piece on the table;
  - edge-to-edge partner search that does not need the box ("Matches");
  - learning from Fits/No answers;
  - Border, Corners and Zones finders across the whole table;
  - a shared Map;
  - "open spots" for the late game.
- **Where Puzzle Solver is ahead:**
  - still-photo batches that work on any browser, not iPhone Safari only;
  - assembled patches located on the box;
  - guided step-by-step placing with turn words;
  - animated fit;
  - box auto-detection with candidates, and close-up stitching for a sharper reference;
  - no 13 MB WASM download;
  - measured rotation accuracy at a tighter 10° tolerance.
- **UX philosophy.** puzzle-helper is a power tool with many modes (Scan, Border, Find, Map, Zones, Matches, Teach background, Measure lens angle). Puzzle Solver is a linear "photo → result → place" flow. puzzle-helper's long feature list and its handoff notes ("No phone reviews for now", "unverified on the phone") suggest a steep learning curve and fragile live tracking.

### Gaps
- No real-photo box-placement accuracy for puzzle-helper was found in its plans, handoffs or results history.
- GitHub API metadata (stars, licence) could not be retrieved: the API returned empty fields. The licence status rests only on the missing LICENSE file.
- I did not run puzzle-helper's tests (read-only instruction), so its numbers are as reported in its files.

## 3. Competitors' claimed capabilities

### Takeaway
All five artwork-matching store apps (Solver Works, Puzzle Finder, PuzzleLens, Puzzle Detective, Puzzle Pointer) take **one piece per search**. None publishes an accuracy number.

- **Rotation guidance:** PuzzleLens and Puzzle Pointer.
- **Graded hints:** PuzzleLens.
- **Barcode catalogue:** Puzzle Pointer (10,000+ puzzles, iPhone, server plus OpenAI).
- **Many languages:** Puzzle Detective (21).
- **"Fits?" feedback loops:** Puzzle Pointer ("Did it fit?") and Puzzle Finder (email error report, added in v1.6).
- **Shape matching:** PuzPal is the only one, live camera, one gap or piece at a time.

### Cited Findings
- **Jigsaw Puzzle Solver (Solver Works, Android)** [claimed]:
  - "1. Take a photo of the complete puzzle image … 2. Take a photo of a single puzzle piece. 3. See the best matching location on the puzzle."
  - "some areas, such as blue skies or areas with little detail, are harder to match … illustrated puzzles are easier to match than puzzles based on photos."
  - "This app is a preview version."
  - 5K+ downloads, 50 reviews, contains ads, updated Oct 21, 2026.
  — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
  - Users report it is "less than 25% correct" (one review), with a percentage shown, and "the region is most of the time correct". — [competitors.md](/home/user/puzzle-solver/research_notes/Puzzle%20solver%20monetization/competitors.md)
- **Puzzle Finder (LY4Dev, Android)** [claimed]:
  - "Take a photo of your puzzle box … Photograph the piece you want to place … shows you exactly where it belongs"
  - "Advanced image recognition with OpenCV", "Works 100% offline - no internet required", "Supports puzzles of all sizes", "Fast and accurate results", "No data collection … No ads, no tracking".
  - v1.6 (Aug 30, 2026): "Report a detection error by email — images attached automatically".
  — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US)
- **PuzzleLens (iOS 18+, Mac and visionOS also listed)** [claimed]:
  - "photograph the piece you're stuck on … tells you the row, the column and which way to turn the piece"
  - "Ask for the region first, narrow it down, and only then ask for the exact cell and which way the piece turns … how many hints a puzzle took is kept in your records"
  - "Sky, water, flat colour areas … shows you a region and says it isn't sure"
  - "runs entirely on your iPhone. No internet needed"
  - progress mosaic gallery; optional friends sign-in.
  - **Languages: English and Turkish** (`languageCodesISO2A`: EN, TR).
  - Free with ads after scans; Pro subscription removes ads ($0.99/month per earlier notes).
  - v1.1.2, 2026-10-12, 0 ratings.
  — [iTunes lookup / App Store](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [competitors.md](/home/user/puzzle-solver/research_notes/Puzzle%20solver%20monetization/competitors.md)
  - "Works with 1000-piece puzzles". — [competitors.md](/home/user/puzzle-solver/research_notes/Puzzle%20solver%20monetization/competitors.md)
- **Puzzle Detective (iOS 16+)** [claimed]:
  - "photograph or select an individual puzzle piece … adjust the four corner handles … Confirm that the piece has been detected correctly … View multiple possible matching locations"
  - saves searched pieces per project; multiple projects; hamster mascot.
  - "Solid-color puzzle pieces do not contain enough visual information for reliable positioning."
  - **21 languages**: AR, BN, EN, FR, DE, HI, ID, JA, KO, MR, PT, RU, ZH, ES, SW, TA, TE, TR, UR, VI (ZH listed twice).
  - On-device or server processing is not stated. Has a trial ("Clearer purchase status and trial messages"). v1.0.1, 2026-10-17, 0 ratings.
  — [iTunes lookup / App Store](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)
- **Puzzle Pointer (iOS 17+, Mac and visionOS)** [claimed]:
  - "Scan the barcode on the box: over 10,000 puzzles are ready to go, from Ravensburger, Buffalo Games, Galison, White Mountain, Springbok, Cobble Hill and more. Not in the catalogue? Photograph the box front or search by name."
  - "Photograph one loose piece. The camera takes the shot when the piece is sharp and whole."
  - "best spots to try it, ringed on your puzzle picture, with your piece beside each one, turned the right way"
  - "Did it fit? Tap yes, or move to the next spot."
  - "plain sky or single-colour pieces get a heads-up before you use a search"
  - "Share a found piece as a picture card."
  - **English only**.
  - 5 free searches, then $2.99 for 10, or $6.99/month.
  — [iTunes lookup / App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
  - Website: "Photos are sent to process your search", "Each piece you search uses one search, whether or not a spot is found", a failed search earns "one extra free search, up to 10 free in total", and no accuracy figure is given. — [puzzlepointer.com](https://puzzlepointer.com/)
  - Privacy policy: the search runs on its server, photos are stored in Cloudflare R2, and a reduced copy goes to OpenAI to check box photos. — [puzzlepointer.com/privacy](https://puzzlepointer.com/privacy/) (via [competitors.md](/home/user/puzzle-solver/research_notes/Puzzle%20solver%20monetization/competitors.md))
- **PuzPal (iPhone)** [claimed]:
  - Three modes: "Scan Gap … move loose pieces into view one at a time until a likely match appears", "Scan Piece … then scan missing gaps around the board", and "Scan Edge" ("a fallback, not the strongest mode").
  - "It matches shape on your iPhone, not puzzle artwork in the cloud"; "Native iPhone app".
  - No price or accuracy is stated.
  — [puzpal.com](https://puzpal.com/)
  - It "appears not yet live" on the App Store (the /download/ page said the listing was "being connected"). — [competitors.md](/home/user/puzzle-solver/research_notes/Puzzle%20solver%20monetization/competitors.md)
- **Browser barcode support** (relevant to closing Puzzle Pointer's gap). The BarcodeDetector API is supported in Chrome for Android. It is **disabled by default on iOS Safari 17.0 to 27.2** and unsupported in Firefox. A PWA would therefore need a JS/WASM decoder on iPhone. — [caniuse: BarcodeDetector](https://caniuse.com/mdn-api_barcodedetector)

### Inferences
- "Honest about plain pieces" is now table stakes: four of the six apps say it. Puzzle Solver has confident and unsure states ("Probably goes here"), but no explicit "this is a plain/sky piece" label and no up-front map of hard regions. That gap matters for marketing.
- The barcode catalogue is Puzzle Pointer's real moat. It depends on a server, a licensed or scraped catalogue of publisher artwork, and OpenAI. Puzzle Solver can't copy it cheaply without dropping its no-upload, no-server position. Licensing the artwork is the hard part, not decoding the barcode.
- Since none of the apps publishes accuracy, Puzzle Solver's measured, reproducible numbers are a differentiator, provided they are framed honestly (synthetic plus small real puzzles).

### Gaps
- Android listings show no language list in the HTML I could parse. Their language support is unknown.
- No competitor publishes accuracy, maximum piece counts (except PuzzleLens's "Works with 1000-piece puzzles"), minimum photo resolution, or processing time.
- No head-to-head test on the same puzzle exists. I could not run any competitor app: they are native mobile apps and this environment has no device.

## 4. Capability matrix (rows = capabilities, columns = products)

### Takeaway
Puzzle Solver leads on batch size, assembled patches, guided placement, fit visualisation, cross-platform reach and measured accuracy. It trails on:
- onboarding without a box photo (barcode);
- languages;
- graded hints;
- an explicit low-texture warning;
- answers that learn or are saved (Fits/No);
- whole-table cataloguing and box-free pair search (puzzle-helper).

### Cited Findings
Legend:
- **V** = verified: measured by a benchmark, test or source code I read.
- **C** = claimed in a listing or README, not verified.
- **—** = not offered, or not mentioned anywhere.
- **?** = unknown.

| Capability | **Puzzle Solver** (PWA) | jellojm puzzle-helper (iPhone web app) | Solver Works (Android) | Puzzle Finder (Android) | PuzzleLens (iOS) | Puzzle Detective (iOS) | Puzzle Pointer (iOS) | PuzPal (iOS, not live?) |
|---|---|---|---|---|---|---|---|---|
| Input mode | Still photos of 10–40 pieces **V** (code/tests) | Live camera sweep + optional still **V** (tests) | 1 piece photo **C** | 1 piece photo **C** | 1 piece photo **C** | 1 piece photo **C** | 1 piece photo, auto-capture **C** | Live camera, 1 gap/piece at a time **C** |
| Pieces per photo/search | 10–40 (bench up to 30 items + patches) **V** | Whole table, catalogued **V** (synthetic 96; real videos 38–50) | 1 **C** | 1 **C** | 1 **C** | 1 **C** | 1 (each search metered) **C** | 1 **C** |
| Box placement (cell) | Yes; synthetic mean top-1 86.8%, Puzzle-Map real 93.9% (ideal outline) **V** | Yes; synthetic top-1 87.0% (292 pcs) **V**; no real figure | Yes **C** (users: region often right, "<25%" one review) | Yes **C** | Row/col **C** | Multiple candidates **C** | Ranked spots **C** | — (shape only) |
| Rotation guidance | Yes, words + animated turn; 100% within 10° when cell right (synthetic) **V** | Arrow + upright thumbnail; 37/37 within 20° (synthetic) **V** | — | — | Yes **C** | — | Yes (piece shown turned) **C** | n/a |
| Confidence / "not sure" | Confident vs unsure; confident precision 99.9% synthetic, 99.1% Puzzle-Map **V** | Calibrated % + verdict words, plain-piece warning **V** (synthetic calibration) | % shown **C** | — | "Says it isn't sure" on sky/flat **C** | Solid-colour disclaimer **C** | Plain-colour heads-up before search **C** | Confidence meter **C** |
| Explicit low-texture (sky) warning | No explicit label (only "unsure") **V** (code) | Yes **V** (code) | Disclaimer **C** | — | Yes **C** | Disclaimer **C** | Yes **C** | — |
| Piece-to-piece fit | Yes, from placements + side DTW; fit precision 1.0, recall 0.846 synthetic; shape-only partner top-1 0.25 **V** | Yes, tab↔blank shape + seam colour, box-free; real join top-1 19/28 **V** | — | — | — | — | — | Yes (shape) **C** |
| Fit visualisation | Animated "show the fit" **V** | Arcs/glow on camera + Map **C** | — | — | — | — | — | Live overlay **C** |
| Assembled patches located on box | Yes; assembledRecall 1.0 in most scenarios **V** | Assembled part tracked, "open spots" **V** (tests) | — | — | — | — | — | Gap scanning **C** |
| Guided step-by-step placement | Yes ("Start placing") **V** | — (finders instead) | — | — | — | — | — | — |
| Graded hints (region → cell → turn) | — **V** | Zones / area search (partial) **C** | — | — | Yes **C** | — | — | — |
| "Wrong, try next" | "Not this one" → next candidate, not saved, not learned **V** | Fits/No, logged, refits calibration **V** | — (dev: "hadn't thought about that") | Email error report **C** | — | — | "Did it fit?" + refund search **C** | — |
| Border/edge finder | Edge filter, piece kind **V** | Border/Corners/Edges, next-along-border 108/120 synthetic **V** | — | — | — | — | — | Scan Edge **C** |
| Box lookup without photo | — (photo + piece count) **V** | — | — | — | — | — | Barcode, 10,000+ catalogue, name search **C** | n/a |
| Box auto-detection / sharpening | Auto quad + candidates (synthetic success 1.0); close-up stitching **V** | Manual corners **C** | ? | ? | ? | Manual 4 handles **C** | Auto via catalogue/photo **C** | n/a |
| Photo quality feedback | 16 quality codes with hints; live meter **V** | Capture coach, hold-still hint **V** | Tips **C** | — | — | Tips + detection confirm **C** | Auto-capture when sharp **C** | Lighting FAQ **C** |
| On-device / offline | Yes; pure TS, no server; offline PWA **V** (code, e2e) | Yes; 10–13 MB OpenCV download, then offline **V** | Unclear; ad SDK shares IDs **C** | Yes **C** | Yes, but tracking ads **C** | ? | No: server + OpenAI **C** | Yes **C** |
| Platforms | Any modern browser; e2e on Chromium + WebKit **V** | iPhone Safari focus **C** | Android | Android | iOS/Mac/visionOS | iOS | iOS/Mac/visionOS | iOS |
| Languages | English only **V** | English only **V** (README/UI) | ? | ? | EN, TR **C** | 21 **C** | EN **C** | ? |
| Multiple puzzles / progress | Yes, progress %, export/import **V** | Yes, several puzzles, % done **V** | ? | ? | Gallery + mosaic **C** | Projects + saved pieces **C** | Saved puzzles/pieces **C** | ? |
| Published accuracy | Yes (benchmark in repo) **V** | Yes (synthetic + owner's data) **V** | No | No | No | No | No | No |
| Price | Free (today) | Free | Free + ads | Free + Ko-fi | Free + ads; Pro sub | Trial; $4.99/3 mo, $9.99/yr, $19.99 lifetime | 5 free; $2.99/10; $6.99/mo | One-time (TBD) |

Sources:
- Puzzle Solver: [README.md](/home/user/puzzle-solver/README.md), [docs/ARCHITECTURE.md](/home/user/puzzle-solver/docs/ARCHITECTURE.md), [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json), benchmark re-run 2026-10-22.
- puzzle-helper: [README.md](/home/user/jellojm/puzzle-helper/README.md), [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md), [test/results/history.jsonl](/home/user/jellojm/puzzle-helper/test/results/history.jsonl).
- Store apps: [Solver Works](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US), [Puzzle Finder](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US), [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555), [Puzzle Detective](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265), [Puzzle Pointer](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519), [puzzlepointer.com](https://puzzlepointer.com/), [puzpal.com](https://puzpal.com/).
- Prices: [competitors.md](/home/user/puzzle-solver/research_notes/Puzzle%20solver%20monetization/competitors.md).

### Inferences
- **What to emphasise**, in this order:
  1. Many pieces per photo, against everyone's one at a time. Puzzle Pointer charges per piece, so a 40-piece batch would cost about $12 in its packs.
  2. Assembled patches plus guided placement with turn instructions. No other app does both.
  3. "When it says sure, it's right": 99%+ confident precision, measured.
  4. No upload, any device, no install.
- **What not to overclaim:** real-world accuracy on big photographic puzzles. Plain or grey areas measure at about 59% top-1 even synthetically, and edge-of-board patches at about 19%.

### Gaps
- Competitor cells marked **C** are listing claims only. Competitor accuracy is unknown and untested.

## 5. Gaps that are cheap to close, with effort estimates from the codebase

### Takeaway
The cheapest wins are mostly UI-only:
- Graded hints: about 1 to 2 days.
- An explicit "plain piece / hard area" label and box-picture overlay: about 2 to 3 days.
- Saving the existing "Not this one" answers as Fits/No style feedback and showing a "next spot" loop in placing mode: about 1 to 2 days.
- A "single stuck piece" capture preset: about 2 to 4 days. The matcher already handles lone pieces; capture guidance is what's missing.
- Language support: about 1 week of plumbing, plus translation per language.

Barcode decoding alone is cheap. A Puzzle Pointer-style catalogue is not, because of artwork licensing and the need for a server.

### Cited Findings
- **"Wrong, try again" already exists in part.** `ItemDetail.tsx` has a "Not this one" button (`data-testid="not-this-one"`), shown only when there is more than one candidate. `ScanResultScreen.tsx` keeps the rejections in transient React state (`setRejected`). The answer is not saved and does not affect matching. puzzle-helper logs every Fits/No answer and refits its calibration once it has 12 or more. Puzzle Pointer rewards a failed search with an extra free search. — [src/ui/components/ItemDetail.tsx](/home/user/puzzle-solver/src/ui/components/ItemDetail.tsx); [src/ui/screens/scan/ScanResultScreen.tsx](/home/user/puzzle-solver/src/ui/screens/scan/ScanResultScreen.tsx); [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md); [App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
- **Graded hints.** The placing mode already frames the target at about 7 × 7 cells plus a whole-picture overview (`ui/lib/framing.ts`), and the turn is a separate component (`TurnGuide`). A "region → cell → turn" reveal is a UI state on top of existing pieces. PuzzleLens markets this and logs hints per puzzle. — [docs/ARCHITECTURE.md](/home/user/puzzle-solver/docs/ARCHITECTURE.md); [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
- **Low-texture labelling.** Matching already computes a confidence from the margin over the best distinct alternative, and the reference is a Lab pyramid with known pixels per cell. A per-cell texture measure (Puzzle-helper uses `t2.tex < 0.2` for its plain-piece warning) could drive a "plain piece, several spots look alike" label and a hard-areas overlay on the Picture tab. — [docs/ARCHITECTURE.md §5](/home/user/puzzle-solver/docs/ARCHITECTURE.md); [PLAN-hard-issues.md](/home/user/jellojm/puzzle-helper/PLAN-hard-issues.md)
- **Single-piece quick mode.** Unit tests show the matcher placing single pieces with no shape and no body size, by scale search (`match.test.ts`: "places single pieces without shape or body size (scale search)"). On Puzzle-Map, single pieces with ideal outlines placed at 93.9% top-1. But segmenting hand-held photos placed only 22.9%. The camera tips currently say "10–40 pieces per photo" (`CameraCapture.tsx`). — [src/pipeline/match/match.test.ts](/home/user/puzzle-solver/src/pipeline/match/match.test.ts); [bench/baseline.json](/home/user/puzzle-solver/bench/baseline.json); [src/ui/components/CameraCapture.tsx](/home/user/puzzle-solver/src/ui/components/CameraCapture.tsx)
- **Languages.** There is no i18n layer. User-facing text sits in about 290 string literals across `src/ui` and `src/pipeline`, plus about 90 JSX text nodes. Quality messages and hints are built in the pipeline (`quality.ts` `issue(..., 'The pieces are small in the photo.', HINT.resolution)`), so they must be turned into codes plus parameters. Turn words come in angle bands (`ui/lib/rotation.ts`), which also need localising. Puzzle Detective ships 21 languages; PuzzleLens ships English and Turkish. — [src/pipeline/pieces/quality.ts](/home/user/puzzle-solver/src/pipeline/pieces/quality.ts); [docs/ARCHITECTURE.md](/home/user/puzzle-solver/docs/ARCHITECTURE.md); [Puzzle Detective](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)
- **Barcode.** No barcode code exists. The native BarcodeDetector is off by default on iOS Safari, so iPhone would need a WASM decoder. Puzzle Pointer's catalogue relies on a server and OpenAI. — repository grep; [caniuse](https://caniuse.com/mdn-api_barcodedetector); [puzzlepointer.com/privacy](https://puzzlepointer.com/privacy/)
- **Box-free pair search and whole-table catalogue** (puzzle-helper's "Matches" and "Fill this spot"). Puzzle Solver's shape-only side retrieval is weak: top-1 0.245 with detected corners and about 0.11 with jitter. Colour plus DTW reaches 0.576 / 0.42. Its fits rely on box placements. — benchmark re-run 2026-10-22; [bench/sides.eval.ts](/home/user/puzzle-solver/bench/sides.eval.ts)

### Inferences
Effort estimates assume one developer who knows the codebase; all are [inferred]. S ≈ ≤ 2 days, M ≈ 3 to 5 days, L ≈ 1 week or more.

| Gap (competitor that has it) | Effort | Notes |
|---|---|---|
| Graded hints: region → cell → turn, with a hint count per puzzle (PuzzleLens) | **S** | UI state in PlacingScreen/ItemDetail plus one stored counter. Also answers the "cheating" stigma. |
| Explicit "plain piece / look-alike spots" label, plus a hard-areas overlay on the box picture (PuzzleLens, Puzzle Pointer, Detective) | **S–M** | Per-cell texture from the existing reference index; use the margin between candidates for the piece label. High marketing value. |
| Make "Not this one" a saved Fits/No answer; show "Did it fit? Next spot" in guided placing; feed answers into the feedback export (Puzzle Pointer, puzzle-helper) | **S** | Rejections already exist in state. Saving them in IndexedDB and adding them to Send feedback is small. Learning or calibration from answers is **M**. |
| "One stuck piece" preset: a capture tip ("lay it on the table"), skipping the 10-piece guidance, showing the top-3 spots (all store apps) | **S–M** | The matcher supports lone pieces. Mostly copy and UX, plus a Puzzle-Map-style test with on-table single pieces. |
| Multi-language UI, starting with DE/FR/ES/NL | **M**, then about 1 day per language for translation and QA | Add a small i18n layer, extract about 380 strings, and turn pipeline messages into code plus parameters. |
| Barcode scan that pre-fills name, piece count and size (partial Puzzle Pointer) | **M** | WASM decoder plus a public product lookup. Breaks the "nothing leaves the device" claim unless the user opts in. |
| Barcode → box artwork catalogue (Puzzle Pointer) | **L** plus licensing | Needs a server, artwork rights and catalogue upkeep, which conflicts with the privacy positioning. Not cheap; not recommended near term. |
| Share a found piece as an image card (Puzzle Pointer) | **S** | The cut-out and framing code already exists (`usePieceCutout`, `framing.ts`). |
| Box-free pair search across scans / whole-table catalogue (puzzle-helper) | **L** | Needs much better shape-plus-colour side matching (top-1 is 0.25 to 0.58 now) and cross-scan piece identity. |

### Gaps
- Effort estimates come from reading module structure and string counts, not from prototyping.
- I did not check whether piece outlines and confidence margins are already exposed to the UI in the form a texture label needs. A quick spike in `src/pipeline/match/` would confirm it.
