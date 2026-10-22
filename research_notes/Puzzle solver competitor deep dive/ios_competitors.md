# iOS App Store competitors of Puzzle Solver: deep-dive dossiers (as of 2026-10-22)

How the data was collected:
- **Store data.** The iTunes Lookup and Search APIs were queried for 8 storefronts (us, gb, de, ca, au, fr, jp, nl). The apps.apple.com US and GB listing pages were fetched directly, and screenshots were downloaded and viewed.
- **Developer sites.** Developer websites, privacy, support and terms pages were fetched directly.
- **Domains.** Domain registration dates come from RDAP.
- **Hacker News.** Searched through the Algolia API.
- **Blocked sources.** Reddit (old. and www.) returned 403, and so did Product Hunt. No Reddit or Product Hunt evidence is included.
- **Keyword ranks.** These are positions in the iTunes Search API. That is a *proxy* for App Store search rank, not the live App Store ranking.

All metrics are dated 2026-10-22 unless a different date is stated. This builds on `research_notes/Puzzle solver monetization/competitors.md` and does not repeat its review and pricing analysis except where it is extended here.

## Q1. Product dossiers: features, in-app purchases (IAPs), version history, privacy labels, devices, ratings

### Takeaway
All three live iOS competitors locate **one piece per photo**. They have 0 or 1 ratings in every storefront checked, and all launched between Sep 14 and Sep 23, 2026.

- **Puzzle Pointer** is by far the most actively developed: 9 versions in about 25 days. It is also the most commercial (metered searches, a $6.99/month plan, a barcode catalogue, SEO content). It is also the only one that uploads photos to a server and to OpenAI.
- **PuzzleLens** is on-device but ad-funded, with tracking (AdMob). It localises its store title aggressively for search.
- **Puzzle Detective** is on-device and multilingual (21 languages), but looks unfinished: its support email is still a placeholder, and it has shipped only one update in 5+ weeks.
- **PuzPal** is still not on the App Store, about 7 months after its website went up.

### Cited Findings

