# Community Sentiment: What Jigsaw Puzzlers Say About Piece-Finder Apps and Getting Help (Voice of the Customer)

Access note (researched 2026-10-22): reddit.com, www.reddit.com/.json, api.reddit.com, old.reddit.com, the Reddit RSS feed, PullPush, Arctic Shift and the Wayback Machine were all blocked or rate-limited (403/429/500/connection reset). The WebSearch tool refuses the reddit.com domain. Most Redlib mirrors were behind bot walls, but one, **snoo.habedieeh.re**, worked, so all Reddit quotes below were read through it. Citations use the canonical reddit.com URL. Scores are Reddit points as the mirror showed them on 2026-10-22. YouTube data came from YouTube's public innertube API, Play Store reviews from Google Play's public review endpoint, and App Store data from the iTunes lookup API. TikTok search renders only client-side, so no data could be pulled from it.

## 1. Threads about apps that show where a piece goes, reactions to specific apps, and using ChatGPT/Gemini/AI to place pieces

### Takeaway
People do ask for an app that shows where a piece goes, and have done so for years. The askers are usually stuck on a hard puzzle and tend to be younger or more technical. In r/Jigsawpuzzles, the largest community of hobbyists, the response to a "helper app" pitch is mostly cool or hostile: "the process is the point." Placement accuracy is the main complaint in reviews of the existing piece finders. Generic chatbots (ChatGPT, Gemini) get poor reports when used on physical pieces.

### Cited Findings
**Demand signals ("is there an app…")**
- r/Jigsawpuzzles, "Puzzle solver/helper programs?" (Apr 24 2024, 1 pt): "After a few casual 500-1000 piece puzzles I got a challenge puzzle and I am really stuck with it. Are there any apps/software that could help?" The top reply (11 pts): "I don't know of any AI or other applications for solving jigsaw puzzles." A 2025 commenter (in French) said Gemini "ne sait résoudre que des puzzle de moins de 20 pieces et avec beaucoup d'erreur" ("can only solve puzzles of under 20 pieces, with many errors"). — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ccb0di/puzzle_solverhelper_programs/)
- The same thread has since become the launch thread for the two hobbyist competitors:
  - u/Several-Tangerine616 (Jan 29 2026) promoted the Android app **Puzzle Finder** (`www.ly.puzzlefinder`): "free, and ad-free… You take a picture of the box, then a coin [piece], and the image recognition suggests placement options. It doesn't work on single-color coins." In January 2026 they also wrote (in French) "j'ai voulu tricher, je sais c'est mal!" ("I wanted to cheat, I know it's bad!").
  - u/Bawbicus (Oct 17 2026), who disclosed being the **Puzzle Pointer** (iPhone) developer, posted because "the thread still ranks on Google for 'puzzle solver app'". They described the app this way: "it marks the area of the picture to look at. You still place the piece… it matches the picture, not the shape. So it's good on something like the stormtroopers box… and not great on Krypt, gradients, or anything single-colour." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ccb0di/puzzle_solverhelper_programs/)
  - The original poster (u/alparius, Jan 29 2026) said they had "ended up implementing the same thing in a python notebook with opencv". — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ccb0di/puzzle_solverhelper_programs/)
