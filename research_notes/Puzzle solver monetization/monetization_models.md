# Monetization Models for Small Consumer Utility / Hobby Apps (Puzzle Solver context)

Context: Puzzle Solver is a browser-only PWA with on-device CV, no server costs, privacy-first, built by a solo indie developer. Usage is episodic: intensive for one puzzle (days to weeks), then idle until the next one. Researched October 2026. Data years are labelled. Most benchmark data comes from vendors (RevenueCat, Adapty, Superwall) whose datasets are mobile app-store subscription apps, not web PWAs. Treat them as directional for a web app.

## 1. Subscription-app benchmarks (RevenueCat SOSA 2025/2026, Adapty 2025/2026, Superwall)

### Takeaway
Across 2025-2026 data, hard paywalls convert about 5x better than freemium at download-to-paid (10.7-12.1% vs about 2.1-2.2% median), and they earn about 8x more revenue per install. Weekly plans now drive most revenue in Utilities and Photo & Video, but they retain terribly (3-6% at 12 months). Annual plans retain far better (about 44% in year 1). Median annual price is about $30-35, and low-priced apps convert to trial less often but retain better.

### Cited Findings
**Conversion: hard paywall vs freemium**
- RevenueCat SOSA 2025 (2024 data), Day-35 download-to-paid: hard paywall median 12.11% vs freemium 2.18%. Hard paywall refund rate 5.8% vs freemium 3.4% — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- RevenueCat SOSA 2026 (2025 data), Day-35 download-to-paid: hard paywall median 10.7% (top 10%: 38.7%) vs freemium 2.1%. Hard paywall fell about 1.4 points year on year while freemium held steady — [RevenueCat blog, 2026 in 10 minutes](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026); [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth)
- SOSA 2026 revenue per install, hard paywall vs freemium: $2.32 vs $0.27 at Day 14, and $3.09 vs $0.38 at Day 60 (about 8x) — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth)
- SOSA 2026 yearly-subscriber 1-year retention: freemium 28%, hard paywall 27%. Once people pay, retention is about the same under either model — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- SOSA 2026: 50% of paid conversions happen on Day 0 — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth). SOSA 2025: 82% of trial starts happen on install day — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Secondary analysis of SOSA 2025: first-year LTV per payer is about $49.30 for hard-paywall apps vs $24.24 for freemium apps — [Airbridge, Hard Paywall vs Freemium 2026](https://www.airbridge.io/en/blog/hard-paywall-vs-freemium-2026)
- Adapty 2025 (2024 data): install-to-paid without a trial reaches 18-38%, highest in Lifestyle and Productivity. Install-to-trial is below 12% in most cases. Direct paywalls convert better than trials in most categories, but trial users have up to 64% higher LTV — [Adapty State of In-App Subscriptions 2025 in 10 minutes](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/). Note: the 18-38% figure is much higher than RevenueCat's medians. It probably measures a different funnel, for example among users who reach the paywall. Do not compare it directly.

**Regional conversion (SOSA 2026)**
- Download-to-paid: North America 2.8% vs IN/SEA 0.7%. Annual price: North America $39.99 vs IN/SEA $18.32. Revenue per install at Day 60: North America $0.55 vs IN/SEA $0.11 — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth). Another secondary source gives North America median conversion as 2.6%, Western Europe 2.0% and IN/SEA 1.4%. The two sources conflict, possibly because they use different metric definitions — [Data Analysis Journal / search snippet](https://dataanalysis.substack.com/p/2026-benchmarks-more-apps-less-quality)

**Trials**
- SOSA 2026 trial-to-paid: 17-32 day trials median 42.5% vs trials of 4 days or less 25.5% (about 70% better). Yet 46.5% of apps use trials of 4 days or less, up from 42.1% — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- SOSA 2026: 55% of 3-day-trial cancellations happen on Day 0. Day-0 cancellation rate is 39.8% for 7-day trials, 35.7% for 14-day trials and 31% for 30-day trials — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth)
- SOSA 2025: 17-32 day trials median 45.7% vs about 26.8% for short trials. Trial-to-paid is 47.8% for low-priced apps vs 28.4% for high-priced apps — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Adapty 2026 (secondary write-up): 12-month LTV is $54.50 for a weekly plan with a trial vs $7.40 for a weekly plan without one — [Adapty 2026 coverage via search snippet, ppc.land](https://ppc.land/95-of-app-subscription-revenue-goes-to-top-10-adaptys-2026-benchmark-report/)
- Adapty 2025: adding a trial to a weekly plan raises day-30 retention from 23% to 42% — [Adapty 2025 summary](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)

**Retention by plan length**
- SOSA 2025 year-1 retention: yearly 44.1% (down from 47.1%), monthly 17.0%, weekly 3.4%. First-renewal churn is 30-50% for weekly plans and 15-40% for monthly plans. Annual first renewal is 61.7% — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- SOSA 2025: low-priced yearly plans retain 53.7% vs 48.3% for high-priced plans. Low-priced monthly plans retain 22.5% vs 12.2% for high-priced plans — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- SOSA 2026: about 72% of annual subscribers cancel (turn off auto-renew) in year 1, up from about 56%. 35% of annual cancellations happen in month 1 — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- Adapty 2025: 65% of weekly subscribers cancel within 30 days and 5% are still active at one year. For monthly plans, 43% are retained at day 90 and 17% at one year — [Adapty 2025 summary](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)
- Involuntary churn (billing failures): 31% of cancellations on Google Play and 14% on the App Store (SOSA 2026) — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)

