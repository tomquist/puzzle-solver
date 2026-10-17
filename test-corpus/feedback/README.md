# Feedback files

Files created in the app with **Send feedback** (`puzzle-feedback-*.json`). Each one holds a real
scan photo as analysed, what the app detected, the user's corrections (missed pieces, false
detections, merged pieces, wrong outlines, wrong places), confirmed placements and optionally the
puzzle picture and box photo.

- `npm run feedback:inspect -- test-corpus/feedback/<file>.json` re-runs the current pipeline on the
  file and writes annotated images to `.debug/feedback/` plus a summary.
- `npm run bench` replays every file here and checks the corrections stay fixed
  (bench/feedback.eval.ts, gated by bench/baseline.json).

Feedback files contain the user's photos – only commit files you are allowed to publish.
