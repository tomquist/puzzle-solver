# Real-photo corpus

Drop puzzle exports from the app here (Settings → Export, file `*.puzzle.json` — rename to
`*.json` if needed). Every piece you confirmed with "Placed ✓" becomes a labelled test case:
`npm run bench` re-analyses the stored scan photos and checks that those pieces are still matched to
the cells you confirmed. Accept new numbers with `UPDATE_BASELINE=1 npm run bench`.

Exports contain your photos — only commit puzzles you are happy to publish.

Third-party material (freely licensed photos in `feedback/`, the Puzzle-Map dataset fetched by
`npm run corpus:fetch-puzzlemap` into `puzzle-map/`, which stays out of the repository) is listed
with its source and licence in CREDITS.md.
