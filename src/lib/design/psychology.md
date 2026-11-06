# Psychology of Visual Design and Attention: Layout Rules for Claude

Audience: Claude, when it places elements with exact coordinates for fliers, posters, slides, social graphics, handouts and documents.
How to read it: each section gives the **finding**, how strong the **evidence** is, and then **RULES** you can apply directly. Where a number is a design convention rather than a research result, it is marked *(heuristic)*.

Units used below: `W`/`H` = canvas width/height; `S` = the shorter side; `body` = body text size in pt; `LH` = body line height. 1 pt = 0.353 mm. Cap height is about 0.7 × font size, so **font size in pt ≈ 4 × cap height in mm**.

---

## 1. What people notice first, and in what order

**Finding.** Vision runs in two stages. In the first, *preattentive* stage (roughly 200–250 ms, before the eye moves on purpose), the brain processes a few basic features across the whole field in parallel: size, colour hue, luminance contrast, orientation, motion, enclosure and sharpness. An item that differs from its neighbours on **one** of these features "pops out" at once, however many distractors there are. An item that differs only by a *combination* of features (say "red AND tilted" among red upright and blue tilted items) has to be searched for one item at a time, which is slow (Treisman's feature-integration theory; Wolfe's guided search). Faces are a special case: they capture attention strongly and early, and eye-tracking heatmaps of ads almost always have a hotspot on any face present.

**Evidence: strong** for pop-out and for faces capturing attention. **Moderate** for gaze cueing: lab studies reliably show that viewers follow a pictured face's gaze. The well-known ad evidence (a baby looking at the headline sends much more attention to the copy than a baby looking at the viewer) comes from a usability-industry eye-tracking study reported mainly in blogs, not from a peer-reviewed paper. Pieters & Wedel (2004; 1,363 print ads, more than 3,600 viewers) found that the picture captures attention **whatever its size**, while text gains attention as it gets **bigger**, and that the brand element's size had little effect.

**Order of capture (typical, for print and static screens):**
1. Faces, especially eyes; people and animals.
2. The element with the highest luminance contrast against its surroundings.
3. The largest element (a big image or a big headline).
4. A saturated, isolated colour among muted ones.
5. Then reading starts: top-left for left-to-right languages, or the largest text.

**Three-level hierarchy (see → read → act):**
| Level | Job | Time budget | Elements |
|---|---|---|---|
| 1 See | Stop the passer-by | ~1 s from 3–5 m | One image or one headline, nothing else at this weight |
| 2 Read | Explain what it is and why it matters | ~3–10 s at 1–2 m | Subhead/benefit line, date, place |
| 3 Act | Let an interested person act | Up close | Details, price, CTA, QR/URL, logos, fine print |

**The 1-second / 3-second test.** A poster has about 1 second to say what kind of thing it is (concert, sale, lost cat, deadline) and about 3 seconds to get across the core message. If a viewer cannot answer "what is it, and is it for me?" from Level 1 and Level 2 alone, the design fails.

**RULES**
- Put exactly **one** Level-1 element on the canvas. Make it at least **2×** the visual weight (area or type size) of the next-largest element. Headline size ≥ **2× body**; on posters, ≥ **3×**.
- Use type-size steps of **1.25–1.6×** between levels *(heuristic)*. Don't let two text levels differ by less than **1.2×**: 14 pt next to 15 pt reads as an error, not as hierarchy.
- When the design includes a face that isn't looking at the camera, **mirror or crop it so the gaze points toward the headline or CTA**, and put that text inside the gaze line, within about 1–2 face-widths of the eyes. A face looking straight at the viewer gets attention but keeps it on the face, so in that case put the headline right next to the face.
- Never let a face's gaze point **off the canvas edge**. Keep at least 0.5 face-width of empty space ("lead room") in front of the gaze.
- Things pop out on a **single** contrasting feature. To make the CTA pop, change one thing strongly (a saturated colour against neutrals, *or* a filled box against plain text). Don't change three things weakly.
- Pictures capture attention even when small, so you don't need to fill half the canvas with an image just to be noticed. Text needs **size** to be noticed: give the headline space.
- Run a **squint/blur test** on your render (blur by about 1% of `W`). The Level-1 element must still be identifiable, and you should see 3–4 distinct blobs of weight, not 10.

