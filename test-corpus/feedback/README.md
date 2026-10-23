# Feedback files

Files created in the app with **Send feedback** (`puzzle-feedback-*.json`). Each one holds a real
scan photo as analysed, what the app detected, the user's corrections (missed pieces, false
detections, merged pieces, wrong outlines, wrong places), confirmed placements and optionally the
puzzle picture and box photo.

- `npm run feedback:inspect -- test-corpus/feedback/<file>.json` re-runs the current pipeline on the
  file and writes annotated images to `.debug/feedback/` plus a summary. Files from Chromium
  browsers are decoded with Playwright's Chromium (`--decoder auto`, the default): JPEG decoders
  differ by a level or two, which can change segmentation, and since the app analyses the stored
  JPEG this reproduces exactly what the phone saw. The benchmark decodes the same way (it needs
  Playwright's Chromium: `npx playwright install chromium`).
- `npm run bench` replays every file here and checks the corrections stay fixed
  (bench/feedback.eval.ts, gated by bench/baseline.json).
- `GRAPH_CUT=1` (or `0`) in front of either command turns the graph-cut outline refinement on
  (off) for A/B comparisons (SegmentOptions.graphCut); `GRAIN=1` (or `0`) the wood-grain table
  model (SegmentOptions.grain, pieces/grain.ts; off by default).

Marks are what the user tapped, not ground truth: users tap beside a piece, overlook one or mark
two touching pieces as one. Before a new file's marks count, check every mark by eye on the photo
(crop each marked region or point at full resolution) and record the verdicts next to the file in
`<name>.review.json` (format in scripts/feedback/review.ts): 'ok', 'wrong' (the user's mistake) or
'unsure', plus for merged marks the number of regions the area really holds (`parts`; an assembled
group counts as one). With a review only 'ok' marks count in the benchmark; the user's file stays
unchanged. For photos where every piece can be told apart, the review also lists one point per
loose piece or assembled group (`objects`), checked by eye on close-ups, never copied from a
result: an answer key that also catches mistakes nobody marked (objectRecall, objectClean,
objectPrecision). A 'bad_outline' mark is judged when its review lists the pieces the marked area
really holds (`pieces`: a few by-eye points spread over each piece, `assembled`: which of them form
an assembled group): fixed when each piece lies whole in one region and only an assembled group
shares one, as a patch (outlineFixed).

Feedback files contain the user's photos – only commit files you are allowed to publish. The
puzzle picture and the box photo show the publisher's (usually copyrighted) artwork: strip them
before committing with `npm run feedback:strip -- <in.json> test-corpus/feedback/<name>.json`. Such
scan-only files replay segmentation and the user's marks; matching checks need the picture and are
skipped.

Photos not taken with the app (freely licensed table photos of other puzzles, `flickr-*.json`,
sources and licences in ../CREDITS.md) are wrapped into scan-only files with
`npm run feedback:from-photo -- <photo.jpg> <out.json>`: reduced to the app's analysis size, the
segmentation of the build that made the file as the stored result, no marks. Only their answer key
counts. They are stress tests (other tables and motifs, oblique views, small or blurred pieces):
low numbers are expected and gated so they do not get worse. `npm run feedback:inspect` draws the
answer key over the current outlines in `8-key.png` (found alone / merged / missed / unsure).

| File | Situation | Review |
|---|---|---|
| `2026-10-18-wood-planks-1500pc.json` | 1500 pieces on light wood with dark plank gaps; dark shadow zone at the bottom; 6 pieces reported as missed (all were detected but merged with plank gaps or unsure) | 6/6 marks ok; complete answer key (18 objects: 13 pieces, 5 assembled groups) |
| `2026-10-18-dense-table-frame-1500pc.json` | 1500 pieces, half-built border frame plus ~100 loose pieces packed closely on a light grey-green table, many touching; a lighter surface at the top right; 10 regions reported as merged. Segmentation was unstable here (32–66 regions depending on JPEG re-encoding or ±1 noise) | 10/10 marks ok; 6 with part counts |
| `2026-10-18-spread-stone-table-1500pc.json` | About 64 loose pieces spread out on a grey-beige stone-like table, few touching, soft shadow at the bottom left; 1 region reported as not a piece (a darker patch of table) | 1/1 mark ok; complete answer key (64 objects, 1 unsure) |
| `2026-10-18-two-surfaces-grey-pieces-1500pc.json` | Olive cloth on the left, light grey-blue table on the right; large assembled blocks; grey and dark pieces on the light table (all 14 marked as missed) and outlines that leave out the dark parts of pieces on the cloth (6 marked) | 20/20 marks ok; answer key for the light table's lower right (x 1000–1800, y 1200–2400: 20 objects, 4 unsure) |
| `2026-10-18-two-surfaces-letters-1500pc.json` | Same table as the previous file, rearranged, with the LOVE LETTERS title strip; a dark blue-grey (the grey pieces' colour) was learned as a second table colour, so grey pieces vanish (14 marked missed) and dark parts of pink pieces are cut off (32 marked bad outlines) | 43 marks ok, 3 unsure (near-correct outlines); answer key for the light table's lower right (x 1050–1800, y 1300–2400: 23 objects, 6 unsure) |
| `2026-10-18-two-surfaces-third-1500pc.json` | Third photo of the two-surface table; analysed on the phone with 87fd698: 70 regions there, 59 in the replay of the stored JPEG (a table-swallowing region at the bottom right appears only in the replay); 4 outlines marked | 3 marks ok, 1 unsure |
| `2026-10-18-touching-chain-closeup-1500pc.json` | Close-up (pieces ~260 px) of 11 loose pieces in a touching chain on a darker grey table; 4 regions marked as merged (2 pieces each) | 4/4 marks ok with part counts; complete answer key (15 objects, 4 unsure) |
| `2026-10-18-pale-pieces-light-table-1500pc.json` | Pale mauve/grey pieces on a light grey table (low contrast), a large assembled block on the left; a dark colour (Lab 36,4,3, 26 % inside) learned as table; 10 missed pieces and 33 fragment outlines marked | 43/43 marks ok; answer key for the loose pieces (x 500–1700, y 600–2000: 14 objects, 2 unsure) |
| `2026-10-18-glare-wood-five-pieces-1500pc.json` | Five loose pieces on a light wood table with a bright glare patch in the middle; the glare became two large false regions, one merged with a piece. First file analysed and sent with the same build (replay reproduces the phone exactly) | 3/3 marks ok, 2 with corrected kinds (outline off → not a piece); complete answer key (5 objects) |
| `2026-10-18-closeup-halo-wood-1500pc.json` | Close-up (pieces ~330 px) of five loose pieces on a light wood table, slightly soft; every outline takes in a 20–40 px band of table/soft shadow (3 marked) | 3/3 marks ok; complete answer key (5 objects) |
| `2026-10-18-floor-tiles-48-correct-1500pc.json` | 42 loose pieces and 6 assembled groups spread on light wood-look floor tiles with grout lines; segmentation fully correct; two pieces marked as shown in the wrong place (matching needs the picture, not in the file) | 1 mark ok, 1 unsure; complete answer key (48 objects) – a must-stay-correct reference |
| `2026-10-19-closeup-shadow-board-1500pc.json` | Close-up (pieces ~300 px) on a tan MDF board, warm light, the phone's hard-edged shadow over the middle; three assembled groups and knobs cut off at the edges; the table model took a grey piece colour as a further table colour, so every group falls apart into fragments (27 marked) | 25/27 marks ok (2 are pieces cut off by the photo edge, outlined as well as visible); complete answer key (3 objects, 4 unsure) |
| `2026-10-19-wide-board-patches-1500pc.json` | Same board and light, wider: big assembled patches cover most of the photo border, loose pieces in the middle, water stains; the table model is learnt from the patches at the border (board colour only a further colour, the dark blue-grey pieces another), so nearly every outline is a fragment (47 marked) | 47/47 marks ok (12 checked in detail); answer key for the upper middle (6 objects, 3 unsure) |
| `2026-10-19-board-letter-strip-1500pc.json` | Same tan board in better light, analysed by 6ff77be (after the table-model fix): patches around the border, ~60 loose pieces; an assembled letter strip (ACCEPTED … HANDMADE with three pieces on top) is split into 6 regions (marked as merged); a few touching pieces outlined across each other; one two-piece patch placed on the chalkboard sign (wrong place) | 15/15 marks ok (6 merged marks judged as bad outlines); answer key for the middle (16 objects, 3 unsure) |
| `2026-10-20-blue-table-block-50pc-1500pc.json` | One assembled block of ~50 pieces (shop window) turned ~30° on a light blue table; outlined well as one patch, but the app found no placement for it (unmatched) | 2/2 marks ok (table stains); answer key: 1 object |
| `2026-10-20-blue-table-exploded-45-1500pc.json` | The same block taken apart: 45 loose pieces in the block's row/column order on the light blue table; every outline correct | no marks; complete answer key (45 objects) – a must-stay-correct reference |
| `2026-10-20-blue-table-half-exploded-1500pc.json` | The block half taken apart: a partial block, pairs and loose pieces; glare blob, a speck and the bottom photo edge taken for pieces | 5 marks ok, 1 wrong (the marked outline is fine, its neighbour takes in empty table), 1 unsure; no answer key |
| `2026-10-20-blue-table-rebuilt-1500pc.json` | The block mostly rebuilt plus loose pieces on the light blue table; the table edge along the top comes out as 7 false regions, a pair gets a ring of table; two pieces marked as placed wrongly | 2 wrong-place marks pending the private truth set; complete answer key (14 objects) |
| `2026-10-20-haba-18-oak-grain.json` | A different puzzle: HABA 18-piece children's puzzle (6 rows × 3 columns, cells 1.6× wider than tall, thick cardboard, pieces ~190×300 px) loose on a strongly grained oak table. Every outline frays along the grain, two touching pairs are cut or merged, a knot and a cut-off tab became false regions (21 marked). One piece has blanks on both long sides and reads as two at a glance | 21/21 marks ok (1 judged as a bad outline: a cut-off tab); complete answer key (18 objects) |
| `2026-10-20-haba-18-assembled-floor.json` | The HABA puzzle assembled but for four holes on a grey wood-look floor with plank seams, four loose pieces beside it; the patch was placed over rows 1–4 only (cells 1.6× wider than tall, matched as square), the corner piece under the box picture's "18" badge placed on its neighbour's cell (marked wrong place) | 1/1 mark ok; complete answer key (5 objects) |
| `2026-10-20-haba-18-two-holes-floor.json` | The HABA puzzle assembled but for two holes, turned ~12°, on the grey floor; the two missing pieces beside it, both placed and turned right, but marked as wrong place because the patch was placed over rows 1–4 only | 2 marks wrong (the placements are right); complete answer key (3 objects) |
| `flickr-electric-eye-sunlit-wood-pieces.json` | Third-party (Flickr, CC BY 2.0): about 40 loose pieces in purple, blue and pink on a wooden table in low sun, stripes of sunlight and shadow across table and pieces, slightly oblique, pieces ~200 px. The table model takes the pieces' colours for table: most pieces fall apart into slivers along their dark edges and shadows | Complete answer key (42 objects: 32 pieces, 10 unsure: pieces cut off by the photo edge) |
| `flickr-electric-eye-oblique-wood-pieces.json` | Third-party (Flickr, CC BY 2.0): same table and pieces in even light, very oblique (far half out of focus), pieces ~150–300 px wide and squashed; several touch or overlap | Answer key for the lower part (y 600–1600: 35 objects, 12 unsure: overlapping pairs, pieces at the edges and just above the area) |
| `flickr-tatters-peacock-white-cloth-1000pc.json` | Third-party (Flickr, CC BY-SA 2.0, original file 1204x800): 1000-piece peacock puzzle partly assembled on a white patterned cloth, loose pieces (~35 px) around it; at the left the loose pieces lie in pairs (two pieces joined side by side or stacked), counted as one object each | Answer key for the loose pieces at the left (x 0–335, y 160–800: 37 objects including the assembled puzzle's left border, 3 unsure). Whether the pairs are joined or only touching cannot be told at this size: objectPrecision counts a split pair as a false region |
| `flickr-chrisrycroft-birds-oak-partial.json` | Third-party (Flickr, CC BY 2.0): birds puzzle partly assembled on an oak table, shallow depth of field (only a band across the middle is sharp), strong wood grain | Answer key for the sharp table area at the right (x 1500–2400, y 400–900: 10 objects: 2 loose pieces, a small assembled group and the large assembly; 6 unsure at the edges and out of focus) |
| `flickr-welikesharing-map-oblique-wood.json` | Third-party (Flickr, CC BY 2.0): map puzzle partly assembled on light wood, very oblique; loose grey/yellow pieces whose grey print is close to the table colour | Answer key for the loose pieces at the right (x 1620–2400, y 330–800: 8 objects, 2 unsure; two of the objects are assembled pairs) |