- Hacker News, u/memco, on the Brickit LEGO-scanner thread (2022-09-11): "I'm working on a jigsaw puzzle and hit a bit of a dry spell and was hoping there might be an app that could help find the pieces in a pile and where they go. Nothing exists yet that I could see. I imagine with a completed picture and a view of a piece it would be possible to show where in the picture the piece goes… Extra p[o]ints if you can give it a view of the current progress and it could show you where the pieces should go." — [HN Algolia API, story 32796324](https://hn.algolia.com/api/v1/search?query=jigsaw%20app%20piece%20goes&tags=comment)
- HN, "Jigsolved: Computer Vision to Solve Jigsaw Puzzles" (2018-08-13, 49 points, 13 comments):
  - u/petters: "Does not really solve puzzles. Just locates a single piece with sift."
  - u/kjeetgill replied: "it's like 70% of it, right? Especially if the goal was just to build a human aide."
  - u/Someone: "[I] am still looking for the smartphone app that does this." — [HN](https://news.ycombinator.com/item?id=17750335)
- YouTube, "Jig Sawlver – iOS Puzzle Solving App" (TheDuckCow, Jun 24 2015, 36,349 views), a university project that never shipped. Its comments are a long tail of unmet demand:
  - "Anyone find an actual APP available like this???????" (8 likes, ~5 years ago)
  - "I would buy this app. Would this work on iOS phone app?" (~4 years ago)
  - "would this work on a 9000 piece puzzle :D" (4 likes)
  - "Can this thing work on a 3000 piece puzzle?"
  - "I can't find it on the App Store" (~1 year ago)
  - "Please tell me your gonna lanch it!" (~2 years ago)
  - One feature request: "once the program has identified all the pieces and where they go to start with one piece by blinking that piece… so the puzzle person can find it." — [YouTube](https://www.youtube.com/watch?v=MZIAz_6t6xA)

**The hobbyist community's reaction to a helper app**
- r/Jigsawpuzzles, "Is there any market for a jigsaw helper app?" (Aug 9 2026, **0 points**). The developer pitched an AR app to find edges and corners, help colour-blind users and "point out where a piece could potentially fit". Replies:
  - u/malachopter (12 pts): "I feel like having ai solve jigsaw puzzles defeats the entire purpose of jigsaw puzzles… The people that enjoy jigsaw puzzles enjoy the challenge which is defeated by this kind of app."
  - u/elanlei (7): "For most of us doing the puzzle is the fun bit, not having a completed piece. I don't see any need to speed up the process."
  - u/lemeneurdeloups (6): "I am not looking for any app that would hurry the journey along to a destination; the Journey is the Whole Point."
  - u/wharleeprof (6): "That's a firm No thank you. I do puzzles because they are low tech, no screens. If/when puzzling becomes too challenging for me, I'll start doing lower piece counts… Otoh, if you could create an alarm that sounds every time a piece falls on the floor… I'll buy that in a heartbeat."
  - u/PuzzleAndTea (5): "I use jigsaw puzzles as an analogue hobby… an app seems like something that would interfere with my hobby rather than improving it."
  - u/LilannaLiola (2) gave the only use case anyone suggested: "for resellers or 2nd hand shops. They could scan the pieces… and quickly see if there are pieces missing. I don't think anyone who puzzles as a hobby would find this useful." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1vjgfnm/is_there_any_market_for_a_jigsaw_helper_app/)
- r/Jigsawpuzzles moderators, "Update to Rule 3, Promotions: No more digital puzzle building apps or games" (Sep 15 2026, **368 pts**): "You as a community have overwhelmingly voted them down… we have expanded rule three to ban promotion of apps and games where you build jigsaw puzzles. Apps that help with databasing and puzzle tracking have been well received so those may continue to be promoted."
  - Top comment (79 pts): "Why would you want to put together a puzzle digitally? I use puzzles to get off my phone."
  - (The rule covers digital jigsaw games. Whether physical-puzzle helper apps fall under it is not stated.) — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1whajcu/update_to_rule_3_promotions_no_more_digital/)
- r/Jigsawpuzzles, "Is there any actual way to 'cheat' in puzzling?" (Dec 2 2025). u/wintermute93 (2 pts): "If you have a high resolution image of the completed puzzle, it wouldn't be that hard to write a script that took in a photo of a random piece and spat out a heatmap of where it was most likely to fit… Looking at the completed puzzle image and carefully searching it for matching details? Totally cool. Asking a friend who's really good at puzzles to do that for you? Okay, I guess. Asking a computer vision library to do that? Over the line, that's a foul. Mark it zero." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1pbvdqf/is_there_any_actual_way_to_cheat_in_puzzling/)

