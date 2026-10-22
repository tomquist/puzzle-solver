# Android, web and open-source competitors of Puzzle Solver: deep dive

Data collected on 2026-10-22. Unless marked otherwise, every metric is as of that date.

Sources and methods:
- **Google Play.** I used the `google-play-scraper` Python library against Play's own endpoints. It pulled reviews from 11 locale/country pairs (en-US/GB/AU/CA, nl, de, fr, es, it, pt-BR, pl), which were then de-duplicated, plus raw listing HTML in en/nl/de/fr/es and the Data-safety pages.
- **GitHub.** I used the GitHub MCP repository search, raw.githubusercontent.com READMEs and GitHub Pages probes. The GitHub REST API and github.com HTML pages were blocked by the session proxy.
- **Blocked sources.** AppBrain, APKPure, Ko-fi and the HTTPS version of puzzlesolver.app returned 403, a TLS failure or 502. AndroidRank and 42matters had no page for either app (404). Reddit was not attempted, because earlier research found it blocked.

This builds on `research_notes/Puzzle solver monetization/competitors.md` and does not repeat it.

## Solver Works: "Jigsaw Puzzle Solver" (Android)

### Takeaway
Solver Works is a one-app, one-person (or family) Dutch developer. It ships updates fast: about 30 versions, 0.3.0 to 0.5.14, in 9.5 months. The rating is polarised: 25 of 50 ratings are 1-star and 18 are 5-star. Most complaints are about accuracy. It is **not on-device**: the privacy policy says piece and box photos "may be temporarily uploaded to our secure server", and the app uses Firebase Analytics, Crashlytics and AdMob. The website puzzlesolver.app is a parked "Coming Soon" page. I found no iOS app, social accounts, press, pricing or public roadmap.

### Cited Findings
**Listing facts (2026-10-22)**
- Title "Jigsaw Puzzle Solver". Summary: "Helps find where a jigsaw puzzle piece goes. Take photos to see the match." Genre Tools, rated Everyone. Free, **no in-app purchases** (offersIAP false), **"Contains ads"**. — [Google Play (en)](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)
- **Released Jan 6, 2026. Updated Oct 21, 2026.** That is newer than the Oct 7 date in the earlier notes. — [Google Play (en)](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)
- Installs badge "5,000+". The scraper's exact-install field (`realInstalls`, from Play's own page data) reads **7,887** (scraped value, not a public badge). — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)
- Rating 2.75 from **50 ratings**, of which 6 have written text in the default locale. The histogram (1★ to 5★) is **[25, 0, 6, 0, 18]**. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)
  - Conflicting data: the developer page shows the app at **3.8★**. The two figures may use different weighting or regions; I could not reconcile them. — [Play developer page "Solver Works"](https://play.google.com/store/apps/developer?id=Solver+Works&hl=en)
- The developer page lists **one app only**. — [Play developer page](https://play.google.com/store/apps/developer?id=Solver+Works&hl=en)
- The listing is localised into Dutch, German and French. Dutch: "Jigsaw Puzzle Solver helpt de plek van een puzzelstukje in een fysieke legpuzzel te vinden". German: "…hilft dabei, den richtigen Platz für ein Puzzleteil … zu finden". — [nl listing](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=nl); [de listing](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=de)
- No "What's new" text is shown in any of the five locales fetched (en, nl, de, fr, es). — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)
- Contact email contact@puzzlesolver.app. The listing gives no website. Privacy policy: puzzle-solver-privacy-policy.carrd.co. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)