#### A. PuzzleLens (Alperen Saglam), id6812349555
- **Store names and positioning.** The US store name is now "PuzzleLens: Puzzle Solver" and the subtitle is "Jigsaw Piece Finder & Helper". Promo text: "Stuck on a piece? Photograph it and see where it goes in seconds. Runs entirely on your iPhone, no internet needed. Works with 1000-piece puzzles." — [App Store US](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
- **Localised store titles (ASO tactic).** The title changes by storefront:
  - GB/CA/AU: "PuzzleLens: Jigsaw Solver"
  - DE: "PuzzleLens: Puzzle-Löser"
  - FR: "PuzzleLens: Solveur de Puzzle"
  - NL: "PuzzleLens: Legpuzzel Hulp"
  - JP: "PuzzleLens: Puzzle Solver"

  Source: iTunes Lookup API, 2026-10-22, [gb](https://itunes.apple.com/lookup?id=6812349555&country=gb), [de](https://itunes.apple.com/lookup?id=6812349555&country=de), [nl](https://itunes.apple.com/lookup?id=6812349555&country=nl)
- **Listing facts.**
  - 7.3 MB; requires iOS 18.0+.
  - Also runs on Mac (macOS 15+, M1+, "Designed for iPhone. Not verified for macOS") and on visionOS 2.0+.
  - Languages: English and Turkish.
  - Categories: Utilities (primary), then Entertainment.
  - Age rating shows **13+** on the web page but 4+ in the API's trackContentRating. This may reflect Apple's newer age-rating tiers, so treat it as unresolved.
  - "Contains: Advertising, User-Generated Content, Social Media".

  Sources: [App Store US](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [Lookup US](https://itunes.apple.com/lookup?id=6812349555&country=us)
- **IAP list.** Only one product: "PuzzleLens Pro $0.99", a monthly auto-renewing subscription that removes ads. The free tier gives "Unlimited puzzles, scans and hints — no daily limit". — [App Store US](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
- **Ad load.** The privacy policy dated Oct 17, 2026 gives the frequency. Ads appear "when a new puzzle's picture has been prepared, and before a piece scan result is shown, once every three scans". They are served by Google AdMob, behind an ATT prompt, plus Google's consent form in the EEA and UK. Pro users never start the ad SDK. — [PuzzleLens privacy](https://alperensaglam.github.io/puzzlelens/privacy)
- **Feature list (listing, how-to page and screenshots).**
  - Scan the box picture once.
  - **Grid setup**: "count the pieces along the long edge and enter it so the grid is exact".
  - Photograph the piece "on a flat, single-colour surface, hold the phone parallel".
  - **Graded hints**: region, then a 3×3 area, then the exact cell and rotation.
  - A 5×5 close-up on the exact spot.
  - An "isn't sure" mode for sky or flat colour.
  - **On-device calibration**: "As you confirm placements it got right, the app calibrates to that puzzle".
  - A progress mosaic and a gallery (In progress / Completed / Set aside).
  - Optional Sign in with Apple, friends and progress sharing.
  - Light and dark themes; English/Turkish switch inside the app.
  - Pick piece photos from the library; HEIC support.

  Sources: [How-to](https://alperensaglam.github.io/puzzlelens/); [App Store US](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
- **Screenshot headlines (6 screenshots).** "Find where any piece goes", "Hints first, answers later", "Watch it come together", "Pick up where you left off", "Every puzzle in one place", "Easy on the eyes, day or night".
  - The mock UI shows "Row 7 · Column 15 · Rotate 90°" and "94% confident", plus stats "Hints 30 / Reveals 10 / Scans 52 / Grid 38×27 / 1,026 pieces".
  - Example puzzles are The Great Wave and Starry Night.
  - The screenshot filenames are Turkish ("01-yerini-bul", "02-ipucu", "03-mozaik").

  Source: screenshot URLs from [Lookup US](https://itunes.apple.com/lookup?id=6812349555&country=us)
- **Version history (4 versions in 19 days).**
  - 1.0: Sep 23.
  - 1.1.0: Oct 7. "Redesigned from the ground up". Added the progress mosaic, the 5×5 close-up, library photo import, and "Hints are now unlimited for everyone — no daily limit", which implies 1.0 had a daily hint cap. Introduced "PuzzleLens Pro: no ads (monthly subscription)".
  - 1.1.1: Oct 9. New typeface.
  - 1.1.2: Oct 12. Bug fix: "scan result would not open".

  Source: [App Store US](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555)
- **App Privacy label.**
  - "Data Used to Track You": Identifiers, Usage Data.
  - "Data Linked to You": Location (coarse), Contact Info (email), User Content (other), Identifiers (Device ID, User ID), Usage Data. These are used for Third-Party Advertising, Developer Marketing, Analytics and App Functionality.
  - "Not linked": Diagnostics.
  - This conflicts with the "your photos don't go anywhere" marketing only in the ads sense. The policy says no image is ever sent to a server.

  Sources: [App Store US](https://apps.apple.com/us/app/puzzlelens-puzzle-solver/id6812349555); [privacy](https://alperensaglam.github.io/puzzlelens/privacy)
- **Ratings.** userRatingCount is 0 in us, gb, de, ca, au, fr, jp and nl (2026-10-22). — [Lookup US](https://itunes.apple.com/lookup?id=6812349555&country=us)

#### B. Puzzle Pointer: Piece Finder (Bobby Landerman), id6809997519
- **Listing facts.**
  - Subtitle: "Jigsaw piece finder by photo".
  - 13.8 MB; iOS 17.0+; Mac (macOS 14+, M1+); visionOS 1.0+.
  - English only; 4+.
  - Categories: **Lifestyle** (primary), then Utilities.

  Source: [App Store US](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
- **IAP list.** "10 Search Pack $2.99" and "Monthly $6.99".
  - The free tier is 5 searches. A free search that finds nothing, or a "didn't fit", earns 1 extra, capped at 10 completed free searches, and "an extra cannot add another".
  - "Completed matcher responses, including no-match, use a run". Processing failures and reopening saved results are free.
  - The monthly plan excludes "Automated, bulk, or API use".

  Sources: [App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519); [Support](https://puzzlepointer.com/support/); [Terms, effective 2026-09-18](https://puzzlepointer.com/terms/)
- **Feature list.**
  - Find the puzzle by **barcode** ("over 10,000 puzzles"), box photo or name.
  - "Request this puzzle" when a barcode is not in the catalogue.
  - Auto-capture "when the piece is sharp and whole".
  - Ranked spots ringed on the picture, with the piece shown rotated to match.
  - A "Did it fit?" Yes / Not there loop.
  - A plain-colour warning before a search uses up an allowance.
  - Detects a photo of the box text instead of the picture.
  - Box-camera guidance (cut off / too far / tilted).
  - Reads the piece count printed on the box.
  - Saved puzzles and pieces; a share card; optional Sign in with Apple.
  - "Delete private data".

  Sources: [App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519); [puzzlepointer.com](https://puzzlepointer.com/)
- **Screenshot headlines (5 screenshots).**
  - "Stuck on a piece? Snap it. We show you where it goes."
  - "Scan the box. Thousands ready. Barcode, box photo or name. Add it once."
  - "Photograph one piece. The frame turns green when the shot is ready."
  - "Did it fit? On to the next."
  - "Pick up where you left off."
  - Badges: "No ads", "Any brand, any box", "No account needed".
  - Examples: a Dowdle "Costco" 1,000-piece puzzle and Buffalo Games "Mountain Retreat". There is also an orange puzzle-piece mascot ("piece companion").

  Source: screenshots from [Lookup US](https://itunes.apple.com/lookup?id=6809997519&country=us)
- **Version history (9 versions in about 25 days, the highest velocity in the category).**
  - 1.0: Sep 23.
  - 1.0.1: Sep 24. Clearer search allowances and subscription details.
  - 1.0.2: Sep 26. "See possible areas while a full search continues". Faster matching.
  - 1.0.3: Sep 30. Barcode, box photo or name; "New: 10 searches for $2.99".
  - 1.0.4: Oct 8. Barcode-first start, "Request a puzzle", share card. Searches stopped before matching are refunded.
  - 1.0.5: Oct 12. A guided redesign with a "piece companion". "New and existing accounts now have five free searches".
  - 1.0.6: Oct 13. Box-camera guidance; piece count read from the box; "When a result is only a guess, the result screen says so".
  - 1.0.7: about Oct 15–16 (shown as "6d ago"). Plain-colour pre-check that doesn't use a search; detects a photo of the wrong side of the box; corner editor.
  - 1.0.8: Oct 17. Piece shown rotated beside each spot.

  Sources: [App Store US](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519); [Lookup US](https://itunes.apple.com/lookup?id=6809997519&country=us), currentVersionReleaseDate 2026-10-17
- **App Privacy label.** "Data Linked to You": Usage Data (analytics); Purchases; **User Content: Photos or Videos**, Other User Content; Identifiers (User ID). There is no tracking section. — [App Store US](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)
- **Ratings (2026-10-22).**
  - US: 1 rating, 5.0.
  - **DE: 1 rating, 3.0.**
  - gb, ca, au, fr, jp, nl: 0.

  Source: [Lookup US](https://itunes.apple.com/lookup?id=6809997519&country=us); [Lookup DE](https://itunes.apple.com/lookup?id=6809997519&country=de)
- **Staggered rollout.** The storefront release date is 2026-09-23 in the US but **2026-09-30 in gb, ca, au and de**. That points to a US-first launch, then expansion a week later. — iTunes Search API per storefront, e.g. [gb search](https://itunes.apple.com/search?term=piece+finder&country=gb&entity=software&limit=50)

#### C. Puzzle Detective: Piece Finder (Emily Liu), id6808541265
- **Listing facts.**
  - Subtitle: "Smart Jigsaw Piece Finder".
  - 42.2 MB, the largest binary of the three. Requires iOS 16.0+; iPhone only, with no Mac or visionOS listed.
  - Utilities (primary), then Lifestyle; 4+.
  - **21 languages**: English, Arabic, Bengali, French, German, Hindi, Indonesian, Japanese, Korean, Marathi, Portuguese, Russian, Simplified Chinese, Spanish, Swahili, Tamil, Telugu, Traditional Chinese, Turkish, Urdu, Vietnamese.

  Source: [App Store US](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)
- **IAP list.** "3-Month Access $4.99", "Annual Access $9.99", "Lifetime Access $19.99". There is also a trial:
  - Its server tracks "whether a trial search was used and the remaining trial entitlement". The size of the trial is not disclosed.
  - The support FAQ says "Unlimited Access is a one-time, non-consumable in-app purchase". That product name matches none of the three IAPs listed, so the docs look out of date or inconsistent.

  Sources: [App Store US](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); [Privacy](https://puzzledetectiveapp.pages.dev/privacy/); [Support](https://puzzledetectiveapp.pages.dev/support/)
- **Feature list.**
  - Capture or import the full image; adjust the four corner handles.
  - Photograph or select one piece; confirm the detection.
  - "Best match / Option 2 / Option 3" candidates; pinch-zoom.
  - Saved pieces per project; multiple projects; history.
  - A hamster-detective mascot; enter the piece count when creating a puzzle.

  Sources: [App Store US](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); [Support](https://puzzledetectiveapp.pages.dev/support/)
- **Screenshots (4 raw device captures with no marketing captions).**
  - Labels visible: "Best match", "Option 2", "Option 3", "Pieces found: 1/3", "The End".
  - A status line reads "**Lifetime unlocked · offline ready**".
  - Timestamps are in Chinese-locale text ("2026/9/10 清晨 5:02"), which suggests the developer's device is set to Chinese.

  Source: screenshots from [Lookup US](https://itunes.apple.com/lookup?id=6808541265&country=us)
- **Version history (2 versions).**
  - 1.0: Sep 14.
  - 1.0.1: Oct 17. Redesigned Home, library and results screens; "Updated hamster search animations"; "Clearer purchase status and trial messages".
  - Outside the US, the storefront release date is **2026-10-17** (gb, ca, au, de). The app seems to have been US-only for its first month.

  Sources: [App Store US](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); iTunes Search API per storefront, e.g. [gb](https://itunes.apple.com/search?term=puzzle+piece+finder&country=gb&entity=software&limit=50)
- **App Privacy label.** "Data Linked to You" for App Functionality: Purchases, Identifiers (Device ID), Usage Data (Product Interaction), Diagnostics. No tracking. — [App Store US](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)
- **Ratings.** 0 in all 8 storefronts checked (2026-10-22). — [Lookup US](https://itunes.apple.com/lookup?id=6808541265&country=us)
- **Unfinished launch.** The support and privacy pages still say "Email **Support email to be added before launch**". The privacy policy is dated "Effective September 4, 2026". — [Support](https://puzzledetectiveapp.pages.dev/support/); [Privacy](https://puzzledetectiveapp.pages.dev/privacy/)

#### D. PuzPal (developer unnamed). Still not on the App Store.
- An iTunes Search for "puzpal" in us and gb on 2026-10-22 returns no PuzPal app. — [Search US](https://itunes.apple.com/search?term=puzpal&country=us&entity=software&limit=20)
- The /download/ page still reads: "The App Store listing is being connected. Check back shortly". — [puzpal.com/download](https://puzpal.com/download/)
- The domain was registered **2026-03-27** and last changed 2026-03-28 (Cloudflare NS). The sitemap lastmod dates are 2026-03-28 to 03-30, and the privacy policy says "Last updated: 28 March 2026". — [RDAP](https://rdap.org/domain/puzpal.com); [sitemap](https://puzpal.com/sitemap.xml); [privacy](https://puzpal.com/privacy/)
- **Planned features.**
  - Live-camera **shape and contour matching** with three modes: Scan Gap, Scan Piece, Scan Edge ("a fallback, not the strongest mode").
  - A real-time confidence indicator.
  - A built-in "Report Matching Issue" tool that records a clip plus diagnostics.
  - iOS 18+, iPhone only, a one-time paid purchase, no accounts. Contact: help@puzpal.com.

  Source: [About/FAQ](https://puzpal.com/about/); [contact](https://puzpal.com/contact/)

### Inferences
- **Puzzle Pointer** is the competitor to watch. It ships every 2–3 days, and its release notes respond to the classic failure modes: wrong box crop, blurry piece, plain pieces, "only a guess".
- **Puzzle Detective** looks under-resourced. It has one update, placeholder support contacts and unannotated screenshots, and it went worldwide only on Oct 17.
- **PuzzleLens** sits in between: a burst of redesign work around Oct 7–12, then quiet.
- No app has any review traction in US, GB, DE, CA, AU, FR, JP or NL.
- **Model size (inference only).** Size hints at architecture. PuzzleLens at 7.3 MB on-device suggests classical CV or Apple Vision rather than a bundled neural model. Puzzle Detective's 42.2 MB, together with its "first search after opening the app is slower… one-time preparation" note, suggests a bundled model loaded at launch.
- **Market signal.** PuzzleLens dropped a daily hint cap in 1.1.0 and moved to ads plus a $0.99 Pro tier. Puzzle Pointer added a $2.99 pack after launching with a subscription only (1.0.3). Both changes suggest early conversion was weak at the original terms.

### Gaps
- The trial size for Puzzle Detective is not stated anywhere public.
- Whether Puzzle Detective's 3-month and annual IAPs are non-renewing or auto-renewing could not be confirmed.
- Non-US IAP prices were not collected.
- The meaning of the 13+ vs 4+ age-rating discrepancy for PuzzleLens is unresolved.
- No download or revenue estimates exist. These apps are too small for public ASO tools, and Sensor Tower and AppMagic were not accessible.

## Q2. Developer background, portfolio, and launch activity

### Takeaway
All three live apps are solo-developer projects with no company entity: the seller is an individual name in each case.

- **Bobby Landerman** and **Alperen Sağlam** both ran high-cadence multi-app portfolios in Aug–Oct 2026: 8 apps in 23 days for Landerman, 5 products in about 2 months for Sağlam. That pattern is typical of AI-assisted indie builders.
- **Emily Liu** has a single app.
- No launch posts were found on HN. Reddit and Product Hunt were blocked. Web search engines don't index any of these apps yet.

### Cited Findings
- **Alperen Sağlam (Turkey).**
  - His site's tagline is "Apps that each do one thing well". It lists Watchntalk (web plus Chrome extension; iPhone app "in App Store review"), Lokma (a LiDAR calorie measurer), PuzzleLens, Drawluma (AR drawing) and Biverba (a two-person translator).
  - Contact is a Gmail address. The site is bilingual Turkish/English and hosted on GitHub Pages.

  Source: [alperensaglam.github.io](https://alperensaglam.github.io/)
- **Sağlam's App Store portfolio.** Biverba (released 2026-08-12), Drawluma (2026-09-06, v1.4.0 by Oct 15), PuzzleLens (2026-09-23), LOKMA (2026-10-04). All four have 0 US ratings. — [iTunes Lookup, artistId 6797633691](https://itunes.apple.com/lookup?id=6797633691&entity=software&country=us); [developer page](https://apps.apple.com/us/developer/alperen-saglam/id6797633691)
- **Bobby Landerman.** Seven other apps besides Puzzle Pointer, all released 2026-09-01 to 2026-09-14, all with 0 ratings:
  - TailLedger: Pet Medication (09-01)
  - Cedar: Allergy Tracker (09-02)
  - Between Cats: Behavior Log (09-04)
  - Tablekind: Shared Meals (09-05)
  - Noted Together (09-09)
  - Post Pill: Birth Control Log (09-14)

  Most of them stopped updating within about a week of launch, while Puzzle Pointer kept shipping. — [iTunes Lookup, artistId 6804782721](https://itunes.apple.com/lookup?id=6804782721&entity=software&country=us); [developer page](https://apps.apple.com/us/developer/bobby-landerman/id6804782721)
- **puzzlepointer.com setup.** The domain was registered **2026-09-14**, 9 days before launch (Cloudflare NS). The website is hosted on Vercel and the backend on Cloudflare (R2). — [RDAP](https://rdap.org/domain/puzzlepointer.com); [Privacy](https://puzzlepointer.com/privacy/)
- **Landerman's web footprint.** A web search for "Bobby Landerman" found no LinkedIn, X or personal profile. The only hit was a 2007 trade item about a "Bob Landerman" joining Brand Factory as VP sales, and it is not known whether this is the same person. — [just-style.com](https://www.just-style.com/news/us-bob-landerman-joins-brand-factory-as-vp-sales/)
- **Emily Liu.** Puzzle Detective is the only app under artistId 6808541267. There is no seller URL in the API. The website is a Cloudflare Pages subdomain (puzzledetectiveapp.pages.dev) with no About or author information. — [iTunes Lookup](https://itunes.apple.com/lookup?id=6808541267&entity=software&country=us); [site](https://puzzledetectiveapp.pages.dev/)
- **PuzPal.** No person or company is named on any page. The privacy policy covers "the PuzPal iPhone app and the website", and the contact is help@puzpal.com. — [puzpal.com/privacy](https://puzpal.com/privacy/)
- **Launch posts.**
  - HN Algolia searches for 2026 posts ("jigsaw piece", "jigsaw app", "Puzzle Pointer", "PuzzleLens", "jigsaw solver") found no launch post for any of these apps.
  - The only related 2026 Show HNs were "Jigsaw Haiku" (a game, 118 points, Sep 4, 2026) and "FunFrame – toddler puzzles from family photos" (1 point, Oct 7).

  Source: [HN Algolia](https://hn.algolia.com/api/v1/search_by_date?query=jigsaw%20app&numericFilters=created_at_i%3E1764547200)
- **Search-engine visibility.** Web searches for "Puzzle Pointer", "Puzzle Detective" and "PuzPal" returned no pages about these apps. The engine said the app "may not exist". The apps are effectively invisible outside the App Store and their own sites. — [search result](https://apps.apple.com/us/app/find-restore/id6444747256) (an irrelevant top hit, shown as evidence of the miss)
- **Social links.** puzzlepointer.com, the PuzzleLens pages and puzpal.com link to no X, Instagram or TikTok accounts. Puzzle Pointer's footer has only How it works / Guide / Catalogue / Support / Privacy / Terms / Contact. — [puzzlepointer.com](https://puzzlepointer.com/); [puzpal.com](https://puzpal.com/)

### Inferences
- Landerman's portfolio pattern looks like a builder testing many niches quickly and doubling down where there is signal: 7 utility apps in 2 weeks, mostly abandoned, then sustained investment in Puzzle Pointer. Puzzle Pointer is the one getting attention, which suggests it showed early traction relative to his other apps.
- None of the competitors has a community, social presence or brand. Distribution is App Store search plus, for Puzzle Pointer, SEO.

### Gaps
- Reddit (r/Jigsawpuzzles, r/puzzles), X, TikTok and Product Hunt launch posts could not be checked: Reddit returned 403 on both old and www JSON, and Product Hunt returned 403. This should be checked manually.
- No LinkedIn or GitHub identity could be confirmed for Landerman or Liu. GitHub user lookups were blocked in this session.

## Q3. Technology claims: on-device vs cloud, LLM use, catalogue source, accuracy and admitted limits

### Takeaway
The apps split cleanly by architecture:

- **PuzzleLens**, **Puzzle Detective** and **PuzPal** claim on-device matching.
- **Puzzle Pointer** is cloud-based. A server runs the matcher, and OpenAI checks every box photo.

Puzzle Pointer's barcode catalogue is a proprietary snapshot of **13,457 products (11,154 pictures profiled)**. It is used both for lookup and for SEO content (a difficulty report on 6,601 1,000-piece puzzles). The data source is not disclosed. The product titles look like they come from retailer or marketplace listings, but that is an inference.

Nobody publishes accuracy numbers. Every app admits plain or similar regions fail, and Puzzle Pointer's terms disclaim exact placement entirely.

### Cited Findings
- **Puzzle Pointer architecture.** "The piece search runs on that Puzzle Pointer server." Photos are stored in Cloudflare R2, and unattached uploads are cleaned up after 7 days. "A reduced-size copy of that photo is sent to OpenAI, which returns a short multiple-choice answer" to check the box photo shows the whole picture. "No advertising or third-party analytics SDK." — [Privacy, effective 2026-10-09, updated 2026-10-20](https://puzzlepointer.com/privacy/)
- **Catalogue size and source.**
  - The difficulty report (Oct 2026) says: "Catalogue snapshot v1-941753faa98a82565de8: **13,457 products, 11,154 pictures profiled, 6,601 of them 1,000-piece**". Box pictures are "most… 1,200 to 3,000 pixels wide".
  - It covers 36 brands, with counts including Ravensburger 867, MasterPieces 821, Eurographics 507, Schmidt 483, White Mountain 443, Clementoni 403, Springbok 387 and Buffalo Games 311.

  Source: [Puzzle Pointer difficulty report](https://puzzlepointer.com/guides/how-hard-is-a-1000-piece-puzzle/)
- **What the catalogue titles look like.** They read like marketplace listings, for example:
  - "Piece Jigsaw Puzzle for Adults - Nature…"
  - "Teile für Erwachsene | Polarlicht"
  - "EL. Unique Friendship [Puzzle]"
  - "Dowdle Costco Puzzle 1,000-Piece / The Costco Wholesale Treasure Hunt"

  Product pages store a "UPC/EAN barcode in the saved record", e.g. 9780735387010 for Galison Moody Cats. — [difficulty report](https://puzzlepointer.com/guides/how-hard-is-a-1000-piece-puzzle/); [Galison Moody Cats page](https://puzzlepointer.com/puzzles/galison-moody-cats-1000/)
- **Catalogue disclaimers.** "Catalogue coverage is limited, and a similar title does not guarantee the same picture or edition." Barcode misses go into "a private aggregate queue to guide catalogue improvements". — [How it works](https://puzzlepointer.com/how-it-works/); [Privacy](https://puzzlepointer.com/privacy/)
- **Catalogue as SEO.** puzzlepointer.com publishes per-puzzle landing pages. One example: "Galison Moody Cats 1,000-piece puzzle — find where your piece goes", with a difficulty score of 6/100, "Plain pieces about 9 of 1,000", "27×37 piece grid inferred". It also has brand pages and a guide, "How to find where a jigsaw puzzle piece goes". The sitemap lists about 20 puzzle pages so far. — [sitemap](https://puzzlepointer.com/sitemap.xml); [brands](https://puzzlepointer.com/puzzles/brands/); [guide](https://puzzlepointer.com/guides/find-a-jigsaw-puzzle-piece/)
- **Puzzle Pointer's admitted limits.** "provides a visual suggestion for an approximate area… does not guarantee an exact physical fit". "The app does not verify a mechanical fit." "Plain gradients, repeated motifs and tiny details can remain unresolved." "Keep the app open while the search processes. Timing varies." — [Terms](https://puzzlepointer.com/terms/); [How it works](https://puzzlepointer.com/how-it-works/)
- **PuzzleLens.** "Puzzle pictures and piece photos. Processed and stored on your iPhone. No image is ever sent to a server." "Scan records. Kept on device to improve matching." The subscription is checked on the device. The server is used only for the optional friends feature. — [PuzzleLens privacy](https://alperensaglam.github.io/puzzlelens/privacy)
- **Puzzle Detective.** Photos are "processed on your device… not uploaded to our servers". A server is used only for trial and entitlement checks via **Apple App Attest**, plus diagnostics. A screenshot shows "offline ready". There is a slow first search after launch. — [Privacy](https://puzzledetectiveapp.pages.dev/privacy/); [Support](https://puzzledetectiveapp.pages.dev/support/)
- **PuzPal.** "does not use AI, machine learning, or neural networks. It detects the outline… using Apple's Vision framework, then compares those contour shapes mathematically." — [puzpal.com/about](https://puzpal.com/about/)
- **Accuracy claims.**
  - Puzzle Pointer, PuzzleLens and Puzzle Detective publish no accuracy rates.
  - PuzzleLens's screenshots show a per-result confidence ("94% confident").
  - Puzzle Pointer shows "When a result is only a guess, the result screen says so" (v1.0.6).
  - Puzzle Detective says "Solid-color puzzle pieces do not contain enough visual information".

  Sources: [PuzzleLens screenshots via Lookup](https://itunes.apple.com/lookup?id=6812349555&country=us); [Puzzle Pointer App Store](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519); [Puzzle Detective App Store](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265)

### Inferences
- **Catalogue source (unconfirmed).** The catalogue was most likely assembled from retailer or marketplace product feeds. The evidence is the Amazon-style multilingual titles, UPC/EAN fields and 1,200–3,000 px product images. This cannot be confirmed, and image rights may be a weak point for Puzzle Pointer.
  - Hey Puzzlers, an iOS puzzle tracker, advertises a larger catalogue of 70,978 puzzles by barcode (see Q4). Barcode puzzle catalogues are therefore buildable by small teams.
- **Cost structure.** Puzzle Pointer's server plus OpenAI setup costs money per search. That explains the metering (5 free, then $2.99 per 10). An on-device or browser competitor can offer unlimited use at near-zero marginal cost.
- **Privacy positioning.** Puzzle Pointer's App Privacy label lists "Photos or Videos — linked to you". For privacy-sensitive users this is a concrete point of contrast with Puzzle Solver.

### Gaps
- No independent accuracy benchmarks exist for any of these apps.
- The matching algorithms are not described by Puzzle Pointer, PuzzleLens or Puzzle Detective: CV method, embeddings and model type are all unstated.
- Whether Puzzle Pointer's matcher itself uses an LLM or vision model, beyond the OpenAI box check, is not disclosed.

## Q4. Sweep for iOS or web apps the earlier research missed

### Takeaway
No *additional live App Store app* that locates physical pieces was found. The search covered 40+ keyword queries across us, gb, de, ca and au.

The notable new finds are:
- **Puzzle Helper** (jellojm). A free, open-source **iPhone web app** that, like Puzzle Solver, catalogues **many pieces at once** on-device in the browser. It also does border-piece detection, pair "Matches" and joined pieces. It is the closest conceptual competitor to Puzzle Solver found so far, but it has zero traction.
- **SolveAPuzzle**, a web piece-finder from 2023 to 2026, has **shut down**.
- **Pi Jigsaw Puzzle Aid** (2017), a niche iOS helper for one specific puzzle, is effectively abandoned.

Everything else in the "puzzle helper / tracker" space on iOS is a collection or timer tracker, not a solver.

### Cited Findings
- **Puzzle Helper (jellojm/puzzle-helper, GitHub, web app).**
  - Repo description: "iPhone web app that catalogs jigsaw pieces with the camera and finds where they go".
  - **Multi-piece and on-device**: sweep the camera over the table, or "Catalog from a photo" for "every piece in it at once". "Nothing is uploaded… saved on the phone (IndexedDB)". Uses OpenCV.js/WASM in a Web Worker.
  - Modes: Border, Map, Matches (likely pairs), and "Joined pieces (build the puzzle)". It shows orientation ("top edge up… the white arrow on the piece points to its top edge").
  - Self-reported tests: "the right piece came first 74 of 80 times" and border "108 of 120". It notes synthetic tests are "a best case".
  - Repo stats: 0 stars, 0 forks, 79 commits. Files are dated 2026-10-07/08.
  - The app is live at jellojm.github.io/puzzle-helper (HTTP 200 on 2026-10-22).

  Sources: [GitHub](https://github.com/jellojm/puzzle-helper); [live app](https://jellojm.github.io/puzzle-helper/)
- **SolveAPuzzle (web).** The homepage now reads: "SolveAPuzzle has shut down. For a few good years, this little tool helped people find where their pieces went… SolveAPuzzle · 2023 – 2026". Its /tools/jigsaw-solver page returns 404. — [solveapuzzle.com](https://solveapuzzle.com/); [tools page (404)](https://www.solveapuzzle.com/tools/jigsaw-solver)
- **Pi Jigsaw Puzzle Aid (iOS, JOERG ORTMANN / ortisoft.de).**
  - Released 2017-03-03; last updated 2022-03-09 (v1.2); 1 rating in DE (5.0); free.
  - It helps solve one product, getDigital's 1,008-piece Pi puzzle: enter a digit sequence from a piece and it shows the piece's position in the 28×26 grid.
  - It is an abandoned, single-puzzle precursor.

  Source: [App Store DE](https://apps.apple.com/de/app/pi-jigsaw-puzzle-aid/id1201178299)
- **Adjacent trackers (not solvers).** These share the audience and are potential partners or acquirers of a solver feature:
  - **Hey Puzzlers: Puzzle Tracker** (released 2025-02-28, v3.0.0 on 2026-09-09). "Scan the barcode on the box… finds your puzzle among **70,978** in the catalogue". Timer, stats, speed-puzzling leaderboards, community. Elite at $3.99/month, $9.99/quarter or $29.99/year; the free tier allows 20 puzzles. — [App Store](https://apps.apple.com/us/app/hey-puzzlers-puzzle-tracker/id6742631904); [heypuzzlers.com](https://www.heypuzzlers.com)
  - **Puzzle Tracker** (Dawid Kurek, 2021-04-29, v7.7.0 on 2026-07-30). **673 US ratings at 4.70** and 49 in GB. It is a gallery and timer, and the only puzzle-hobby utility with a real review base. — [App Store](https://apps.apple.com/us/app/puzzle-tracker/id1561473799); [Lookup](https://itunes.apple.com/lookup?id=1561473799&country=us)
  - **2026 wave of tracker launches**, all with 0–2 ratings:
    - PieceCount: Puzzle Log (2026-07-17)
    - Puzzlr (2026-05-21)
    - PuzOdyssey (2026-07-29)
    - PuzzleTime (speed puzzling, 2026-08-19)
    - Jigsaw Puzzle Tracker: Trinket (2026-10-13)
    - Puzzle-Tracker by Claus Gumbmann (2026-10-19)
    - Puzzle Pace (timer, 2026-02-17)
    - Jvh Puzzle (Jan van Haasteren tracker, 2025-05-27)
    - Puzzle Friend (2025)

    Source: iTunes Search API, e.g. [puzzle tracker, us](https://itunes.apple.com/search?term=puzzle+tracker&country=us&entity=software&limit=50)
- **False positives.**
  - "Find & Restore!" (Serenico Labs) is an iPad piece-matching *game*. — [App Store](https://apps.apple.com/us/app/find-restore/id6444747256)
  - ASolver, Cube Solver 3D and 21Moves are Rubik's-cube solvers, and Block Puzzle Solver is for Block Blast. They dominate "puzzle solver" results. — [Search "puzzle solver" us](https://itunes.apple.com/search?term=puzzle+solver&country=us&entity=software&limit=50)
- **Queries run.** Searches returning no further physical-piece locator included: "piece locator", "puzzle locator", "jigsaw finder", "puzzle cam", "puzzle match", "where does this piece go", "jigsaw scan", "puzzle box scanner", "puzzle piece scanner", "piece matcher", "puzzle sorter", "puzzle piece counter", "missing puzzle piece", "jigsaw assistant", "jigsaw ai", "puzzle ai helper", "jigsaw photo solver" and "puzzle solver camera" (us; plus gb, de, ca and au for the core set). — iTunes Search API, 2026-10-22, e.g. [where does this piece go](https://itunes.apple.com/search?term=where+does+this+piece+go&country=us&entity=software&limit=50)

### Inferences
- **The web channel is also contested.** Puzzle Helper is the first known competitor doing multi-piece batch cataloguing, orientation, pair matches and on-device browser processing, which is Puzzle Solver's core differentiation. It has no distribution, but it shows the concept is reproducible.
- **Free web tools struggle.** SolveAPuzzle's shutdown after about 3 years suggests a free web piece-finder can struggle to sustain itself (inference; its reason for closing is not stated).
- **Trackers as channel.** Puzzle trackers are proliferating in 2026, and at least one (Hey Puzzlers) has a large barcode catalogue and a paying-subscriber model. This is a plausible partnership or distribution channel. It also means trackers could add a piece-finder, which is a threat.

### Gaps
- Searching the App Store directly (not the API), Apple Search Ads keyword popularity, and Android-to-iOS ports were not checked.
- Apps whose names and descriptions avoid all the queried terms could have been missed.
- Puzzle Helper's author identity, actual usage and real-world accuracy are unknown.

## Q5. Keyword positioning on the App Store

### Takeaway
In the iTunes Search API proxy, each competitor "owns" a different keyword:

| Competitor | Keyword owned | Where it ranks #1 |
|---|---|---|
| PuzzleLens | "puzzle solver" and "jigsaw puzzle solver" | "puzzle solver": US and AU. "jigsaw puzzle solver": US, GB, CA, AU and DE |
| Puzzle Detective | "puzzle piece finder" | US and GB |
| Puzzle Pointer | "piece finder" | US, GB and AU |

"jigsaw solver" alone is dominated by large digital-jigsaw games in the US and GB.

These are API positions, not verified live App Store ranks. They also reflect a near-empty field, with 0-rating apps ranking #1.

### Cited Findings
Positions are from the iTunes Search API top 50, collected 2026-10-22.

| Query | PuzzleLens | Puzzle Detective | Puzzle Pointer |
|---|---|---|---|
| puzzle solver | **1** US, **1** AU, 7 CA, 15 GB; not top-50 DE | not top-50 | not top-50 |
| jigsaw puzzle solver | **1** US/GB/CA/AU/DE | 28 DE | 11 DE |
| jigsaw solver | 11 US, 8 GB, 2 CA, 11 AU, **1** DE | 33 DE | 15 DE |
| puzzle piece finder | 12 AU, 13 GB, 27 CA, 4 DE | **1** US, **1** GB, 2 AU, 3 CA, 2 DE | 21 US, 14 GB, 7 AU, 13 CA, **1** DE |
| jigsaw piece finder | 3 DE | 3 US, 2 CA, 6 DE | 7 GB, 6 AU, 9 CA, **1** DE |
| piece finder | 13 DE | 2 US/GB/AU, **1** CA, 5 DE | **1** US/GB/AU, 2 CA, **1** DE |
| find puzzle piece | 12 US, 9 GB | **1** US, **1** CA | 6 US, 6 GB, 3 DE |
| puzzle helper | 18 US, 14 GB, 7 DE | — | 20 DE |
| jigsaw helper | 9 US, 29 GB, **1** DE | — | 4 DE |
| missing puzzle piece | 8 US, 7 GB, 2 DE | 15 US | — |
| puzzle scanner | 9 US, 8 AU | 44 CA | — |

Sources: iTunes Search API, e.g. [puzzle solver us](https://itunes.apple.com/search?term=puzzle+solver&country=us&entity=software&limit=50), [puzzle piece finder us](https://itunes.apple.com/search?term=puzzle+piece+finder&country=us&entity=software&limit=50), [piece finder gb](https://itunes.apple.com/search?term=piece+finder&country=gb&entity=software&limit=50), [jigsaw puzzle solver de](https://itunes.apple.com/search?term=jigsaw+puzzle+solver&country=de&entity=software&limit=50)

What sits around them in the top results:
- **"puzzle solver" US.** 1. PuzzleLens (0 ratings), 2. ASolver (279,558 ratings), 3. Word Search Scanner and Solver (3,990), 4. Block Puzzle Helper: Blast, 5. Cube Solver 3D (260,244). The term is contested by cube, word and block-blast solvers.
- **"puzzle solver" GB.** 1. ASolver, 2. Cube Solver 3D, 3. 21Moves; PuzzleLens is 15th. In GB its title says "Jigsaw Solver" rather than "Puzzle Solver".
- **"jigsaw solver" US.** 1. Magic Jigsaw Puzzles (387,984 ratings), then Jigsaw Puzzles Epic, Puzzle Villa, Jigsaw Puzzle Ultimate, Super Jigsaw. These are digital games.
- **"puzzle piece finder" US.** 1. Puzzle Detective, 2. Find & Restore! (a game), 3. Puzzle Friend (a tracker), then block-puzzle games.

Source: [Search "puzzle solver" us](https://itunes.apple.com/search?term=puzzle+solver&country=us&entity=software&limit=50); [gb](https://itunes.apple.com/search?term=puzzle+solver&country=gb&entity=software&limit=50); [jigsaw solver us](https://itunes.apple.com/search?term=jigsaw+solver&country=us&entity=software&limit=50); [puzzle piece finder us](https://itunes.apple.com/search?term=puzzle+piece+finder&country=us&entity=software&limit=50)

How each app chose its keywords:
- PuzzleLens puts "Puzzle Solver" or "Jigsaw Solver" in its store title, localised per storefront.
- Puzzle Detective and Puzzle Pointer both use "Piece Finder" as the title suffix, and their subtitles add "Jigsaw".

Source: [Lookup gb](https://itunes.apple.com/lookup?id=6812349555&country=gb); [App Store Detective](https://apps.apple.com/us/app/puzzle-detective-piece-finder/id6808541265); [App Store Pointer](https://apps.apple.com/us/app/puzzle-pointer-piece-finder/id6809997519)

### Inferences
- **The keywords are cheap to win.** Apps with 0 ratings reach #1 for exact-match phrases. A native wrapper of Puzzle Solver could compete for these slots quickly. As a web-only PWA, Puzzle Solver has no presence in this channel at all.
- **"Puzzle Solver" is a contested name.** In search it collides with cube, word and block-blast solvers that have hundreds of thousands of ratings. As an App Store name it is already used in PuzzleLens's title. On Android, Solver Works uses the "Jigsaw Puzzle Solver" name and the puzzlesolver.app domain (from earlier notes). Distinctive branding or a qualifier ("jigsaw", "piece finder") is needed.
- **Web SEO is open but has a first mover.** Puzzle Pointer is the only competitor building web SEO, with per-puzzle landing pages, a difficulty report and a how-to guide. Web search for these phrases is currently weak, and in this session's searches Google-style results surfaced only Solver Works, Puzzle Helper and listicles.

### Gaps
- Real App Store search ranks, keyword popularity scores and impression data could not be verified. Public ASO tools (AppFigures, AppTweak, Sensor Tower) were not reachable or don't cover these apps. The iTunes Search API order is only an approximation of App Store search.
- Apple Search Ads activity (whether any competitor bids on "puzzle solver") is unknown.
