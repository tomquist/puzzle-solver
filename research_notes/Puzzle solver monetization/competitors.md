# Competitive landscape: camera apps that help solve PHYSICAL jigsaw puzzles

Data collected 2026-10-21 from App Store listings (iTunes Search API plus apps.apple.com pages, US storefront), Google Play listings (US), developer websites, and Hacker News (Algolia API). Reddit could not be reached: the Reddit JSON API returned a block page, and the search tool refuses reddit.com. Sensor Tower and AppBrain pages also returned 403. So there is **no Reddit sentiment, and no third-party revenue or download estimate, in these notes**. Every price below is the US storefront price.

## Which apps exist, who makes them, and when they launched

### Takeaway
The category is tiny, new and fragmented. Every direct competitor found is a one-person app. Most launched in 2026, and three appeared on iOS within ten days of each other (Sep 14 to Sep 23, 2026). None has real traction yet. The two Android apps are at "5K+" installs, and the iOS apps have 0 or 1 ratings. No manufacturer app (Ravensburger etc.), funded startup, or AI/ChatGPT product turned up. Large "jigsaw" apps with millions of ratings are digital puzzle games, not solvers.

### Cited Findings
**Direct competitors (photo of box, then photo of piece, then location):**
- **Jigsaw Puzzle Solver** (Android). Developer "Solver Works", listed as Michiel van Immerzeel, Amsterdam, NL, contact@puzzlesolver.app. Package `puzzle.solver.puzzle_solver_app`. 5K+ downloads, 2.8 stars from about 50 reviews, "Contains ads", updated Oct 7, 2026. Calls itself "a preview version". Flow: (1) photograph the box image, (2) photograph a single piece, (3) see the best matching location. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
  - On Google Play since January 2026, per AppBrain as summarised by a search engine. AppBrain blocked direct fetch, so this is unverified. — [AppBrain](https://www.appbrain.com/app/jigsaw-puzzle-solver/puzzle.solver.puzzle_solver_app)
  - No iOS version was found under "Solver Works" in an iTunes search. puzzlesolver.app returned HTTP 503 when fetched.
- **Puzzle Finder** (Android). Developer "LY4Dev" (Lefeuvre Yohann, France). Package `www.ly.puzzlefinder`. 5K+ downloads, no rating shown, updated Aug 30, 2026, v1.6. Flow: photograph the box, photograph the piece, "shows you exactly where it belongs". Uses OpenCV. Claims "Works 100% offline", "No data collection", "No ads, no tracking". The Data safety section says no data is collected or shared. — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US)
- **PuzzleLens: Puzzle Solver** (iOS 18+, also listed for Mac M1+ and visionOS). Developer Alperen Saglam (Turkey; also makes AR-drawing, calorie-scanner and translator apps). Released 2026-09-23, v1.1.2 on Oct 12, 2026, 7.3 MB, 0 ratings. Tells you "the row, the column and which way to turn the piece". Has a graded hint system: region first, then exact cell, then rotation. Says when it "isn't sure" on sky or flat colour. Recognition runs "entirely on your iPhone. No internet needed". Also has a puzzle gallery with a progress mosaic and optional friends/social features. — [App Store](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
- **Puzzle Detective: Piece Finder** (iOS 16+). Developer Emily Liu. Released 2026-09-14, v1.0.1 on about Oct 17, 2026, 42.2 MB, in 21 languages, 0 ratings. Flow: photograph or import the full image, adjust four corner handles, photograph or select one piece, confirm detection, then see "multiple possible matching locations". Saves searched pieces per puzzle project and has a "cute hamster detective" mascot. It warns that solid-colour pieces can't be placed reliably. — [App Store](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)
- **Puzzle Pointer: Piece Finder** (iOS 17+, Mac, visionOS). Developer Bobby Landerman, a serial indie with several small tracker apps (Post Pill, Cedar, TailLedger and others). Released 2026-09-23, v1.0.8, 5.0 stars from 1 rating. Its differentiator is a **box barcode scan against a catalogue of "over 10,000 puzzles"** (Ravensburger, Buffalo Games, Galison, White Mountain, Springbok, Cobble Hill), so you don't have to photograph the box. Shows ranked spots "with the piece turned to match the spot". Auto-captures when the piece is sharp. Asks "Did it fit?" for feedback. Warns about plain-colour pieces before you use a search. — [App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519); [puzzlepointer.com](https://puzzlepointer.com/)

**Adjacent or different approach:**
- **PuzPal** (iPhone, iOS 18+). Matches by **piece shape and contour only, not artwork**, using Apple's Vision framework and the live camera. Modes are "Scan Gap", "Scan Piece" and "Scan Edge". It shows a real-time confidence indicator and explicitly says it uses "no AI, machine learning, or neural networks". It is "a matching assistant, not an auto-solver". Fully on-device, with no account. Developer not named on the site. — [puzpal.com/about](https://puzpal.com/about/); [puzpal.com](https://puzpal.com/)
  - On the site's /download/ page, crawled 2026-10-21: "The App Store listing is being connected. Check back shortly". The sitemap is dated March 2026. It appears **not yet live** on the App Store, and no listing turned up in iTunes searches. — [puzpal.com/download](https://puzpal.com/download/)
- **Puzzle Friend** (iOS, Jens Wiese, released 2025-05-20) is a collection organiser and tracker, not a solver. — [App Store search result](https://www.puzzle-friend.com/)
- "Puzzle-Buddy" (Adrondak LLC, iOS, Aug 2026) is a **digital** jigsaw game and does not compete despite the name. — [adrondak.com/puzzlebuddy](https://www.adrondak.com/puzzlebuddy)
- Listicles ranking "best jigsaw puzzle solver apps" fill the slots with open-source GitHub projects (Jigsawlutioner, Zolver, kellinwood's Puzzle Solver, UnPuzzled) and ASolver, which is a Rubik's-cube solver. No consumer jigsaw-helper apps appear in them, which confirms the category had little presence before 2026. — [Rigorous Themes, Jan 2026](https://rigorousthemes.com/blog/best-jigsaw-puzzle-solver-apps/); [Morning Dough, Feb 2024](https://www.morningdough.com/ai-tools/best-ai-jigsaw-puzzle-solver/)
- The web tool "SolveAPuzzle" claims to handle photos of physical puzzles. It was not examined in depth. — [solveapuzzle.com](https://solveapuzzle.com/)

### Inferences
- Four or five near-identical "box photo, then one piece photo, then location" apps shipped in 2026. The core idea is now commoditised, and differentiation has to come from accuracy, many pieces per photo, fit and assembly features, and UX.
- A September 2026 cluster of iOS launches is a fast-moving signal. Expect more entrants, possibly vibe-coded. The near-identical copy ("Stuck on a jigsaw piece?") in PuzzleLens and Puzzle Pointer is notable.
- No incumbent has brand, distribution, or a large review base. The field is still open.

### Gaps
- No Ravensburger, Buffalo, Clementoni or other manufacturer piece-finder app was found. Searches for manufacturer apps returned only digital games. This is not exhaustive.
- No ChatGPT, Gemini or custom-GPT workflow for physical piece location was found documented. Searches returned only GPT-made digital jigsaw games. — [OpenAI community](https://community.openai.com/t/share-a-gui-jigsaw-puzzle-game-made-by-gpts/763107)
- Exact launch dates for the two Android apps could not be verified directly.

## Monetization: prices, tiers, trials, limits, ads

### Takeaway
There is no settled price point yet. Models range from free with ads, through donations, $0.99/month ad removal, and per-search packs ($2.99 for 10), up to a $6.99/month subscription. One app sells 3-month, annual and lifetime access ($4.99 / $9.99 / $19.99). PuzPal plans a one-time paid app. Nobody uses aggressive weekly subscriptions, the $6.99/week pattern common in utility apps.

### Cited Findings
| App | Model | Exact prices (US) | Free tier / limits | Ads |
|---|---|---|---|---|
| Puzzle Pointer (iOS) | Freemium: consumable pack or monthly subscription | "10 Search Pack $2.99" (one-time, "Searches stay on your account until used"); "Puzzle Pointer Monthly $6.99 / month" for unlimited personal searches | First 5 searches free, no account. If a free search fails or the piece "didn't fit", you get an extra free search, "up to 10 free in total". Unusable photos and failures don't count | "No ads, ever" |
| Puzzle Detective (iOS) | Time-boxed access plus lifetime | "3-Month Access $4.99", "Annual Access $9.99", "Lifetime Access $19.99" | Has a trial (release notes mention "Clearer purchase status and trial messages"). Trial length and limits not stated | None declared |
| PuzzleLens (iOS) | Free with ads; Pro removes ads | "PuzzleLens Pro $0.99", a monthly auto-renewing subscription | "Unlimited puzzles, scans and hints — no daily limit"; "supported by ads shown after scans" | Yes, after scans |
| Jigsaw Puzzle Solver / Solver Works (Android) | Free with ads | No in-app purchases listed | Free | "Contains ads" |
| Puzzle Finder / LY4Dev (Android) | Free plus donations | Ko-fi link "ko-fi.com/lefyo" in release notes | Free | "No ads" |
| PuzPal (iOS, apparently not yet live) | Paid upfront | "a one-time purchase from the App Store with no recurring fees, in-app purchases, or hidden costs". Price not published | — | — |

Sources: [Puzzle Pointer App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519), [puzzlepointer.com pricing/FAQ](https://puzzlepointer.com/); [Puzzle Detective App Store](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); [PuzzleLens App Store](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [Solver Works Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US); [Puzzle Finder Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US); [PuzPal About/FAQ](https://puzpal.com/about/)

- For comparison, digital jigsaw *games* charge far more. Critical Hit Software's Jigsaw Puzzle "Puzzle Club" is $6.99/week, $19.99/month or $139.99/year (2020 listing, per a search summary). Jigsaw Master (Yang Li) is $6.99/week or $12.99/month. These show that jigsaw hobbyists do pay subscriptions for puzzle *content*. — [search summary of App Store/AppFollow listings](https://apps.appfollow.io/ios/jigsaw-master-jigsaw-puzzles/6479604972?country=br) (secondary aggregator; prices may be stale)

### Inferences
- Puzzle Pointer's per-search pricing implies about $0.30 per piece located. Hobbyists use these apps on the few "stuck" pieces, so usage is bursty. That favours packs or lifetime pricing over monthly subscriptions. Puzzle Detective's $19.99 lifetime and PuzPal's one-time price reflect the same idea.
- Puzzle Pointer's server costs (server-side search plus OpenAI calls) push it toward metered pricing. An on-device or browser-only product has near-zero marginal cost per search and can undercut it with "unlimited" plans.
- A $0.99/month ad-free tier (PuzzleLens) suggests the developer expects low willingness to pay or is chasing volume. It sets a low reference price in the category.

### Gaps
- PuzPal's actual price is unknown.
- Puzzle Detective's trial terms and any free-search quota are unknown. These were not visible in the listing text.
- Non-US pricing was not collected.

## Downloads, ratings and revenue estimates

### Takeaway
Every competitor is at "micro" scale: at most 5K+ installs on Android, and 0 or 1 ratings on iOS for the September 2026 launches. No public revenue estimates exist, and they would most likely be negligible, under a few hundred dollars a month. That last point is an inference, not data.

### Cited Findings
- Solver Works Jigsaw Puzzle Solver: **5K+ downloads, 2.8 stars, ~49 to 50 reviews** (phone), as of 2026-10-21. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
- LY4Dev Puzzle Finder: **5K+ downloads**, no rating summary displayed. — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US)
- PuzzleLens: 0 ratings (userRatingCount 0). Puzzle Detective: 0 ratings. Puzzle Pointer: 1 rating, 5.0. App Store pages say "This app hasn't received enough ratings or reviews to display an overview" for the first two. — [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [Puzzle Detective](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); [Puzzle Pointer](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
- For scale, digital jigsaw games are huge on iOS: Easybrain "Jigsaw Puzzles - Puzzle Games" has 1,111,706 ratings, Jigsawscapes 432,576, and Critical Hit "Jigsaw Puzzle: Daily Puzzles" 401,130. This is evidence of a large jigsaw-hobbyist audience on mobile, not of solver demand. — iTunes Search API, 2026-10-21 ([Easybrain listing](https://apps.apple.com/us/app/jigsaw-puzzles-puzzle-games/id1324604053))

### Inferences
- With 5K installs, ads (Solver Works) or donations (Puzzle Finder) would bring in only trivial revenue. Nobody has proven demand at scale. A first mover with good accuracy could still own the category, but the total addressable revenue is unproven.

### Gaps
- No Sensor Tower, AppMagic or Appfigures estimates. The pages were blocked or don't exist for apps this small. No founder interviews, Indie Hackers posts, or press revenue figures were found.

## What reviews praise and complain about

### Takeaway
The only meaningful review base is Solver Works on Android, with about 50 reviews at 2.8 stars. The dominant theme is **accuracy**: good on detailed or illustrated puzzles, poor on photo-realistic puzzles and low-detail areas. Users want a "try again / it's wrong" feedback loop. No paywall or subscription complaints exist yet, because the reviewed apps are free.

### Cited Findings
- Negative (Jeff Bell, May 25, 2026): "The learning function for AI is slow… give the user the ability to tell the app when it's wrong so it can keep trying… Currently it is less than 25% correct." The developer replied that a "try again" function is "a nice idea; we actually hadn't thought about that yet… Puzzles with clear details generally have much higher accuracy." — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
- Mixed (Egor Arslan, Apr 9, 2026): "Great and well working app. It even helped me find some pieces, but I still wouldn't say it works perfectly on detailed puzzles. A good feature is that it shows the percentage on the left." — same source
- Positive (Cerri Love, Sep 1, 2026): "Lifesaver for a really complex puzzle. Works really well." — same source
- Another reviewer, per a search summary: "positions are not 100% accurate, but the region is most of the time correct." — [Google Play (en_AU)](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_AU)
- The developer's own disclaimer: "some areas, such as blue skies or areas with little detail, are harder to match… illustrated puzzles are easier to match than puzzles based on photos." — same source
- Every competitor now builds "honesty about hard pieces" into its marketing. PuzzleLens: "Rather than inventing an answer, PuzzleLens shows you a region and says it isn't sure". Puzzle Pointer: "plain sky or single-colour pieces get a heads-up before you use a search". Puzzle Detective: "Solid-color puzzle pieces do not contain enough visual information". This suggests early users complained about confidently wrong results. — [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [Puzzle Pointer](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519); [Puzzle Detective](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)
- Privacy angle (from listings, not reviews):
  - Solver Works' Data safety says it "may share… Location and Device or other IDs" with third parties (ads) and "Data can't be deleted". — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
  - PuzzleLens is advertised as on-device, yet its App Store privacy label declares "Data Used to Track You: Identifiers, Usage Data" and coarse location for third-party advertising. — [App Store](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
  - Puzzle Pointer uploads photos: "The piece search runs on that Puzzle Pointer server. Photos… are stored… in private Cloudflare R2 storage". It also sends "a reduced-size copy of that photo… to OpenAI" to check box photos. — [Puzzle Pointer privacy policy, effective 2026-10-09](https://puzzlepointer.com/privacy/)

### Inferences
- Accuracy on hard puzzles (photographic, low-detail, 1000+ pieces) is the core quality battleground and the main source of 1 to 2 star reviews.
- A "wrong, try next" loop is a low-cost feature users explicitly asked for. Puzzle Pointer added one ("Did it fit? Tap yes, or move to the next spot").

### Gaps
- No iOS reviews exist yet for the September 2026 apps. Older Solver Works reviews beyond the three shown were not retrievable without the Play reviews API.
- No reviews mentioning paywalls, subscription anger or piece-count limits exist in this category yet. Those signals will only appear as paid apps gain users.

## Media coverage, viral moments, and the "cheating" stigma

### Takeaway
No press coverage or viral moment specific to consumer piece-finder apps was found. The closest viral content is engineering and robot spectacle (Stuff Made Here, Jigsolved), not a consumer app. Reddit, the main hobbyist venue, could not be accessed, so community attitudes toward paying and "cheating" are **unverified**.

### Cited Findings
- HN: "Stuff Made Here: Algorithms of Jigsaw Puzzle Solvers Explained" (YouTube, posted Dec 2022). Stuff Made Here's puzzle-solving-robot video was widely viewed, but HN traction was low (2 points). — [HN item](https://news.ycombinator.com/item?id=33816308)
- HN: "Jigsolved: Computer Vision to Solve Jigsaw Puzzles" (Cornell Tech, Aug 2018, 49 points, 13 comments). — [HN item](https://news.ycombinator.com/item?id=17750335)
- HN: "Jigsaw Puzzle Robot, Or: How We Solved a Puzzle in 15 Months" (2024). — [HN item](https://news.ycombinator.com/item?id=41043314)
- HN: "Counting jigsaw puzzle pieces with OpenCV" (kleemans.ch, Jul 2025). — [HN item](https://news.ycombinator.com/item?id=44487930)
- No "Show HN" post for a physical-puzzle piece-finder app was found (Algolia search on "jigsaw puzzle piece", "jigsaw solver", "puzzle piece finder"). — [HN Algolia](https://hn.algolia.com/)
- A Harvey Mudd clinic project, "Puzzle Master 9000: The Jigsaw Puzzle-Helping App" (2020), took an overhead image of loose pieces and found pairs with the highest probable fit. It is academic precedent for multi-piece and fit matching, not a shipped product. — [HMC Clinic](https://hmc.edu/clinic/2020/puzzle-master-9000-the-jigsaw-puzzle-helping-app)
- On the cheating question, the only discussion found concerns a *digital* jigsaw game (Steam). One commenter called using an orientation cue cheating "because a physical puzzle gives no such hint", and another argued that reading light and shading is normal puzzling. — [Steam Community discussion](https://steamcommunity.com/app/351030/discussions/0/1291817837620862241)
- Competitors position their apps against the stigma. PuzzleLens offers graded hints: "How much help you take is your choice — and how many hints a puzzle took is kept in your records". PuzPal says "It's a matching assistant, not an auto-solver". Solver Works calls itself "a helpful assistant that makes solving them more fun". — [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [PuzPal](https://puzpal.com/about/); [Solver Works](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)

### Inferences
- Several developers independently framed their apps as "assistant, not solver" and added hint gradation. That suggests they anticipate the cheating stigma (or have met it).

### Gaps
- r/Jigsawpuzzles and r/puzzles threads, TikTok coverage, and news articles were not reachable or not found. Reddit blocked both the API and the search tool. This is the biggest open gap for willingness-to-pay and stigma evidence, and is worth a manual check.

## Gaps competitors leave that Puzzle Solver covers

### Takeaway
Every artwork-matching competitor locates **one piece per photo**, and none does piece-to-piece fit, already-assembled patches, or guided step-by-step placement. Only PuzPal does fit, and only by shape, one at a time, in an app that may not be live. All are native single-platform apps (iOS-only or Android-only). Puzzle Solver's multi-piece batches (10 to 40 per photo), fit detection with animation, patch handling, guided placement, cross-platform PWA and fully on-device, no-upload design are clear differentiators. Rotation guidance and bad-photo warnings are no longer unique.

### Cited Findings
| Capability | Solver Works (A) | Puzzle Finder (A) | PuzzleLens (iOS) | Puzzle Detective (iOS) | Puzzle Pointer (iOS) | PuzPal (iOS, not live?) | **Puzzle Solver (PWA)** |
|---|---|---|---|---|---|---|---|
| Pieces per photo | 1 ("a single puzzle piece") | 1 | 1 ("the piece you're stuck on") | 1 ("an individual puzzle piece") | 1 ("one loose piece") | 1 at a time, live camera | **10–40** |
| Location in picture | Yes | Yes | Yes (row/col, graded hints) | Yes (multiple candidates) | Yes (ranked spots) | No (shape only) | Yes |
| Rotation guidance | Not stated | Not stated | **Yes** ("which way to turn") | Not stated | **Yes** (piece shown turned) | n/a | Yes |
| Piece-to-piece fit | No | No | No | No | No | **Yes** (contour gap/piece) | **Yes, with animation** |
| Already-assembled patches | No | No | No | No | No | Gap scanning only | **Yes** |
| Guided placement | No | No | Progress mosaic | Saved pieces list | "Did it fit?" loop | Confidence meter | **Yes, piece by piece** |
| Bad-photo / hard-piece warnings | Disclaimer only | — | Uncertainty flag | Tips + detection confirm | Auto-capture + plain-colour warning | Lighting FAQ | Yes |
| Box lookup without photo | No | No | No | No | **Barcode, 10,000+ puzzle catalogue** | n/a | No (photo once) |
| On-device / offline | Unclear; ad SDK shares IDs | **Yes** (claims) | **Yes** (but ad tracking) | Not stated | **No** (server + OpenAI) | **Yes** | **Yes, nothing uploaded** |
| Platforms | Android | Android | iOS/Mac/visionOS | iOS | iOS/Mac/visionOS | iOS | **Any browser** |
| Price | Free + ads | Free + Ko-fi | Free + ads; $0.99/mo no ads | $4.99/3mo, $9.99/yr, $19.99 lifetime | 5 free; $2.99/10; $6.99/mo | One-time (TBD) | Free (today) |

Sources: [Solver Works](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US); [Puzzle Finder](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US); [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [Puzzle Detective](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); [Puzzle Pointer](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519), [Puzzle Pointer privacy](https://puzzlepointer.com/privacy/); [PuzPal About](https://puzpal.com/about/). Puzzle Solver column is from the brief, not researched.

### Inferences
- **Strongest unique wedges:**
  1. Batch detection of 10 to 40 pieces per photo. Competitors charge or meter *per piece*, and Puzzle Pointer's model makes a 40-piece batch cost about $12 in packs.
  2. Piece-to-piece fit plus patch handling.
  3. Cross-platform with no install, and fully private.
- Puzzle Pointer's barcode catalogue is a convenience feature Puzzle Solver lacks. It is not essential, because Puzzle Solver needs only one box photo.
- Privacy is a credible marketing angle. One competitor uploads photos to its own server and to OpenAI, one ships tracking ads, and one claims "on device" while declaring tracking identifiers.
- Being web-only cuts both ways. No 30% store cut, and Android plus iOS are reached at once. But App Store search, where every competitor gets found, is unavailable, and payments need a web processor (Stripe, Lemon Squeezy, etc.).

### Gaps
- Accuracy was not benchmarked head-to-head. No public tests compare these apps on the same puzzle.
- Maximum piece counts supported were not stated, except PuzzleLens "Works with 1000-piece puzzles". — [App Store](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