**Prices and plan mix**
- SOSA 2026: median annual price is $34.80, up from $31.60. Common price bands are $4.99-$6.99 weekly, $7.99-$9.99 monthly and $29.99-$39.99 annually — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth). SOSA 2025 median subscription price: $29.99 — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Adapty 2025 average prices (US): weekly $8.1, monthly $15.2, annual $44.6. In Utilities and Photo & Video, annual costs about 6x weekly — [Adapty 2025 summary](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)
- Adapty 2025: weekly plans earn over 50% of revenue in Productivity, Utilities and Photo & Video. 12-month LTV for weekly plans is $58.4 in Utilities and $53.2 in Productivity. Annual-plan LTV in Photo & Video is $42.4. One-time purchases are up 6% — [Adapty 2025 summary](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)
- SOSA 2026 by price tier: realized year-1 LTV per payer is $62.19 for high-priced apps vs $10.69 for low-priced apps. Download-to-trial is 8.9% vs 4.4% — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth)
- Refunds (Adapty 2025): annual plans 4.2% (highest) and weekly plans 2.6% — [Adapty 2025 summary](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)

**Category outcomes and long tail**
- SOSA 2025: Photo & Video has the highest share of new apps reaching $1k (27.57%) and $10k (8.75%) monthly revenue within two years. The all-app figures are about 20% and 5% — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- SOSA 2026: 17.3% of new apps reach $1k MRR within two years and 4.6% reach $10k MRR. The median app's MRR growth is 5.3% — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth)
- SOSA 2025 revenue per install at Day 60: overall median $0.31. App Store median $0.38 vs Google Play $0.14 — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- SOSA 2026 web purchases: web makes up 3.2% of revenue globally and 4.9% in North America. 41% of the largest apps use web purchases vs 1.3% of the smallest — [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth)

**Superwall**
- Superwall's own pages carry only anecdotal testimonials, with no sample sizes or methods. One customer says adding an annual plan at a 60% discount next to the monthly plan raised proceeds per user by 80% and trial conversion by 22%. Another says showing 3 plan durations instead of 2 "significantly increased conversion" — [Superwall, existing apps](https://superwall.com/solutions/by-stage/existing-apps)