**ChatGPT / general AI for physical pieces**
- r/Jigsawpuzzles, "LPT Confession – Used AI to help locate pieces" (Mar 31 2026, 0 pts). The poster: "Slow but also helpful for a piece I could not locate (I just took a picture of the board and asked AI for help." The only reply: "I tried it once. It was completely inaccurate and unhelpful." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1s91bos/lpt_confession_used_ai_to_help_locate_pieces/)
- YouTube, "Putting AI to the test – Episode 4 | Can AI solve a jigsaw?" (Tomorrow, Unfolded, Sep 29 2026, 33 views). Digital square-tile test only: "ChatGPT matched 9/9 and 64/64 original tile positions. Grok matched 4/9 and 1/64. Gemini returned no solution… and an error." This is not a test on physical pieces. — [YouTube](https://www.youtube.com/watch?v=NrcLRd1nTaY)
- A custom GPT called "Jigsaw Genius" invites users to share a photo of a puzzle in progress for hints. Its accuracy and usage were not verified. — [ChatGPT GPT store](https://chatgpt.com/g/g-49MNsW3Gg-jigsaw-genius)

**User reviews of the named competitors (2026)**
- **Jigsaw Puzzle Solver (Solver Works, Android).** 2.8★, 50 reviews, 5K+ downloads, "Contains ads" label (but the developer replied "The app is currently free, has no ads, and needs no registration"). Last updated Oct 21 2026. All 15 reviews returned by Play:
  - 5★ Jan 19 2026: "It is a great help! It makes me able to enjoy the puzzle more."
  - 5★ May 25 2026: "Works surprisingly well. Positions are not 100% accurate but the region is most of the time correct."
  - 5★ Apr 9 2026: "It even helped me find some pieces, but I still wouldn't say it works perfectly on detailed puzzles. A good feature is that it shows the percentage on the left."
  - 5★ Sep 1 2026: "Lifesaver for a really complex puzzle."
  - 3★ May 25 2026: "you… should give the user the ability to tell the app when it's wrong so it can keep trying… Currently it is less than 25% correct." The developer replied: "A 'try again' function is a nice idea; we actually hadn't thought about that yet."
  - 3★ Apr 15 2026: "the first piece worked perfectly, but every single piece after failed. Seems to have a 5% success rate."
  - 1★ Apr 25 2026: "Not even close."
  - 1★ Mar 17 2026: "unable to detect basic shapes chooses… an empty spot on the border… does not give you the option to train the AI."
  - 1★ Jan 24 2026: "app keeps crashing when trying to recognise piece."
  - 1★ Aug 1 2026: "scam doesn't work."
  - Caution: one 5★ reviewer, "Ronald van Immerzeel", shares a surname with the listed developer, Michiel van Immerzeel. — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
- **Puzzle Finder (LY4Dev, Android).** 5K+ downloads. Listed as offline OpenCV, "No ads, no tracking". Reviews:
  - 5★ Aug 20 2026: "I cannot believe this app is a real jigsaw solver. but it genuinely guessed correctly the position of two pieces… of 1500 pieces from a complete grayscale puzzle."
  - 4★ Jul 20 2026: "works pretty well but on my more detailed puzzles it sometimes guesses completely wrong… on pieces with very little detail and colour."
  - 1★ Aug 28 2026: "not even close then the app makes it seem like its your fault it couldnt figure out where the piece goes."
  - 1★ Jun 19 2026: "it scan the piece and put in the rong spot."
  - The developer replied (in French) that routing images through a vision AI "a un coût" (costs money) and that they prefer to keep the app "local et gratuite" (local and free). — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US)
- **Puzzle Pointer (iOS, Bobby Landerman).** Released Sep 23 2026. Free, 5.0 from 1 rating. Claims barcode lookup of "over 10,000 puzzles… from Ravensburger, Buffalo Games, Galison…". — [iTunes lookup](https://itunes.apple.com/lookup?id=6809997519&country=us)
- **PuzzleLens (iOS, Sep 23 2026)** and **Puzzle Detective: Piece Finder (iOS, Sep 14 2026).** Both have 0 ratings, so there is no review voice yet.
  - PuzzleLens's copy markets graded hints: "As much hint as you want, as little as you want… Ask for the region first, narrow it down, and only then ask for the exact cell and which way the piece turns." — [iTunes lookup PuzzleLens](https://itunes.apple.com/lookup?id=6812349555&country=us); [iTunes lookup Puzzle Detective](https://itunes.apple.com/lookup?id=6808541265&country=us)
- No Reddit mentions of PuzPal, PuzzleLens or Puzzle Detective were found in mirror searches of r/Jigsawpuzzles and all of Reddit. — [Reddit search via mirror](https://www.reddit.com/r/Jigsawpuzzles/search?q=PuzPal&restrict_sr=1)

### Inferences
- The core r/Jigsawpuzzles audience is not the right target, and promoting there is risky: pitches score 0 and digital jigsaw apps are already banned. The people who ask for help are stuck, frustrated solvers who search Google ("the thread still ranks on Google for 'puzzle solver app'"). That points to SEO and search-intent acquisition rather than community promotion.
- Placement accuracy on low-detail areas is the make-or-break review driver for every competitor. Users explicitly asked for "try again" / "tell the app when it's wrong" loops. A ranked list of candidates with rotation, plus a "not here, next guess" button, answers the most common 1–3★ complaint.
- Puzzle Pointer's copy ("You still place the piece") and PuzzleLens's ("as much hint as you want") show competitors already framing themselves as hints, not solvers, to defuse the cheating stigma.

### Gaps
- No upvote counts on Facebook group posts. Facebook was not accessible.
- No Reddit threads found reacting to PuzPal, PuzzleLens or Puzzle Detective by name. These apps are too new or too small.
- The question "is there an app that tells you where a puzzle piece goes" on r/AskReddit was not found via the mirror's search.

## 2. The cheating debate: how puzzlers view help, and who is OK with it

### Takeaway
For casual home puzzling, the overwhelming, heavily upvoted consensus is "there's no cheating; whatever brings you joy." Looking at the box, sorting, letter codes on the back, and using a photo of someone else's completed puzzle are all broadly accepted. People still feel guilt or ego about it ("I don't feel great about it"). A vocal minority draws the line at computer vision or AI specifically, because it removes the searching, which they see as the point. Accepted reasons for help: very hard images (sky, gradients, foil, galaxy, Starry Night), poor-quality or knock-off printing, elderly relatives, kids, developmental delay or disability, and simply wanting to finish.

### Cited Findings
- r/Jigsawpuzzles, "Is this cheating?" (May 31 2025, **798 pts**). A couple built a puzzle directly on a same-size poster. Top reply, u/BM-NS (**1,162 pts**): "No rules to puzzling. Whatever brings you joy." Second, u/Good-Avocado-495 (325): "There are really no rules about how to puzzle." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1kzy2vr/is_this_cheating/)
- r/Jigsawpuzzles, "Is it cheating to use the alphabet sorting?" (Feb 15 2026, 147–149 pts). The poster placed "maybe 50 pieces out of 1000" in two weeks, then sorted by the back letters "and now the puzzle is a breeeze!"
  - Top reply, u/redsowhat (**355 pts**): "There really is no such thing as cheating if you are doing a puzzle for your own enjoyment… (unless you are at a competition, of course)."
  - u/JohnMulder (16): "a holographic/foil finish… made every piece look essentially the same. After months… I looked up a photo of the finished product and individually found the shapes of which piece went where… No regrets."
  - u/12thMemory (42): "I have 100% used them when the situation called for it; like when I did a sky full of nearly shadeless yellow pieces."
  - The poster: "I think ego came into play when I had to use the back of the puzzle!" — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1r5n5cj/is_it_cheating_to_use_the_alphabet_sorting/)
- r/Jigsawpuzzles, "Today I 'cheated' to complete this puzzle" (Mar 27 2026, 230–234 pts). The poster: "I really struggled with the sky… I just wasn't having fun anymore. So I found a picture of someone else who had completed the same puzzle… I used the photo to help narrow down what shape I was looking for… Now it's completed and I dont feel great about it." Later: "For whatever reason I feel guilty when I do it, or that I'm not a 'real puzzler'."
  - Replies: u/biancanevenc (57): "That's not cheating! That's smart puzzling!"; u/laura14472 (6): "Genius! Not cheating. It's a puzzling hack."; u/kkkhhjdyhrthhhjft (10): "the crypt puzzles come with a literal piece map." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1s58r08/today_i_cheated_to_complete_this_puzzle/)