---

## 2. Scanning patterns and where the CTA goes

The eye doesn't read a page evenly. Which pattern you get depends on **how much text there is** and **how structured** it is.

| Pattern | When it happens | Evidence | Layout implication |
|---|---|---|---|
| **Z-pattern** | Sparse designs: posters, fliers, ads, title slides, social graphics with 3–6 elements | Moderate (practitioner eye-tracking; follows reading direction and salience) | Logo/headline top-left → top-right, diagonal down, then bottom-left → bottom-right ending on the CTA |
| **F-pattern** | Dense, *unstructured* text: long handouts, document pages without headings | Strong (NN/g eye-tracking since 2006, replicated in 2017) | The first lines and left edges get read; the right side and lower lines are skipped. NN/g treats F as a **failure mode** to design against |
| **Layer-cake** | Text with clear, descriptive headings | Strong (NN/g) | Eyes jump from heading to heading and only read body text under a heading that matters to them. This is the pattern you want for handouts |
| **Spotted** | The viewer is hunting for something specific (a date, a price, a room number) | Strong (NN/g) | Make the hunted items visually distinct: bold digits, consistent placement |
| **Gutenberg diagram** | Even, homogeneous text blocks with no strong hierarchy | **Weak** (an old newspaper-design model; strong visual elements override it) | Top-left = primary optical area; bottom-right = terminal area; bottom-left = "fallow" (weakest) |

Note: in right-to-left scripts (Arabic, Hebrew) all of these mirror.

**RULES**
- **Sparse layouts (posters, fliers, social, title slides):** put the Level-1 element on the top line or upper third, and the CTA/QR at the **end of the reading path**: bottom-right, or bottom-centre on symmetric layouts. Put supporting info along the diagonal/middle band.
- Don't put essential info in the **bottom-left corner** of sparse designs. That spot is weakest; use it for logos, sponsors and fine print.
- **Text-heavy layouts (handouts, documents):** break text with a descriptive heading every **150–300 words** or every 3–5 paragraphs, so readers scan layer-cake instead of F. Front-load: put the key word or number in the **first 2–3 words** of headings, bullets and paragraphs, because the left edge is what gets read.
- Put the single most important fact in the **first two lines** of a text block. Content below the first screen or fold, or below the middle of a dense page, gets much less attention.
- On dense pages, put the CTA **both** near the top (for people who have already decided) and at the end (for people who read through). On sparse pages, one CTA is enough.
- Strong visual weight overrides every scanning pattern. A big face or bright block in the bottom-left will be looked at first. So decide the order first, and use salience to enforce it. Don't rely on the pattern alone.
- Align the main text blocks to a **common left edge**. A consistent left axis is what makes F-style and layer-cake scanning efficient.

---

## 3. Gestalt principles as spacing rules

**Evidence: strong** (a century of perception research). The brain groups elements automatically. Your spacing is a statement about which things belong together, whether you mean it or not.

