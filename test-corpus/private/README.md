# Private placement truth — NEVER COMMIT ANYTHING FROM HERE

This folder is ignored by version control (only this README is tracked). It holds **full** feedback
files of the user's own puzzle: their photos and the puzzle's reference picture, a commercial
publisher's artwork. Never commit them, never copy them anywhere else in the repository, never
paste crops of the reference picture into committed files, issues or pull requests. Before every
commit, `git status` must show nothing from this folder.

Each feedback file `<name>.json` comes with a placement truth `<name>.truth.json` (format and
scoring: `scripts/feedback/truth.ts`):

```json
{
  "format": "puzzle-solver-truth",
  "version": 1,
  "feedback": "fb18.json",
  "created": "2026-10-20",
  "method": "how the truth was established",
  "pieces": [{ "x": 812, "y": 455, "row": 18, "col": 21, "rotationDeg": 146, "unsure": false, "note": "…" }],
  "blocks": [{ "x": 1100, "y": 1000, "cells": [{ "row": 10, "col": 21 }], "rotationDeg": 207 }]
}
```

- `x`, `y`: a point well inside the piece / block in the scan photo as analysed (`scan.photo`).
- `row`, `col`: the true grid cell (0-based, as in the app).
- `rotationDeg`: the app's `Placement.rotationDeg` — the clockwise turn in degrees [0, 360) that
  takes the piece from how it lies in the photo to upright.
- `blocks`: assembled groups, with all their cells and their common turn.
- `unsure`: identity or placement doubtful; counts in neither direction.

Truth must come from the photos, not from the app's own placements (e.g. a block placed and
checked by eye, then taken apart and each loose piece identified in the block photo by its print
and outline).

`npm run bench` runs `bench/private.eval.ts` on every file here that has a truth sidecar: it
replays the file with the current pipeline and prints top-1 / top-3 cell, rotation within 10°,
confident share and precision, found / merged — for the current code and for the result stored in
the file. Report only; it is skipped when the folder holds no such files.
