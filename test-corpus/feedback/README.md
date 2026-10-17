# Feedback files

Files created in the app with **Send feedback** (`puzzle-feedback-*.json`). Each one holds a real
scan photo as analysed, what the app detected, the user's corrections (missed pieces, false
detections, merged pieces, wrong outlines, wrong places), confirmed placements and optionally the
puzzle picture and box photo.

- `npm run feedback:inspect -- test-corpus/feedback/<file>.json` re-runs the current pipeline on the
  file and writes annotated images to `.debug/feedback/` plus a summary.
- `npm run bench` replays every file here and checks the corrections stay fixed
  (bench/feedback.eval.ts, gated by bench/baseline.json).

Feedback files contain the user's photos – only commit files you are allowed to publish. The
puzzle picture and the box photo show the publisher's (usually copyrighted) artwork: strip them
before committing with `npm run feedback:strip -- <in.json> test-corpus/feedback/<name>.json`. Such
scan-only files replay segmentation and the user's marks; matching checks need the picture and are
skipped.

| File | Situation |
|---|---|
| `2026-10-18-wood-planks-1500pc.json` | 1500 pieces on light wood with dark plank gaps; dark shadow zone at the bottom; 6 pieces reported as missed (all were detected but merged with plank gaps or unsure) |
