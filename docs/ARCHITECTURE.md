# Puzzle Solver – Architecture

A browser-only jigsaw puzzle assistant. You photograph the puzzle box once, then photograph
handfuls of loose pieces; the app finds every piece in the photo, tells you where it goes in the
picture (and how to turn it), which pieces fit together, and warns when a photo is not good enough
to be analysed. Everything runs locally in the browser – no server, no upload.

## 1. User flows

### 1.1 Set up a puzzle
1. **Box photo** – take a photo of the box (camera via `getUserMedia`, or `<input type=file
   capture>` / gallery upload). Photos are EXIF-rotated and limited to 4096 px.
2. **Find the picture** – `detectBox` proposes the quadrilateral of the picture on the box (several
   candidates: whole lid, picture inside a printed frame). The user can drag the four corners (with
   a magnifier) and cycle candidates.
3. **Details** – name, number of pieces, physical width × height (cm/in). The physical size fixes
   the aspect ratio for perspective correction and, together with the piece count, determines the
   grid (`estimateGrid`, e.g. 1000 pieces at 70×50 cm → 38 × 27). The grid can be overridden. Cut
   style: grid (default) or irregular.
4. **Rectify** – the picture is perspective-corrected into the *reference image*.
5. **Optional close-ups** – if the reference has too few pixels per piece (quality check
   `reference_low_resolution`), the user can add close-up photos of parts of the box. Each is
   registered against the reference (ORB-style features + RANSAC homography) and composited into a
   higher-resolution reference.
6. **Save** – everything (photos, reference, thumbnail, settings) goes to IndexedDB, so the
   puzzle is there next time the page is opened. Puzzles can be exported/imported as files.

### 1.2 Solve
1. **Scan** – spread a handful of pieces (or assembled patches) on a contrasting, plain background
   and take one photo. A live quality meter (sharpness/exposure) helps before pressing the shutter.
2. **Analyse** (Web Worker): quality checks → segmentation → per-region shape analysis → matching
   against the reference → fit detection.
3. **Results** – the photo with every piece thinly outlined (no fill) and a small number label
   placed just outside the outline (`ui/lib/labels.ts`), colour-coded by confidence; a short pink
   bar on the edge that must end up on top (`topBarFor`, from `upVector`); connection lines are
   dotted light lines with dark-rimmed dots that flow toward the biggest unit of their cluster
   (`flowDirections` in `ui/lib/linkGraph.ts`: the item with the most pieces, then the most links;
   each line toward its end nearer to it), routed around the pieces (`routeLink` in
   `ui/lib/route.ts`: each end leaves its joining side along the outward normal; a curve that would
   still cut through a body goes round it on the shorter side). Press-and-hold shows the clean photo. Tapping a piece
   selects it: its connection lines turn thicker and cyan, the pieces it joins get cyan outlines
   and rings, their connections in turn (levels 2–3, `selectionLevels`: whole levels only, at most
   12 more items and about a quarter of all items) lighter cyan outlines and lines without rings,
   everything else fades and the photo around them darkens (one even-odd path), and a bar replaces
   the action bar with where it goes and its connections in words (each mention selects that
   piece, "· N more beyond" counts the rest); the box picture's markers and the full-screen view
   show the same levels. "Show the fit" (▶ next to a mention, or a tap on a level-1 line): the
   smaller item, cut out of the photo, glides along the routed line to its docked pose next to the
   other one as that one lies (`fitPose` in `ui/lib/fit.ts`: turn by the difference of the two
   rotations, offset by the touching cells' grid step along the anchor's axes, per-axis cell size
   from the box picture's cell aspect), clicks in at the seam, holds and fades back (`FitAnimation`:
   Web Animations transforms, paused while the view moves; reduced motion: a static docked ghost).
   The details sheet adds the box
   picture around the target, the piece type (corner/edge/interior), the rotation needed and the
   other candidates. The reference shows numbered markers at the matched locations. Photo and
   picture open in a full-screen view (Fullscreen API where available, else a fixed layer; closes
   with ×, Esc or back) that shares the selection.
   Overlay strokes inside the zoom view are sized with `--u` (one screen px in content units, set
   by `ZoomPanView`): `vector-effect: non-scaling-stroke` does not undo its CSS scale. Every change
   of a line's dash offset restyles and repaints it, so the flow is a timer (`useLineFlow`) that
   steps the offset by about one screen px 5 or 10 times a second (a CSS animation would restyle
   every frame, also while panning or scrolling), holds still while the view moves (`data-moving`),
   the page scrolls or the full-screen view covers it, and rests after ~13 s (~18 s after a
   selection). Pan and pinch move the content with a transform written straight to the element:
   no React render and no change of `--u` per move; the new scale is committed (one render) when
   the gesture ends, so strokes and labels scale with the photo for that moment. On a 4× throttled
   CPU with the 87-item scan this keeps pinch, pan and page scroll at 53–60 fps. At the fit
   zoom a one-finger drag on a picture scrolls the page (`touch-action: pan-y`); zoomed in, it pans.
   The guided placing mode shows one item at a time: the photo around it as it lies (3–4 piece
   sizes, corner marks, the pink "top" bar labelled "top"; tap for a close-up), the turn, and the
   upright box picture around the target (about 7 × 7 cells, at most 2.5× the picture's
   resolution, pinch to zoom) with an overview of the whole picture (`ui/lib/framing.ts`).
   The turn is shown with the piece itself (`TurnGuide`, also in the details sheet): its cut-out
   (drawn once, masked by its outline – `usePieceCutout`) turns from how it lies to upright the
   short way with a CSS transform (ease in-out 1.2 s, hold 1 s, three loops, tap replays) next to
   an arc arrow that grows with it; with reduced motion "now → then" side by side; upright pieces
   get "✓ right way up". The words come in bands of the short-way angle (`ui/lib/rotation.ts`):
   < 10° "Already the right way up", < 35° "a little", < 60° "half a quarter", < 120° "a quarter",
   < 155° "nearly halfway round", else "upside down" – right = clockwise – with the exact angle
   ("84° clockwise") in small print.
