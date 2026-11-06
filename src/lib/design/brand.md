# Extra design guidance: identity, covers, tokens, social specs, vague-request defaults

Additions to the static-design guide, which already covers grids, type, colour, art styles, format templates and attention psychology. Everything here is new material distilled from a user's own brand, logo, platform and cover research. Treat the numbers as strong defaults. Platform pixel values come from secondary sources and change often.

---

## 1. Brand, logo and visual-identity craft

### 1.1 What actually makes an identity read as trustworthy and premium
- **Consistency and legibility do the work, not colour psychology.** Trust comes from repeated, consistent exposure and competent execution (clean geometry, legible type, generous whitespace). "Blue = trust", "red = sales" and "green = growth" are weakly evidenced and depend on culture. Use a colour because it fits the personality and context (blue is conventional for information, monochrome reads premium or editorial, warm amber reads approachable), not because of a supposed effect.
- **Sleekness comes from subtraction:** one weight, one accent, one shape idea. Durable identities use **one structural device that recurs through the whole product**: a dot grid, a single coloured stroke, a cream page plus one serif, a red box. The device is structural (it also forms the divider, the card edge, the bullet), never decorative.
- **Serif vs sans is not a trust lever.** Studies find them about equal; a humanist sans scored highest for trust across countries in one large study. Choose for tone: serif reads editorial or literary, geometric or grotesque sans reads modern or technical.
- **For a new, unknown brand, a slightly figurative mark beats a purely abstract one.** Logos that hint at what the brand does (a recognisable object or tool of the trade) raise evaluation and perceived authenticity, and are easier to learn. The effect fades as the brand becomes familiar. The mark and the name should say the same thing: matching meaning doubles fluency.
- **Distinctiveness beats cleverness.** Ask: would a stranger mistake this for another brand? A new brand has no fame, so uniqueness is the only thing it controls. Never imitate an existing organisation's mark.
- **Choose once and freeze.** Audiences punish changes to familiar marks (high-profile rebrands have been reversed within days to months). Design the system fully before launch, then keep it.

### 1.2 The two-part system
- **Wordmark lockup** for wide surfaces (banners, title slides, end cards, letterheads): the name in authoritative type, often with a rule or bar.
- **Compact mark** for small or square surfaces (avatar, favicon, corner bug, app icon), built from **the same device** as the wordmark, so the two clearly belong together.
- Provide a dark-on-light and a light-on-dark version of each from the same tokens. Provide a solid version and a knockout version for busy photos.

### 1.3 Small-size craft rules (avatars, icons, bugs)
- Design at 512 × 512. Test at 98, 64, 40, 32 and 16 px, in a circle crop, in grayscale, and under a 2 px blur.
- One glyph, at most 2 tones plus background. **Never a wordmark as an avatar.** It's illegible at 40–110 px.
- Keep the glyph inside the inscribed circle with **≥15–20% padding**, because corners get cropped.
- Minimum stroke or feature ≈ 6% of tile width. Gaps and counters ≥ 5% of width so they don't close up at 40 px.
- Wide shapes (long rules, wordmarks) fail in circles. Re-proportion them into a short, centred unit for the avatar.
- Favicon: one shape, two colours, legible at 16 px. Clear space around any mark = one glyph unit on all sides.
- A letter in a rounded square reads as an app icon. Avoid it as the only mark unless "app" is the intent.

### 1.4 Clichés that make identities look dated or generic
- **Dated or clichéd:** globe-with-swoosh, microphone, bevelled or shiny TV-style graphics, ticker glitch and scan lines, red "BREAKING" banners, literal newspaper icon, shields, eagles and flags, the Wi-Fi or RSS quarter-arcs (means "feed"), speech bubbles (means "chat app").
- **Reads as "software" rather than the intended category:** gradient orbs, sparkles, abstract blobs, glassmorphism, lowercase geometric wordmark alone.
- **Atom or space traps:** multiple crossed ellipses, a nucleus, planets, rings, stars, glows.
- **Marks:** no gradients, drop shadows or outer glows on the mark itself.
- **Motion:** logos don't spin, pulse or loop (a moving ring reads as a loading spinner). If a mark animates at all: 200–300 ms fade or scale from 96% to 100%, ease-out, then static.

### 1.5 Identity method when Claude must create one
1. Write a brief: 3–4 tone words, the one image or idea, constraints, and an anti-list of clichés.
2. Pick the structural device (rule, bar, dot, frame corner, column) and build the wordmark lockup, compact mark, divider, card edge and bullet from it. Bonus pieces from the same device: a fragment used as an underline or divider, a dot used as a bullet, and an oversized cropped version at 8–10% opacity as a background decal (never behind body text).
3. Generate several genuinely different layouts, not colour variants: colour variants all pass or fail together.
4. Run the small-size tests above. Cap revision at about 3 rounds, then present the best options. Endless self-critique converges on blandness.

