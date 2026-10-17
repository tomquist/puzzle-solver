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
3. **Results** – the photo with every piece outlined and numbered, colour-coded by confidence, with
   an arrow showing which way is "up". The reference shows numbered markers at the matched
   locations. Tapping a piece shows its top candidates side by side with the matching reference
   crop (rotated the same way as the piece lies), the piece type (corner/edge/interior) and the
   rotation needed. Neighbouring pieces and pieces that fit a patch are listed.
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
componentMask(labels, label, bbox): Mask                          // bbox-sized mask of one component
traceOuterContour(m: Mask, start?: Point): Point[]                // clockwise, pixel coordinates
simplifyPolygon(pts: Point[], epsilon: number, closed?: boolean): Point[]  // Douglas–Peucker
convexHull(pts: Point[]): Point[]
polygonArea(pts) / polygonPerimeter(pts) / polygonCentroid(pts)
minAreaRect(pts: Point[]): { center: Point; width: number; height: number; angle: number; corners: Quad }
smoothContour(pts: Point[], sigma: number): Point[]               // closed-curve Gaussian smoothing
resampleContour(pts: Point[], n: number): Point[]                 // equal arc-length
pointInPolygon(p: Point, poly: Point[]): boolean
canny(img: GrayImage, low: number, high: number, sigma?: number): Mask
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
detectBox(photo: RGBAImage): BoxDetection
suggestRectifiedSize(quad: Quad, aspect?: number, maxSide?: number): { width: number; height: number }
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
  // MatchInput { regionId; kind: RegionKind; image: RGBAImage (bbox crop); mask: Mask (same size);
  //              origin: Point (crop origin in photo coords); shape?: PieceShape (photo coords);
  //              orientationDeg: number; expectedBodySize?: number /* photo px per cell */ }
  // MatchOptions { placedCells?: CellRef[]; maxCandidates?: number }
findFits(regions: DetectedRegion[], matches: RegionMatch[], grid: GridSpec): FitHint[]
// synthetic data for tests
generateJigsaw(rows, cols, width, height, seed): JigsawCut       // piece outlines in reference coords
renderPiecesPhoto(reference, cut, pieces: number[], opts): { photo: RGBAImage; truth: PieceTruth[] }
renderBoxPhoto(reference, opts): { photo: RGBAImage; quad: Quad }
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

**Fits** – two regions fit when their best placements are adjacent cells with consistent
rotations (location), and/or when complementary sides (tab ↔ blank) have matching profiles and
lengths (shape). A loose piece fits a patch when its cell is adjacent to the patch's covered cells.

**Quality** – sharpness (Laplacian variance and edge width on piece outlines), exposure (clipping,
mean), glare (bright low-saturation blobs), background contrast (Otsu separability), resolution
(pixels per piece side), touching/cut-off pieces, perspective (piece-size variation), reference
pixels per cell.

## 6. Build, test, deploy

- `npm run dev` – Vite dev server. `npm run build` – typecheck + production build into `dist/`.
- `npm test` – Vitest unit tests (Node). `npm run test:e2e` – Playwright smoke tests.
- `.github/workflows/deploy.yml` – on every push to `main`: install, typecheck, test, build, deploy
  `dist/` to GitHub Pages. Pull requests run the same checks without deploying.