- r/Jigsawpuzzles, "Letters on the back – Cheating, or fair play?" (Dec 30 2023, 173 pts):
  - u/gigibim (**186 pts**): "My grandma likes it because it makes them easier for her – she's 92 so otherwise the puzzle would be too hard to enjoy."
  - u/figoftheimagination (195): "there's no cheating in puzzling, as long as you're having fun."
  - u/CaptainJusticeOK (66): "Great for children. Not cheating, but would be unfulfilling for me."
  - u/pingyooo (51): "I did about 85% of it the normal way but the remaining pieces were all the same flat color so it was pretty much impossible to finish otherwise."
  - u/RockabillyPep (32), on Starry Night: "it could not be done without the letters."
  - A minority view, u/Puzzled-Bath-1173 (1): "Letters are so pointless and clearly for children struggling with an attention deficit." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/18upba8/letters_on_the_back_cheating_or_fair_play/)
- r/Jigsawpuzzles, "Do you consider looking at the puzzle picture… 'cheating'?" (Mar 11 2022, 219 pts). u/chalu-mo (185): "Nope. I always have the box just right beside me." A minority (64 pts, deleted user, quoted by u/Myrdrahl) compares looking at the box to "looking at the solution of a crossword or sudoku." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/tbyq3e/do_you_consider_looking_at_the_puzzle_picture/)
- r/Jigsawpuzzles, "Is there any actual way to 'cheat'…" (Dec 2 2025). Consensus: only false claims or competition rule-breaking count. u/BlueCyann (17): "the only way I could conceive of 'cheating'… would be to claim you'd done the puzzle when you actually hadn't." The only dissent singling out software is the u/wintermute93 "computer vision library… Over the line" comment quoted in Q1. — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1pbvdqf/is_there_any_actual_way_to_cheat_in_puzzling/)
- YouTube, "Cheating At Puzzles? Let's Settle This Debate Once And For All" (thepuzzlingcanadian, Apr 12 2026, 5,351 views):
  - "What happens between you and your puzzle is nobody's business but your own." (96 likes)
  - "How do you cheat in a solo hobby, that is usually done for relaxation?" (50)
  - "I have used the codes on the back of a puzzle once and it really helped me, I don't think I would have enjoyed making the puzzle without the codes." (14)
  - A galaxy-puzzle story: "I spent 7 hours on Saturday trying every piece 100 times and only put in 10 pieces. It was either put it back in the box or use the codes."
  - Seniors and space: "I buy them to do when I'm visiting my elderly mother… one section at a time… my puzzle doesn't take up too much space on her table."
  - A holdout: "I was tempted to use them at times, but I did not go there… I didn't want to 'cheat'." — [YouTube](https://www.youtube.com/watch?v=0Nf0qbiEP7A)
- YouTube, "people are CHEATING while doing jigsaw puzzles (drama)" (Zachary Michael Also, May 28 2026, 18,160 views). A commentary on a Facebook-group cheating debate. The video references a Facebook poll in which, per one commenter, "19% of respondents" took the hard-line view (poll itself not seen). Comments:
  - "Look at the box? Straight to jail. Don't ever look at the box? Believe it or not, straight to jail." (105 likes)
  - "facebook craft and hobby groups will have the MOST insane blow ups and drama" (29)
  - Disability and accommodation: "My daughter has shape coded puzzles due to her developmental delay. Love them." (32); "This is like calling when a teacher lets you have a 'cheat' sheet or open book test cheating… it's just a tool or help." (9)
  - "I am, unfortunately, in a facebook puzzle group… the most divisive one is whether or not you put the edge pieces into a separate bag." (12) — [YouTube](https://www.youtube.com/watch?v=dd5V_7BxLBg)
- YouTube, "Is this Cheating while Completing a Puzzle?" (Luisa Puzzles, Aug 1 2024): "Definitely not cheating – I think it's super handy if you get stuck, helping someone who is newer to puzzles"; "great for puzzling with kids"; "Use if you need it but at least try first." — [YouTube](https://www.youtube.com/watch?v=mc_kzv7Bmy0)
- Mumsnet AIBU, "To assume nice, normal reasonable people look at the box…" (Apr 17 2020, older):
  - Box-lookers dominate: "I definitely look at the box, I would be there for months otherwise (and have lost interest by then)!"
  - A minority: "Looking at the box is cheating and if you're going to look at the box what's the point in doing it!?"
  - The OP mentions a friend ran a Facebook poll (no tally shown). — [Mumsnet](https://www.mumsnet.com/talk/am_i_being_unreasonable/3883100-To-assume-nice-normal-reasonable-people-look-at-the-box-when-doing-a-jigsaw-puzzle)
- Puzzle maker Buffalo Games says "most jigsaw puzzle competitions allow competitors to look at the boxes". This is a vendor source. — [Buffalo Games blog](https://buffalogames.com/blog/is-it-cheating-to-look-at-the-puzzle-box/)

### Inferences
- The accepted mental model is a tool you choose to use when stuck, like back-letter codes, posters or Krypt piece maps. A full "solver" is not. Messaging that copies the language of the accepted tools ("a hint when you're stuck", "you still place the piece", "use it as much or as little as you want") rides an existing norm. "Solves your puzzle" invites the "defeats the purpose" reaction.
- The guilt is real even where peers forgive it ("I dont feel great about it", "ego came into play"). Product copy that gives permission (for example, "no puzzle police") and a graded-hint design that preserves the click of placing the piece could reduce that guilt.
- Segments with explicit peer permission: kids, seniors aged 90+, people with developmental delay or vision issues, plain or gradient or foil areas, poor-quality prints, and abandon-or-finish moments.

### Gaps
- No quantitative split for "is it cheating to use an app". The 19% Facebook-poll figure is second-hand from a YouTube comment and unverified.
- No direct quotes found from low-vision users about apps. The low-vision thread found (Jun 2026) recommends large pieces, lamps and magnifiers, not apps. — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1tvlqgu/eyesight_issues_recommended_puzzle_brands/)

## 3. Biggest pain points in physical puzzling, and which ones people would pay to solve

### Takeaway
The pain points that come up most are low-detail areas (sky, ocean, black space, white, gradients, foil) solved by "brute force", poor print quality or a box image that doesn't match the pieces, missing pieces, a lost box or reference image, lack of space and pets or kids, and large puzzles that stall and get abandoned. The only explicit "I'd buy that in a heartbeat" in hobbyist threads was for a lost-piece alarm. Missing-piece detection (resellers, thrifted puzzles) and missing-reference help (lost box) are gaps no app addresses.

### Cited Findings
- **Sky and plain areas.**
  - r/Jigsawpuzzles, "I own this piece for over 2 years now and the sky is all that's left. (For the past 6 months...)" (Mar 13 2025, 122 pts). Top reply (80): "Honestly? Just brute force it… It will take time and be boring." Others: "Always my go to with these Beelzebub areas. Trial and error." (13); "I had a puzzle with nothing but all white pieces left, easily 150 – 200 of them… Took a few hours for two or three days." Some enjoy it: "I actually love the brute force parts… No brain used." (7) — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ja80cd/ok_i_own_this_piece_for_over_2_years_now_and_the/)
  - Recent completed-post titles name the same thing: "Finished! 1000 pieces, the sky was not easy LOL!" (Oct 13 2026, 78 pts); "It was the sky for me that made it the most challenging" (Sep 11 2026). — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1x4yzby/finished_1000_pieces_the_sky_was_not_easy_lol/); [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1wdsvu2/photo_odyssey_eiffel_tower_in_paris_france_1000/)
  - Every competitor admits it cannot help here. Solver Works: "some areas, such as blue skies or areas with little detail, are harder to match". Puzzle Pointer: "not great on Krypt, gradients, or anything single-colour". — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US); [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ccb0di/puzzle_solverhelper_programs/)
- **Giving up and stalled puzzles.**
  - "My first time giving up on a puzzle" (Aug 7 2026, 132 pts): "it's been sitting here for weeks unfinished. It's hard and not fun… I really hate not finishing!!" — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1vi1rdi/my_first_time_giving_up_on_a_puzzle/)
  - "I'm so close to give up puzzling" (Jan 2 2026): "Even thinking about the current state of the puzzle stresses me out." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1q1xd3s/im_so_close_to_give_up_puzzling/)
  - Stained-glass puzzle: "In 2 weeks (1hr ish a day) I was able to place maybe 50 pieces out of 1000." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1r5n5cj/is_it_cheating_to_use_the_alphabet_sorting/)
