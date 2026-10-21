# Distribution & Payments for a Browser-Only PWA (Puzzle Solver), as of Oct 2026

Research date: 2026-10-21. Many of the store and court facts below changed during 2025–2026 and may still be moving. Dates are given for each one. Most fee comparisons come from third-party blogs, not the vendors' own pricing pages, unless marked otherwise.

## 1. Web payments for a backend-less app: Merchant-of-Record vs plain Stripe; license keys & offline unlock

### Takeaway
A Merchant of Record (MoR) charges about 5% + $0.50 per sale. In return it becomes the legal seller and handles EU VAT. For a solo EU seller it is clearly the easiest option. Polar and Lemon Squeezy include license-key APIs, but those APIs are online and unsigned. For true offline unlocking, the realistic options are (a) validate once online and cache the result, or (b) add a tiny serverless function that issues an Ed25519-signed token, which the app verifies on the device.

### Cited Findings
- **Paddle:** 5% + $0.50 per transaction, flat, with no monthly fee and tax handling included (checked 12 Sep 2026). International cards are covered by the base rate. — [aliteq: cheapest MoR 2026](https://aliteq.com/cheapest-merchant-of-record); [buildmvpfast comparison](https://www.buildmvpfast.com/blog/lemon-squeezy-vs-polar-paddle-merchant-of-record-2026)
- **Lemon Squeezy (owned by Stripe since July 2024):** still lists 5% + $0.50 as of Oct 2026, plus surcharges of +1.5% for international cards, +1.5% for PayPal and +0.5% for subscriptions. Its own FAQ says fees "could exceed 5% + 50 cents" in edge cases. — [turbostarter 2026 fees](https://www.turbostarter.dev/blog/stripe-vs-lemonsqueezy-vs-polar-vs-creem-choosing-the-right-saas-payment-provider); [aliteq](https://aliteq.com/cheapest-merchant-of-record)
- **Stripe Managed Payments** (Stripe's own MoR product): entered public preview in Feb 2026 as the formal migration path for Lemon Squeezy merchants. Lemon Squeezy keeps running as a standalone product for now. — [fungies: LS/Stripe acquisition timeline](https://fungies.io/lemon-squeezy-stripe-acquisition-saas-founders-2026/)
  - Pricing: one source puts it at about 3.5% on top of standard Stripe processing (2.9% + $0.30), so roughly 6.4% + $0.30 all-in for domestic cards. — [turbostarter](https://www.turbostarter.dev/blog/stripe-vs-lemonsqueezy-vs-polar-vs-creem-choosing-the-right-saas-payment-provider)
  - Another source says 5% + $0.50, the same as Lemon Squeezy. — [fungies](https://fungies.io/lemon-squeezy-stripe-acquisition-saas-founders-2026/)
  - These figures conflict. Check them on Stripe's own pricing page.
- **Polar.sh:** sources disagree on pricing.
  - Free Starter plan at 5% + $0.50, and a $20/month Pro plan at 3.8% + $0.40 (Polar's own breakeven point is about $1,379/month in sales). — [aliteq](https://aliteq.com/cheapest-merchant-of-record)
  - A flat 4% + $0.40 "as of mid-2026". — [delivvo](https://delivvo.io/blog/polar-vs-lemonsqueezy-vs-paddle-merchant-of-record-2026)
- **All-in cost on an example $29 sale** to a US customer: Paddle and Polar's free plan $1.95, Lemon Squeezy $2.09, Stripe Managed Payments $2.36, Gumroad $3.40. — [aliteq](https://aliteq.com/cheapest-merchant-of-record)
- **Polar license keys** (official docs):
  - Endpoints: `POST /v1/customer-portal/license-keys/activate` and `/validate`. The documented examples send only the key and organization_id, with no API token, so they look callable from a client.
  - Supported features: activation limits (e.g. 3 devices), usage quotas, and expiry for one-time purchases. Subscription keys are revoked when the subscription ends.
  - Polar recommends validating once per app session. The docs say nothing about offline validation.
  - — [Polar docs: License Keys](https://polar.sh/docs/features/benefits/license-keys)
- **Lemon Squeezy License API:** offers activate, validate and deactivate. It is "a separate API from the Lemon Squeezy API and has different requirements", with a rate limit of 60 requests/minute. The page fetched did not say whether the API can be called from a browser or whether CORS is allowed. — [LS docs: License API](https://docs.lemonsqueezy.com/help/licensing/license-api)
- **Licensing tool landscape:** a 2026 guide lists two routes: an MoR with built-in licensing (e.g. Paddle, Dodo), or a dedicated license server such as Keygen or Cryptolens paired with a payment processor. Keygen and Cryptolens offer offline support; the MoRs offer it only in limited form. — [fungies: selling license keys 2026](https://fungies.io/sell-software-license-keys-developer-guide-2026.md)
- **Offline keys and piracy:** an indie developer who tried to pirate their own product found that leaked keys which cannot be revoked are the main long-term cost of offline verification. They suggest binding each signed token to an order ID or email hash, so a leaked key can be traced back to its buyer. — [Indie Hackers: "I tried to pirate my own product"](https://www.indiehackers.com/post/i-tried-to-pirate-my-own-product-799871fa0a)

### Inferences
- **Architecture options for a no-backend PWA:**
  - **(A) Simplest.** The buyer pays through the MoR's hosted checkout or overlay and gets a license key by email. The app calls Polar's or Lemon Squeezy's validate endpoint once while online and stores the result in IndexedDB. Weakness: the response is not cryptographically signed, so anyone can patch it with DevTools.
  - **(B) Most robust offline.** Add a single serverless function (e.g. a Cloudflare Worker) that receives the MoR's webhook, or is called after checkout. It signs `{orderId, emailHash, tier, issuedAt}` with an Ed25519 private key. The PWA embeds the public key and verifies the token with WebCrypto, fully offline. This means a "backend" only for issuing tokens, not for running the app.
  - **(C) Use Keygen's signed license files.** This needs a Keygen account in addition to the payment provider.
- **Piracy probably matters little for a cheap hobby app.** All code runs on the client, so a determined user can always patch out the license check, whichever scheme is used. The license gate mostly keeps honest buyers honest. Engineering effort is better spent on the purchase flow than on DRM.
- **Plain Stripe is cheaper per sale** (about 1.5% + €0.25 on EEA cards, from background knowledge, not verified here). However, the seller must then register for VAT OSS, charge the right VAT rate for each EU country, and handle invoicing. For low volumes that is not worth the hassle compared with an MoR.
- **Fixed fees hurt at low prices.** At a €3–5 price point the $0.50 fixed fee is 10–17% of the sale. That pushes the price up (€5–10 one-time), or towards Paddle's or Polar's tiers.

### Gaps
- I could not verify the current Paddle, Lemon Squeezy, Polar or Stripe Managed Payments rates on the vendors' own pricing pages; they come from third-party comparisons dated mid- to Oct 2026.
- Not confirmed:
  - whether Stripe Managed Payments issues license keys;
  - whether the Lemon Squeezy and Polar license endpoints allow browser (CORS) calls;
  - whether Keygen's offline Ed25519 signed licenses work as I recall (background knowledge only);
  - browser support for WebCrypto Ed25519 (I believe it is now in Chrome, Safari and Firefox, but did not verify this session).
- Gumroad's current fee structure was not checked directly; only the $3.40-on-$29 figure above.

## 2. Wrapping the PWA for stores (TWA/Bubblewrap/PWABuilder, Capacitor), guideline 4.2, WKWebView concerns

### Takeaway
Google Play is fairly easy to reach with a Trusted Web Activity (TWA, a wrapper that runs the PWA in Chrome). The main obstacle for a new personal account is the 12-tester / 14-day closed test. The iOS App Store is harder: a thin WebView wrapper is the textbook case for a guideline 4.2 rejection, so the iOS build needs real native value, such as native camera capture, a native share sheet or native navigation.

### Cited Findings
- **Google Play closed-test rule** (Google's own help page): a newly created personal developer account must run a closed test with at least 12 testers who have been opted in for the last 14 days continuously. Until then, Production and Pre-registration stay disabled. — [Google Play Console Help](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-GB)
  - Third-party guides say this applies to personal accounts created after Nov 13, 2023, and that organization accounts are exempt. — [extendsclass 2026](https://extendsclass.com/blog/google-plays-closed-testing-requirement-what-developers-need-to-know-in-2026)
  - Testers only count once they have installed the app, and the 14-day clock effectively resets if the count drops below 12. — [rapidnative](https://www.rapidnative.com/deploy/google-play-12-tester-requirement)
  - This is not Google-verified, and is widely called the "12-tester tax" on solo devs. — [gitconnected](https://levelup.gitconnected.com/the-12-tester-tax-google-plays-closed-testing-rule-is-quietly-killing-solo-devs-2cea83c2e338)
- **Guideline 4.2 and thin wrappers:** a thin PWA wrapper is "the textbook case" that guideline 4.2 targets. The practical rule is that the app should do at least one meaningful thing a home-screen shortcut cannot. Suggested additions: push notifications, offline support, native navigation, biometrics, share sheets. — [vp0: Convert PWA to iOS 2026](https://vp0.com/blogs/convert-pwa-to-ios-app-fast-2026)
- **Typical rejection pattern:** a single full-screen WKWebView loading a remote URL, needing a constant connection, with no native navigation. Adding one native API on its own (push, location) is reportedly not enough. — [technetexperts: Guideline 4.2](https://www.technetexperts.com/guideline-4-2-minimum-functionality/)
- **Capacitor rejection example:** a January 2026 Apple Developer Forums thread describes a Capacitor app with custom Swift plugins that was still rejected under 4.2. — [Apple Dev Forums 812889](https://developer.apple.com/forums/thread/812889)
- **Open question on server-delivered code:** another forum thread asks whether delivering functionality from a server after approval is allowed (cf. guideline 2.5.2 on downloaded code). It was unanswered. — [Apple Dev Forums 829592](https://developer.apple.com/forums/thread/829592)

### Inferences
- **Puzzle Solver's iOS position is better than most wrappers.** It is fully offline, the computer vision runs on the device, and it uses the camera. If the iOS build bundles the web assets locally (Capacitor default) rather than loading a remote URL, and adds native features, 4.2 risk drops considerably. Useful native features: a native camera/photo picker, haptics, a share sheet, and possibly Vision/Core ML acceleration.
- **Code updates must ship as app updates.** Updating code over the air from GitHub Pages would conflict with 2.5.2, so app-store builds would need their own release process.
- **Android options:** Bubblewrap and PWABuilder produce a TWA that runs in the user's Chrome, so camera, Web Workers and IndexedDB behave as they do in the browser. Digital Asset Links verification (which ties the app to the domain) needs a file hosted at `/.well-known/assetlinks.json` on the PWA's domain. GitHub Pages project sites (user.github.io/repo) can't serve that file at the domain root, so a custom domain or a user/organization site is likely needed. This is from background knowledge and was not verified this session.
- **Store purchases inside wrappers:** a store-distributed wrapper that sells digital unlocks must use, or at least offer, store billing, except where the link-out rules in section 3 apply.

### Gaps
- I did not fetch the current exact wording of guidelines 4.2 or 2.5.6 from Apple's site.
- No 2025–2026 source found comparing camera, getUserMedia or WASM/Worker performance in WKWebView versus Safari. From background knowledge (not verified), getUserMedia has worked in WKWebView since iOS 14.3, and all iOS browsers must use WebKit (outside EU alternative-engine rules).
- I did not find coverage of Google's 2026 Android developer-verification programme, or how it affects TWA or sideloaded distribution.
- I did not confirm whether TWA apps need to use Play Billing (via the Digital Goods API) for in-app unlocks, or can use the new US/EEA external-link options described below.

## 3. Store fees in 2026: Apple and Google, US court cases, EU DMA

### Takeaway
For a developer earning under $1M a year, the store cut is now much smaller:
- **Google Play** (US, UK, EEA, since 30 Jun 2026): 10%, plus another 5% only if Google Play's own billing system is used.
- **Apple, EU** (from 1 Oct 2026): 15% with Apple's payment system for Small Business Program members; 10% for link-outs or other payment processors; 5% for apps distributed outside the App Store.
- **Apple, US:** external purchase links currently carry a 0% commission. That depends on the outcome of the Epic case, which the Supreme Court has agreed to hear (as of Oct 2026).

### Cited Findings
**Apple, US (Epic v. Apple):**
- **Ninth Circuit, Dec 2025:** the court largely upheld the April 2025 contempt finding. It said the outright bans on charging any commission on link-outs, and on all link restrictions, were too broad, and that Apple may charge a reasonable commission tied to the costs of coordinating external links. The district court is to set that framework. — [Justia: 9th Cir. No. 25-2935, 2025-12-11](https://law.justia.com/cases/federal/appellate-courts/ca9/25-2935/25-2935-2025-12-11.html); [Fenwick](https://www.fenwick.com/insights/publications/ninth-circuit-largely-upholds-ruling-in-epic-v-apple)
- **Supreme Court:**
  - Apple asked the Supreme Court to hear the case (cert petition, No. 25-1311) in spring 2026. Sources give different dates for the filing: April or May 2026.
  - The Court agreed to hear the case (granted certiorari). IPWatchdog reported this on 30 Jun 2026; another source gives 2 Jul 2026.
  - Apple's opening merits brief is dated 14 Sep 2026.
  - — [IPWatchdog 2026-06-30](https://ipwatchdog.com/2026/06/30/high-court-grants-cert-in-apples-challenge-to-ninth-circuit-contempt-ruling-in-app-store-dispute/); [SCOTUS merits brief PDF](https://www.supremecourt.gov/DocketPDF/25/25-1311/424150/20260914154510009_2026-09-14%20No.%2025-1311%20Apple-Epic%20Merits%20Opening%20Brief.pdf); [Oyez 25-1311](https://www.oyez.org/cases/2026/25-1311)
- **Apple's proposed link-out fees (Aug 2026):** 15% standard; **5% for Small Business Program apps**; 10% for partner programs and subscription renewals. These need the district court's approval, and Apple cannot collect a link-out commission until then. US developers can currently link out at 0%. — [iClarified 2026-08-14](https://www.iclarified.com/101778/apple-seeks-court-approval-for-15-commission-on-external-app-purchases); [iPhone in Canada 2026-08-14](https://www.iphoneincanada.ca/2026/08/14/apple-proposes-15-cut-purchases-outside-app-store/); [neonpay 2026](https://www.neonpay.com/blog/apple-app-store-alternative-payment-fees-what-developers-pay-in-2026)
  - **Conflict:** one source says Apple kept charging 27% on outside payments as of Jun 2026. This contradicts the zero-commission reports. — [tech-insider](https://tech-insider.org/apple-epic-supreme-court-2026/)
- **Small Business Program (standard terms):** 15% commission instead of 30% for developers with under $1M in proceeds. If you go over $1M, the standard rate applies for the rest of the year. — [RevenueCat docs](https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/app-store-small-business-program.md)

**Apple, EU (DMA), new terms effective 1 Oct 2026** (Apple newsroom, Aug 2026):

| Path | Standard | Small Business Program and other programs |
|---|---|---|
| App Store, Apple in-app purchase | 26% | 15% (also auto-renewing subscriptions after year one) |
| App Store, alternative payment processor | 20% | 10% |
| App Store, link-out to web purchase | 15% | 10% |
| Outside the App Store (alternative marketplaces or web distribution) | 5% Core Technology Commission (CTC) | — |

- The CTC replaces the per-install Core Technology Fee. The initial acquisition fee and store services fee are dropped.
- In-app purchase can now be offered alongside alternative payments. Whatever payment setup you choose must be kept for 12 months.
- Child protections:
  - Kids-category apps can't link out.
  - Under-18s need a parental gate before alternative payments or link-outs.
  - Under-13s can't be sent to websites to pay.
- Web distribution is now open to more kinds of company. One qualifying route is a moderate Dun & Bradstreet financial-stability score.
- Every app distributed outside the App Store must still pass Notarization (Apple's basic check).
- — [Apple Newsroom, Aug 2026](https://www.apple.com/newsroom/2026/08/apple-announces-changes-for-apps-in-the-european-union/); [gHacks 2026-08-19](https://www.ghacks.net/2026/08/19/apple-replaces-per-install-eu-core-technology-fee-with-a-flat-5-commission/); [Apple Developer: apps in the EU](https://developer.apple.com/support/apps-in-the-eu/)
- The European Commission welcomed the changes and said it will monitor them. — [The Next Web](https://thenextweb.com/news/apple-eu-app-store-fees-dma-core-technology-commission)
- These terms supersede the June 2025 EU structure (e.g. 13%/20% plus the Core Technology Fee). — [RevenueCat June 2025](https://www.revenuecat.com/blog/growth/apple-eu-dma-update-june-2025)

**Google Play (after the Epic v. Google settlement), effective 30 Jun 2026 in the US, UK and EEA:**
- 10% service fee on the first $1M of annual earnings, whichever payment method is used: Google Play billing, alternative billing, or external web links. This includes auto-renewing subscriptions.
- An extra 5% billing fee applies only if Google Play's own billing system is used.
- Above $1M: 20% for new installs and 25% for existing installs (excluding subscriptions). Link-out fees above $1M are 20%.
- — [9to5Google 2026-06-24](https://9to5google.com/2026/06/24/google-play-store-external-billing-june-30/); [MacRumors 2026-06-24](https://www.macrumors.com/2026/06/24/google-play-store-fee-change/); [FoxData](https://foxdata.com/en/blogs/google-play-store-opens-external-billing-fees-drop-to-10-starting-june-30-2026/)
- One source says developers in the external-links programme must report transactions and pay fees from **1 Oct 2026**. This is not verified against Google's own docs. — [taylancetech](https://taylancetech.com/blog/google-play-2026-changes-app-store-fees-third-party-stores)
- Older articles saying US external links carried 0% fees pending an April 2026 hearing appear to be superseded. — [Coda](https://www.coda.co/blog/epic-v-google-policy-update-2026/); [Stash](https://www.stash.gg/blog/google-android-policy-update-what-it-means-for-your-dtc-strategy)

### Inferences
- **Effective take rates for Puzzle Solver** (selling about €5–10 one-time, well under $1M a year):

  | Channel | Approximate cut |
  |---|---|
  | Web via MoR | ~6–10% (the fixed fee dominates at low prices) |
  | Google Play, Play Billing | 15% |
  | Google Play, link-out to an MoR checkout | 10% + MoR fees |
  | Apple App Store, in-app purchase (Small Business Program) | 15% |
  | Apple US link-out | 0% today, possibly 5% later + MoR fees |
  | Apple EU link-out | 10% + MoR fees |

- **For small sums, the store's own payment system is often simplest.** Link-outs mean paying both the store commission and the MoR fee, and add friction. Link-outs mainly pay off for people who already buy on the web.
- **Apple's US rules are the least stable.** A Supreme Court ruling, likely in the first half of 2027 (inference), could restore Apple's ability to charge a commission on link-outs.

### Gaps
- No primary Google Play Console help page was fetched for the exact 2026 rates, programme enrolment steps, or Germany/EEA specifics.
- The zero-commission status for Apple US link-outs as of Oct 2026 rests on secondary sources, and one source conflicts.
- Developer programme fees were not verified this session: Apple $99/year and Google $25 one-time (background knowledge).

## 4. Discoverability and iOS PWA limitations

### Takeaway
Installing a PWA on iOS is still hard: there is no install prompt, it takes 4 or more taps through the Share menu, and there is no background sync. Apple reversed its 2024 plan to remove home-screen web apps in the EU, so they still work there. I found no hard evidence quantifying how much store presence matters for hobby apps. The inferences below are reasoning, not data.

### Cited Findings
- **Install friction on iOS:** Safari has no `beforeinstallprompt`, so there is no install banner. Users must add the app via Share → Add to Home Screen, which usually takes 4 or more taps. — [MagicBell: PWA iOS limitations](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide); [MobiLoud](https://www.mobiloud.com/blog/progressive-web-apps-ios)
- **Storage on iOS** (sources partly disagree):
  - A 7-day cap on script-writable storage has applied to Safari since iOS 13.4, with least-recently-used eviction when space runs low.
  - Per WebKit, apps added to the home screen are skipped by that data-removal algorithm.
  - Home-screen apps keep their storage separate from Safari. A license unlocked in Safari will not carry over to the installed app.
  - — [MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide); [MobiLoud](https://www.mobiloud.com/blog/progressive-web-apps-ios)
- **Push and background work:** Web Push for home-screen apps has existed since iOS 16.4 and must be requested in response to a user action. Background Sync and Background Fetch are not available. — [MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- **EU:** Apple's iOS 17.4 beta (Feb 2024) briefly turned EU PWAs into shortcuts. Apple then reversed this and kept home-screen web apps in the EU. — [Michael Tsai blog 2024-02-09](https://mjtsai.com/blog/2024/02/09/ios-17-4-changes-pwas-to-shortcuts-in-eu); [MobiLoud](https://www.mobiloud.com/blog/progressive-web-apps-ios)
- **"The browser is the store":** an Indie Hackers founder argues this for episodic or social indie consumer apps in 2026. This is opinion, not data. — [Indie Hackers](https://www.indiehackers.com/post/pwas-are-killing-app-store-only-thinking-for-indie-consumer-apps-63cb99bd60)

### Inferences
- **Licensing implications on iOS:**
  - The separate storage on iOS means buyers who unlock in Safari must re-enter their key or token in the installed app, so the "restore purchase" flow needs to be simple (e.g. a magic link or pasting the key).
  - Losing IndexedDB data to eviction is a reason to make license tokens easy to recover (the email receipt holds the key) rather than storing them only on the device.
- **Search behaviour (reasoning):** people who search for "jigsaw puzzle helper" are likely to look in app stores on their phones, where puzzle apps are common. A web-only product relies on SEO, content, YouTube or TikTok demos, and puzzle communities (r/Jigsawpuzzles, Facebook groups).
- **Reach versus cost:** a Google Play TWA is cheap extra reach (10–15% cut). An iOS App Store build costs more (Capacitor work, $99/year, 4.2 risk) but gives the biggest discoverability boost on the platform where installing a PWA is weakest.

### Gaps
- No quantitative evidence found comparing App Store or Play search with SEO for hobby or utility apps, or measuring PWA install conversion rates.
- I found no iOS 26-specific changes to PWA behaviour. Safari 26.x release notes were not checked.
- Apple's exact storage quotas for installed PWAs are unpublished, and sources conflict.

## 5. Legal/practical for an EU (German) solo seller

### Takeaway
German consumers have a 14-day right of withdrawal (Widerrufsrecht) for digital purchases. It only lapses on delivery if the buyer explicitly consents to immediate delivery and acknowledges losing the right, and this is then confirmed on a durable medium. An MoR acts as the seller and takes over most of that checkout, VAT and invoicing work. The Kleinunternehmer small-business VAT exemption was revised in 2025: €25k previous-year turnover and €100k current-year.

### Cited Findings
- **When the withdrawal right lapses (§ 356 Abs. 5 BGB):** the right only ends if the seller has actually started performance after the consumer **expressly consented** and **confirmed knowing** they lose the right. Without both, the right persists even after a full download. — [IT-Recht Kanzlei](https://www.it-recht-kanzlei.de/digitale-inhalte-verkauf-eu-verbraucherrechterichtlinie.html); [e-recht24](https://www.e-recht24.de/ecommerce/13530-widerrufsrecht-fuer-digitale-inhalte.html)
  - The wording may be pre-written, but a checkbox must be an opt-in that is not pre-ticked. — [IT-Recht Kanzlei](https://www.it-recht-kanzlei.de/digitale-inhalte-verkauf-eu-verbraucherrechterichtlinie.html)
- **Stricter since 28 May 2022 for paid digital content:** the seller must also confirm, after the purchase and on a durable medium (e.g. email), that the withdrawal right has lapsed. The consumer must receive a contract copy or confirmation covering these points; if any element is missing, the right remains. — [IT-Recht Kanzlei 2022](https://www.it-recht-kanzlei.de/widerrufsrecht-digitale-inhalte-dienstleistungen-2022.html)
- **Court example:** LG Köln (21 May 2019, Az. 31 O 372/17) held that a notice in the Play Store was not "express" consent. — [IT-Recht Kanzlei: LG Köln](https://www.it-recht-kanzlei.de/lg-koeln-widerrufsrecht-verzicht-digitale-inhalte.html?print=1)
- **Kleinunternehmerregelung (§ 19 UStG, from 2025):**
  - Limits: €25,000 net turnover in the previous year, and €100,000 in the current year.
  - Exceeding €100,000 ends the status immediately, not at year end.
  - A new EU-wide small-business scheme (EU-weite Kleinunternehmerregelung) exists for other member states, with a €100,000 EU-wide turnover cap.
  - Opting out of the exemption binds you for 5 years.
  - — [IHK München](https://www.ihk-muenchen.de/ratgeber/steuern/umsatzsteuer/kleinunternehmerregelung/); [lohnsteuer-kompakt](https://www.lohnsteuer-kompakt.de/steuerwissen/kleinunternehmerregelung-aenderungen-ab-2025/); [selbststaendigkeit.de](https://selbststaendigkeit.de/buchhaltung-fuer-gruender/umsatzsteuer-bei-kleinunternehmen/)

### Inferences
- **What the MoR takes over:** with an MoR (Paddle, Lemon Squeezy, Polar, Stripe Managed Payments), the MoR is the seller to the consumer. It collects and remits VAT for each EU country, issues invoices, and runs the checkout, including the withdrawal-waiver wording and receipts. The developer's income becomes a B2B payout from one company.
- **What stays with the developer:** an Impressum on the website and in the app's About page, plus a privacy notice. Both are much simpler for an app with no backend and no tracking.
- **Plain Stripe or self-selling:** the developer must build the express-consent checkbox, send the durable-medium confirmation email, and handle EU VAT. Cross-border B2C digital sales are taxed at the customer's rate above the €10k EU threshold, via OSS (background knowledge). Being a Kleinunternehmer does not remove that cross-border complexity.
- **App stores** are also the seller or commission agent to consumers for in-app purchases (in the EU, Apple and Google handle VAT). This is another reason store billing is simpler than link-outs for small sums.

### Gaps
- **Impressum:** I did not verify the current legal basis, believed to be § 5 DDG (the Digitale-Dienste-Gesetz, which replaced the TMG in May 2024; background knowledge only), or whether it applies to the app-store listing.
- **Tax:** I did not confirm how MoR payouts (e.g. from Paddle UK or Lemon Squeezy/Stripe US/IE) count towards Kleinunternehmer turnover and reverse-charge reporting. This needs a Steuerberater.
- **OSS threshold:** the €10k OSS threshold for digital services was not verified in a source this session.
- **Legal sources:** the withdrawal-right sources date from 2019–2022. I did not check for 2025–2026 changes, such as the EU "withdrawal button" (Widerrufsbutton) requirement that I believe takes effect in 2026 (unverified).

## 6. Real examples of indie devs selling web apps / PWAs

### Takeaway
The best-documented solo web-app success is Photopea: about $1M in revenue in 2020, mostly from ads plus a premium subscription, not one-time licenses. I found little reliable public data on one-time-license PWA sales.

### Cited Findings
- **Photopea** (solo developer Ivan Kutskir): free and ad-supported, with an ad-free premium subscription and a self-hosted corporate version. Revenue was about $1M in 2020, mostly from ads, the rest from premium users and self-hosting fees. — [Wikipedia: Photopea](https://en.wikipedia.org/wiki/Photopea)
  - Premium costs about $5/month or $50/year (aggregator, possibly dated). — [Costbench](https://www.costbench.com/software/design/photopea/)
  - Ad earnings dropped significantly during COVID while the user base kept growing. — [AdPushup interview](https://www.adpushup.com/blog/decrypting-ad-tech-with-ivan-kuckir-founder-at-photopea/)
  - A newsletter claims ads bring in more than $150k/month. This is unverified. — [ByzanTime](https://byzantime.beehiiv.com/p/one-man-show-photopea-success-story)
- **Lamiaa Hub** (Product Hunt): sells nine offline productivity PWAs for one-time prices of $1.99–$9.99. They work offline with local storage and need no accounts. No results data was disclosed. — [Product Hunt](https://www.producthunt.com/products/lamiaa-hub-premium-pwa-marketplace)

### Inferences
- **Photopea's model needs huge traffic.** Free core features plus ads or a premium tier only works at very high volume, which a niche jigsaw app is unlikely to reach.
- **Plausible models for a niche app:** a free tier (e.g. limited solves, or one puzzle at a time) plus a one-time "Pro" unlock, or a small one-time price, is more realistic.
- **Excalidraw+ and tldraw** sell team/collaboration subscriptions or SDK licenses (background knowledge). They are not good comparables for a one-time offline consumer unlock.

### Gaps
- I found no reliable published revenue figures for Excalidraw+, tldraw, Squoosh-like tools, or indie one-time-license PWAs.
- I did not find a Hacker News thread with concrete numbers on selling PWAs; the searches returned none.