---

## 2. Attention, thumbnails and covers

### 2.1 Cover and thumbnail rules
- **The one test that matters most:** shrink the cover to feed size (**160 × 284** for a vertical cover, about 168 × 94 for a 16:9 thumbnail) and look again. If the headline isn't readable at that size, it fails. Almost nobody checks this.
- **Type-led, ≤5 words** (≤42 characters, max 3 lines), sentence case, heavy display weight. Auto-fit by stepping down the type scale. Never condense or letter-space to make it fit.
- **One subject, one focal element, one accent:** a rule, a keyline box, or one highlighted word. Never more than one.
- Background: one strong image or a flat brand colour. **Darken or desaturate photos 25–45%** so the type always wins. Check contrast of the title against its actual local background patch, not the average: below 4.5:1 is a failure.
- Put the **topic** on the cover, not a reaction.
- Small, consistent wordmark or segment chip, **in the same position every time** (e.g. top-left or bottom-left inside the safe area). A category chip ("Explainer", "Update") helps people scan.
- **Hard fails for a credible look:** arrows, red circles, scribbles, shocked faces, ALL-CAPS shouting, extreme saturation, fake "BREAKING" banners, anything that imitates a real organisation's graphics, and a headline that overstates the content. The absence of these is itself a trust signal.
- **Consistency beats novelty** for series covers. Keep a fixed template, with a fixed colour per segment or series type. Prevent near-duplicates by varying layout across a set (≥3 layouts) and checking each new cover against recent ones.

### 2.2 Titles that pair with covers
Patterns that work for informational content: a question as the title ("Why did X just Y?"), a concrete noun plus a specific number, a named series prefix ("Update: …"), an honest hedge ("how real is it?"), and plain-language swaps for jargon. Avoid emotional claims you can't back up ("SHOCKED everyone"), "the TRUTH about", and implied intent ("they LIED").

### 2.3 Scored cover review (use on your own render)
Score 1–5 on: legibility at feed size (hard fail if unreadable), contrast (hard fail below 4.5:1), safe areas, single focal point (the eye lands on the headline first), brand consistency (mark position, accent and type scale match the tokens), trustworthy tone (hard fail on tabloid markers), text accuracy (hard fail on overclaiming), and distinctiveness against recent covers.

---

## 3. Design tokens across a set

When making more than one piece (a deck, a carousel, a post series, a video plus its cover), **define tokens first and design from them.** No hard-coded one-off values.

### 3.1 The token set
```
color:   bg, surface, ink, ink_muted, rule, accent   (+ the same keys for the dark theme)
type:    family_display, family_body, family_mono; scale e.g. [28,36,48,64,84,112,148] (px @1080 wide)
         weights (2-3 max); tracking_display -2%..-4%; chip caps +6%
space:   base 8 -> 8/16/24/32/48/64; margin (e.g. 72 @1080); columns 6; gutter 24
radius:  one family, e.g. card 16, tile 24, chip full
stroke:  icon 2px @48, hairline rule 1-2px
motion:  ease + durations (if anything animates)
safe:    per-format safe box
```

### 3.2 Practice
- **One file feeds every surface:** slides, posts, cover, chart palette, captions, lower thirds, icons. A new surface is designed by token first, then art.
- **Families share all tokens except one accent.** Sub-brands, series or sections get their own accent hue (or one glyph), and everything else stays identical, so siblings are recognisable at a glance.
- **Light and dark parity:** both themes use the same layout, sizes and spacing. Only colour tokens swap. Pick a lighter accent for dark backgrounds: a mid-blue that passes on paper can fail at ~3:1 on navy.
- **Store computed contrast** for every text pairing (ink/bg, muted/bg, accent/bg, accent/surface in both themes). Text needs ≥4.5:1 (large text ≥3:1). Non-text marks such as chart lines and icons need ≥3:1 against neighbours. Logos are exempt, but the UI text around them is not.
- **Colour-blind safety in the tokens:** separate categories by lightness as well as hue. Use Okabe-Ito-style hues when there are more than 2 categories. Never use red/green as the only distinction.
- **Neutral, calm defaults:** deep navy or charcoal instead of pure black, warm off-white instead of pure white, one restrained accent. Status or "live" indicators reuse the accent, not alarm red.
- **Consistency check for a set:** put all the pieces side by side. Margins, title baseline, mark position, type sizes and accent use should line up exactly. Any piece that looks as if it came from another template fails.
- For slides: build the master layouts from tokens (title, section, content, data, quote, closing), and vary only the content. Rotate between 3–4 layouts so a long deck doesn't look stamped out, while keeping every token fixed.

---

## 4. Platform asset specs for social graphics