- **Reference-image problems.** On the 798-pt thread:
  - u/guaiying (201): "at worst, no poster and the box-front picture is partly obscured by labels or branding!"
  - u/afaerber (70): "Ravensburger… the cover photo is always obscured by random crap… struggled with several areas because I couldn't see it on the cover."
  - u/Fussel-012 (172): posters are "significantly smaller, than the puzzle." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1kzy2vr/is_this_cheating/)
  - Secondhand Rosetta Stone puzzle (Jan 7 2026, 43 pts): "the pieces are significantly less clear than the photo on the box." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1q6tqtd/difficulty_with_rosetta_stone_jigsaw_puzzle/)
  - Lost-box requests: "I bought it like 2 years ago and lost its box so I don't have any references" (Jan 6 2026). — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1q5dgi0/guys_i_need_help_finding_the_picture_of_this/)
- **Missing pieces.** High-engagement threads:
  - "If multiple pieces are missing kindly do not donate the jigsaw…" (Nov 27 2025, **855 pts**)
  - "Thrift store puzzle missing about 70 pieces!!!" (Sep 19 2026, 356 pts)
  - "72 pieces. 72 pieces missing." (Feb 11 2026, 285 pts)
  - "Galison Puzzle Issue (47 Pieces Missing)" (Jan 13 2026, 258 pts) — [Reddit search](https://www.reddit.com/r/Jigsawpuzzles/search?q=missing+piece&restrict_sr=1); [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1p7zxif/if_multiple_pieces_are_missing_kindly_do_not/)
  - A request on an app-ideas thread: "I would like a place where I can post a pic of a missing piece(s) and see if anyone has the same puzzle." The developer replied: "I know this is a huge issue people have." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1wv67y7/an_app_for_puzzlers_not_a_self_promotion/)
  - u/LilannaLiola saw resellers and secondhand shops as the one valid helper-app use: "quickly see if there are pieces missing." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1vjgfnm/is_there_any_market_for_a_jigsaw_helper_app/)