4. **Confirm** – marking a piece as placed records its cell in the solving progress; placed cells
   are shaded on the reference and de-prioritised in later matches.
5. **Quality feedback** – blurry, dark, glare, low contrast, too small, touching pieces, pieces cut
   off by the photo border … each with an actionable hint.

### 1.3 Additions beyond the original brief
- Export/import puzzles as a single file (backup, move to another device).
- Solving progress tracking (placed cells, percentage).
- Edge/corner piece detection – flat sides restrict a piece to the border and fix its rotation;
  the UI can filter "show only edge pieces" to help sort.
- Shape-based fit hints for pieces whose image content is ambiguous (sky, water).
- Live camera quality meter, multiple box-detection candidates, magnifier for corner editing.
- Works offline once loaded (static files only).

## 2. Code layout and ownership

```
src/
  cv/                 Pure TS image-processing primitives. No DOM. (core: image, color, filter,
                      resize, geometry, warp, raster)
    threshold.ts      Otsu / adaptive threshold                         [cv-shapes]
    morphology.ts     binary erode/dilate/open/close, fillHoles          [cv-shapes]
    components.ts     connected-component labelling                      [cv-shapes]
    contour.ts        outer contour tracing                              [cv-shapes]
    polygon.ts        simplify, hull, min-area rect, perimeter, ...      [cv-shapes]
    edges.ts          Canny                                              [cv-shapes]
    features/         keypoints, descriptors, matching, RANSAC           [stitch]
  pipeline/           Higher-level algorithms built on cv/ (pure TS, worker-safe)
    grid.ts           piece count + aspect → rows × cols                 [storage]
    box/              box/picture quad detection, reference quality      [box]
    stitch/           close-up registration + high-res compositing       [stitch]
    pieces/           segmentation, piece shape analysis, photo quality  [pieces]
    match/            reference index, piece/patch placement, fit hints  [match]
    analyzeScan.ts    orchestration of one scan                          [integration]
  model/types.ts      Domain model shared by everything (structured-clone safe)
  storage/            IndexedDB repository (+ in-memory variant)         [storage]
  worker/             api.ts (contract), worker entry + client           [integration]
  platform/           Browser-only helpers: blob ↔ RGBAImage, camera     [ui]
  ui/                 React UI                                           [ui]
  testing/            Synthetic jigsaw generator + Node image IO for tests [match]
```

Rules:
- `src/cv` and `src/pipeline` must not touch the DOM (`document`, `window`, canvas). They run in a
  Web Worker and in Node tests. `OffscreenCanvas` is also off-limits there – stay pure TS.
- Everything crossing the worker boundary or stored must be structured-clone friendly.
- Each package exposes its public API through an `index.ts`.
- Unit tests live next to the code as `*.test.ts` and run in Node with Vitest (`npm test`).
- Debug images: tests may write PNGs to `.debug/<area>/` (git-ignored) when `DEBUG_IMAGES=1`, using
  `savePng` from `src/testing/nodeImageIO.ts`.