### Inferences
- The hard-paywall vs freemium gap, about 10-12% vs about 2%, comes from apps used daily or habitually. For an episodic tool, the "aha" moment (the solver finding a piece) is the best moment to convert. That favours a gate shown right after first value, such as one free puzzle or a few free piece matches, over a gate before any use.
- Weekly plans dominate Utilities revenue on mobile, but they retain at 3-6% after 12 months and are associated with aggressive app-store tactics. A puzzle-length "pass" (one week or one month, non-renewing) fits the episodic usage much better and avoids renewal resentment.
- Puzzle Solver is a web PWA, so app-store benchmarks are an upper bound. Web checkout (Stripe, Paddle, Lemon Squeezy) adds friction, and web purchases are only 3-5% of revenue even for apps that offer them. On the other hand, web checkout avoids the 15-30% store commission.
- Year-1 LTV for low-priced apps is about $8-11 per payer (SOSA 2025/2026). That is roughly what a $5-10 one-time unlock would capture from an episodic user, so a subscription may not out-earn a one-time unlock in this niche.

### Gaps
- I could not get exact SOSA 2025/2026 medians for the Utilities and Productivity categories (download-to-paid, price). They are in the full PDF, which is behind a form.
- Superwall publishes no quantitative benchmark report that I could find.
- No benchmark covers PWAs or web-only apps specifically.

## 2. Subscriptions vs one-time purchases for low-frequency / episodic utilities; subscription fatigue; hybrid models; indie case studies

### Takeaway
Subscription fatigue is well documented for streaming. For apps, the hard data is weaker: one-time purchases are growing modestly (+6% per Adapty), but weekly subscriptions are still taking share. Lifetime options next to subscriptions are common (35%+ of apps run hybrid models), and indie anecdotes say most paying users of small utilities pick yearly or lifetime when offered. I found no rigorous public before/after revenue numbers for well-known switchers (Halide, Darkroom, Bear, Fantastical and others).