- **Space, kids and pets.**
  - "I have 2 small kids and no space is safe! I either have to work entirely on a single cookie sheet or finish in one sitting." (Sep 16 2026)
  - "Hoarding the kitchen island with a puzzle is not exactly very kind towards other people in the house." (Sep 15 2026) — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1whajcu/update_to_rule_3_promotions_no_more_digital/)
  - "Pokémon 5000 piece puzzle, Ravensburger…Fail" (Aug 26 2026, 319 pts): a half-done puzzle destroyed while moving it. — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1vza1dv/pokémon_5000_piece_puzzle_ravensburgerfail/)
- **Lost or dropped pieces.** u/wharleeprof: "if you could create an alarm that sounds every time a piece falls on the floor or gets stuck to my sleeve, I'll buy that in a heartbeat." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1vjgfnm/is_there_any_market_for_a_jigsaw_helper_app/)
- **Sorting is disliked by some.** "Sorting the pieces at the beginning is probably my least favorite part." (Dec 3 2025); people pre-bag edge pieces to skip it. — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1pbvdqf/is_there_any_actual_way_to_cheat_in_puzzling/)
- **Eyesight.** "I'm really starting to have trouble with seeing detail on pieces after some eye issues this spring." Solutions suggested: oversized pieces, lamps, magnifiers. — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1tvlqgu/eyesight_issues_recommended_puzzle_brands/)

### Inferences
- The point where people are willing to accept help is the stalled, no-longer-fun moment, usually on a low-detail area. That is exactly where picture-matching apps are weakest. A product that combines image matching with shape and orientation cues, or honestly sets expectations ("best on detailed areas; for sky, use shape mode…"), would stand out. All competitors fail here, and 1★ reviews cluster on it.
- "Lost box / no reference" and "find missing pieces" (thrift and resale) are adjacent jobs with visible pain and no app answer. Puzzle Pointer's barcode catalogue (10,000+ puzzles) partly addresses lost or obscured box images.

### Gaps
- No survey data ranking pain points. The evidence is anecdotal, though upvote counts give some weight.
- No direct evidence of people paying to solve sky or sorting pain.

## 4. Willingness to pay: price, subscription vs one-time, "I'd pay $X"

### Takeaway
There is very little explicit willingness-to-pay evidence for piece finders. Every current piece finder is free, and some stress "free, no ads, no registration". In the adjacent jigsaw-app and tracker space, puzzlers resent subscriptions and ads, respond to small one-time prices ($2.99, "a few dollars"), and object to paywalls on basic features such as CSV export. Purchase intent for a piece finder appears only in scattered comments ("I would buy this app").