## 3. Conventions

- **Coordinates**: x right, y down; integer coordinates are pixel centers.
- **Angles**: radians in `cv/`, degrees in the domain model (`…Deg`). Positive = clockwise on screen.
- **Quads**: `[TL, TR, BR, BL]`, clockwise on screen (`orderQuad`).
- **Matrices**: `Mat3` row-major; a matrix maps *source* → *destination* (`warpRGBA(src, H, …)`
  inverts internally).
- **Masks**: `Uint8Array` with 0/1.
- **Grid cells**: `(row, col)`, 0-based; cell `(r, c)` covers reference pixels
  `[c·W/cols, (c+1)·W/cols) × [r·H/rows, (r+1)·H/rows)`.
- **Piece local frame**: `PieceShape.corners[0]` is the top-left corner after rotating the photo
  by `-angleDeg`; sides 0..3 = top, right, bottom, left in that frame.
- **Placement rotation**: `Placement.rotationDeg` = clockwise rotation that turns the piece *as it
  lies in the photo* into its upright orientation in the finished puzzle. The UI draws an "up" arrow
  on the piece pointing at photo direction `rotate(-rotationDeg) · (0, -1)`.

## 4. Module contracts

Signatures every package must provide (exported from its `index.ts`). Types come from
`src/model/types.ts` and `src/cv/*`.

### cv-shapes (`src/cv/*.ts`)
```ts
otsuThreshold(values: GrayImage, mask?: Mask, bins?: number): { threshold: number; separability: number }
threshold(img: GrayImage, t: number): Mask                       // 1 where value > t
adaptiveThreshold(img: GrayImage, radius: number, offset: number): Mask
erode / dilate / open / close (m: Mask, radius: number, shape?: 'square' | 'disk'): Mask
fillHoles(m: Mask): Mask
labelComponents(m: Mask, connectivity?: 4 | 8): { labels: Int32Array; count: number; stats: ComponentStats[] }
  // ComponentStats { label, area, bbox: Rect, centroid: Point, touchesBorder: boolean }
  // ComponentStats also has `start: Point` (raster-first pixel; fast start for traceOuterContour)
componentMask(labels, width, label, bbox, pad?): Mask             // bbox(+pad)-sized mask of one component
findOuterContours(m: Mask, minArea?): { contour: Point[]; stats: ComponentStats }[]
traceOuterContour(m: Mask, start?: Point): Point[]                // clockwise, pixel coordinates
simplifyPolygon(pts: Point[], epsilon: number, closed?: boolean): Point[]  // Douglas–Peucker
convexHull(pts: Point[]): Point[]
polygonArea(pts) / polygonPerimeter(pts) / polygonCentroid(pts)
minAreaRect(pts: Point[]): { center: Point; width: number; height: number; angle: number; corners: Quad }
smoothContour(pts: Point[], sigma: number): Point[]               // closed-curve Gaussian smoothing
resampleContour(pts: Point[], n: number, closed?: boolean): Point[] // equal arc-length
pointInPolygon(p: Point, poly: Point[]): boolean
canny(img: GrayImage, low: number, high: number, sigma?: number): Mask   // thresholds in Sobel units (step H ≈ 4H)
houghLines(edges: Mask, opts?): { rho; theta; votes }[]          // x·cosθ + y·sinθ = ρ
fitLine(pts): { point; direction } | null;  lineIntersection(p1, d1, p2, d2): Point | null
distanceTransform(m: Mask, opts?): GrayImage                      // exact Euclidean, set pixels → distance to nearest unset
```

### quality metrics (`src/pipeline/quality/metrics.ts`, shared)
```ts
blurMetric(gray, mask?, radius?): number        // 0 sharp .. 1 blurry, content-normalised
laplacianVariance(gray, mask?): number
exposureStats(img, mask?): { mean; clippedLow; clippedHigh; p05; p95 }
glareMask(img, opts?): Mask
noiseSigma(gray): number
```

### stitch (`src/cv/features/`, `src/pipeline/stitch/`)
```ts
detectFeatures(img: GrayImage, opts?): { keypoints: Keypoint[]; descriptors: Uint8Array }   // ORB-like
matchFeatures(a, b, opts?): FeatureMatch[]                                                   // ratio + cross-check
ransacHomography(src: Point[], dst: Point[], opts?): { H: Mat3; inliers: boolean[] } | null
registerCloseup(reference: RGBAImage, closeup: RGBAImage): CloseupRegistration | null
composeHighRes(reference, closeups: { image; registration }[], opts: ComposeOptions): RGBAImage
```