**Data safety and privacy (key for Puzzle Solver's privacy positioning)**
- Data safety section:
  - Shared with third parties: "Device or other IDs" and "Approximate location", for Analytics and Advertising or marketing.
  - Collected: the same two types, for the same purposes.
  - "Data is encrypted in transit".
  - "Data can't be deleted". — [Play Data safety](https://play.google.com/store/apps/datasafety?id=puzzle.solver.puzzle_solver_app&hl=en)
- Privacy policy, last updated 18 July 2026:
  - "When using puzzle solving features, the images you provide **may be temporarily uploaded to our secure server for processing**… deleted automatically after processing. Only with your explicit opt-in consent, images may be used for improving the app."
  - Third parties: Firebase Analytics, Firebase Crashlytics, Google AdMob, Google Play Services, and a "Cloud Service Provider" that hosts uploaded images.
  - Uses a random "Installation ID".
  - "The app is not intended for children under 13". — [Privacy policy (carrd)](https://puzzle-solver-privacy-policy.carrd.co/)
- Contradiction: on 2026-08-02 the developer replied to a review: "The app is currently free, **has no ads**, and needs no registration." The listing, however, says "Contains ads" and the policy names AdMob. Ads may be integrated but not yet served; I could not verify this. — [Google Play reviews](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en); [Privacy policy](https://puzzle-solver-privacy-policy.carrd.co/)

**Update history, reconstructed from the app version recorded on each review (no public changelog exists)**

| Version | Seen on (2026) |
|---|---|
| 0.3.0 | Jan 8 |
| 0.3.2 | Jan 12 |
| 0.3.5 | Jan 17 |
| 0.3.6 | Jan 24 |
| 0.3.9 | named in the developer's reply of Jan 26 |
| 0.3.12 | Feb 13 |
| 0.3.16 | Feb 20 |
| 0.3.19 | Mar 1 |
| 0.3.20 | Apr 5 |
| 0.3.21 | Apr 15 |
| 0.3.23 | Apr 9 |
| 0.3.27 | May 25 |
| 0.4.0 | Jun 21 |
| 0.4.3 | Jul 11 |
| 0.5.1 | Aug 1 |
| 0.5.9 | Sep 1 |
| 0.5.10 | Sep 24 |
| 0.5.12 | Oct 1 |
| 0.5.14 | Oct 12 |

Listing updated Oct 21. — [Google Play reviews](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)

**Developer statements about the roadmap (all from review replies)**
- 2026-01-10: "French translations are planned." They have since shipped, since the listing is now in French.
- 2026-03-18: training the model is "a great suggestion".
- 2026-05-27: a "try again" function: "we actually hadn't thought about that yet".
- 2026-10-12: "**support for more than 1000 pieces is planned**". This implies a current limit of 1,000 pieces.

Source for all four: [Google Play reviews](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)

Usage tips repeated in many replies: "Matching depends on entering the correct number of pieces and rotating the piece photo upright" and "Piece detection works best with a plain background in a color that is not present in the puzzle piece". So the app needs **manual upright rotation by the user**: it does not infer rotation. — same source

**All 26 written reviews retrieved, across 11 locales, Jan 5 to Oct 12, 2026: categorised**

Stars: 17 five-star, 2 three-star, 7 one-star. 7 reviews are written in Spanish, French, Polish or German; the rest are in English.

| Theme | Count | Examples (date, stars) |
|---|---|---|
| Works / accurate / "it actually works" | 9 | "it's pretty accurate" (Feb 13, 5★); "It actually works!" (Sep 24, 5★); "it works perfectly!" (Sep 25, 5★); "Fonctionne super bien" (Mar 1, 5★) |
| Helps when stuck / makes puzzling more fun | 6 | "Lifesaver for a really complex puzzle" (Sep 1, 5★); "it really helps when you get stuck" (Aug 30, 5★); "Puzzlen macht sehr viel mehr Spaß" (Jun 21, 5★); "makes puzzling relaxed and fun" (Jan 17, 5★) |
| Region right, exact cell not | 2 | "Positions are not 100% accurate but the region is most of the time correct" (May 25, 5★); "wouldn't say it works perfectly on detailed puzzles" (Apr 9, 5★) |
| Likes confidence display / uncertainty handling | 2 | "shows the percentage on the left" (Apr 9); "handle uncertainty in good way" (Jul 11, 5★) |
| Inaccurate / doesn't work | 8 | "5% success rate" (Apr 15, 3★); "less than 25% correct" (May 25, 3★); "Not even close" (Apr 25, 1★); "scam doesn't work" (Aug 1, 1★); "No sirve para nada" (Jan 12, 1★); "no jala" (Apr 5, 1★); "chooses an empty spot on the border" (Mar 17, 1★); "die Teile die er findet, passen nicht zur richtigen Stelle" (Oct 12, 1★) |
| Low-detail / single-colour areas are hard (user acknowledges) | 1 | Polish review, Feb 20, 5★ |
| Piece detection / shape failure | 1 | "unable to detect basic shapes" (Mar 17, 1★) |
| Crashes | 1 | "keeps crashing when trying to recognise piece" (Jan 24, 1★) |
| Piece-count limit (1,000 maximum) | 1 | "es gehen nur 1000 Teile Puzzel" (Oct 12, 1★) |
| Feature requests: feedback / "try again" loop, train the AI | 2 | Jeff Bell (May 25); Jay Pridemore (Mar 17) |

Source: [Google Play reviews (all locales)](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)

- **Developer responsiveness.** The developer replied to 17 of 26 written reviews, including **all 7 one-star reviews**, usually within 0–3 days (one reply took 30 days: May 26 → Jun 25). The replies are in English, even to Spanish, German and French reviewers. — same source
- **Possible friends-and-family reviews.** One 5★ review (2026-08-30) is by "Ronald van Immerzeel", who shares the listed developer's surname. Another 5★ (Kilbert Meadows) is dated 2026-01-05, a day before the public release date. — same source
- **puzzlesolver.app website.** Over HTTP it serves a Porkbun parking page: "puzzlesolver.app — Coming Soon… A brand new website is on its way." HTTPS fails the TLS handshake. The MX records point to Porkbun mail forwarding. No pricing, roadmap or iOS information exists there. — [puzzlesolver.app (HTTP)](http://puzzlesolver.app/); DNS via [dns.google](https://dns.google/resolve?name=puzzlesolver.app&type=MX)

### Inferences
- Solver Works' privacy stance is weak against Puzzle Solver's: server upload, Firebase, AdMob, location and device-ID sharing, and no data deletion. The no-upload claim directly differentiates Puzzle Solver from the most-installed Android competitor.
- Server-side matching plus an ad SDK and no IAP suggests the developer plans ads or a later paid tier. The "preview version" label and the parked domain suggest a website or wider launch is coming.
- The 1★/5★ split (nothing at 2★ or 4★) reflects how accuracy depends on the puzzle: it works on detailed, illustrated puzzles and fails on photographic or low-detail ones. The same split is likely to apply to any artwork-matching app, including Puzzle Solver.
- Users have to rotate the piece upright themselves and enter the right piece count. Puzzle Solver's automatic rotation guidance is a real UX gap against this app.

### Gaps
- No iOS app, social accounts (X, Instagram, TikTok, Reddit), press coverage, Product Hunt or LinkedIn presence was found for "Solver Works" or "Michiel van Immerzeel". Web searches returned nothing relevant.
- I could not determine whether ads are actually shown. The listing and the developer's reply conflict.
- The rating trend over time is not available. AppBrain and AndroidRank were blocked or had no page. Only the review dates above give a rough trend: early reviews (Jan–Mar) were mostly 5★, the 1★ cluster ran Mar–Aug, and Sep–Oct were mostly 5★ again apart from one 1★.
- The 24 ratings with no written text could not be read.

## Puzzle Finder by LY4Dev (Android)

### Takeaway
Puzzle Finder is a free, no-ads, genuinely offline Kotlin/Jetpack Compose and OpenCV app by a French hobby developer. By the scraped exact count it has slightly **more installs (9,304) than Solver Works (7,887)**, but its written reviews are mostly negative: 5 of 9 are 1★. The developer says plainly that he built it to learn to code, with no AI, so that nobody pays for cloud vision tokens. It is monetised only through a Ko-fi tip link. The last update was Aug 30, 2026, slower than Solver Works.

### Cited Findings
**Listing facts (2026-10-22)**
- "Puzzle Finder". Summary: "Find where your puzzle pieces belong with image recognition 🧩". Tools, rated Everyone, free, no IAP, no ads. **Released Jan 27, 2026; updated Aug 30, 2026.** — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en)
- Installs badge "5,000+". Scraped `realInstalls` reads **9,304** (scraped, not a public badge). — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en)
- The listing shows no rating summary. The developer page shows **3.1★**. — [Play developer page "LY4Dev"](https://play.google.com/store/apps/developer?id=LY4Dev&hl=en)
- The developer page lists **only this one app**. — same source
- Listing claims:
  - "Advanced image recognition with OpenCV".
  - "Works 100% offline".
  - "Supports puzzles of all sizes".
  - "No data collection… No ads, no tracking".
  - The description is localised into German, French, Dutch and Spanish. — [en](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en); [de](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=de)
- What's new (v1.6): "Report a detection error by email — images attached automatically • Choose which pieces to share: last, selection or all • Tooltip on first use to find the feedback button • Higher image quality for better accuracy • A kind review means a lot 🙏 ko-fi.com/lefyo ☕". In the Dutch locale the release notes appear in French, untranslated. — [Google Play en](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en); [nl](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=nl)
- Data safety: "doesn't collect or share any user data". The developer has also "committed to follow the Play Families Policy". — [Play Data safety](https://play.google.com/store/apps/datasafety?id=www.ly.puzzlefinder&hl=en)
- Privacy policy, "Last updated: January 2026":
  - "100% offline… No data is sent to any server… No analytics… No crash reporting".
  - Permissions are Camera and (optionally) Storage.
  - Open-source libraries listed: **OpenCV (BSD) and Jetpack Compose**, so this is a native Kotlin Android app.
  - Hosted on GitHub Pages at `ly4dev/puzzlefinder-legal`.
  - Contact ly4dev+contact@gmail.com. — [Privacy policy](https://ly4dev.github.io/puzzlefinder-legal/privacy-policy); [Legal index](https://ly4dev.github.io/puzzlefinder-legal/)
- ly4dev.github.io has no user site (404). No other website was found. — [ly4dev.github.io](https://ly4dev.github.io/)

**Version timeline, from review versions and build stamps**

| Version | Build date | Seen in |
|---|---|---|
| v1.3.0 | 2026-02-19 22:11 | reviews |
| v1.5.0 | 2026-04-19 | reviews |
| v1.6.1 | 2026-06-30 | reviews |
| v1.6 | — | release notes; listing updated 2026-08-30 |

The build stamp is encoded in the version string, e.g. "1.3.0.2602192211". — [Google Play reviews](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en)

**All 9 written reviews, Feb 19 to Aug 28, 2026: categorised**

Stars: 1 five-star, 2 four-star, 1 two-star, 5 one-star.

| Theme | Count | Examples |
|---|---|---|
| Wrong location / doesn't work | 5 | "scansionati 30 pezzi e nessun pezzo è stato messo correttamente" (Jun 25, 1★); "put in the rong spot… it whonts to put the piece enny ware" (Jun 19, 1★); "No funciona" (Jun 14, 1★); "bancale" (shaky) (Jun 28, 1★); "not even close then the app makes it seem like its your fault" (Aug 28, 1★) |
| Camera / capture friction (retakes needed) | 1 | "bisogna rifare spesso le foto per catturare il pezzo" (Jun 25) |
| Detection bug (pieces "bigger than the box") | 1 | Feb 19, 2★ |
| Works well, fails on low-detail pieces | 1 | "sometimes guesses completely wrong… pieces with very little detail and colour" (Jul 20, 4★) |
| Surprise success on a hard puzzle | 1 | "guessed correctly the position of two pieces… one of 1500 pieces from a complete grayscale puzzle" (Aug 20, 5★) |
| Detailed power-user feedback | 1 | 1000-piece Minions puzzle: "you can use a jpg from web", "can find 2 or 3 pieces together, sometimes", "found solution 95% Times"; asked for auto-capture and auto-search, and a 5-button feedback bar instead of an animation (Feb 23, 4★) |

Source: [Google Play reviews](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en)

**Developer replies**
- The developer replied to **all 9 reviews, in French**, even to English, Spanish and Italian reviewers. He asks users to email photos. — same source
- Statements:
  - 2026-02-24: "Le lancement de la recherche en automatique après la prise de la photo est prévu" (automatic search after the photo is taken is planned).
  - 2026-06-28: "J'ai fait cette application gratuite pour m'essayer au code python **sans utiliser d'IA** pour ne pas payer (vous ou moi des tokens cloud vision)". He made it free to try his hand at coding, without AI, so that neither he nor users pay for cloud vision tokens. He says Python, but the privacy policy lists Jetpack Compose.
  - 2026-07-20: "Il faudrait une appli qui demande à scanner toutes les pièces une par une 😅" (you'd need an app that scans every piece one by one).
  - 2026-08-28: "Je pourrais faire passer les images par une IA de vision mais cela a un coût. Je préfère pour l'instant garder l'App en local et gratuite." (He could route images through a vision AI but that costs money, and prefers to keep the app local and free for now.)

  Source for all four: [Google Play reviews](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en)

### Inferences
- Puzzle Finder is the closest Android analogue to Puzzle Solver's privacy stance: offline, no data, OpenCV. But it matches one piece at a time, has no fit detection, and the reviews suggest poor accuracy. Nobody on Android has yet combined privacy with good accuracy.
- The developer's own remark, that an app scanning all pieces would be needed for low-detail areas, describes Puzzle Solver's batch and fit approach. He sees the gap but has not built it.
- With Ko-fi as the only revenue and a two-month gap since the last update (Aug 30 to Oct 22), the project looks like a hobby that is slowing down, not a commercial threat.

### Gaps
- **Ko-fi page (ko-fi.com/lefyo):** Cloudflare challenge (403) to both curl and WebFetch. The supporter count is unknown.
- The developer's identity beyond "LY4Dev" (Lefeuvre Yohann, France, per earlier notes) could not be confirmed, and no other apps or projects were found. The only GitHub content found is the `ly4dev/puzzlefinder-legal` repo.
- The rating count behind the 3.1★ on the developer page is not exposed (the scraper returned None).

## jellojm/puzzle-helper (open-source web app)

### Takeaway
"Puzzle Helper" is an iPhone-first PWA in plain JavaScript, running a custom SIMD build of OpenCV.js 4.10 in a Web Worker. In features it is **the closest competitor to Puzzle Solver anywhere**. It does:
- live multi-piece scanning with a persistent table map;
- placement on the box picture with a rotation arrow;
- calibrated pair-fit probabilities with 2×2 loop checks;
- border/corner finders;
- assembled-section tracking with "open spots";
- "fill this spot";
- colour zones;
- several puzzles saved at once.

It is live on GitHub Pages: v0.28.0, last modified 2026-10-11. The repository has no licence file, 0 stars and 0 forks. It was built at very high cadence, about v0.11 to v0.28 in 8 days, apparently by AI coding agents for one owner. It is a separate codebase from tomquist/puzzle-solver.

### Cited Findings
**Identity, hosting and cadence**
- GitHub repo `jellojm/puzzle-helper`. Description: "iPhone web app that catalogs jigsaw pieces with the camera and finds where they go". JavaScript. **0 stars, 0 forks. Created 2026-10-03; last updated 2026-10-11.** — [GitHub search result](https://github.com/jellojm/puzzle-helper)
- **Live at https://jellojm.github.io/puzzle-helper/**. The deployed `js/main.js` has `APP_VERSION = '0.28.0'`, Last-Modified "Sun, 11 Oct 2026 23:32:33 GMT". — [GitHub Pages](https://jellojm.github.io/puzzle-helper/)
- The shallow clone holds one commit: `35ea546`, 2026-10-11, author "jellojm <180761882+jellojm@users.noreply.github.com>", message "v0.28.0: learned background…". No real name is disclosed. — local clone `/home/user/jellojm/puzzle-helper`
- **Licence: none.** There is no LICENSE file, and no licence or copyright string anywhere in the app's own code. The only match is inside the vendored OpenCV build. `package.json` is `"private": true`. By default, all rights are reserved. — local clone
- Version cadence, from `RESEARCH-ai-puzzle.md`, the HANDOFF files and `test/results/history.jsonl`:

  | Version | Date (2026) | Notes |
  |---|---|---|
  | v0.11.1 | Oct 3 | research doc written against this version |
  | v0.12–v0.16 | Oct 3 | ranked research plan items implemented |
  | v0.21.0–0.21.4 | Oct 7 | |
  | v0.22.0–0.22.2 | Oct 7 | |
  | v0.23.0 | Oct 7, 23:21 UTC | |
  | v0.23.4 | Oct 8, 18:55 UTC | |
  | v0.26.2, v0.27 | — | referenced in PLAN-auto-background |
  | v0.28.0 | Oct 11 | |

  — local clone (`RESEARCH-ai-puzzle.md`, `HANDOFF-2026-10-07*.md`, `test/results/history.jsonl`, `PLAN-auto-background.md`)
- **Developed by AI agents for a single owner:**
  - HANDOFF files: "This handoff is for the next agent working on Puzzle Helper"; "Other agents run tests on this PC".
  - `.gitignore` excludes `.agent-coordination/`.
  - Owner context: "iPhone XR, Chrome iOS. Two PCs share this folder through OneDrive"; the owner "wants values tuned automatically, with no new settings" and drops phone reports into `reports/`.
  - Instructions in the README use Windows and VS Code.

  — local clone (`HANDOFF-2026-10-07.md`, `HANDOFF-2026-10-07-v0.22.md`, `.gitignore`, `README.md`)

**Features (README, v0.28.0)**
- **Scan.** You sweep the camera over the table. Each piece gets a catalogue entry and a dot that changes from grey to blue (shape read) to green (placed on the box). Dots follow the camera between readings. Gold dashed lines link loose pieces that "very likely fit together". — README
- **Catalog from a photo.** One full-resolution still catalogues every piece in it at once, using `ImageCapture` on iOS 18.4 and later. — README
- **Find panel.** Shows each piece's spot on the box and its best partners per edge, with verdict words (Strong match / Likely / Maybe / Look-alike / Unlikely). The percentages are calibrated ("'90%' means about 9 in 10 fit") and keep learning from the user's Fits / No answers. It also shows a which-way-up arrow, "Mark as in the puzzle" with progress, the Corners / Edges / Unplaced finders, and a whole-catalogue "Matches" pair search that needs no box picture. — README
- **Map.** Turns the camera off and shows every scanned piece from above, at its table position and angle, for shared use on a phone or iPad. — README
- **Assembled-part features:**
  - Area search.
  - Fill this spot: "in testing the right piece came first 74 of 80 times, vs 64 by the picture alone".
  - Open spots: the assembled part is built up from close views, located on the box, and holes, pockets and edge spots are drawn.
  - Finished border found by itself, then read cell by cell against the box.
  - Zones A–F for tray sorting.
  - Next along the border: "right 108 of 120 times in testing".

  — README
- Privacy: "Everything runs on the phone. Nothing is uploaded, and the catalog is saved on the phone (IndexedDB)." The first launch downloads about 10 MB of OpenCV, and the app then works offline. — README

**Algorithms (README "How it works" table, plus the `js/vision/` code; 9,571 lines across 14 modules, `engine.js` alone 4,198)**
- **Segmentation.** Every frame, at 640 px. The background is chosen from candidates (dominant colour, taught colours, box palette, a learned background in v0.28). Lamp shadows are evened out. On steady frames an edge channel is added for pale pieces. Touching pieces are separated with notch, corner and watershed splitters. — README; `js/vision/segment.js`, `bgLearn.js`
- **Motion.** A 96 px thumbnail tracker moves the dots between readings, plus a "table map" that fits the camera position by RANSAC similarity on known pieces. — README; `js/vision/flow.js`
- **Shape.** The outline is reduced to 4 corners and 4 edges, each typed tab / blank / flat. Each edge gets 32 shape points and 32 colour points. — README; `js/vision/pieceModel.js`
- **Box placement.** Corners fix rotation to one of 4 options and the grid fixes the scale. A colour pre-filter runs over all cells, then a pixel comparison over the top ~20. — README; `js/vision/box.js`
- **Matching.**
  - Tab↔blank only.
  - Procrustes shape distance plus colour across the seam, with a box-adjacency bonus.
  - A softmax with a "partner not scanned yet" null option.
  - Then a Platt-style calibrator refit from the answer key.
  - Loop and mutual-best consistency checks.

  — README; `RESEARCH-ai-puzzle.md` (Tier 1 item 2, Tier 2 item 7); `js/vision/matcher.js`
- No ML in the live loop, by design ("No machine learning in the live loop on an iPhone XR"). — `RESEARCH-ai-puzzle.md`

**Accuracy claims and how they were measured**
- The README warns: "The synthetic tests are a best case: computer-generated pieces under perfect lighting." The 74/80 and 108/120 figures come from `test/solve-aids.js`, which runs on a synthetic puzzle (`require('./synth')`). — README; `test/solve-aids.js`
- Real data, from `test/results/history.jsonl`, 113 runs:
  - `real-joins` (the owner's hand-labelled photos, v0.23.3–0.23.4, Oct 8): 28 true join sides. Partner ranked first **19/28**, top-3 23/28; shape alone 12/28; 17 of the 28 are near-ties. On the "known-weak" photos: top-1 8/30 sides.
  - `real-50`, the owner's 50-piece video IMG_3593 (v0.22.2, Oct 7): 48 of 51 entries "checked", 47 matched to the answer key, 2 doubles.
  - `real-50` case 3605, the counter video (v0.23.3): only 34 checked of 70 entries, 12 extra entries.

  — local clone `test/results/history.jsonl`
- From PLAN-v0.23: only "1 of 14" true joins passed the strict shown-pair rule (mutual first both ways, prob ≥ 0.8), although "10 of 14 ARE mutual first both ways, but at prob 0.2–0.6". — `PLAN-v0.23-map-and-pairs.md`
- Open problems, per its own docs:
  - Pale pieces on pale tables ("Nobody has solved pale pieces on a pale table in software").
  - The glass table setup ("IMG_3609: … still 0 checked").
  - Excess duplicate entries.

  — `RESEARCH-ai-puzzle.md`; `HANDOFF-2026-10-07-v0.22.md`

**Competitive research inside the repo (useful leads)**
- `RESEARCH-ai-puzzle.md` (2026-10-03) names these comparators:
  - Harstil/piece-finder, "top-1 78–86%, 93–97% when confident".
  - johnb8005/puzzle-piece-finder.
  - PuzPal.
  - "PuzAI", whose main feature is colour zones.
  - Mohammed-Jameal-J/jigsaw-puzzle-assistant.
  - jigsawlutioner, puzzle-bot and Zolver.
  - A John August post: "General chat-model vision is about 30% on jigsaws".

  — `RESEARCH-ai-puzzle.md`; [John August](https://johnaugust.com/2026/ai-jigsaw-puzzles)

**Independence from tomquist/puzzle-solver**
- puzzle-helper:
  - Plain browser JavaScript, a global `PH.*` namespace, a vendored OpenCV.js WASM build (`vendor/opencv-4.10.0-simd-em3174.js`) and Node test scripts.
  - Its repo was created 2026-10-03.
- tomquist/puzzle-solver:
  - TypeScript with Vite and Vitest, and no OpenCV dependency in `package.json`.
  - Its first commit, "Puzzle Solver: browser-only jigsaw puzzle assistant", is dated 2026-10-17.
- In a spot check I grepped `src/` for puzzle-helper's distinctive identifiers (`boardLevel`, `isCloseRead`, `shapeAgree`, "Fits / No"). The only shared name was the generic `unitArea`: a weighted piece-area estimator in `src/pipeline/pieces/segment.ts`, written as typed TS with a different signature. In puzzle-helper `unitArea` is a property passed through `PH.segment` options, not the same function.

  — local clones; `git log` of `/home/user/puzzle-solver`

### Inferences
- In features, puzzle-helper overlaps Puzzle Solver's main differentiators more than any store app does: multi-piece capture, fit detection, assembled patches and guided placement. It is not a market threat today: no licence, 0 stars, a hand-typed GitHub Pages URL, iPhone-only tuning, and no marketing.
  - Its README even tells other users to fork it to their own GitHub Pages to install it.
  - But anyone can copy the idea, and it shows that a capable AI-assisted solo developer can reach similar functionality in about 10 days.
- Its honest, measured numbers on real data (partner first 19/28; most true joins too uncertain to show) are a useful public benchmark for how hard pair-fitting is on real phone photos. Puzzle Solver should expect similar real-world limits.
- No copied code was found. The two projects converge on similar ideas because they read the same literature (loops, mutual-best, tab/blank typing).

### Gaps
- The full commit history could not be checked: the clone is shallow, and the GitHub API and HTML were blocked. The cadence above is reconstructed from in-repo documents.
- The author's real identity is not disclosed anywhere in the repo.
- No public roadmap beyond the in-repo PLAN files. Roadmap items in `PLAN-auto-background.md` and the HANDOFF "open issues" are internal: more automatic background learning, the quality-floor fix for close reads, an answer key for IMG_3605.

## Sweep: other Android apps, websites, open-source projects and research prototypes

### Takeaway
On Google Play, searches in English, German, French, Dutch, Spanish and Italian surface **only Solver Works and LY4Dev** as physical-piece finders. Everything else is digital jigsaw games, sudoku or cube solvers, or a collection tracker. On the web and GitHub, a burst of small **browser and on-device projects appeared in 2026**, several with live GitHub Pages builds:
- johnb8005/puzzle-piece-finder: has a "many pieces at once" mode and a no-two-pieces-per-cell assignment.
- Harstil/piece-finder: a live-scan PWA with published top-1 accuracy.
- syrja1/jigsaw-puzzle-helper: Finnish.
- erland/pwa-puzzle-finder.
- maksym-hrytsenko/puzzle-assistant: iOS, SAM 2.1.

All have 0 stars. The one established web tool, SolveAPuzzle, **shut down in 2026**.

### Cited Findings
**Google Play sweep (2026-10-22)**
- English queries: "jigsaw puzzle solver", "puzzle piece finder", "puzzle helper", "jigsaw assistant", "find puzzle piece camera", "jigsaw piece scanner", "puzzle solver camera", "jigsaw puzzle piece locator", "puzzle piece identifier", "jigsaw helper camera", "puzzle box photo piece".
- Other languages: "Puzzle Helfer", "Puzzleteil finden", "Puzzleteile Kamera erkennen", "trouver pièce puzzle", "pièce de puzzle où", "puzzelstukje vinden", "puzzel hulp stukje", "encontrar pieza puzzle", "pieza rompecabezas cámara", "trova pezzo puzzle".
- Only `puzzle.solver.puzzle_solver_app` and `www.ly.puzzlefinder` are physical-puzzle helpers. Puzzle Finder ranks first or second for most of the German, French, Spanish and Italian queries. — [Play search e.g. "Puzzleteil finden"](https://play.google.com/store/search?q=Puzzleteil%20finden&c=apps&hl=de)
- Adjacent or false positives:
  - **Puzzle Tracker** (proactiveBit) is a collection, timer and barcode tracker. Released 2021-03-11. 10,000+ installs (scraped exact 45,782), 4.46★ from 767 ratings, IAP "$2.99 – $79.00 per item", no ads. It is evidence that jigsaw hobbyists pay for utility apps, though it is not a solver. — [Google Play](https://play.google.com/store/apps/details?id=com.puzzletimer)
  - "AI Puzzle Solver" (FullStackPathway) is a generic LLM logic, math and word puzzle solver: 10,000+ installs, 2.6★ from 260 ratings, ads plus a $4.99 IAP. It is not for jigsaws, but it competes for the "puzzle solver" search term. — [Google Play](https://play.google.com/store/apps/details?id=com.fullstack.aipuzzlesolver)
  - "Puzzle Camera" (snowdog.app) is a camera slide-puzzle game. "Puzzle Seek" (Cleverside) is a jigsaw plus hidden-object game. Neither is relevant. — [Puzzle Camera](https://play.google.com/store/apps/details?id=app.snowdog.puzzle_camera); [Puzzle Seek](https://play.google.com/store/apps/details?id=com.cleverside.puzzleseek)

**Websites**
- **SolveAPuzzle has shut down.** The homepage now reads: "The last piece is in place. SolveAPuzzle has shut down. For a few good years, this little tool helped people find where their pieces went… SolveAPuzzle · 2023 – 2026." — [solveapuzzle.com](https://solveapuzzle.com/)
- Web searches for browser piece-finders returned only games, puzzle makers and the HMC clinic page. No commercial web competitor was found. — [web search results incl. HMC](https://hmc.edu/clinic/2020/puzzle-master-9000-the-jigsaw-puzzle-helping-app)

**GitHub: physical-puzzle helper apps created in 2025–2026 (all 0 stars unless noted; dates from GitHub search metadata)**

| Repo | Type | Created → last update | Live? | Key points |
|---|---|---|---|---|
| [johnb8005/puzzle-piece-finder](https://github.com/johnb8005/puzzle-piece-finder) | Browser app (React/TS, Bun), no server | 2026-09-21 → 2026-09-29 | **Yes**: [johnb8005.github.io/puzzle-piece-finder](https://johnb8005.github.io/puzzle-piece-finder/) | Key, piece, place flow. Plain-canvas ZNCC colour correlation over 4 turns × 3 sizes, coarse-to-fine, top-3 with verdicts ("Strong match" / "Likely match" / "Several spots look alike"). **"Many pieces at once" mode**: photograph many loose pieces, each cut out and numbered, and "no two pieces are given the same cell" (greedy assignment). Optional photo of the partly finished puzzle rules out filled spots. Saved puzzles in IndexedDB. "Nothing is uploaded." |
| [Harstil/piece-finder](https://github.com/Harstil/piece-finder) | PWA (TS), no OpenCV, ~45 KB worker | 2026-09-23 → 2026-09-27 | GitHub Pages 404 (not deployed there) | Live camera scan of loose pieces, labels like "C12 · R7" with a rotation arrow, confidence colours, "Mark as placed" removes the spot, region finder. Masked ZNCC plus gradient and colour stats with fitted weights. **Published accuracy on synthetic puzzles**: top-1 92/82/89/68/65% at 100/300/500/1000/2000 pieces; held-out test 86/78/85% at 100/300/500; rotation 100%; confident answers right 93–97%. Limits: pieces must not touch, and table-coloured pieces are missed. |
| [maksym-hrytsenko/puzzle-assistant](https://github.com/maksym-hrytsenko/puzzle-assistant) | iOS (Swift), Ukrainian UI | 2026-08-01 → 2026-10-20 | Not on App Store (build from source) | Aimed at ~4000-piece puzzles. **Segment Anything 2.1 Core ML** for piece outlines, Metal shader masked Lab colour correlation, 4 rotations. Area assembly mode, mark placed. "Probabilities are an uncalibrated heuristic". |
| [syrja1/jigsaw-puzzle-helper](https://github.com/syrja1/jigsaw-puzzle-helper) | Web app (compiled build only), Finnish UI ("Palapeli") | 2026-10-11 | **Yes**: [syrja1.github.io/jigsaw-puzzle-helper](https://syrja1.github.io/jigsaw-puzzle-helper/) | The UI asks for a whole-puzzle picture, a photo, and "Montako palaa palapelissä on?" (how many pieces?). Source not published. |
| [erland/pwa-puzzle-finder](https://github.com/erland/pwa-puzzle-finder) | PWA + OpenCV.js | 2026-01-01 → 2026-01-04 | **Yes**: [erland.github.io/pwa-puzzle-finder](https://erland.github.io/pwa-puzzle-finder/) | MVP: live segmentation, per-piece extraction, rule-based edge/corner classification, quality hints. No box matching mentioned. |
| [chiaolun/jigsaw_helper](https://github.com/chiaolun/jigsaw_helper) | React + Python FastAPI/OpenCV over WebSocket (server) | 2026-01-05 | No | Hold a piece to the webcam; SIFT matching, rotation-invariant, multiple candidates. |
| [alanclyeh/jigsaw_puzzle_locator](https://github.com/alanclyeh/jigsaw_puzzle_locator) | HTML | 2026-06-06 → 2026-06-27 | No Pages site found | "Help people to resolve jigsaw puzzle quickly"; no README. |
| [Mohammed-Jameal-J/jigsaw-puzzle-assistant](https://github.com/Mohammed-Jameal-J/jigsaw-puzzle-assistant) | FastAPI + React, server | not captured | No | One photo of scattered pieces: detection "99.5–99.7% success", edge classification "96% accuracy on the synthetic test set", border and corner finding, rotation. All on synthetic data. |
| [ddrpa/jigsight](https://github.com/ddrpa/jigsight) | Python desktop, Chinese | 2025-04-06 → 2026-05-13 | No | **20★**. Webcam plus SIFT piece location and rotation ("rotation… 别管对不对了", roughly "never mind whether it's right"). Recommends Zolver for low-feature areas. |
| [tiagompita/puzzle-piece-finder](https://github.com/tiagompita/puzzle-piece-finder), [texmex76/puzzle-piece-finder](https://github.com/texmex76/puzzle-piece-finder), [YYY923110/puzzle-piece-finder](https://github.com/YYY923110/puzzle-piece-finder) | Python scripts | 2025-08 to 2026-08 | No | Template matching. YYY923110 finds a piece by the number printed on its back. |

Sources: the repo READMEs fetched from raw.githubusercontent.com, and the GitHub Pages probes, 2026-10-22.

**GitHub: established solvers and robots (stars as of 2026-10-22)**
- [nemanja-m/gaps](https://github.com/nemanja-m/gaps): 772★. A genetic-algorithm solver for square digital puzzles; updated 2026-10-13. Not a physical helper.
- [roksenhorn/puzzle-bot](https://github.com/roksenhorn/puzzle-bot): 338★. Python for a jigsaw-solving robot; updated 2026-10-06.
- [Kawaboongawa/Zolver](https://github.com/Kawaboongawa/Zolver): 209★. An automatic solver from piece images using edge and shape matching; updated 2026-09-21.
- [markroberyoutube/puzzle_bot](https://github.com/markroberyoutube/puzzle_bot): 126★. Mark Rober's jigsaw robot; created 2024-03; updated 2026-09-17.
- [davidlavy88/jigsawpuzzlesolver](https://github.com/davidlavy88/jigsawpuzzlesolver): 15★. C++ SIFT and FLANN (2012).

Source: GitHub repository search.
- byWulf/jigsawlutioner was cited in the puzzle-helper research as solving "only Ravensburger-style cuts by shape". I could not retrieve its star count. — `RESEARCH-ai-puzzle.md`; [packagist](https://packagist.org/packages/bywulf/jigsawlutioner)

**Hugging Face Spaces**
- I searched Spaces for "jigsaw", "puzzle-piece" and "puzzle-solver". There are no physical-piece localisation demos. The results are toxic-comment classifiers (the "Jigsaw" dataset), Jigsaw-ViT experiments, digital jigsaw games and logic-puzzle solvers, all with 0–1 likes. — [HF Spaces API "jigsaw"](https://huggingface.co/api/spaces?search=jigsaw&limit=60); [HF "puzzle-solver"](https://huggingface.co/api/spaces?search=puzzle-solver&limit=60)

**Academic prototypes and robotics (brief)**
- **WPI MQP "Jigsaw Puzzle Solver" (2022).** Advised by Prof. Jacob Whitehill. The students uploaded photos of scattered pieces and the finished puzzle, and matched on edges, internal features (SIFT) and colour, with visual cues. Accuracy "declined linearly as the puzzle was split into more pieces". The puzzle-helper research cites SIFT placement falling from 91% to 54% between 24 and 96 pieces. — [WPI Digital](https://digital.wpi.edu/concern/student_works/qf85nf844?locale=en); [report PDF](https://digital.wpi.edu/downloads/9593tz483)
- **Harvey Mudd Clinic "Puzzle Master 9000" (2020).** An overhead photo of loose pieces; contours are extracted and compared to find the most probable fitting pairs. — [HMC Clinic](https://hmc.edu/clinic/2020/puzzle-master-9000-the-jigsaw-puzzle-helping-app)
- **Robotics.** Stuff Made Here's jigsaw robot (YouTube, explained in a Dec 2022 video, HN item), Mark Rober's puzzle_bot (above), and "Jigsaw Puzzle Robot… solved a puzzle in 15 months" (HN 2024). These are spectacle and engineering, not consumer tools. — [HN Stuff Made Here](https://news.ycombinator.com/item?id=33816308); [HN robot 2024](https://news.ycombinator.com/item?id=41043314)

### Inferences
- The "browser-only, nothing uploaded, box photo then piece" idea is now common in hobby open source. At least four GitHub Pages or PWA builds appeared between Jan and Oct 2026. johnb8005's "many pieces at once" with unique-cell assignment is the closest open-source match to Puzzle Solver's 10–40-piece batches. puzzle-helper is the closest on fit, patch and guidance features.
- None of these projects has distribution: 0 stars, no store presence, no marketing. Discoverability, polish and trustworthy accuracy are the real moats, not the algorithms.
- SolveAPuzzle closing after about 3 years is weak evidence that a stand-alone web piece-finder struggled to sustain itself. Its cause of closure is unknown.
- Harstil's published synthetic top-1 curve (92% at 100 pieces falling to about 65% at 2000), together with puzzle-helper's real-photo pair top-1 of 19/28, gives a reasonable expected accuracy band for Puzzle Solver's own claims.

### Gaps
- GitHub commit counts, contributors and exact last-commit dates for each repo could not be fetched, because the GitHub API was blocked. The "last update" dates come from search metadata (`updated_at`), not commit logs.
- The source and author of syrja1's compiled build are unknown. I did not test whether alanclyeh's locator is hosted.
- "PuzAI" (cited in puzzle-helper's research for colour zones) was not located in this sweep.
- Reddit, TikTok and YouTube app reviews were not searched (blocked or out of scope).

## Traction estimates

### Takeaway
Both Android competitors are under 10K lifetime installs after about 9 months: about 7.9K for Solver Works and about 9.3K for Puzzle Finder. That works out to roughly 850 and 1,050 installs a month on average (my calculation). Every open-source competitor has 0 stars except jigsight (20★). No third-party install-history service was reachable.

### Cited Findings
- Solver Works: 5,000+ badge; scraped exact installs 7,887; 50 ratings; released 2026-01-06. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en)
- Puzzle Finder: 5,000+ badge; scraped exact installs 9,304; rating hidden (3.1★ on the developer page); released 2026-01-27. — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en); [developer page](https://play.google.com/store/apps/developer?id=LY4Dev&hl=en)
- AppBrain (both apps) and APKPure returned HTTP 403. AndroidRank returned 404 (no page). 42matters returned 404. APKCombo failed through the proxy (502). — [AppBrain](https://www.appbrain.com/app/jigsaw-puzzle-solver/puzzle.solver.puzzle_solver_app)
- Review counts grew slowly. Solver Works: 26 written reviews over 9.5 months, all locales. Puzzle Finder: 9 over 8 months. — Google Play reviews (both listings above)
- GitHub stars (2026-10-22): jellojm/puzzle-helper 0; johnb8005 0; Harstil 0; maksym-hrytsenko 0; syrja1 0; erland 0; ddrpa/jigsight 20. — GitHub search

### Inferences
- Estimate: average monthly installs are about 7,887 / 9.5 ≈ 830 for Solver Works and about 9,304 / 8.8 ≈ 1,060 for Puzzle Finder. These are averages only; the trend over time is unknown.
- Puzzle Finder has more installs but fewer ratings. Its first-place ranking for most non-English Play queries, together with its localised listing, may be driving installs in Europe (inference).
- With 50 ratings and roughly 8K installs, Solver Works' rating-to-install ratio is about 0.6%, typical for a utility app. Nothing suggests viral growth.

### Gaps
- No time series of installs, no country split, and no revenue data. AppBrain, Sensor Tower and AppMagic were blocked or have no coverage for apps this small.
- The `realInstalls` figure comes from Play's page data via a scraper. Google does not document it publicly, so treat it as an approximation.