| Principle | Perception | RULE (numbers) |
|---|---|---|
| **Proximity** | Things that are close together read as one group. This is the strongest grouping cue and beats colour and shape | Space **inside** a group ≤ **½** the space **between** groups (target 1:2 to 1:3). Label-to-object gap ≤ **0.5 × LH**. Heading sits closer to the text below it than to the text above: space above ≈ **2×** space below |
| **Similarity** | Same colour, size, shape or weight reads as same role | Give every element with the same role **identical** font, size, colour, corner radius and icon size. Make different roles differ by **≥1.25×** in size or by a clearly different hue/weight. Never near-match |
| **Common region** | A shared background or border groups items, even overriding proximity | Use a card/panel to group 2–6 related items. Inner padding ≥ **1 × LH** (≥ 3% of `S` on posters). Gap between cards ≥ the inner padding |
| **Continuity** | The eye follows lines, edges and implied paths | Line up elements along shared axes. Arrows, diagonals and gaze lines should **point to the next element in the reading order**. Don't let a strong line lead off the canvas |
| **Closure** | People complete incomplete shapes | You can crop images and shapes at the canvas edge (bleed) and the shape still reads. Crop people between joints, not at them, and never crop through the eyes |
| **Figure-ground** | One region reads as the object and the rest as background | Text must sit on a calm ground. Behind text on a photo, use an overlay or a scrim at 40–70% opacity, or place text over flat image areas. The figure should have **≥ 3:1** luminance contrast with its ground |
| **Symmetry / order** | Symmetric, aligned layouts read as stable, formal and finished | Centred symmetry suits formal notices, invitations and certificates. Asymmetric layouts (left-aligned, with a dominant image on one side) feel dynamic and suit promotions. Pick one; don't half-centre |
| **Uniform connectedness** | Lines or connectors bind items more strongly than proximity | Use connector lines for timelines and process steps. Keep connectors **lighter or thinner** than the items they join |

**General spacing rules**
- Margins: ≥ **5% of `S`** on documents and slides, **6–10%** on posters and social graphics. Keep text **out of the outer 5%** (printer trim, platform UI overlays).
- Build all spacing from one base unit (e.g. `u = body × 0.5`), and use multiples only: 1u, 2u, 3u, 4u, 6u, 8u *(heuristic)*. Snap coordinates to it.
- Put elements on a grid: a **12-column grid** for slides and documents, **4–6 columns** for posters. Column gutter ≈ 2–4% of `W`.
- An edge that is **off by 1–5 px** looks like a mistake, not a choice. Edges that should align must have **identical** coordinates.
- White space is a grouping tool, not wasted space. Aim for **30–50%** empty area on posters and slides *(heuristic)*.

---

## 4. Contrast, isolation (Von Restorff) and the single accent

**Finding.** Among similar items, the one that is different gets noticed and remembered (von Restorff, 1933; a robust memory effect). This only works against a **uniform background of sameness**. When several things compete, each signal weakens the others: salience is relative, so five red items are no longer "the red item". Attention is capacity-limited, and several equal focal points produce a scattered gaze pattern with no starting point.

**Evidence: strong** for the isolation effect and for relative salience. The "60-30-10" colour split is a **designer convention**, not a research result.

**RULES**
- **One accent colour per design**, applied to **one** primary target (the CTA or key number), plus at most 1–2 small echoes of it (a rule line, an icon) that point to the same message.
- Keep the accent to **≤ 10% of canvas area** *(heuristic, the 60-30-10 split: 60% dominant neutral/background, 30% secondary, 10% accent)*.
- Make the isolated item differ strongly on **one** feature: e.g. the only saturated colour in a muted palette, or the only filled shape among outlines, or a size ≥ **1.5×** its siblings.
- Bold or highlight **≤ 10% of the words** in a text block. If everything is emphasised, nothing is.
- **At most 2–3 focal points** per canvas, and they must be ranked: the second ≤ half the visual weight of the first.
- Keep the accent colour off decoration. If a decorative swoosh uses the CTA colour, it steals the CTA's pop-out.
- Contrast budget: the highest-contrast pair on the canvas (e.g. black on white, or white on accent) should belong to the Level-1 or CTA element, not to a footer or logo.

---

## 5. Cognitive load and chunking