Secondary sources unless marked. Check in the app before final export.
| Asset | Upload size | Display and safe-area notes |
|---|---|---|
| YouTube profile (OFFICIAL) | 800 × 800 (≥512) | Renders at 98 × 98, circle mask, ≤15 MB, JPG/PNG/BMP/static GIF |
| YouTube banner (OFFICIAL) | 2560 × 1440 (min 2048 × 1152), ≤6 MB | **Centre safe area 1235 × 338.** Everything outside it crops on some devices |
| TikTok profile | 720 × 720 (512 fine) | Circle, shown ~200 px. No banner |
| Instagram profile | 320 min, use 512+ | Circle, shown ~110 px. Keep the subject in the inner ~70%. No banner |
| Instagram / Facebook Reel cover | 1080 × 1920 | **Profile grid shows a centre 3:4 crop (1080 × 1440)**, so keep the title inside the middle 1440 px |
| Instagram feed post | 1080 × 1350 (4:5) or 1080 × 1080 | 4:5 takes the most feed space. Grid previews crop to 3:4 |
| Facebook profile | 320+ (use 512+) | Circle, ~170 px on desktop, ~128 on mobile, 32 in comments |
| Facebook Page cover | 851 × 315 or 820 × 360 (sources conflict) | Shown 820 × 312 on desktop, 640 × 360 on mobile (sides crop). The profile picture overlaps the lower-left on desktop. Keep content in the centre ~640 × 312 |
| Vertical story or short cover (all) | 1080 × 1920 | Text inside x ~120–960, y ~270–1250. The top ~14% and bottom ~35% are covered by UI, and the right ~120–140 px by action buttons |
| YouTube video thumbnail | 1280 × 720 (16:9) | Bottom-right corner holds the timestamp: keep it empty |

General: the vertical title area sits in the middle band (top ~180–270 px and bottom ~420–670 px are contested). A 6-column grid with 72 px margins and 24 px gutters on 1080 wide is a solid default. Minimum on-screen text is ~32 px at 1080 wide. Export PNG for type-heavy graphics, never upscale a small source, and keep the master at 2× when the platform allows.

---

## 5. Defaults when the request is vague

Don't stop to ask unless something essential is truly unknowable (e.g. a date or name that must be exact). Infer, choose a strong direction, carry it out fully, and state the assumptions in one line afterwards so the user can redirect.

### 5.1 Infer from what's given
| Signal | Infer |
|---|---|
| Format named (flier, slide, post, cover) | Its standard size, safe area and reading distance (sections 4 and 6 of the base guide) |
| Words like "event", "sale", "class", "meeting" | Audience = the public or members. Goal = act (attend, sign up). Hierarchy = what, then when/where, then how to act |
| School or academic context | Credible and clear: editorial or clean-modern, restrained colour, readable body text, sources cited |
| Business or professional | Calm, competent: neutral palette plus one accent, generous whitespace, grid-strict |
| Kids, party, community fun | Warmer palette, rounder shapes, playful but still on a grid with one focal point |
| News, science, explainer, data | Trustworthy editorial: muted neutrals, one accent, diagrams or real charts, small dateline or source labels |
| Existing material supplied (logo, photo, document) | Pull the palette and type from it. Its identity overrides the defaults |

### 5.2 The default direction (when nothing points elsewhere)
- **Tone:** calm, competent, specific, like "a trustworthy person explaining something": never alarm, hype or sterile corporate.
- **Palette:** deep neutral (navy or charcoal) plus warm off-white plus **one** accent chosen to fit the subject. Monochrome plus one accent is the safest premium choice.
- **Type:** one strong sans family (or a serif display with a sans body for editorial topics), 2–3 weights, tight display tracking, sentence case.
- **Layout:** asymmetric on a grid, one dominant element at about 3× the size of the next, generous margins, one recurring structural device (rule or bar).
- **Imagery:** specific and real over generic. If a good real photo isn't available, use a well-made diagram, a typographic composition or textured abstract art rather than a cliché stock or clip-art image. Never posed "stock grammar".
- **Content hierarchy:** headline that states the point in ≤8 words, then a supporting line, then details, then the action or source. Cut anything that doesn't serve the one purpose.

### 5.3 Fill in detail instead of leaving it basic
A vague request is not permission to be minimal-by-omission. Add, where it fits: a small label or kicker above the headline, a real supporting detail (date, place, figure with a unit), a structural rule, layered background depth (texture, low-opacity cropped shape or photo), a consistent icon set, and a credible footer (source, contact, mark). Write real, plausible copy that fits the context, not lorem ipsum. Make sure every addition is specific to the subject. Generic ornament is noise.

### 5.4 Self-check before delivering
Readable at real viewing size (and at thumbnail size if it's shared online)? One focal point that lands first? Contrast ≥4.5:1 against the actual background? Inside the safe areas? Tokens consistent across every page or slide? Free of tabloid markers and clichés? Would it look at home next to professional work in its category? If any answer is no, fix it before showing it.