### Cited Findings
- "I would buy this app." (YouTube comment, ~2021, on the never-released Jig Sawlver demo). — [YouTube](https://www.youtube.com/watch?v=MZIAz_6t6xA)
- r/Jigsawpuzzles, "I built a jigsaw app with no ads, no subscription, no timers. $2.99 once." (May 15 2026). The developer: "I got tired of every digital jigsaw app on the App Store either charging $10/month or shoving an ad in my face between pieces." Commenters: "Nice! I bought" and "Thanks, bought it and am enjoying it." The first question asked was "Are the pictures AI?" (7 pts). — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1tdy8lj/i_built_a_jigsaw_app_with_no_ads_no_subscription/)
- u/DrunkenFist, on a digital jigsaw app: "I liked it so much I actually paid the few dollars for the full version." (Sep 16 2026). — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1whajcu/update_to_rule_3_promotions_no_more_digital/)
- Puzzle Tracker users: "If you make one please add an option to import/export. Puzzle tracker has that feature but charges for it." (Oct 3 2026). Another: "the free version is pretty comprehensive." — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1wv67y7/an_app_for_puzzlers_not_a_self_promotion/)
- Competitors' current pricing posture:
  - Puzzle Finder's developer said a cloud vision AI "a un coût" (costs money) and they prefer to keep it "local et gratuite" (local and free). — [Google Play](https://play.google.com/store/apps/details?id=www.ly.puzzlefinder&hl=en_US)
  - Solver Works' developer: "The app is currently free, has no ads, and needs no registration." — [Google Play](https://play.google.com/store/apps/details?id=puzzle.solver.puzzle_solver_app&hl=en_US)
  - Puzzle Pointer, PuzzleLens and Puzzle Detective are all listed as Free on the US App Store. — [iTunes lookup](https://itunes.apple.com/lookup?id=6809997519&country=us)
- Puzzlers spend freely on the physical hobby itself (a thread on a ~$9,000 Elms puzzle; threads on paying for hard-to-find puzzles), so the barrier is not money in general. — [Reddit search "would pay"](https://www.reddit.com/r/Jigsawpuzzles/search?q=would+pay&restrict_sr=1)

### Inferences
- With four or more free competitors, a paid piece finder needs clearly better accuracy, especially on low-detail areas. Otherwise the market's anchor price is $0.
- If monetised, the community's stated norms favour a small one-time unlock or per-puzzle pass over a subscription. Free-tier generosity matters, and gating basic features invites resentment.
- A browser PWA's "no install, no account, no ads" can be a positioning advantage, matching the "calm, no ads" values puzzlers keep asking for.

### Gaps
- No "I'd pay $X" statement specifically for a piece finder was found.
- No data on conversion or revenue for any competitor.

## 5. YouTube / TikTok: videos demonstrating puzzle-solving apps, view counts, comment sentiment

### Takeaway
No YouTube video demonstrating a consumer piece-finder app (Solver Works, Puzzle Finder, PuzzleLens, Puzzle Detective, Puzzle Pointer, PuzPal) was found. Search results for these app names return unrelated games. Content about puzzle-solving technology is dominated by robots and engineering builds (Mark Rober, Stuff Made Here) with very high views, plus a decade-old university demo. Hobbyist creators' content about help centres on the cheating debate and back-letter codes. TikTok could not be accessed.

### Cited Findings
- YouTube searches for "puzzle piece finder app", "app that solves jigsaw puzzles", "jigsaw puzzle solver app", "PuzzleLens app", "PuzPal puzzle app", "Puzzle Detective jigsaw app" and "Puzzle Pointer app jigsaw" returned no demos of the named apps. Relevant results were engineering videos:
  - "My Puzzle Robot is 200x Faster Than a Human" (Mark Rober, ~2 years ago, **41.8M views**)
  - "Worlds hardest jigsaw vs. puzzle machine (all white)" (Stuff Made Here, ~3 years ago, **7.5M views**)
  - "Zolver – An automatic jigsaw puzzle solver" (~8 years ago, 16.5K views)
  - "Automatic puzzle solver solving 600 blue jigsaw puzzle pieces based only on the contour shape" (~10 years ago, 10.5K views) — [YouTube search](https://www.youtube.com/results?search_query=jigsaw+puzzle+solver+app)
- Puzzlers know Mark Rober's robot: "He and his team made a software that can solve puzzles by taking pictures and matching the shapes… it solved a 1000 all white puzzle in 4 hours." A follow-up asked in Spanish, "Y se puede usar?" ("And can it be used?"). — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ccb0di/puzzle_solverhelper_programs/)
- "Jig Sawlver – iOS Puzzle Solving App" (2015, 36,349 views) has the only demand-style comment thread found; see Q1 for quotes. — [YouTube](https://www.youtube.com/watch?v=MZIAz_6t6xA)
- "3 Apps to boost your Speed Puzzling" (Isabel puzzles On the Edge, Jan 19 2026, 284 views) covers digital puzzle and colour apps as training, not piece finders. — [YouTube](https://www.youtube.com/watch?v=-aLLgF9yEfY)
- Cheating-debate videos are where help is discussed:
  - Zachary Michael Also (May 28 2026, 18,160 views) — [YouTube](https://www.youtube.com/watch?v=dd5V_7BxLBg)
  - thepuzzlingcanadian (Apr 12 2026, 5,351 views) — [YouTube](https://www.youtube.com/watch?v=0Nf0qbiEP7A)
  - Karen Puzzles, "Did I cheat at this 20 piece jigsaw puzzle?" (~5 years ago, 171,787 views) — [YouTube search](https://www.youtube.com/results?search_query=is+it+cheating+jigsaw+puzzle)
  - Pieceful Puzzles, "Puzzle cheating" (Mar 2 2025, 1,392 views): "Nothing wrong with a little help. Use the aid if you need to. Ignore it if you don't." — [YouTube](https://www.youtube.com/watch?v=ECNdw0n03js)
- Puzzlers also watch technique content for low-detail areas: Karen Puzzles, "How to Solve a Solid Color Puzzle (Expert-Level Strategies)" (469,802 views); "10 Expert-Level Tips for Doing a Jigsaw Puzzle" (1.26M views). — [YouTube search](https://www.youtube.com/results?search_query=app+that+solves+jigsaw+puzzles)

### Inferences
- There is open space for demo and explainer content showing a real-world piece finder working. No competitor has visible video marketing.
- The robot videos (tens of millions of views) prove mass curiosity about "computer solves jigsaw", but the comments that ask "can I use it?" are the actual demand signal.

### Gaps
- TikTok blocked: tiktok.com/search returned only a JavaScript shell with no extractable results, so no TikTok view counts or comments.
- YouTube watch pages were rate-limited (Google "sorry" page). Comments were fetched through the innertube API, which returns a top-comments sample, not the full set.

## 6. Facebook groups, puzzle forums, Ravensburger community, Discord, Hacker News

### Takeaway
Facebook puzzle groups were not reachable directly. Second-hand reports describe them as the most heated venue for "cheating" debates, with polls and "drama". Hacker News interest in jigsaw solvers is technical and has been small (tens of points): commenters note that single-piece location "doesn't really solve puzzles" but is most of a useful "human aide". Several developers have built the same box-photo-plus-piece-photo tool independently.

### Cited Findings
- Facebook second-hand reports:
  - "facebook craft and hobby groups will have the MOST insane blow ups and drama and people leaving to make their own communities" (29 likes)
  - "I found a bag of puzzle pieces… a puzzle facebook group [told me] I needed to be burned at the stake for my treachery" (11 likes) — [YouTube comments](https://www.youtube.com/watch?v=dd5V_7BxLBg)
- HN story results for "jigsaw puzzle solver":
  - "Solve large jigsaw puzzles using genetic algorithms and OpenCV" (2017, 73 pts, 29 comments)
  - "Jigsolved: Computer Vision to Solve Jigsaw Puzzles" (2018, 49 pts, 13 comments)
  - "AI Jigsaw Puzzle Solver" (unpuzzler, 2020, 1 pt)
  - "Jigsaw Puzzle Robot, Or: How We Solved a Puzzle in 15 Months" (2024, 2 pts)
  - No 2025–2026 HN story about a consumer piece-finder app was found. — [HN Algolia](https://hn.algolia.com/api/v1/search?query=jigsaw%20puzzle%20solver&tags=story)
- Selected HN comments:
  - "Do most people keep the solution visible while solving a jigsaw?" (u/lozenge, 2018)
  - "If you have a picture of the solution it can tell you how to put the pieces yes." (u/talltimtom, 2018) — [HN](https://news.ycombinator.com/item?id=17750335)
  - u/justinlloyd (2021): "Have built computer vision based bots for… a real-world jigsaw puzzle solver on a phone… Computer vision cheating is surprisingly easy and just getting easier." — [HN Algolia comment search](https://hn.algolia.com/api/v1/search?query=jigsaw%20puzzle%20cheating&tags=comment)
- On a 2021 Show HN jigsaw website, a user noted that auto-assistance "kinda took away from the jigsaw puzzle experience. Maybe make it rotate to a random perpendicul[ar]…", an early sign that help features must be optional. — [HN Algolia comment search](https://hn.algolia.com/api/v1/search?query=jigsaw%20puzzle%20cheating&tags=comment)
- Duplicate independent builds seen in community threads:
  - A Python/OpenCV notebook (u/alparius)
  - Puzzle Finder Android (u/Several-Tangerine616, a holiday project "installed on my smartphone and my son's")
  - Puzzle Pointer iOS
  - The 2015 Jig Sawlver
  - An AR helper (u/ in the Aug 2026 thread) — [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1ccb0di/puzzle_solverhelper_programs/); [Reddit](https://www.reddit.com/r/Jigsawpuzzles/comments/1vjgfnm/is_there_any_market_for_a_jigsaw_helper_app/)

### Inferences
- The basic box-plus-piece matching approach is easy to copy (many solo developers, free apps). Advantage would have to come from accuracy on hard areas, rotation guidance, "fits-with" detection, a puzzle catalogue or no-install convenience, not from the concept itself.

### Gaps
- Facebook groups (e.g. "Jigsaw Puzzle Lovers"), JigsawJunkies, Ravensburger community forums and Discord servers were not accessible or not searched with results. Facebook requires login and Discord is closed. No direct quotes from these venues.
- No 2024–2026 HN discussion specifically about consumer piece-finder apps.
