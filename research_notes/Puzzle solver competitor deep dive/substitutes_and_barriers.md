# Indirect Competition, Substitutes and Barriers to Entry for "Puzzle Solver"

Research date: 2026-10-22. Sources are web search results and fetched pages. Some pages (cobblehillpuzzles.com, heypuzzlers.com) returned HTTP 429 and could not be read. Reddit could not be reached directly, here or in the sibling monetization notes, so Reddit sentiment is missing. Where a figure comes from a third-party estimator (AsInsight, AppGoblin, Sensor Tower), it is labelled as an estimate.

Context from sibling notes (`research_notes/Puzzle solver monetization/competitors.md`, collected 2026-10-21): the direct piece-finder competitors are Solver Works "Jigsaw Puzzle Solver" (Android, since about Jan 2026, 5K+ installs), LY4Dev "Puzzle Finder" (Android, OpenCV, offline), and three iOS apps launched 2026-09-14 to 2026-09-23: PuzzleLens, Puzzle Detective and Puzzle Pointer. This file covers everything *other* than those direct rivals.

## 1. General-purpose AI (ChatGPT, Gemini, Claude, Google Lens, Apple Visual Intelligence) as a substitute

### Takeaway
I found **no published test, blog post, video or forum report (2024–2026) of anyone successfully using ChatGPT, Gemini, Claude, Google Lens or Apple Visual Intelligence to locate a photographed physical piece on a box image**, and no OpenAI, Google or Apple feature marketed for it. Academic benchmarks say frontier VLMs are poor at jigsaw spatial reasoning, well below humans and near chance on anything bigger than tiny grids. For now, general AI is a weak substitute, though that could change quickly.