### box (`src/pipeline/box/`)
```ts
detectBox(photo: RGBAImage, opts?): BoxDetection   // candidate labels: 'picture' | 'lid' | 'frame-inner' | 'alternative' | 'whole-photo'
suggestRectifiedSize(quad: Quad, aspect?: number, maxSide?: number): { width: number; height: number }
rotateQuad(quad: Quad, quarterTurns: number): Quad  // +1 = rectified output rotated 90° clockwise
estimateQuadAspect(quad: Quad): number
assessReference(reference: RGBAImage, grid: GridSpec): QualityReport   // px per cell, sharpness, glare
```

### pieces (`src/pipeline/pieces/`)
```ts
segmentPieces(photo: RGBAImage, opts?): Segmentation
  // Segmentation { regions: SegmentedRegion[]; background: { color: [L,a,b]; ... }; foreground: Mask; quality: QualityReport }
  // SegmentedRegion { region: DetectedRegion; mask: Mask /* bbox-sized */; }
analyzePieceShape(contour: Point[], mask?: Mask, bboxOrigin?: Point): PieceShape | null
dominantOrientation(contour: Point[]): number                     // degrees in (-45, 45]
assessPhoto(photo: RGBAImage, seg?: Segmentation): QualityReport
assessFrame(frame: RGBAImage): FrameQuality
```

### match (`src/pipeline/match/`, `src/testing/synth.ts`)
```ts
buildReferenceIndex(reference: RGBAImage, grid: GridSpec, cut: CutStyle): ReferenceIndex
matchRegion(index: ReferenceIndex, input: MatchInput, opts?: MatchOptions): RegionMatch
matchRegions(index, inputs: MatchInput[], opts?): RegionMatch[]   // whole scan; 2 passes with photo→print colour correction
  // MatchInput { regionId; kind: RegionKind; image: RGBAImage (bbox crop); mask: Mask (same size);
  //              origin: Point (crop origin in photo coords); shape?: PieceShape (photo coords);
  //              orientationDeg: number; expectedBodySize?: number /* photo px per cell */ }
  // MatchOptions { placedCells?: CellRef[]; maxCandidates?: number }
findFits(regions: DetectedRegion[], matches: RegionMatch[], grid: GridSpec, opts?: FitOptions): FitHint[]
  // FitOptions { shape?: 'rms' | 'dtw' | 'dtw-levelled'; band?; strips?: Map<regionId, EdgeStrips>; colourShare?; cache? }
sampleEdgeStrips(image, mask, origin, contour, shape): EdgeStrips | null   // Lab strip just inside each side
// synthetic data for tests
generateJigsaw(rows, cols, width, height, seed): JigsawCut       // piece outlines in reference coords
renderPiecesPhoto(reference, cut, pieces: (number | number[])[], opts): { photo: RGBAImage; truth: PieceTruth[] }  // arrays = patches
renderBoxPhoto(reference, opts): { photo: RGBAImage; pictureQuad: Quad; lidQuad: Quad }
truthPieceShape(cut, truth): PieceShape;  perturbReference(img, opts): RGBAImage
```

### storage (`src/storage/`, `src/pipeline/grid.ts`)
```ts
createIndexedDbRepository(dbName?: string): PuzzleRepository
createMemoryRepository(): PuzzleRepository
estimateGrid(pieceCount: number, aspect: number): { best: GridSpec; candidates: GridSpec[] }
```

### integration (`src/worker/`, `src/pipeline/analyzeScan.ts`)
`analyzeScan(index, photo, options, onProgress)` chains: limit size → `segmentPieces` →
`analyzePieceShape` per region → `assessPhoto` → `matchRegion` per region → `findFits`. The worker
exposes `PipelineApi` (see `src/worker/api.ts`) via Comlink.

## 5. Algorithms (summary)

**Box detection** – downscale to ~1000 px; candidate quads from (a) Canny edges → contours →
polygon approximation to 4 convex vertices, (b) colour segmentation against the photo border,
(c) dominant lines (Hough) intersections; scored by edge support along the sides, area and
rectangularity; nested "picture inside the lid frame" candidates are kept as alternatives. Corners
refined by fitting lines to edge points. Rectified size honours the physical aspect ratio.

