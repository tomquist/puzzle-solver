# Third-party material in the test corpus

Every file in `test-corpus/` that the project did not make itself, with its source and licence.
Licences were checked on each source page (2026-10-19). All other files in `test-corpus/feedback/`
are the project owner's own photos, sent from the app (see feedback/README.md).

The photos below show jigsaw puzzles whose printed motifs belong to their publishers / artists.
They are used only as segmentation tests (scan photos of loose pieces and partly assembled
puzzles); no puzzle picture or box photo is included, so nothing is matched against the artwork.

## Table photos (`feedback/flickr-*.json`)

Each `.json` is a scan-only feedback file made with `npm run feedback:from-photo`: the photo
embedded as base64 JPEG (`scan.photo`) plus the segmentation result of the app at commit 6ff77be
(`scan.result`). The `.review.json` next to it is our answer key for the photo (points drawn by
eye, no image data). The embedded photos stay under their original licences; the feedback files
that hold them are distributed under the same licence.

| File | Title, author | Source | Licence | Changes |
|---|---|---|---|---|
| `feedback/flickr-electric-eye-sunlit-wood-pieces.json` | "jigsaw puzzle pieces" by Electric-Eye | https://www.flickr.com/photos/35111587@N00/4054093512 | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | Original (3072×2048) reduced to 2400×1600 (the app's analysis size; area averaging, src/cv/resize.ts) and re-encoded as JPEG quality 92 |
| `feedback/flickr-electric-eye-oblique-wood-pieces.json` | "Puzzle pieces" by Electric-Eye | https://www.flickr.com/photos/35111587@N00/4054095536 | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | Original (3072×2048) reduced to 2400×1600 as above, JPEG quality 92 |
| `feedback/flickr-tatters-peacock-white-cloth-1000pc.json` | "Solving the puzzle" by Tatters ✾ | https://www.flickr.com/photos/62938898@N00/13287225825 | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) | None: the original file (1204×800, the largest size on Flickr) is embedded byte for byte |
| `feedback/flickr-chrisrycroft-birds-oak-partial.json` | "Partially complete jigsaw puzzle with birds" by chris.rycroft (Chris Rycroft) | https://www.flickr.com/photos/193316968@N06/52940052506 | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | Original (6240×3510) reduced to 2400×1350 as above, JPEG quality 92 |
| `feedback/flickr-welikesharing-map-oblique-wood.json` | "Jigsaw puzzle" by We Like Sharing | https://www.flickr.com/photos/192018235@N04/52612441739 | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | Original (4032×2268) reduced to 2400×1350 as above, JPEG quality 92 |

## Puzzle-Map dataset (not committed)

`npm run corpus:fetch-puzzlemap` downloads part of the Puzzle-Map dataset into
`test-corpus/puzzle-map/` (git-ignored) for `bench/puzzlemap.eval.ts`:

- Puzzle-Map Dataset by Pablo Moreira (pablo-moreira), https://huggingface.co/datasets/pablo-moreira/puzzle-map,
  revision ffc40afb7c3e31dd48804e6e550b51287414f6e2, licence
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (dataset card). Files are used unmodified.
- Only the labelled pieces are fetched: the author's own photos (`100_dc_*`, `120_avengers_*`,
  `camera_*`, `puzzle-focus_*`) and the reference pictures `100_dc.jpg`, `120_avengers.png`,
  `6_patos*.jpg`. The parts of the dataset built on Roboflow Universe datasets carry no puzzle
  labels and are not fetched.
- The pictures show Marvel, DC Comics and children's-puzzle artwork. The dataset's CC BY 4.0 cannot
  license that artwork, so the data stays out of the repository and is for local benchmarking only.