### Cited Findings
- Subscription fatigue (streaming): 41% of streaming subscribers have cancelled at least one service due to fatigue (CivicScience). 37% of young US subscribers have done so — [eMarketer](https://www.emarketer.com/content/subscriptions-edge-ownership-across-media-software-hardware); [Subscription Insider on Medium](https://medium.com/@subscriptioninsider/subscription-fatigue-is-real-heres-what-the-data-shows-9fa40d32087e). Deloitte 2025 Digital Media Trends: 41% say streaming content isn't worth the price (secondary citation) — [Subscription Insider on Medium](https://medium.com/@subscriptioninsider/subscription-fatigue-is-real-heres-what-the-data-shows-9fa40d32087e)
- Adapty: one-time purchases are up 6%. Weekly plans grew from 23% to 46% of plans between 2022 and 2025. Recurring billing in apps is still growing despite "fatigue" — [Adapty, subscription trends](https://adapty.io/blog/9-subscription-trends-dominating-2025/)
- RevenueCat SOSA 2025: 35%+ of apps mix subscriptions with consumables or lifetime purchases (Gaming 61.7%) — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Halide (Lux): built its reputation on a roughly $6 one-time purchase. Mark II (2020) moved to $11.99/yr with a $36 lifetime option alongside, and early adopters kept $9.99/yr. Lux says it keeps a one-time option and uses the subscription to fund continuous updates. No revenue split is published — [AppleInsider forum on Halide Mark II](https://forums.appleinsider.com/discussion/218376); [Lux: Why is Halide not free?](https://www.lux.camera/why-is-halide-not-free/)
- Overcast (Marco Arment): earned $70,343 from Apple in 2014 under freemium with a $5 IAP, after about 15 months of full-time work. In 2015 it switched to "patronage" ($1/month, non-recurring) — [Six Colors](https://sixcolors.com/link/2015/01/overcasts-2014-sales-numbers/); [roopc.net analysis](https://roopc.net/posts/2015/overcast-business-model/); [Macworld](https://www.macworld.com/article/226680/its-a-rare-developer-who-relies-on-patronage.html). Arment later moved Overcast to ads plus a premium subscription, but I did not re-verify the current model in this session.
- David Smith (Widgetsmith dev, 2016): his income shifted from paid apps to "almost all ad-based". Paid apps became "a vanishingly small proportion of my income" — [Loop Insight](https://loopinsight.com/2016/09/06/david-smith-on-the-shifting-app-store-business-model). He later moved Widgetsmith to subscription (via RevenueCat) and charges for features with ongoing data costs (weather, tides) — [RevenueCat Widgetsmith case study](https://www.revenuecat.com/customers/widgetsmith); [Founder Playbook summary](https://www.betterlaunch.co/playbooks/episodes/david-smith-widgetsmith)
- Indie dev diary (Itemlist): priced at $2.99/mo, $19.99/yr and $59.99 lifetime. "Most paid users choose yearly or lifetime option", so MRR growth is low and lifetime buyers dilute recurring revenue — [dabo.dev](https://dabo.dev/revealing-my-revenue-metrics)
- Rule of thumb for lifetime pricing: 3-5x the annual price, to avoid cannibalising loyal subscribers. This is advice, not measured — [PricePush glossary](https://pricepush.app/glossary/lifetime-purchase); 3-4x per [AppOpportunity](https://appopportunity.com/blog/indie-app-revenue-models-2026)
- Indie Hackers anecdote: a team selling one-time licences added paid "lifetime updates" (an annual upgrade fee) and says this nearly doubled the LTV of one-time buyers. Self-reported — [Indie Hackers](https://www.indiehackers.com/post/subscriptions-vs-one-time-payments-a-developers-honest-take-f153e48960)
- A 2026 indie developer post argues for one-time IAP over subscription across 4 utility apps. It is a modelled comparison, not measured — [DEV Community](https://dev.to/snake_sun/why-i-picked-one-time-iap-over-subscription-for-4-indie-ios-apps-storekit-2-2026-data-1nk6)
- Commission note: Apple charges 30% on one-time IAP and 15% on subscriptions after year 1. The Small Business Program rate of 15% applies to all IAP for developers under $1M — [Airbridge](https://www.airbridge.io/en/blog/subscription-vs-one-time-purchase-app). Not relevant to a web-only PWA that uses its own checkout.

### Inferences
- For an episodic tool with no server costs, the usual argument for subscriptions (funding ongoing costs) is weak, and users are likely to see a renewing charge for a tool they use for two weeks a year as unfair. A one-time unlock, optionally with a cheap time-limited pass, fits both the usage pattern and the "no server costs, privacy-first" message.
- If a subscription is offered at all, it should sit as the cheaper-per-period option next to a prominent lifetime unlock. Low-priced annual plans retain better (53.7% year 1), but episodic users will likely forget the app between puzzles and churn at renewal.

### Gaps
- I found no published before/after revenue figures for Darkroom, Bear, Fantastical, Pixelmator or Apollo (Apollo shut down in 2023 over Reddit API pricing, not because of its monetization model). I found no reliable 2024-2026 consumer survey measuring app-specific (non-streaming) preference for one-time vs subscription.
- I found no data on the lifetime plan's share of revenue in the RevenueCat or Adapty public summaries.

## 3. Consumable / credit / pay-per-use models

### Takeaway
Consumables are mostly used as a hybrid layer on top of subscriptions (about 12.5% of AI apps combine the two). I found no rigorous public conversion benchmark for "pay per project" or credits in scanner or photo utilities.

### Cited Findings
- RevenueCat SOSA 2026: AI apps are about 67.7% subscription-only and about 12.5% subscription plus consumables, leading other categories in consumable hybrids by about 2.5 points (secondary summary) — [search snippet of RevenueCat SOSA 2026](https://www.revenuecat.com/state-of-subscription-apps)
- Hybrid credit pattern: a subscription covers base access and consumable credits cover heavy usage. One source suggests a 75/25 subscription/usage split, without naming its underlying research — [Fluxsy](https://fluxsy.io/resource/blogs/app-in-app-purchase-subscription-ltv)
- Claim that consumables add 20-30% ARPU by charging heavy users. This is an unsourced vendor claim — [DEV Community, PaywallPro](https://dev.to/paywallpro/global-subscription-app-conversion-benchmarks-3c75)
- Implementation caveat: an app's credit product was rejected by Apple review until it was reclassified. The IAP type matters — [Medium](https://medium.com/@ishay_13213/consumable-vs-auto-renewable-subscription-in-apples-in-app-purchases-ec04250051dd)

### Inferences
- Puzzle Solver's natural unit of value is "one puzzle". A per-puzzle unlock (for example $1.99-$2.99 per puzzle, or a 3-puzzle pack) matches the episodic pattern and can sit next to a lifetime unlock that acts as the anchor. On the web, no store review limits what kind of purchase this can be.
- Because the app has no server costs, metered credits ("scans" or "pieces") would feel artificial and may hurt goodwill. A per-puzzle or time-pass unit is easier to explain.

### Gaps
- I found no published conversion data for per-project or per-use unlocks in scanner or photo utilities (Adobe Scan, CamScanner, Remini and similar).

## 4. Ads: eCPM/RPM and whether ads are worth it at small scale

### Takeaway
Ad revenue for a niche hobby web tool is tiny. Hobby-site AdSense RPMs are typically about $0.40-$5 per 1,000 pageviews, and banners earn about $0.4-$1.5 eCPM in tier-1 markets. A tool used in long sessions on a single page generates few pageviews, and ads would undermine the "privacy-first" positioning.

### Cited Findings
- AdSense page RPM for gaming, general and hobby sites: typically $0.40-$5. Example: an indoor-plants hobby blog earns about $0.80 per 1,000 pageviews vs about $18 for a personal-finance site. New sites on plain AdSense with mixed geography usually earn $1-5 RPM. These are operator surveys, not audited data — [AppAdRevenue guide (2026)](https://www.appadrevenue.com/guides/how-much-do-websites-earn); [Techconda (2026)](https://www.techconda.com/2026/02/adsense-rpm-benchmarks.html)
- Ad blockers: an estimated 20-35% of desktop pageviews in tech-savvy niches never show ads. Google retired AdSense session metrics from September 2025 — [search summary of Techconda / MonetizationGuy](https://monetizationguy.com/minis/so-what-exactly-is-session-rpm)
- Mobile eCPMs (US): rewarded video about $12-14 (Appodeal, 2021-22 data). Interstitial about $9.6-11 (2021-22), and about $19.6 per Tenjin Q1 2024. Banner about $0.4-0.5 (Appodeal Q4 2024 North America) or $0.5-1.5 tier-1 (2025 summary). These come from game-heavy datasets — [Appodeal eCPM report](https://appodeal.com/blog/mobile-ecpm-report-app-ad-monetization-worldwide-performance); [Udonis](https://blog.udonis.co/mobile-marketing/mobile-apps/ecpms); [PlayIO 2026](https://blog.playio.co/mobile-game-ecpm-benchmarks-2026)
- David Smith's 2016 portfolio became "almost all ad-based" when he had millions of free downloads. Ads worked at very high volume, and he later moved Widgetsmith to subscriptions — [Loop Insight](https://loopinsight.com/2016/09/06/david-smith-on-the-shifting-app-store-business-model)

### Inferences
- Illustrative arithmetic, not a sourced figure: 10,000 monthly users × about 5 pageviews each × $2 RPM ≈ $100/month. The same 10,000 users at a 2% conversion × $5 one-time ≈ $1,000. At small scale, ads earn an order of magnitude less than even a weak paid conversion, and third-party ad scripts contradict the "privacy-first, on-device" pitch.
- Rewarded ads ("watch an ad to unlock this puzzle") earn the highest eCPMs, but they need an ad SDK that a PWA cannot easily use. Web rewarded-ad options exist but are niche.

### Gaps
- I found no 2025-2026 audited AdMob eCPM benchmark for non-game utility apps, and no quantitative study of how ads affect ratings or retention for utility apps.

## 5. Donations / tip jars / pay what you want

### Takeaway
Tip jars convert very poorly without an existing audience. Anecdotes show tip rates well under 0.1% of users. Pay-what-you-want raises the share of people who buy but sharply lowers the average price, unless it is tied to a cause.

### Cited Findings
- Indie anecdote: a tip jar in an app with 20k downloads and good reviews brought 3 tips in a month (about 0.015%). The developer's view was that tip jars only work with outside brand recognition — [Convopage thread (@JPEGuin)](https://convopage.com/c/1269349151483011072)
- Buy Me a Coffee anecdote: a creator's conversion rate was 1/4206 visitors ≈ 0.023% — [Indie Hackers](https://www.indiehackers.com/post/1-4206-conversion-rate-on-buy-me-a-coffee-1ed21a2288)
- Aggregated tipping statistics (unverified, no methodology): about $620M a year across about 2.8M creators; only 21% of creators get monthly tips; 18.5% of tippers become monthly members — [VoxBooster 2026](https://voxbooster.com/blog/digital-tipping-creator-statistics-2026). Treat as low reliability.
- Overcast 2015 patronage ($1/month, optional): Arment reportedly estimated about 5% of users would need to pay to match prior revenue. This is a secondhand estimate, not a reported result — [roopc.net](https://roopc.net/posts/2015/overcast-business-model/); [Macworld](https://www.macworld.com/article/226680/its-a-rare-developer-who-relies-on-patronage.html)
- Gneezy et al. (Science, 2010), theme-park photo field experiment: at a fixed $12.95 price, 0.5% bought. Under pay-what-you-want, 8.39% bought but paid only about $0.92 on average. PWYW with half of revenue going to charity produced the highest profit — [Freakonomics summary](https://freakonomics.com/2010/07/how-to-maximize-pay-what-you-wish-pricing); [Wikipedia: Ayelet Gneezy](https://en.wikipedia.org/wiki/Ayelet_Gneezy)
- Gneezy et al. (PNAS, 2012): when people can name their own price, fewer of them buy than at a fixed low price, because paying "too little" hurts self-image — [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3358869)

### Inferences
- A tip jar can be an extra after a successful puzzle ("Finished! Buy me a coffee"), but it should not be the main model. At about 0.02-0.1% conversion, 10k users yield single-digit tips per month.
- PWYW with a suggested default price and a minimum (a "pay what you want, $3 minimum, $6 suggested" unlock) is a reasonable goodwill play for a hobby audience. The PNAS result suggests a fixed low price may sell to more people than open PWYW.

### Gaps
- I found no first-party conversion data from Ko-fi, Buy Me a Coffee or GitHub Sponsors. I found no current numbers for in-app tip jars in apps like Pocket Casts or Overcast.

## 6. Pricing psychology: anchoring, decoys, regional pricing, trial length, intro offers; willingness to pay of hobbyist / puzzle demographic

### Takeaway
Several findings point the same way: longer trials convert better (42.5% vs 25.5%), an annual or lifetime anchor next to a short plan raises conversion and revenue per user, and regional pricing roughly halves prices in lower-income markets. Data on what the puzzle demographic will pay for apps is essentially absent. Demographic data itself is mixed: buyers skew female, but frequent puzzlers skew younger and male in one Ipsos survey.

### Cited Findings
- Trial length: 17-32 day trials have a median trial-to-paid of 42.5% vs 25.5% for trials of 4 days or less (SOSA 2026). The 2025 figures were 45.7% vs about 26.8% — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026); [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Anchoring and decoy: a Superwall customer reports that adding a 60%-discounted annual plan next to monthly raised proceeds per user by 80% and trial conversion by 22%. Testing 3 plan durations instead of 2 raised conversion. Both are anecdotal — [Superwall](https://superwall.com/solutions/by-stage/existing-apps)
- Advice to price lifetime at 3-4x annual so the subscription looks cheap. This is advice, not a test result — [AppOpportunity](https://appopportunity.com/blog/indie-app-revenue-models-2026)
- Price level: high-priced apps get higher download-to-trial (8.9% vs 4.4%) and much higher year-1 LTV ($62.19 vs $10.69). Low-priced apps get higher trial-to-paid (47.8% vs 28.4%, 2025) and better retention — [SaaStr summary of SOSA 2026](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth); [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Regional pricing: annual price is $39.99 in North America vs $18.32 in IN/SEA (SOSA 2026). Adapty 2025: weekly price in the Netherlands is 62% above the US, Turkey is about 3.5x lower, and country gaps are typically 2-3x — [SaaStr](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth); [Adapty 2025](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)
- Price trends (Adapty 2025): weekly prices rose 12.5% in the US and 12.2% in Europe. Annual prices were mostly stable — [Adapty 2025](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)
- Puzzle demographics (Ipsos for Ravensburger, US, 2018 survey published 2019): nearly half of US adults do a jigsaw at least once a year and about 1 in 5 monthly or more. Men are more likely than women to puzzle monthly (24% vs 14%), and so are 18-34s (34%) vs 55+ (10%). Relaxation and fun are the main motives, especially for women and older adults — [Ipsos](https://www.ipsos.com/en-us/node/478706); [Ipsos PDF](https://www.ipsos.com/sites/default/files/ct/news/documents/2019-01/ravensburger-2018-puzzle-survey-pr-01-03-2019.pdf)
- Aggregator (unverified, attributed to Statista): women are 62% of puzzle purchasers globally, and 45% of US puzzle buyers are 35-54 (2023) — [Gitnux](https://gitnux.org/puzzle-industry-statistics/)

### Inferences
- The assumption that the audience is "older, mostly female" is only partly supported. Buyers may skew female, but the most frequent puzzlers in the Ipsos sample skewed younger and male. The paywall copy and price should not assume a single persona.
- Physical jigsaws commonly retail around $15-30 (general knowledge, not sourced here). Anchoring an app unlock against the price of the puzzle itself ("less than a third of the price of your puzzle") is a plausible framing to test.
- Because usage is episodic, a long free window covering one whole puzzle is the episodic version of the "long trial converts better" finding: the user finishes a puzzle with the tool's help and then pays to keep using it.

### Gaps
- I found no data on how much puzzle hobbyists, or older and female app users in general, are willing to pay for apps. No study on intro-offer effects (pay-up-front discounts) for utilities came up in this session.

## 7. Free trial vs free tier with usage limits for a session-based utility

### Takeaway
Freemium converts about 2% of downloads, while a gate after a small free allowance (closer to a hard paywall) converts about 5x better. Trials raise LTV but not necessarily early conversion. Long trials convert best. No source tests this directly for episodic tools, but the evidence favours a free allowance measured in value (for example one complete puzzle, or N piece matches) over a time-based trial, because a calendar trial can expire before the user starts the next puzzle.

### Cited Findings
- Freemium download-to-paid median about 2.1-2.2% vs hard paywall 10.7-12.1% (SOSA 2025/2026). Retention among annual payers is the same under both models (27-28%) — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026); [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)
- Direct paywalls (no trial) convert better than trials in most categories, but trial users have up to 64% higher LTV — [Adapty 2025](https://adapty.io/blog/state-of-in-app-subscriptions-2025-in-10-minutes/)
- Trial cancellations happen almost immediately: 55% of 3-day-trial cancellations occur on Day 0, and 84% occur on Day 0-1 — [RevenueCat blog 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)
- RevenueCat recommends A/B testing whether to offer free trials at all, rather than assuming they help — [RevenueCat blog](https://www.revenuecat.com/blog/growth/should-your-app-stop-offering-free-trials)
- Hard-paywall refund rate (5.8%) is higher than freemium (3.4%). Gating too early creates regret — [RevenueCat SOSA 2025](https://www.revenuecat.com/state-of-subscription-apps-2025)

### Inferences
- Recommended structure for Puzzle Solver, based on the evidence above: (a) a free tier that is fully usable for a first puzzle, or a small piece-match quota per puzzle, so the "aha" moment happens; (b) a paywall shown at the moment of peak value; (c) a one-time lifetime unlock as the anchor (illustratively $9.99-$14.99) plus a cheap non-renewing per-puzzle or 30-day pass (illustratively $2.99-$4.99); (d) an optional "tip" after completion. These price points are inferences from the SOSA low-price LTV figures ($8-11 per payer per year) and the lifetime rule of thumb of 3-5x annual, not tested values.
- A web PWA has no app-store trial machinery, and a card-required trial would add friction and conflict with privacy expectations. A usage-based free tier is the simpler, more goodwill-friendly option.

### Gaps
- I found no controlled study comparing time-limited trials with usage-limited free tiers for episodic or project-based tools. The decision should be validated with the developer's own A/B tests.