**Segmentation** – estimate the background colour model from the photo border (Lab, robust,
optionally a low-order polynomial for lighting gradients); foreground = colour distance (+
gradient) thresholded with Otsu; morphology + hole filling; connected components; regions far
larger than the median single piece are patches (or touching pieces), tiny ones are fragments.
Optionally (`SegmentOptions.grain`, off by default, `GRAIN=1` in the benchmark and feedback tools)
on a strongly grained table (`pieces/grain.ts`; texture coherently oriented in most tiles of about
a piece) the table colour is measured along the grain line through each pixel – the robust mean of
grain-like table pixels within about half a piece before or after it, as a residual from the smooth
and local table model – and the photo is segmented again against it with the grain-free spread:
stripes of grain no longer grow onto the pieces as ragged spikes or join them, while print near
the wood's colour stands out (off by default: see segment.ts GRAIN_DEFAULT). Assembled patches keep the table they enclose open in their masks
(the cells of missing pieces).

**Piece shape** – smoothed contour; corner candidates from curvature/convex-hull; best 4-corner
combination by rectangularity and area; sides classified flat/tab/blank from the deviation profile;
piece kind (corner/edge/interior) from flat sides.

**Matching** – the reference is turned into a Lab pyramid with known pixels-per-cell. A piece is
normalised (rotated by its corner angle into 4 candidate orientations, scaled so its body equals
one cell, background masked out with a small erosion). Coarse search: masked, zero-mean normalised
cross-correlation across all channels for every grid cell (edge pieces only at matching borders with
compatible rotation), small offset search. The best ~30 hypotheses are refined at higher
resolution with sub-cell offsets, small angle/scale adjustments. Confidence comes from the best
score and its margin over the best distinct alternative. Patches use the same machinery with a
sliding search and their dominant orientation; irregular-cut puzzles use the sliding search too.
The scale comes from the scan's median piece size; a photo without any single piece (e.g. one
large assembled block) measures it from the patch's own seams (`pieces/patchPitch.ts`: thin-line
responses projected across the grid directions form a comb with the piece size as period; for
cells wider than tall the two directions' periods differ by the cells' aspect), which
also tells such a lone block from a single piece in segmentation. In a small puzzle (≤ 64 cells) a
patch without a size reference is also searched at every size up to the whole puzzle. A patch
covers the cells its mask has print over. One cell, one piece (`match/claims.ts`): a confident
loose piece on a cell a patch covers is a contradiction – the less confident placement gives way –
and when the scan's confident placements and the user's placed cells leave at most three cells
free, the pieces without a confident place are assigned to them (the corner under a box picture's
badge, the last pieces of a puzzle). A region whose size says it is not what it is matched as – a
single piece far from one piece's area (merged pieces, table attached, half a piece), or a small
patch of touching loose pieces – is placed at most ambiguously, also when its neighbours would
place it (groups).

**Fits** – two regions fit when their best placements are adjacent cells with consistent
rotations (location), and/or when complementary sides (tab ↔ blank) have matching profiles and
lengths (shape). A loose piece fits a patch when its cell is adjacent to the patch's covered cells.
Profiles are compared with dynamic time warping in a ±2-sample Sakoe-Chiba band after removing the
best straight line through their difference ('dtw-levelled', `sideCompare.ts`, the default of
`analyzeScan`'s `sides` option): a body corner found a few pixels off along the outline shifts the
knob along the profile (warping absorbs it) and tilts the neighbouring side's baseline (the line
absorbs it). The option also offers plain DTW ('dtw') and the point-by-point RMS ('rms', findFits'
own default). Optionally (`sides.colour`, off) the Lab colour of a thin strip just inside each side
(2–3.5 % of the body size in, `edgeStrips.ts`) joins the comparison, DTW-aligned with the partner's
reversed strip, lightness counting half and a small lighting gain compensated.
`bench/sides.eval.ts` measures how often each comparison ranks the true partner first among a
scan's sides, with and without simulated corner errors.

**Quality** – sharpness (Laplacian variance and edge width on piece outlines), exposure (clipping,
mean), glare (bright low-saturation blobs), background contrast (Otsu separability), resolution
(pixels per piece side), touching/cut-off pieces, perspective (piece-size variation), reference
pixels per cell.

## 6. Build, test, deploy

- `npm run dev` – Vite dev server. `npm run build` – typecheck + production build into `dist/`.
- `npm test` – Vitest unit tests (Node). `npm run test:e2e` – Playwright smoke tests.
- `.github/workflows/deploy.yml` – on every push to `main`: install, typecheck, test, build, deploy
  `dist/` to GitHub Pages. Pull requests run the same checks without deploying.
