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

Marks are what the user tapped, not ground truth: users tap beside a piece, overlook one or mark
two touching pieces as one. Before a new file's marks count, check every mark by eye on the photo
(crop each marked region or point at full resolution) and record the verdicts next to the file in
`<name>.review.json` (format in scripts/feedback/review.ts): 'ok', 'wrong' (the user's mistake) or
'unsure', plus for merged marks the number of regions the area really holds (`parts`; an assembled
group counts as one). With a review only 'ok' marks count in the benchmark; the user's file stays
unchanged. For photos where every piece can be told apart, the review also lists one point per
loose piece or assembled group (`objects`), checked by eye on close-ups, never copied from a
result: an answer key that also catches mistakes nobody marked (objectRecall, objectClean,
objectPrecision).

Feedback files contain the user's photos – only commit files you are allowed to publish. The
puzzle picture and the box photo show the publisher's (usually copyrighted) artwork: strip them
before committing with `npm run feedback:strip -- <in.json> test-corpus/feedback/<name>.json`. Such
scan-only files replay segmentation and the user's marks; matching checks need the picture and are
skipped.

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