### Cited Findings
**Academic benchmarks of VLMs on jigsaw tasks**
- *Jigsaw-Puzzles* benchmark (Lyu et al., arXiv 2505.20728, May 27, 2025) defines a "Piece Localization" task: given a partly masked image and a patch, the model must find the patch's original position. Results on Easy (2×2, 2 masks; chance 50%) and Hard (3×3, 4 masks; chance 25%):
  - Gemini-2.5-Pro: 78.82% Easy, 61.09% Hard (best model).
  - GPT-4o: 61.55% / 53.45%.
  - Claude-3.7-Sonnet: 60.27% / 44.55%.
  - Gemini-2.5-Flash-Thinking: 76.64% / 51.27%.
  - Humans: 95.45% / 91.36%.
  - Source: [arXiv 2505.20728](https://arxiv.org/html/2505.20728v1)
- That task is far easier than the real one. It uses a clean digital image, a choice among 2 to 4 slots, and no rotation, lighting or perspective. A real 1000-piece puzzle has about 1000 candidate positions and 4 rotations. — inference from the [task definition](https://arxiv.org/html/2505.20728v1)
- *JigShape* (Shawn Li, Yue Zhao et al., USC/NUS/Adobe and others, arXiv 2607.27670, v2 Aug 4, 2026) tests full reassembly of tab-and-blank puzzles at 4×4 to 16×16. Zero-shot results:
  - GPT-5.5: 69.65% piece accuracy at 4×4 (26.40% exact match), but only 4.37% at 8×8 and 0.67% at 12×12.
  - Claude Opus 4.8: 8.50% at 4×4. Grok-4.2-reasoning: 11.97%. Llama-4-Maverick: 6.62%. GPT-5.4-mini: 6.75%.
  - Random: 6.25%.
  - The authors conclude that "zero-shot geometric reasoning is largely absent" and report a "scaling cliff": even fine-tuned 8–12B models fall from about 97% at 4×4 to under 5% at 12×12.
  - Accuracy is highest for corners and lowest for interior pieces.
  - Gemini was not evaluated.
  - Source: [arXiv 2607.27670](https://arxiv.org/html/2607.27670)
- Some of the work above is reassembly from pieces alone, a harder and different problem than matching a piece to a known box image. FCViT, cited in a Nov 2025 paper, regresses each fragment's absolute (x, y) grid position, which is the closest research analogue to "where does this piece go". — [arXiv 2511.06315](https://arxiv.org/html/2511.06315v1)

**Consumer and anecdotal evidence**
- A custom GPT called "Jigsaw Genius" exists in the ChatGPT GPT Store. It invites users to "Share a photo of a puzzle you're working on for help or hints!" I found no usage numbers or quality reports. — [ChatGPT GPT Store](https://chatgpt.com/g/g-49MNsW3Gg-jigsaw-genius)
- Tests by blogger "titotal" show ChatGPT's *image generation* struggles to draw coherent jigsaw puzzles: piece shapes and holes don't match. This is generation, not localization, and is reported via search-result summary only. — [titotal Substack](https://titotal.substack.com/p/15-simple-ai-image-prompts-that-stump); [follow-up](https://titotal.substack.com/p/its-still-easy-to-stump-chatgpts)
- Google Lens guidance is generic: crop to one subject, use good light. Lens is built for identifying products, landmarks and text. I found no source showing it matching a piece to a box region. — [Lilach Bullock guide](https://www.lilachbullock.com/how-to-use-google-lens/); [Google Search Help](https://support.google.com/websearch/answer/1325808?hl=en&co=GENIE.Platform%3DAndroid)
- One direct competitor already uses an LLM as a *component*. Puzzle Pointer sends "a reduced-size copy of that photo… to OpenAI" to check box photos, while its piece search runs on its own server. — [Puzzle Pointer privacy policy, effective 2026-10-09](https://puzzlepointer.com/privacy/) (via sibling notes)
- A Quora thread asks whether AI can assemble a puzzle from a photo of the finished image. This shows latent consumer curiosity, but it is anecdotal. — [Quora](https://www.quora.com/Is-there-a-way-to-take-a-photo-of-the-finished-puzzle-and-with-AIs-help-assemble-the-exact-puzzle-from-scratch)

### Inferences
- The lack of any "I asked ChatGPT where this piece goes" content, despite huge chatbot usage, suggests that either people rarely try it or it fails often enough that nobody posts about it. Benchmark data supports the second explanation.
- The risk is real but not imminent. The jump from GPT-4o (53% on 3×3 Hard) to GPT-5.5 (70% on 4×4 JigShape) shows fast progress. Classical feature matching (SIFT/ORB, as used by the OpenCV-based competitors) plus a 2D search over the box image is still far better suited than a chat VLM, and it runs on-device and for free.
- The bigger threat is an OS-level feature: Apple Visual Intelligence or Google Lens adding a "find in image" mode. Matching a template inside a reference image is a generic CV primitive, so a platform owner could ship it. I found no evidence of plans (see Gaps).
- A chat assistant is also slower: two photos, a prompt and a text answer, against a camera overlay. Even with equal accuracy, a dedicated app keeps a UX edge.

### Gaps
- No YouTube, TikTok, HN or Reddit test of ChatGPT, Gemini or Claude locating a physical piece on a box image turned up across several searches. Reddit could not be accessed directly. An in-house test (GPT-5.x, Gemini 2.5/3, Claude on 10–20 real pieces) would close this gap cheaply.
- No information on Apple Visual Intelligence or Gemini Live handling this task, and no OpenAI or Google feature marketed for jigsaws.
- Gemini 3-era models were not covered by either benchmark found.

## 2. Adjacent apps that could add a piece-finder feature (trackers, timers, digital jigsaw games)

### Takeaway
The adjacent ecosystem is real but small, apart from the digital jigsaw games. Collection trackers already own the barcode-to-puzzle catalogue that is the natural on-ramp to a piece finder. **MySpeedPuzzling** has 43.5K puzzles, about 26K with EANs, and 11.9K puzzlers. **Hey Puzzlers** claims 70K+ entries. None advertises a piece finder yet. Digital jigsaw games are much larger (100M+ downloads) but serve a different job, and I found no sign that they are moving into physical-puzzle help.

### Cited Findings
**Collection trackers and speed-puzzling tools**
- **MySpeedPuzzling** (web-first, with apps, open source):
  - 43,547 puzzles from 1,990 brands; 540,651 solve times; "over 11,865 puzzlers".
  - 26,014 puzzles have an EAN barcode; barcode "Scanning" feature.
  - Collection tracking, stopwatch, leaderboards, marketplace.
  - "Free to join" plus an unpriced membership.
  - No piece finder mentioned.
  - Source: [myspeedpuzzling.com](https://myspeedpuzzling.com/en)
- MySpeedPuzzling's FAQ says its source code is open source on GitHub, and it uses recorded solves for medians, e.g. about 3h16m for a 1000-piece solo. — [MySpeedPuzzling FAQ](https://myspeedpuzzling.com/en/faq)
- **Hey Puzzlers** (iPhone): scanned puzzles are matched against "70,000+ entries" with piece count, brand and artwork; the scanner, catalogue and lists are free. The page could not be fetched (429), so these details come from the search summary. — [heypuzzlers.com](https://www.heypuzzlers.com/); [App Store](https://apps.apple.com/mx/app/hey-puzzlers/id6742631904)
- **Puzzled** (iOS, Android, web):
  - Barcode scan, a community database "over 10,000 in catalogue", progress photos, friends feed and stats.
  - Free tier capped at 30 puzzles; "Puzzled Pro" subscription (price not shown).
  - No piece finder.
  - Source: [getpuzzled.app](https://getpuzzled.app/)
- **Puzzle Tracker** (Dawid Kurek, iOS): free with in-app purchases, barcode scanner widget, solve timer, wishlist/completed lists. — [App Store](https://apps.apple.com/us/app/puzzle-tracker/id1561473799)
- **iCollect Everything** catalogues puzzles with barcode scanning and estimated values (iOS/Android/desktop). — [icollecteverything.com](https://www.icollecteverything.com/puzzles/)
- **Puzzle Friend** (iOS, Jens Wiese, May 2025) is a collection organiser, not a solver. — [puzzle-friend.com](https://www.puzzle-friend.com/) (via sibling notes)
- The names "Puzzle Pal", "Puzzle Inventory" and "MyPuzzles" from the brief did not surface as identifiable apps in searches. — search results above

**Digital jigsaw games**
- **Magic Jigsaw Puzzles** (ZiMAD):
  - Downloads: over 120M as of 2023 per Wikipedia; the App Store listing claims 150M (the developer's own claim). — [Wikipedia: ZiMAD](https://en.wikipedia.org/wiki/ZiMAD)
  - Revenue: AppGoblin estimates about $100K+ per month on iOS, 26% IAP and 74% ads. This is a third-party estimate. — [AppGoblin](https://appgoblin.info/apps/439873467)
- Sensor Tower, Q2 2024, top US jigsaw apps by peak *weekly* revenue (estimates): Magic Jigsaw Puzzles about $34K; Veraxen "Jigsaw Puzzles for Adults HD" about $30K; Critical Hit "Jigsaw Puzzle" about $15K; Bimi Boo kids puzzles about $6.9K; Digital Strawberry "Jigsaw Bug" about $4.9K. — [Sensor Tower blog](https://sensortower.com/blog/2024-q2-unified-top-5-jigsaw%20puzzle-revenue-us-64bc06fde1714cfff1ded232)
- ZiMAD's CEO reportedly said in Feb 2024 that subscriptions are over 70% of payments for the game. This comes from a secondary Chinese-language summary and is unverified. — [WN Hub](https://wnhub.io/zh/news/monetization/item-42981)
- iOS rating counts (from sibling notes, 2026-10-21): Easybrain "Jigsaw Puzzles" 1,111,706; Jigsawscapes 432,576; Critical Hit 401,130. — [App Store](https://apps.apple.com/us/app/jigsaw-puzzles-puzzle-games/id1324604053)
- I found no Ravensburger "Puzzle Moments" app or any Ravensburger scan or AR app in searches. — search results above

### Inferences
- **The most likely fast follower is a tracker, not a game.** Trackers already hold the barcode → puzzle → box-image link. MySpeedPuzzling, with 26K EANs and an open-source codebase, could add "scan box, then point at piece" with modest effort. Puzzle Pointer has already combined the two: a barcode catalogue of 10K+ puzzles with a piece finder.
- Digital jigsaw game makers have scale and CV-adjacent skills, but their business is ads and subscriptions inside a digital game. A physical-puzzle helper doesn't fit that model well, so they are unlikely entrants.
- A partnership or integration with a tracker (deep-link "find this piece" from a MySpeedPuzzling or Hey Puzzlers puzzle page) may be more valuable than competing on catalogue size.

### Gaps
- No user counts for Hey Puzzlers, Puzzled or Puzzle Tracker; Puzzled Pro and MySpeedPuzzling membership prices not found.
- Jigsaw Puzzles Epic (Kristanix) subscription price not found.
- Could not verify whether Jigsaw Planet or other web puzzle sites expose image APIs.

## 3. Physical aids (sorting trays, boards, mats) as a proxy for willingness to pay

### Takeaway
Puzzlers already pay **about $7–$66** for physical aids that make puzzling easier. Top Amazon listings carry **thousands to tens of thousands of reviews**, and AsInsight estimates **1,000–3,000 units per month per top-10 product** in a single search niche. This is solid evidence of willingness to pay for "less friction" at price points well above a $3–$7 app purchase.

### Cited Findings
- AsInsight, Amazon US, "puzzle piece sorter trays" search, August 2026 (all sales figures are estimates):

  | Rank | Product | Price | Rating | Reviews | Est. monthly units |
  |---|---|---|---|---|---|
  | 1 | Buffalo Games Puzzle Saver | $6.97 | 4.6 | 19.8K | 3,000 |
  | 2 | Buffalo Games Roll-Up Mat | $10.97 | 4.0 | 4.9K | 3,000 |
  | 3 | ALL4JIG 1500-pc rotating board | $59.49 | 4.6 | 9.4K | 3,000 |
  | 5 | Newverest roll-up mat | $42.97 | 4.6 | 3.3K | 2,000 |
  | 6 | Rotatable 360° board with drawers | $39.99 | 4.5 | 1.5K | 2,000 |
  | 7 | Buffalo Games Sorting Trays (7 pc) | $10.97 | 4.7 | 4.6K | 1,000 |
  | 9 | Puzzle binder | $65.99 | 4.4 | 904 | 1,000 |

  - Top-10 average: $33.43 and 4.5 stars, across 127 tracked products.
  - The page has internal inconsistencies: 160 products in one price tier against 127 tracked, and two different top-3 click-share figures.
  - Source: [AsInsight](https://www.asinsight.com/report/US/puzzle-piece-sorter-trays)
- In the broader "puzzle tray" niche, the $20–$50 band holds 45% of tracked listings (July 2026, AsInsight). — [AsInsight puzzle tray](https://www.asinsight.com/report/US/puzzle-tray)
- Ravensburger Sort & Go:
  - Walmart: 4.7 stars from 168 ratings; $15.30 sale price, down from $21.00. — [Walmart](https://www.walmart.com/ip/Puzzle-Sort-Go/22953240)
  - A reseller page cites 4.6 stars across 13,682 reviews, probably mirrored from Amazon. — [desertcart](https://www.desertcart.sg/products/48073083-sort-and-go-puzzle-sorting-trays)
- A 12-tray Yaomiao set sells for $23.99 on Amazon. — [ShopSavvy](https://shopsavvy.com/products/%22yaomiao-puzzle-sorting-trays%22)
- Springbok and Puzzle EZ sorter sets are also sold at Walmart, so the category has many brands. — [Walmart Springbok](https://www.walmart.com/ip/Puzzle-Sorting-Trays/281961474); [Walmart Puzzle EZ](https://www.walmart.com/ip/909521618)

### Inferences
- Summing the estimates, the top 10 in this one niche move roughly 20K units a month (about 2,000 average × 10). At a $33 average price, that is very roughly $650K a month in Amazon accessory spend, in one search niche alone. This is an order-of-magnitude estimate built on estimates.
- Physical aids are *complements*, not substitutes. Sorting trays reduce search space by colour or shape, which partly solves the same "where is this piece" pain. They suggest the market values convenience. They also position an app as a cheaper "digital accessory" alongside a $40 board.
- Major puzzle brands (Buffalo Games, Ravensburger) sell their own accessories. This suggests they monetize the "make it easier" urge themselves, and might view a piece-finder as a brand extension.

### Gaps
- No direct Amazon page fetches; review counts are via AsInsight and resellers.
- No survey data on what share of puzzlers buy accessories.

## 4. Manufacturer services and reference aids (missing-piece services, posters, apps)

### Takeaway
Manufacturers handle *missing* pieces, mostly with whole-puzzle replacement. They don't help with *finding where a piece goes*. I found no manufacturer app with scan or AR piece-location features. Included posters or reference prints are common in some brands (Cobble Hill is reported to include them), which makes a clean reference image easier to get but does nothing to locate a piece.

### Cited Findings
- **Ravensburger US** "Care Commitment": 365-day replacement for products from its store or authorized US sellers. "Individual replacement pieces are not available" for puzzles, so a full replacement is given. Requests go through the Contact Us form, and proof of purchase may be required. — [Ravensburger US Care Commitment](https://ravensburger.us/en-US/service/care-commitment)
- **Ravensburger UK/EU**, puzzles of 5,000 pieces or fewer: no spares are kept. Within 6 months of purchase from its site or a partner, it will try to provide a replacement puzzle, voucher or refund. — [Ravensburger support: ≤5000 pc](https://ravensburger-en.mindtouch.us/Service_and_Support/Faulty_Items/Missing_a_puzzle_piece_(5000_pieces_or_less_puzzles))
- **Ravensburger 9,000+ piece puzzles**: replacement pieces are possible. Customers supply a photo, the bag letter and the control number. — [Ravensburger support: 9000 pc](https://ravensburger-en.mindtouch.us/Service_and_Support/Faulty_Items/Missing_a_puzzle_piece_(9000__piece_puzzles))
- Trustpilot reviews of Ravensburger include both refused late claims and free full replacements. These are anecdotal. — [Trustpilot](https://www.trustpilot.com/review/ravensburger.de)
- **Buffalo Games**: an instruction sheet mentions action on defects discovered "within 90 days of purchase", but the remedy text was cut off. I found no official missing-piece policy page. — [instruction PDF](https://cdn6.bigcommerce.com/s-gyhhtwx4/product_images/uploaded_images/instructions/801-Esca.pdf); [PissedConsumer complaints](https://www.pissedconsumer.com/buffalo-games/RT-F.html)
- **Cobble Hill**: a marketplace listing describes a 1000-piece Cobble Hill puzzle "mit Poster" (with poster), which supports the claim that posters are included. The official FAQ could not be fetched (429). — [eBay.de listing](https://www.ebay.de/itm/145238753400)
- Historical prior art for "grid reference" aids: EP1177820A2 describes a transparent grid sheet laid over the original picture to locate pieces. — [Google Patents EP1177820A2](https://patents.google.com/patent/EP1177820A2/en)

### Inferences
- Posters and inserts help a camera-based app. A flat, unglossy, large reference image is easier to photograph than a box lid. They do not remove the need for piece location. The app should highlight "photograph the poster" in onboarding.
- Manufacturers already have the highest-quality source images, so they are natural data partners or potential entrants. The absence of any manufacturer app suggests they don't see piece-finding as their job.
- Ravensburger's "no single replacement pieces" policy means a missing-piece helper ("which piece is missing?") is not something the manufacturer competes on.

### Gaps
- Cobble Hill, Buffalo Games, White Mountain and Springbok official missing-piece and poster policies were not confirmed; the sites were rate-limited or not indexed.
- Searches found no manufacturer AR or scan app; absence of evidence is not proof.

## 5. Robots and automation (consumer fascination)

### Takeaway
Jigsaw-solving robots draw large audiences. Stuff Made Here's 2022 machine got wide tech-press coverage and 260K+ likes on one video, and Mark Rober built a separate "Jigsaw" robot. Interest in automated solving is real, but these are entertainment, not products.

### Cited Findings
- Hackaday, Aug 4, 2022 ("Jigsaw Puzzles Are Defeated", Brian McEvoy):
  - Shane Wighton (Stuff Made Here) spent about 18 work-weeks on a robot aimed at an all-white puzzle and a 5,000-piece puzzle painted white.
  - The robot uses suction pick-up; machine vision was a key hurdle.
  - The decoding software needed more compute than consumer machines provide.
  - Source: [Hackaday](https://hackaday.com/tag/solution-without-a-problem/)
- German outlet WUV (Dec 2022) reports the "Jigzilla" machine almost fully assembled 4,000 pure-white pieces, missing only the last row. The video had over 260,000 likes, and the channel over 4M subscribers. — [WUV](https://www.wuv.de/Themen/MarTech-CRM/Jigzilla-KI-Monster-ist-der-Godzilla-fuer-Puzzles)
- Techeblog: the machine can handle 5,000 pieces with suction and a camera. — [Techeblog](https://www.techeblog.com/?p=130677)
- Room Escape Artist (Aug 2023) praises the two puzzle-robot videos as "remarkable", though "not as crazy" as other builds. — [Room Escape Artist](https://roomescapeartist.com/2023/08/07/robots-solving-jigsaw-puzzles-🧩🤖)
- **Mark Rober's "Jigsaw" robot** is described as solving a puzzle 200× faster than the fastest humans. — [Hackster](https://hackster.io/news/give-piece-a-chance-e3b09f45b128); [Briefy summary of "My Puzzle Robot is 200x Faster Than a Human"](https://briefy.ai/summary/v2/fmtjexx1cbrqzqksoij4skb4/en/my-puzzle-robot-is-200x-faster-than-a-human)
- Open-source solvers exist:
  - byWulf "jigsawlutioner" (piece-border matching algorithm). — [GitHub](https://github.com/byWulf/jigsawlutioner)
  - locxter "jgswpzzlbt" (robot). — [GitHub](https://github.com/locxter/jgswpzzlbt)
  - whitcrrd "puzzle-image-segmentation": uses OpenCV feature matching to predict where a piece photo belongs on the box photo. This is essentially the core of this product category, published openly. — [GitHub](https://github.com/whitcrrd/puzzle-image-segmentation)
- Tildes discussion thread on the all-white video. — [Tildes](https://tildes.net/~comp/13kc/worlds_hardest_jigsaw_all_white_vs_puzzle_machine)

### Inferences
- Robot videos show that "machine solves jigsaw" is compelling content. Short-form demo videos of the app, a piece popping into place on camera, are a plausible marketing channel.
- The robot work also shows the hard cases (low texture, all-white) need *shape* matching, not just image matching. This is a technical edge for products that use piece outlines.

### Gaps
- No verified YouTube view counts; the YouTube pages were not fetched.

## 6. Barriers to entry and defensibility (patents, CV difficulty, LLM-assisted coding, data and network effects)

### Takeaway
**Barriers are low.**
- No patent claiming camera-based piece localization against a box image turned up.
- The core method, feature matching against a reference image, is published open source (whitcrrd).
- Five or more near-identical apps shipped in 2026, three within ten days.

**Any moat would come from:**
- Accuracy on hard (low-texture) pieces, using shape and colour cues together.
- On-device privacy and UX.
- A barcode → clean-image catalogue. Puzzle Pointer has 10K+; trackers have 26K–70K entries, but those are catalogue metadata, not necessarily high-resolution images.
- Possibly feedback data ("did it fit?").

### Cited Findings
**Patents**
- Google Patents searches did not surface a patent that claims a phone camera identifying a physical piece's position by matching against a reference image. Closest hits:
  - US20120025462A1 / EP2259852B1 ("Personalized mosaic puzzle set"): matches piece images against regional images of a target picture and picks the arrangement with maximum matching value. This is computer-side matching for manufacturing or arrangement, not a consumer camera. — [US20120025462](https://patents.google.com/patent/US20120025462); [EP2259852B1](https://patents.google.com/patent/EP2259852B1/en)
  - US5605332A ("Pixelated puzzle"): piece pixel colours give a clue to general location. — [Google Patents](https://patents.google.com/patent/US5605332A/en)
  - US9628706: puzzle-piece-shaped camera-capture UI. — [USPTO PDF](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9628706)
  - US10646773: digital puzzle-mode game. — [USPTO PDF](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10646773)
  - US20130079079A1: digital jigsaw for mobile. — [Google Patents](https://patents.google.com/patent/US20130079079A1/en)
  - US8900043B1: structured jigsaw puzzles. — [Google Patents](https://patents.google.com/patent/US8900043)
  - EP1177820A2: transparent grid overlay. — [Google Patents](https://patents.google.com/patent/EP1177820A2/en)
  - US5149098A: board with matching indicia. — [Google Patents](https://patents.google.com/patent/US5149098A/en)

**CV difficulty**
- Every direct competitor openly concedes low-texture failure:
  - Solver Works: "blue skies or areas with little detail are harder to match; illustrated puzzles easier than photographic". — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
  - Puzzle Pointer warns before searching plain sky or single-colour pieces. — [puzzlepointer.com](https://puzzlepointer.com/)
- One Solver Works user reported "less than 25% correct" (May 2026); another said it "helped me find some pieces" but was not perfect on detailed puzzles. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US) (via sibling notes)
- JigShape: accuracy falls sharply with puzzle size; interior pieces are hardest; without shape cues, fine-tuned models fall near chance. Shape and colour cues are complementary. — [arXiv 2607.27670](https://arxiv.org/html/2607.27670)
- Related research: relative-position classification of fragment pairs (Paumard et al.). — [arXiv 1807.03155](https://arxiv.org/abs/1807.03155)
- Related research: reassembly with unknown piece orientation (JigSync, 2026). — [arXiv 2609.18379](https://arxiv.org/pdf/2609.18379)
- Related research: eroded-gap puzzles (VLHSA). — [arXiv 2509.25202](https://arxiv.org/pdf/2509.25202)
- Related research: irregular fragment alignment. — [arXiv 2507.09767](https://arxiv.org/pdf/2507.09767)

**Clone wave and LLM-assisted coding**
- Three iOS piece-finders launched 2026-09-14 to 2026-09-23 (Puzzle Detective, PuzzleLens, Puzzle Pointer). PuzzleLens and Puzzle Pointer use near-identical marketing copy ("Stuck on a jigsaw piece?"). — sibling notes, [PuzzleLens](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [Puzzle Pointer](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
- The Puzzle Pointer developer is a serial indie with several small tracker apps (Post Pill, Cedar, TailLedger and others), and the PuzzleLens developer also makes AR-drawing, calorie-scanner and translator apps. That profile fits rapid, possibly AI-assisted, app production. — sibling notes, [App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
- Before 2026, "best jigsaw solver app" listicles filled their slots with GitHub projects and a Rubik's-cube solver. Consumer jigsaw-helper apps barely existed until 2026. — [Morning Dough, Feb 2024](https://www.morningdough.com/?p=36797); [Rigorous Themes, Jan 2026](https://rigorousthemes.com/blog/best-jigsaw-puzzle-solver-apps/)

**Data and network-effect assets**
- **Puzzle Pointer** offers barcode lookup against "over 10,000 puzzles" (Ravensburger, Buffalo Games, Galison, White Mountain, Springbok, Cobble Hill), so users skip photographing the box. Pricing: 5 free searches, then $2.99 for 10, or $6.99 a month. It asks "Did it fit?" for feedback. — [puzzlepointer.com](https://puzzlepointer.com/)
- **MySpeedPuzzling**: 43,547 puzzles, 26,014 with EAN, 1,990 brands, 11,865+ puzzlers, open source. — [myspeedpuzzling.com](https://myspeedpuzzling.com/en)
- **Hey Puzzlers** claims 70,000+ catalogue entries, including artwork. — [heypuzzlers.com](https://www.heypuzzlers.com/)
- **Puzzled** has a community-built catalogue of 10K+ puzzles. — [getpuzzled.app](https://getpuzzled.app/)
- **Puzzle Warehouse** (retailer app) lists 10,000+ physical puzzles with images, a possible image source or partner. — [App Store](https://apps.apple.com/us/app/-/id6544791389)

### Inferences
- **Patent risk looks low, and so does patent protection.** Prior art (mosaic matching, grid overlays, colour clues) plus open-source code would make broad claims hard to obtain. A formal freedom-to-operate search was not done.
- **LLM-assisted coding has clearly lowered the barrier.** Coding agents can build an OpenCV template-matching app in days. The 2026 clone wave, with serial indie developers and copy-paste marketing, fits that, though no developer has said they used AI. Treat this as an inference.
- **The defensible layers are, in rough order:**
  1. Accuracy on hard pieces: shape-aware matching, multi-piece-per-photo, rotation. Benchmarks show this is unsolved, so it is a real technical lead if achieved.
  2. Distribution and brand: SEO, App Store rank, word of mouth in puzzling communities.
  3. A clean-image catalogue keyed by barcode. It saves a step and lifts accuracy, but trackers already have larger catalogues and could license or copy the idea. Copyright on box art is a risk for building such a catalogue without manufacturer permission.
  4. Feedback data on which matches fit, usable to tune matching. This is weak at current user volumes.
- **Network effects are weak.** One puzzler's use doesn't improve another's, except through a shared catalogue or crowd-sourced "solved piece" data for the same SKU. Social features in PuzzleLens and Puzzled hint at attempts to manufacture this.
- **On-device and browser-only is a differentiator, not a moat.** Puzzle Finder (Android) already claims "100% offline", and PuzzleLens claims on-device recognition. Puzzle Pointer, by contrast, uploads photos to its servers and sends some to OpenAI, so "never leaves your device" is a valid contrast against that rival specifically.

### Gaps
- No formal patent landscape or freedom-to-operate search. Google Patents UI queries could not be run directly; results come via web search. A search on CPC G06V/G06T plus A63F9/10 is recommended.
- No published accuracy benchmark for real photographed pieces against box images, academic or commercial. All accuracy evidence is anecdotal (app reviews) or from digital-only benchmarks.
- Did not confirm whether manufacturers have objected to apps using box art, or licensing terms for puzzle-image APIs. No public puzzle-image API was found.
- No developer has stated they used AI coding tools, so the vibe-coding inference is unverified.