**Finding.** Working memory holds about **4 chunks** in young adults (Cowan, 2001, a revision of Miller's "7±2", which Miller himself meant loosely). Fewer for children and older adults. Under time pressure or distraction, as with a poster glanced at while walking, the usable capacity is lower still. Chunking, meaning grouping items under labels, raises effective capacity. Concrete, specific information (numbers, names, times) is processed and remembered better than vague claims, and precise numbers are judged more credible than round ones.

**Evidence: strong** for capacity limits and chunking. The word-count limits below are **industry heuristics** drawn from that research (outdoor advertising's "about 7 words on a billboard" is a long-standing rule of thumb, not a controlled finding).

**Word and item budgets** *(heuristic, grounded in the capacity limits)*
| Format | Messages | Headline | Total words | Other limits |
|---|---|---|---|---|
| Billboard / far-view poster | 1 | ≤ 7 words | ≤ 15–25 | 1 image |
| Wall poster / event flier | 1 main + 3–4 facts | ≤ 7–10 words | ≤ 50 (glance), ≤ 100 (handheld flier) | ≤ 4 info chunks (what/when/where/how) |
| Social graphic | 1 | ≤ 6–8 words | ≤ 20 | Detail goes in the caption, not the image |
| Slide | 1 idea | sentence headline ≤ 2 lines | ≤ 30–40 | ≤ 6 lines; ≤ 6 bullets of ≤ 6–8 words each; ≤ 3–4 visual groups |
| Handout | 1 topic per page | | ~300–500 per page | Paragraphs ≤ 5 lines; lists ≤ 7 items, otherwise subgroup them |
| Document | | | | Heading every 150–300 words; one idea per paragraph |

**RULES**
- Group facts into **≤ 4 visible chunks** per canvas region, each separated by space ≥ 2× its internal spacing (see §3).
- Turn lists longer than 5–7 items into labelled subgroups of 3–5.
- **Specifics over adjectives:** "Fri 14 Nov, 7 pm, Room B204" beats "this Friday evening". "Saves 3 hours a week" beats "saves time". "127 students joined" beats "lots of people". Put numerals in digits.
- Give dates and times in **one consistent, complete format** that includes the weekday.
- Every element must earn its place. If removing it doesn't change what the viewer understands or does, remove it (coherence; see §10).
- On posters, move everything past Level 3 (full schedules, terms) to the QR/URL destination.

---

## 6. Readability and legibility at distance

**Distance.** 20/20 vision resolves letters about 5 arcminutes tall. Comfortable reading needs roughly **3×** that or more. Signage practice ranges from about 1 inch of letter height per 10 ft (for impact) to 1 inch per 30–40 ft (barely legible). Use cap height as the measure:

- **Minimum readable cap height ≈ distance ÷ 250**
- **Comfortable cap height ≈ distance ÷ 150**
- **Font size (pt) ≈ 4 × cap height (mm)**

| Viewing distance | Use case | Min cap → pt | Comfortable cap → pt |
|---|---|---|---|
| 0.4–0.5 m | Handout, flier in hand, phone | 2 mm → 8 pt | 3.3 mm → 10–13 pt |
| 1 m | Poster read up close | 4 mm → 16 pt | 6.7 mm → 24–28 pt |
| 2 m | Poster body from a corridor | 8 mm → 32 pt | 13 mm → 50 pt |
| 5 m | Poster headline across a room | 20 mm → 80 pt | 33 mm → 130 pt |
| 10 m | Banner / hall signage | 40 mm → 160 pt | 67 mm → 260 pt |

**Slides** (16:9, 13.33 × 7.5 in canvas): body **≥ 24 pt**, preferably 28–32 pt. Titles 36–48 pt. **Nothing below 18 pt**, including chart labels and sources. **Handouts/documents:** body 10–12 pt (print) or 16 px (screen); captions and footnotes ≥ 8–9 pt. **Social graphics** (1080 px wide, seen on a phone at about 1/3 scale): main text ≥ 48 px, smallest text ≥ 28 px.

**Contrast** (WCAG 2.x, which is reasonable to use for print too):
- Body text ≥ **4.5:1**; aim for **7:1**.
- Large text (≥ 24 px regular or ≥ 18.7 px bold) ≥ **3:1**. Meaningful graphics and icons ≥ **3:1**.
- Text over photos: measure contrast against the **lightest/darkest part** behind the glyphs, not the average. Add a scrim when needed.
- About **8% of men** (Northern European ancestry) and about 0.5% of women have colour-vision deficiency, mostly red-green. Never use colour alone to encode meaning; add a label, icon or position. Avoid red/green pairs carrying the meaning.

**Line length and spacing** (evidence: moderate. Dyson's studies show long lines on screen can be scanned *faster*, but readers prefer and comprehend well at medium lengths):
- **45–75 characters per line**, target about 60–66. On slides, ≤ ~50. On posters, ≤ ~40.
- Line height **1.3–1.5×** font size for body. **1.0–1.2×** for large headlines.
- Paragraph spacing ≈ **0.5–1 × LH**. Left-aligned, ragged-right body. Avoid justified text in narrow columns (rivers). Centre only short (≤ 3-line) display text.

**Type styles:**
- **ALL CAPS** reads more slowly in running text, by roughly 10–20% (Tinker and later work; the cause is mainly unfamiliarity, and the "word-shape" explanation is disputed). RULE: caps only for ≤ ~5 words: labels, kickers, short headlines. Add +5–10% letter spacing.
- **Italics** carry a small reading cost in long passages. Use them for emphasis, titles and quotes only, never for body paragraphs, and avoid them at small sizes or at distance.
- **Light text on dark** (negative polarity): in normal lighting, dark-on-light gives better proofreading accuracy and legibility (e.g. Piepenbrock et al., 2013). Light-on-dark causes halation for readers with astigmatism. RULE: use light-on-dark for short display text, slides in dark rooms and posters. For long body text, use dark-on-light. When reversing type, go **one weight heavier** and add **+0.5–1 pt or +2–5% tracking**.
- Body text in regular or medium weights. Avoid thin/light weights below 18 pt or at distance. **≤ 2 typefaces** per design (one display, one text), and **≤ 3–4 sizes** in total.

---

## 7. Colour psychology: what holds up and what doesn't

**Evidence.** Mixed. What holds up: (a) **colour contrast and saturation drive attention**; (b) colour carries **learned, context-specific associations** (red = stop/danger/sale in many Western contexts); (c) colour that "fits" a brand or product category improves recognition and perceived appropriateness (Labrecque & Milne, 2012). What's shaky: universal colour-emotion mappings ("blue = calm" for everyone). Even well-publicised lab effects such as "red impairs test performance" or "red makes people more attractive" have repeatedly **failed close replication**, and reviews flag possible publication bias. Popular claims like "62–90% of product judgments are based on colour" come from weak sources; don't rely on them. Colour meaning is **cultural**: white is bridal in much of the West and associated with mourning in parts of East Asia. Red signals luck and celebration in China. Red and green mean the opposite in some East Asian stock markets.

**Perceptual effects (more robust than emotional ones):**
- **Warm, saturated colours (red, orange, yellow) tend to advance**, and cool, desaturated colours (blue, grey) recede. Chromostereopsis exists, but its strength varies between people. RULE: put warm/saturated colours on foreground and CTA elements, and cool/muted ones on backgrounds and secondary panels.
- **Saturation and brightness contrast** pull the eye far more than hue identity does. RULE: one saturated element in a muted field wins (see §4).
- Fully saturated red text on saturated blue (or similar opponent pairs) **vibrates** and becomes hard to read. Never set saturated complementary colours directly against each other for text.

**Contextual associations** *(learned conventions, mainly Western/global-commercial. Treat them as defaults the user can override)*:
| Context | Conventional palette | Notes |
|---|---|---|
| Food / restaurants | Warm reds, oranges, yellows; fresh greens | Blue is rare in food (few blue foods) and reads as less appetising |
| Tech / software | Blues, violets, near-black, one vivid accent | Blue = reliability is a convention, not a universal emotion |
| Health / medical | Blues, teals, greens, lots of white | Avoid alarming reds except for emergencies |
| School / education | Primary or bright palettes for younger audiences; navy, maroon, forest green for formal/academic | Match the institution's colours when known |
| Finance / legal | Navy, dark green, grey, white | Red can signal loss in finance |
| Luxury | Black, white, gold/metallic, deep jewel tones; low saturation; lots of space | Luxury reads through **restraint** (space, fewer elements) as much as through hue |
| Urgency / sale / safety | Red, orange, yellow-black | Use for genuinely time-critical info only |
| Eco / nature | Greens, earth tones | |

**RULES**
- Brand or institution colours override all of the above.
- Palette: **1 dominant neutral + 1 secondary + 1 accent**. Check every text/background pair against §6 contrast.
- Don't claim or design around a specific emotional effect ("this blue will calm the reader"). Design for **contrast, fit to context and consistency**.

---

## 8. Persuasion for event fliers and notices

**The five questions** a viewer needs answered, in roughly this priority:
1. **What** is it? (Level 1/2)
2. **Why should I care?** The benefit to *me*. (Level 1/2)
3. **When?** Weekday, date, time. (Level 2)
4. **Where?** A specific place, with room number. (Level 2)
5. **How do I act?** Register, show up, scan, call, plus cost and deadline. (Level 3)

**Findings and evidence:**
- **Benefit-first headlines** ("Learn to code your own game in 2 hours") outperform feature- or label-first ones ("Coding Workshop"). This is a long-standing copywriting finding supported by A/B testing practice, though not one controlled study. RULE: the headline states the outcome for the reader. Put the event name in the subhead, unless the name is itself the draw (a known band or brand).
- **Social proof** (Cialdini; e.g. hotel towel-reuse messages that mention other guests worked better than environmental appeals, Goldstein et al. 2008): evidence moderate to strong. RULE: if a true number is available, use a specific one ("Join 240 students who attended last year") near the CTA. Never invent numbers or testimonials.
- **Scarcity and urgency** (e.g. Worchel's cookie-jar study, 1975): items in short supply are valued more. RULE: use only **real** deadlines and limits ("30 seats", "Register by Fri 7 Nov"), placed right next to the CTA in the accent colour. No fake countdowns, no "only 2 left" unless true.
- **A clear, single action** beats several options (choice overload is weaker than once claimed, but a single CTA is clearer). RULE: one primary CTA verb ("Register", "Scan to RSVP"). Make secondary contact info visually quieter.

**QR codes and URLs:**
- Minimum printed size **2 × 2 cm** for hand-held scanning. Otherwise use **side length ≈ scanning distance ÷ 10** (1 m away → 10 cm).
- Keep a **quiet zone of ≥ 4 modules** (blank margin) on all sides. Dark code on a light background. Don't invert, add low-contrast colours or crop it.
- Put it at the **end of the reading path** (bottom-right/bottom-centre) **next to a verb label** that says what scanning does ("Scan to register"). On wall posters, keep it at roughly 1.0–1.6 m from the floor, so never at the very bottom of a tall poster.
- Always add a **short human-readable URL** under or beside the QR (not everyone scans). Leave out "https://" and "www.".

**Flier layout template (sparse, Z-path):**
- Top 15–35% of `H`: the Level-1 headline or hero image, with the headline ≥ 8–12% of `H` in cap height on posters.
- Middle band: benefit subhead + when/where as a tight chunk.
- Bottom 20%: CTA + QR + URL at bottom-right. Logos/sponsors small at bottom-left.

---

## 9. Aesthetics, fluency, trust and memorability

**Findings:**
- **Aesthetic-usability effect** (Kurosu & Kashimura, 1995; Tractinsky, 1997): attractive interfaces are *perceived* as easier to use. **Web credibility** studies (Fogg et al., Stanford, early 2000s) found that the look of a site was the most-mentioned factor when people judged its credibility. Evidence: strong for the perception effect. It shapes first impressions, not actual competence.
- **Processing fluency** (Reber, Schwarz and colleagues): information that is easy to perceive (high contrast, clear type, clean layout) is judged **more true, more likable and more confident**. Statements in higher-contrast colours were rated true more often. Evidence: strong and widely replicated. Corollary: friction (low contrast, clutter, decorative fonts) quietly lowers trust.
- **Familiarity vs novelty, MAYA ("Most Advanced Yet Acceptable", Loewy)**: people prefer things that are new but still recognisable. Research on typicality and novelty in product design supports liking both at once. Evidence: moderate.
- **Memorability**: distinctive items are remembered (isolation effect). Pictures are remembered far better than words (picture superiority effect, strong). One concrete visual metaphor beats several generic decorations.

**RULES**
- **Familiar structure, one novel idea.** Use conventional layouts (headline top, CTA bottom, aligned grid, standard reading order) and spend novelty on **one** distinctive visual idea: an unexpected crop, an oversized numeral, a bold colour field, a visual pun tied to the message.
- That distinctive idea must **carry the message** (e.g. a huge "48h" for a hackathon), not decorate around it.
- Fluency first: high contrast, ≤ 2 typefaces, consistent alignment, generous space. Avoid decorative or script fonts for anything longer than ~4 words or anything that must be read at distance.
- Consistency signals care: identical styles for identical roles, identical spacing between equivalent items, no orphaned single words on headline lines (rebalance the breaks).
- Use real, relevant photos with people over generic stock imagery or clip art when available. Avoid images that clash with the message's tone.
- "Designed" and "trustworthy" overlap a lot. Polish matters most for notices that ask for money, personal data or attendance.

---

## 10. Slides and handouts that help people learn

**Mayer's multimedia learning principles** (Cambridge Handbook of Multimedia Learning; strong evidence, dozens of experiments). These are the ones that reduce wasted mental effort:

| Principle | Finding (median effect size, Mayer) | RULE |
|---|---|---|
| **Coherence** | People learn better when extraneous words, pictures and sounds are removed (supported in 23/23 tests, d ≈ 0.86). Interesting but irrelevant "seductive details" hurt learning | No decorative clip art, background photos or fun facts unrelated to the point. Every image must explain something |
| **Signalling** | Cues that highlight the essential structure help (d ≈ 0.4) | Use headings, numbering, arrows and the single accent colour to mark the key element of each slide. Put the takeaway in the title |
| **Redundancy** | Narration + graphics beats narration + graphics + identical on-screen text (d ≈ 0.86) | If a presenter speaks, slides carry **keywords and visuals, not the script**. Full sentences belong in handouts and speaker notes |
| **Spatial contiguity** | Words placed next to the part of the graphic they describe beat separated words (d ≈ 0.8) | Label diagrams **directly** on or next to the parts (within ~1 LH), not with a separate legend or key. Put chart labels at line ends. Put captions adjacent to their figure |
| **Temporal contiguity** | Showing the related words and picture at the same time helps | Build/animate a label together with the part it labels |
| **Segmenting** | Learner-paced chunks beat one continuous stream | One idea per slide. Split complex diagrams over several slides with progressive reveal |
| **Pre-training** | Learning key terms first helps | Put a definitions/key-terms box at the start of a handout section |
| **Multimedia** | Words + relevant pictures beat words alone | Pair each key concept with a relevant diagram, chart or photo |

**Assertion-evidence slide structure** (Alley and colleagues; evidence moderate, with gains in comprehension reported in engineering education): a **full-sentence headline stating the claim** (≤ 2 lines), supported by **visual evidence** (a chart, diagram or photo) instead of bullet lists.

**RULES for slides**
- Title = the takeaway sentence ("Enrolment doubled after the 2024 redesign"), top-left, 36–44 pt.
- Body: one visual + ≤ 3 short labels, or ≤ 6 lines of text. Never both a dense paragraph and a complex chart.
- Charts: highlight the one series or bar that matters in the accent colour and grey the rest. Label it directly. Delete gridlines and legends where direct labels work.
- Keep a consistent position for titles, page numbers and logos across slides, so viewers don't re-search each slide.

**RULES for handouts**
- Handouts carry the full sentences the slides left out. Layer-cake structure (descriptive headings), numbered steps for procedures, a summary box at the top or end.
- Diagram labels sit on the diagram. Figure and explanation share a spread or column; never make the reader turn a page to match text to figure.
- Leave writing space only if the handout is for note-taking. Make it obvious (lines, labelled boxes).

---

## 11. Attention audit (run on your own render)

Run these checks on the rendered image, not on your intentions. Fix any failure before you deliver.

1. **1-second test:** Look only at the blurred render (blur ≈ 1% of `W`). Is there **one** clear dominant element? Can you tell what kind of thing this is?
2. **3-second test:** From Level 1 + Level 2 alone, can a stranger answer *what, why care, when, where*?
3. **Reading path:** List the order your eye would take: face/contrast → largest → next. Does it match the intended order, and does it **end at the CTA**?
4. **Gaze and lines:** Do faces, arrows and diagonals point toward the headline/CTA and not off-canvas?
5. **One accent:** Is the accent colour used on ≤ 10% of the area and on only one primary target? Count the focal points (≤ 3, clearly ranked).
6. **Hierarchy ratios:** Headline ≥ 2× body (≥ 3× on posters)? No adjacent levels closer than 1.2×? ≤ 3–4 type sizes, ≤ 2 typefaces?
7. **Grouping:** Is space within groups ≤ ½ the space between groups? Do headings sit closer to their own text? Is every intended alignment pixel-identical?
8. **Load:** Within the word budget for this format (§5)? ≤ 4 chunks per region? One message (or one idea per slide)? Specifics instead of vague claims?
9. **Legibility:** Is the smallest text above the minimum for the viewing distance (§6 table; slides ≥ 18 pt, body ≥ 24 pt)? Contrast ≥ 4.5:1 body / 3:1 large text, measured against the worst part of any photo behind the text? Line length 45–75 characters? No long runs of caps, italics or thin weights?
10. **Colour safety:** Does meaning survive without colour (check in greyscale)? No red/green-only coding? No vibrating saturated complementary pairs behind text?
11. **Margins and safe zones:** Is all text inside a margin of ≥ 5% (slides/documents) or 6–10% (posters/social)? Is the QR quiet zone intact?
12. **Action:** Is there one CTA verb, placed at the end of the reading path, with QR ≥ 2 cm (or distance ÷ 10) plus a short URL, and real deadlines/limits next to it?
13. **Coherence:** Can any element be deleted without loss? If yes, delete it. Is the one distinctive idea carrying the message?
14. **Honesty:** Are all numbers, testimonials, scarcity and urgency claims true and supplied by the user?

---

### Key sources (for provenance; all findings above are paraphrased)
- Nielsen Norman Group: F-shaped pattern (2006, revisited 2017); text-scanning patterns (layer-cake, spotted, commitment).
- Treisman & Gelade (1980), feature-integration theory; Wolfe, guided search. Healey, research summaries on preattentive processing.
- Pieters & Wedel (2004), "Attention Capture and Transfer in Advertising", *Journal of Marketing* 68(2).
- Gaze cueing: Palcu, Sudkamp & Florack (2017), *Frontiers in Psychology*. Industry baby-gaze eye-tracking study (Breeze; reported secondhand, treat as indicative).
- von Restorff (1933), isolation effect. Cowan (2001), "The magical number 4", *Behavioral and Brain Sciences*.
- Mayer, *Multimedia Learning* and the Cambridge Handbook chapter on coherence, signalling, redundancy and spatial/temporal contiguity. Alley, assertion-evidence slides.
- WCAG 2.x contrast criteria. Tinker, on capitals and italics. Dyson, on line length. Piepenbrock et al. (2013), on display polarity.
- Elliot & Maier (2014), on colour-in-context theory, and replication failures of red effects (e.g. *Psychonomic Bulletin & Review* 2020 review; Gnambs et al. 2020). Labrecque & Milne (2012), on brand colour.
- Kurosu & Kashimura (1995); Tractinsky (1997); Fogg et al. (Stanford web credibility); Reber & Schwarz (1999), on fluency and judged truth.
- Cialdini, *Influence*; Goldstein, Cialdini & Griskevicius (2008), on social norms; Worchel, Lee & Adewole (1975), on scarcity.
