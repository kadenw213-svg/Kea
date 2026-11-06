# Graphic Design Craft Guide (for placing elements by coordinate)

You design fliers, posters, slides, title pages, social posts, handouts and infographics by placing text boxes, shapes, images and SVG at exact coordinates (points, origin top-left). This guide is a set of rules and recipes. Where it gives numbers, use them unless you have a stated reason not to. Sources distilled: Müller-Brockmann (*Grid Systems*), Bringhurst (*Elements of Typographic Style*), Butterick (*Practical Typography*), Wathan & Schoger (*Refactoring UI*), Lupton (*Thinking with Type*), Material/Apple/Carbon design-system docs, WCAG 2.2, and editorial/poster practice.

Notation: `W`, `H` = page width/height; `S` = short side; `u` = base spacing unit.

---

## 0. The working method (do this every time)

1. **Write the message hierarchy first.** List every piece of content, then rank: **L1** (the one thing — headline or image), **L2** (what/when/where or subhead), **L3** (body, details), **L4** (fine print, logos, URL). There is exactly one L1. If two items both feel like L1, demote one.
2. **Pick an art direction** from §4 that matches audience and mood. Commit to its palette, type and layout recipe; don't mix directions.
3. **Set up the grid** (§1) and compute margins, columns, gutter, baseline unit as numbers before placing anything.
4. **Place L1 first**, big and off-centre (unless the direction is explicitly symmetric). Then L2 near it, then L3 in one column block, then L4 along an edge.
5. **Add detail last** (§5): one or two signature devices, not five.
6. **Render, look, critique** (§7), fix, repeat at least once.

---

## 1. Layout

### 1.1 Spacing unit and scale
- Choose `u` = **S / 100, rounded** to 4, 6 or 8 pt (Letter/A4 → 6 pt; 960×540 slide → 6 pt; 720 post → 8 pt or 6 pt).
- All gaps, paddings and margins are multiples of `u` from this scale: **1, 2, 3, 4, 6, 8, 12, 16, 24**. Never use arbitrary values like 13 or 27.
- **Proximity rule:** gap inside a group ≤ **½** the gap between groups. Label-to-value: 1–2u. Heading-to-its-body: 2–3u. Between sections: 6–8u. Headline cluster to everything else: ≥ 8u.
- Start with too much space, then remove. Crowding is the most common amateur tell.

### 1.2 Margins
- Outer margin **≥ 6–8% of S** for print and social; **≥ 5–7% of W** for slides (≈ 48–64 pt on 960×540).
- Print safe zone: keep all text ≥ 0.25 in (18 pt) inside the trim even if margin is otherwise tight; full-bleed images extend **9 pt (0.125 in)** past the trim.
- Classical/luxury pages: unequal margins, bottom largest. Proportion top : sides : bottom ≈ **1 : 1 : 1.5** (or 2 : 3 : 4 inner/top/outer/bottom for book-like pages).
- Posters and bold directions may let L1 type or images **break the margin to the bleed edge** deliberately — but everything else stays inside. One element breaks the grid; the rest obey it, which is what makes the break look intentional.

### 1.3 Grids
- **Column grid:** content width `C = W − 2·margin`. Columns: 12 for slides/landscape, 6 for portrait print, 4 for square social. Gutter `g` = 2–4u (≈ 12–24 pt). Column width = `(C − (n−1)·g) / n`. Text boxes and images start and end on column edges; spans like 7+5, 8+4 or 4+2 create asymmetry naturally.
- **Modular grid:** add rows: same formula on height. 6×8 portrait, 4×4 square, 12×6 slide. Images and colour blocks occupy whole modules (e.g. 4×3 modules). Swiss/infographic layouts live here.
- **Baseline grid:** set body leading as the unit (e.g. 10 pt type / 14 pt leading → 14 pt baseline). Place every text box top so first baselines land on multiples; make block heights multiples of it. Headline leading = an integer multiple of the baseline where possible (e.g. 42 pt = 3×14).
- **Hierarchical grid** (posters): define 2–3 key horizontal lines (e.g. at H × 0.38 and H × 0.72) and hang content from them. Shared lines across unrelated items create order.

### 1.4 Alignment
- Pick **one dominant alignment axis** (usually left edge of column 1 or of a chosen column). Aim for ≤ 3 distinct left edges on a page. Count them during critique.
- **Default to flush-left, ragged-right** text. Centre only for: symmetric formal directions (luxury, invitation, letterpress), short ≤ 3-line blocks, and slide title cards. Never centre body paragraphs over 3 lines. Never justify narrow columns (< 45 characters) — rivers.
- Right-align only numerals in tables and items hung on a right edge (page numbers, captions to the left of an image).
- Align text to **text baselines and cap heights**, not text-box edges. Text boxes contain internal padding and ascender space; when aligning type with a shape top, nudge the box up so the **cap height** touches the line (roughly box_top − 0.2 × font_size, depending on font).

### 1.5 Focal point, balance, scale contrast
- **One focal point.** L1 should be **≥ 3× the size of L2** on posters/fliers, ≥ 2× on slides. Size steps that are too close (e.g. 24 vs 20) read as indecision. Big jumps read as design.
- **Asymmetric balance:** a large dark/saturated mass on one side is balanced by smaller elements + more empty space on the other. Put L1 on a thirds line: x ≈ W/3 or 2W/3, y ≈ H/3 (or the golden 0.382). Visual centre sits slightly above the geometric centre (≈ 0.45H) — even "centred" things go there.
- **Negative space** is a shape: leave one large empty region (≥ 25–40% of page area on minimal/luxury, ≥ 15% on busy event fliers). Make it a clean rectangle-ish area, not leftover slivers.
- **Rule of thirds** for photos: put the subject's eye/key object on a thirds intersection; put text on the opposite, emptier side.

### 1.6 Avoiding the "everything centred, same size" look
Amateur signature: centred stack, 5+ similar sizes, stock-ish clip art in the middle, equal gaps everywhere, a border hugging the page edge. Fixes:
- Left-align on a grid; make L1 huge; make L4 tiny (8–9 pt print).
- Vary gaps intentionally (tight within groups, wide between).
- Give content a **container shape** (colour block spanning columns, full-bleed image half) instead of floating items on white.
- Use **at most 3–4 type sizes** on a page.
- Crop images large and off-edge instead of small and centred.

---

## 2. Typography

### 2.1 Type scale
Use a modular ratio from a base size `b`:
- **1.25** (major third) — dense documents, handouts, reports.
- **1.333** (perfect fourth) — slides, general fliers.
- **1.5–1.618** (perfect fifth / golden) — posters, social, title pages.
- Posters often skip steps: body → headline may be 6–12×.

Example (b = 11, ratio 1.333): 8.25, 11, 14.7, 19.6, 26, 35, 46, 62, 82. Round to whole points.

### 2.2 Size ranges by format (points)
| Format | L1 headline | L2 sub | L3 body | L4 fine print |
|---|---|---|---|---|
| Letter/A4 flier | 48–110 | 18–28 | 10–13 | 7.5–9 |
| Poster (tabloid+) scaled to Letter coords | 72–200 | 24–40 | 12–16 | 9–10 |
| Handout/report page | 24–36 (title) | 14–18 | 9.5–11.5 | 7.5–8.5 |
| Title page / cover | 40–96 | 16–24 | 11–13 | 8–9 |
| 16:9 slide 960×540 | 36–60 (title), 80–160 (statement/number) | 20–28 | 18–24 (never < 16) | 12–14 |
| Social 720×720 | 48–120 | 20–32 | 16–22 (never < 14) | 11–13 |

### 2.3 Families and pairings (Windows-installed)
Max **2 families** (a third only for code/numbers via Consolas). Prefer one family in several weights over two families. Pair by **contrast** (serif + sans, or wide-heavy display + quiet text), never two similar sans.

**Premium / modern feel:** Segoe UI (all weights incl. Light, Semilight, Semibold, Bold, Black), Segoe UI Variable, Bahnschrift (variable: Light→Bold, plus SemiCondensed and Condensed), Georgia, Sitka (Small/Text/Subheading/Heading/Display optical sizes), Cambria, Constantia, Corbel, Consolas, Calibri Light (used large).
**Neutral / usable with care:** Calibri (reads as "default Office" — fine for body, avoid as headline), Franklin Gothic (Medium/Demi/Heavy — great newsy, sports, editorial headlines), Candara (soft, friendly — kids/education), Trebuchet MS (web-2005 feel; okay for playful), Gabriola (decorative swash — invitations only, sparingly, ≥ 28 pt).
**Dated / cheap-reading unless used ironically:** Impact (meme feel), Arial Black (blunt; acceptable in neo-brutalism), Segoe Script / Comic Sans / Papyrus-style scripts (avoid; Segoe Script only for a single short signature-like accent), Times New Roman (looks like a default), Arial as headline.

**Pairing recipes:**
1. **Swiss modern:** Segoe UI Black/Bold headline + Segoe UI Regular body. Or Bahnschrift Bold headline + Segoe UI body.
2. **Editorial:** Georgia Bold or Sitka Display/Heading headline (tight) + Segoe UI or Corbel body; or reverse: Franklin Gothic Heavy headline + Georgia body.
3. **Condensed impact:** Bahnschrift Condensed Bold, ALL CAPS, huge + Bahnschrift SemiLight or Segoe UI body. Best poster combo on Windows.
4. **Luxury:** Sitka Display or Constantia, light/regular weight, wide-tracked caps for labels + Segoe UI Light body; or Georgia italic for an accent word.
5. **Academic/report:** Cambria headings + Calibri/Segoe UI body, or Constantia/Sitka Text body + Segoe UI Semibold headings.
6. **Friendly school:** Candara Bold or Segoe UI Black headline + Corbel/Candara body.
7. **Newsy/sports:** Franklin Gothic Heavy/Demi Cond headline + Franklin Gothic Book body.
8. **Tech/neon:** Bahnschrift (or Segoe UI) headline + Consolas for labels/data.

### 2.4 Tracking (letter-spacing)
- Display ≥ 48 pt: **−1% to −3%** (−0.01 to −0.03 em). Heavy condensed caps: −1% to 0. Very large (> 120 pt): up to −4%.
- Headlines 24–48 pt: 0 to −1.5%.
- Body: 0. Never track body text.
- **ALL CAPS / small labels** (eyebrows, tags, nav, buttons): **+8% to +15%** (+0.08–0.15 em); tiny (< 10 pt) caps up to +20%.
- Light weights tolerate more tracking than heavy weights.

### 2.5 Leading (line-height)
- Body: **1.3–1.5×** size (longer lines → more leading).
- Subheads: 1.2–1.3×.
- Headlines 2+ lines: **0.9–1.1×**; all-caps display can go to 0.85–0.95× because caps have no descenders. Check ascender/descender collisions.
- Paragraph spacing: 0.5–1× line height, or first-line indent of 1–2 em (not both).

### 2.6 Line length
- Body: **45–75 characters** (ideal ~66). In points ≈ 25–35 × font size. 11 pt → 280–380 pt wide column. On slides, ≤ 60 characters per line, ≤ 6 lines per block.
- Headlines: break lines by **meaning**, manually, aiming for a shape (lines of similar length or a deliberate long-short-long). Never leave a 1-word last line (widow/orphan) — rebreak or re-size.

### 2.7 All caps rules
- Caps only for: short headlines (≤ ~6 words), labels/eyebrows, buttons, metadata. Never paragraphs, never multi-line text below ~24 pt.
- Always track caps positively at small sizes; tighten slightly at big display sizes.
- Small caps-style labels: 70–80% of body size, +10% tracking, Semibold, maybe accent colour.

### 2.8 Hierarchy without size
Use **weight, colour, case, and space** before adding a new size:
- Primary text: near-black tinted neutral (e.g. #1A1D24). Secondary: ~60–65% contrast (#5B6170). Tertiary: ~45% (#8A8F9C) — but tertiary must still pass 4.5:1 for small text if it carries info (#6B7180 on white is ~5:1).
- On coloured backgrounds, don't use grey for secondary text; use a lighter/darker **tint of the background hue** or white at 70–80% opacity.
- De-emphasize with colour/size, not by dropping to Light weight at small sizes (thin + small = illegible).
- Bold a key phrase rather than enlarging it. One accent-coloured word in a headline beats a colour change on everything.

### 2.9 Pro details
- Real typographic characters: curly quotes “ ” ‘ ’, apostrophe ’, en dash – for ranges (7–9 PM), em dash — for breaks, × not x, ° , … single glyph, non-breaking space between number and unit / in "Oct 24".
- Numerals: lining numbers for headings/tables; tabular (monospace widths) in columns — Consolas or Segoe UI's default figures align fine; Georgia has old-style figures (great in body text, bad in tables).
- Times: "7 PM" or "7 pm" or "19:00", consistent; dates "Fri 24 Oct" — short, scannable.
- **Hanging punctuation:** opening quote mark on a large pull quote sits outside the text's left edge (shift box left by the quote's width ≈ 0.4–0.5 × font size) so letters align optically.
- **Optical overshoot:** round letters (O, C) and triangles look smaller — a circle icon should be ~5–8% larger than a square one to look equal.
- Eyebrow above headline: small caps label, tracked, accent colour, 2–3u above the headline.
- Kill double spaces, trailing spaces, underlines for emphasis (underline = link), and faux bold/italic.
- Logotype/brand words never stretched or squashed; never horizontally scale fonts — use a condensed cut (Bahnschrift Condensed).

---

## 3. Colour

### 3.1 Building a palette
- **60-30-10:** 60% dominant (background/neutral), 30% secondary (blocks, image areas, large type), 10% accent (CTA, key word, small shapes). Accent appears 1–3 times, not everywhere.
- Structure: **1 dominant hue + 1 accent + tinted neutrals.** Add a second accent only for data or playful directions.
- **Tinted neutrals:** never pure #000 or #808080 grey. Mix 3–8% of the dominant hue into neutrals. Dark text: #14161C (cool), #1C1712 (warm). Off-white backgrounds: #FAF8F4 (warm paper), #F4F6F9 (cool). Pure white is fine for clean corporate/Swiss, but off-white instantly reads as more considered.
- Build a 9-step ramp for the main hue (lightness ~97, 92, 85, 74, 62, 50, 40, 30, 20 in HSL/OKLCH terms) — use light steps for backgrounds/tints and dark steps for text on those tints. Increase saturation slightly toward the middle; shift hue slightly as it lightens (yellows/oranges warmer, blues toward cyan) to avoid dull ramps.

### 3.2 Contrast (WCAG 2.2)
- Small text (< 18 pt regular / < 14 pt bold): **≥ 4.5:1**. Large text: **≥ 3:1**. Non-text graphics that carry meaning (icons, chart lines): ≥ 3:1. Aim for **7:1** on body text for print and projection (projectors wash out contrast).
- Quick anchors: white on #767676 = 4.5:1; #595959 on white = 7:1. Saturated yellow/cyan/lime with white text fails — put dark text on them.
- Text over photos: add a scrim (gradient from 0% to 60–75% black/dark-hue under the text), or a solid block, or choose the photo's empty region. Check the busiest part behind the text.
- Don't rely on hue alone (red/green) for meaning; pair with labels/shape.

### 3.3 Harmonies
- **Monochrome** (one hue, many lightnesses): safest, most premium.
- **Analogous** (hues within ~30–60°): calm, natural, good gradients.
- **Complementary** (opposite): energy; use one as 90% and the other as a 10% accent; never equal amounts at full saturation (vibrates).
- **Split-complementary / triadic:** playful, kids, Bauhaus; desaturate two of the three or keep one dominant.

### 3.4 Extracting a palette from a reference image
1. Sample 5–8 points: largest background area, main subject, shadow region, highlight, and the most saturated small spot.
2. Dominant = largest area (often desaturate it further for backgrounds). Accent = the most saturated small colour. Text dark = the deepest shadow, darkened to L ≈ 12–18 and kept slightly tinted. Light neutral = brightest highlight pushed to L ≈ 95–97.
3. Check accent vs. background ≥ 3:1 and text vs. background ≥ 4.5:1; adjust lightness, not hue.

### 3.5 Dark vs light designs
- Dark: background is a deep tinted colour (#0E1116, #101826 navy, #1A1410 espresso), not #000. Body text off-white (#E8EAF0), not pure white (glare). Reduce saturation of accents slightly, or use neon-bright accents deliberately (cyber). Increase tracking on small light-on-dark text by ~+1% and weight by one step (Regular → Semibold-ish if thin).
- Light: easier for print and handouts; saves ink. Use dark directions for events at night, tech, music, luxury, cinema.

### 3.6 Gradients that look good
- Use **analogous hues** (≤ 60–90° apart): e.g. #FF5F6D → #FFC371, #4158D0 → #C850C0, #0BA360 → #3CBA92.
- Complementary gradients (blue → orange) pass through muddy grey in RGB. Fix: **add a middle stop** with a hue between them at high saturation (blue → violet/magenta → orange), or interpolate in OKLCH/LCH.
- Shift hue *and* lightness across the gradient (dark-saturated to light-warm), not just lightness of one hue (looks like a shadow).
- Large soft "mesh" look: 2–4 overlapping blurred circles (radial gradients 0→100% opacity to transparent, radius 40–70% of W) of analogous colours on a dark or saturated base.
- Add **2–4% noise/grain** over gradients to prevent banding and add tactility.
- Angle: 120–160° diagonals feel more dynamic than pure vertical/horizontal.

### 3.7 Colour and mood
| Mood | Palette cues |
|---|---|
| Trust, corporate, calm | navy #1B2A4A, blue #2F6FED, cool greys, white |
| Energy, sport, sale | red #E63946, orange #FF6B1A, black, yellow accent |
| Luxury | black/espresso/deep green #0F2A22 + cream #F3EDE2 + gold-ish #B8955A (flat ochre, no shiny gradients) |
| Nature, wellness | sage #A3B18A, moss #3A5A40, sand #E9E1D1, terracotta #C9734B |
| Playful, kids | saturated primaries/secondaries softened: #FF6B6B, #FFD93D, #6BCB77, #4D96FF on cream |
| Tech, futurist | near-black #0A0F1E + cyan #00E5FF + magenta #FF2E88 / acid lime #C6FF00 |
| Academic, serious | ink #1F2A44, oxblood #7A1F2B or forest #2D4A3E, paper #FAF7F0 |
| Retro 70s | mustard #E0A526, burnt orange #D9622B, brown #6B3E26, cream #F2E6CE, avocado #8A9A3B |

---

## 4. Art-direction catalogue

Each entry: **Use** · **Palette** · **Type** · **Layout** · **Signature** · **Pitfalls**.

**1. Swiss / International Typographic**
- Use: conferences, lectures, architecture, music programmes, anything information-led.
- Palette: white or off-white + black + one pure accent (red #E30613, or cobalt #0047BB).
- Type: Segoe UI Bold/Black or Bahnschrift, flush-left ragged-right, tight tracking for display, one family.
- Layout: modular grid (6×8 portrait). Headline huge, possibly rotated 90° or cropped by the edge. Info in small blocks hung on grid lines. Strong asymmetry.
- Signature: thin rules (0.5–1 pt) on grid lines, numbers as graphic elements, a single geometric shape (circle, bar) in accent.
- Pitfalls: centred text; decorative fonts; too many accents.

**2. Editorial magazine**
- Use: newsletters, feature handouts, reports, profiles, cover pages.
- Palette: paper #FAF8F4, ink #161616, one muted accent (oxblood, deep teal).
- Type: serif display (Georgia Bold, Sitka Display) tight-leaded + sans body or serif body; italic deck; caps eyebrow.
- Layout: 12/6-column, big image crop on 7–8 columns, text on the rest; pull quote spanning columns; drop cap 3 lines deep.
- Signature: hairline rules between columns, folio/issue line at top in tiny caps ("ISSUE 04 — OCTOBER 2026"), captions in italic 8–9 pt.
- Pitfalls: too many fonts; stretching images; centred everything.

**3. Bold modern gradient**
- Use: product launches, tech talks, social posts, apps.
- Palette: vivid analogous gradient (violet → pink → orange) or dark base with glowing blobs; white type.
- Type: Segoe UI Black or Bahnschrift Bold, very large, −2% to −3% tracking, sentence case.
- Layout: big headline left-aligned lower-left or upper-left; generous space; 1 product image/mockup overlapping.
- Signature: grain overlay 3%, soft glow, pill-shaped tag (radius = height/2).
- Pitfalls: grey midpoints; low text contrast on light gradient areas; rainbow gradients.

**4. Neo-brutalism**
- Use: student clubs, indie events, creative portfolios, playful startups.
- Palette: cream #FFF4E0 or white + black + 2 loud flats (yellow #FFD60A, pink #FF5DA2, blue #3D5AFE).
- Type: Arial Black / Segoe UI Black / Bahnschrift Bold caps; Consolas for labels.
- Layout: chunky boxes on a grid, slight intentional misalignment avoided — the rawness is in borders and shadows, not sloppiness.
- Signature: **2–4 pt black outlines** on every box, **hard offset shadows** (solid black, 0 blur, offset 4–8 pt down-right), stickers rotated ±3–8°.
- Pitfalls: mixing with soft shadows or gradients; too many colours; tiny text.

**5. Minimalist luxury**
- Use: galas, invitations, menus, premium products, certificates.
- Palette: deep black/green/navy or ivory #F5F0E6 + one metallic-feeling flat (#B8955A) used thinly.
- Type: Sitka Display / Constantia / Georgia in regular or italic, large but light; labels in caps +15–25% tracking at 8–10 pt.
- Layout: centred symmetry allowed; 35–50% empty space; margins 10–12% of S.
- Signature: hairline (0.5 pt) frame inset 4u from the edge, small ornament or monogram, very few words.
- Pitfalls: crowding; heavy weights; drop shadows; shiny gold gradients.

**6. Retro 70s**
- Use: music nights, food, vintage markets, summer events.
- Palette: mustard, burnt orange, brown, cream, avocado (see §3.7).
- Type: no Cooper-style font on Windows, so use Georgia Bold tightly tracked (−2%) for a chunky serif, or Franklin Gothic Heavy; Corbel/Segoe UI body.
- Layout: concentric stripes/rainbow arcs (3–5 bands, equal width), sunburst, centred or lower-third headline.
- Signature: parallel stripe bands with rounded ends, warm grain, slightly faded colours.
- Pitfalls: neon colours (wrong era); too many bands; pure black.

**7. Risograph / print grain**
- Use: zines, art shows, workshops, indie music.
- Palette: 2–3 riso inks: fluorescent pink #FF48B0, blue #0078BF, yellow #FFE800, teal #00838A on off-white paper.
- Type: Bahnschrift Condensed or Franklin Gothic, bold; small Consolas details.
- Layout: overlapping shapes with **multiply blend**, slight misregistration (offset a duplicate 1–3 pt).
- Signature: grain/halftone texture 8–15%, overprint colours where shapes overlap.
- Pitfalls: more than 3 inks; clean vector-perfect look (defeats the point); grain on small text.

**8. Bauhaus geometric**
- Use: art/design events, education, architecture, posters needing instant graphic punch.
- Palette: red #D62828, yellow #F7B801, blue #1D3557, black, cream.
- Type: Bahnschrift or Segoe UI Bold, lowercase or caps, grid-aligned, sometimes vertical.
- Layout: circles, quarter-circles, squares and triangles composed on a modular grid; text in a column beside.
- Signature: shapes cut by the edge, half-circle arches, solid flat colour, no gradients.
- Pitfalls: too many shapes (keep 4–8); random sizes not on the grid.

**9. Organic / blob**
- Use: wellness, community, sustainability, friendly brands.
- Palette: soft naturals (sage, peach #F6C6A8, clay, cream), low saturation.
- Type: Corbel/Candara or Segoe UI Semibold, sentence case, generous leading.
- Layout: 2–3 irregular blob SVGs (smooth cubic curves, 5–8 control points) behind content, bleeding off edges.
- Signature: rounded corners everywhere (consistent radius), hand-drawn line squiggles, leaves.
- Pitfalls: blobs behind text without enough contrast; too many blobs; mixing with sharp brutalism.

**10. Glassmorphism** (use rarely)
- Use: tech/app promos on a colourful background only.
- Palette: vivid gradient/blob background; cards white at 12–20% opacity, 1 pt white border at 30–40%, background blur.
- Type: Segoe UI Semibold, white.
- Layout: 1–3 floating cards over a gradient.
- Signature: frosted panel, subtle highlight on top edge.
- Pitfalls: **don't use** on white/flat backgrounds (invisible), for print (blur prints muddy), or for body text (contrast fails). If blur isn't supported, fake with a semi-opaque light tint.

**11. Duotone photo**
- Use: event posters with a photo, campaigns, speaker cards.
- Palette: map photo shadows → dark colour (#1B1464), highlights → light/vivid colour (#FF6F61). Text in the light colour or white.
- Type: heavy condensed sans caps (Bahnschrift Condensed Bold) overlapping the image.
- Layout: full-bleed photo; headline over the empty area; or photo on half, solid colour on the other half.
- Signature: two-colour image, big type crossing the subject (behind/in front layering).
- Pitfalls: low-contrast duotone pairs; busy photos; using >2 colours.

**12. Collage / cut-paper**
- Use: creative events, youth, culture, mixed-content announcements.
- Palette: paper tones + 2 brights + black.
- Type: mixed weights of one family plus a "label" look (black boxes with white text, Consolas).
- Layout: overlapping rotated (±2–6°) rectangles and cut-out images, torn-edge shapes (jagged SVG polygons), tape strips (semi-opaque rectangles at 40–60%).
- Signature: soft drop shadows under paper pieces (2–3 pt offset, 4–6 pt blur, 15–20% opacity), stickers, halftone dots.
- Pitfalls: chaos with no focal point — keep one dominant element and a clear reading order.

**13. Academic / clean report**
- Use: handouts, study guides, research summaries, lab reports, title pages.
- Palette: white/paper, ink navy #1F2A44, one accent (oxblood or teal) for headings and rules, light tint #EEF2F7 for callout boxes.
- Type: Cambria/Sitka/Constantia headings + Calibri/Segoe UI body, or the reverse; numbered headings.
- Layout: single 6-col grid, body 4–5 columns wide, margin notes in remaining column; baseline grid strictly.
- Signature: thin accent rule under the title, small caps running head, figure captions "Figure 1 —", tinted callout boxes with 3 pt left border.
- Pitfalls: Times/Calibri-default look, centred headings everywhere, clip art.

**14. Playful kids / school event**
- Use: school fairs, classroom handouts, family events.
- Palette: cream base + 3–4 cheerful flats softened (see §3.7); dark navy text, not black.
- Type: Segoe UI Black or Candara Bold headline, slightly rotated (−3°) or on a wavy baseline; Corbel/Candara body ≥ 12 pt.
- Layout: big headline in a sticker/badge shape, simple illustrations, info in rounded cards.
- Signature: confetti dots, stars, squiggles in consistent stroke width (3–4 pt, round caps), rounded radius 12–16 pt.
- Pitfalls: Comic Sans; rainbow on every letter; too many clip-art styles.

**15. Vintage letterpress**
- Use: craft fairs, rustic weddings, barbershop/coffee, heritage.
- Palette: cream #F2EAD8, ink black-brown #2A2420, red #A63A2B, maybe navy.
- Type: Georgia/Constantia caps for display, Franklin Gothic Demi Condensed or Bahnschrift Condensed, mixed sizes stacked centred, each line filling the measure.
- Layout: symmetric centred stack, lines justified to the same width by varying size, rules and stars between lines.
- Signature: double rules (2 pt + 0.5 pt), ornaments (★ ❦ ◆), banner ribbons, worn texture 5–10%.
- Pitfalls: too many novelty fonts; perfect digital crispness without texture.

**16. Cyber / neon**
- Use: gaming, hackathons, electronic music, tech nights.
- Palette: #0A0F1E / #07040F base, neon cyan #00E5FF, magenta #FF2E88, acid lime #C6FF00 (pick 2).
- Type: Bahnschrift (Condensed for display), Consolas for data/labels, caps tracked wide in labels.
- Layout: grid lines/perspective floor, HUD-style corner brackets, data readouts in corners.
- Signature: glow (2–3 stacked copies of a shape/text in the neon colour at 40%/20%/10% opacity, growing blur), scanline texture, chromatic offset (cyan/magenta copies shifted 1–2 pt).
- Pitfalls: glow on body text; >2 neons; low contrast secondary text.

**17. Nature / earthy**
- Use: environmental, outdoor, farmers' markets, wellness, gardening.
- Palette: moss, sage, sand, terracotta, bark brown #4A3B2C.
- Type: Sitka/Georgia headlines + Corbel/Segoe UI body; italic accents.
- Layout: big photo or leaf illustration bleeding off one side; text on a sand panel.
- Signature: botanical line art (single stroke weight), paper texture, organic edges.
- Pitfalls: green-on-green low contrast; generic leaf clip art.

**18. Corporate premium**
- Use: business proposals, investor slides, professional reports, recruitment.
- Palette: navy/ink #0F1B2D, white, one confident accent (electric blue #2F6FED or teal #0EA5A4), cool tinted greys.
- Type: Segoe UI (Semibold headings, Regular body), or Bahnschrift headings; numbers large and light (Segoe UI Light 72+ pt for KPIs).
- Layout: 12-col grid, generous margins, left-aligned headline + key number; consistent card system.
- Signature: one thin accent bar (4 × 40 pt) above headings, data as big numerals with tiny labels, subtle 1 pt dividers, single-weight line icons.
- Pitfalls: stock-photo handshake look, 3D charts, gradients on everything, clip art.

**19. Big-type statement (typographic poster)**
- Use: when there's no good image; quotes; announcements.
- Palette: two colours, high contrast (e.g. #FF4D00 on #F2EDE4, or cream on oxblood).
- Type: one heavy family; headline fills 70–90% of the width, lines broken for rhythm; tight leading 0.85–0.95.
- Layout: type is the image; small info in the corners on the margin grid.
- Signature: one word in outline (stroke only) or in accent colour; letters cropped by the edge.
- Pitfalls: unreadable crops (keep ≥ 70% of the key word visible); widows.

---

## 5. Detail techniques that read as "pro"

- **Layering and depth:** overlap at least one pair of elements (image over colour block by 2–4u; headline crossing an image edge). Overlap amounts should be decisive (≥ 10% of the smaller element), not 2 pt accidents.
- **Shadows:** soft, low and tinted: offset y = 2–8 pt, x = 0–2 pt, blur = 2× offset to 4× offset, opacity **8–18%**, colour = darkest tone of the palette not pure black. Two-layer shadow (small tight 1 pt/2 pt at 12% + large 12 pt/24 pt at 8%) looks most natural. Hard shadows only in brutalism/retro. Never use default heavy grey drop shadows on text.
- **Inner frames:** a hairline rectangle inset 3–5u from the page edge (luxury, letterpress, certificates). Inset and frame weight consistent on all sides.
- **Texture and grain:** noise at 3–6% opacity over large colour fields (blend multiply/overlay); paper texture 5–10% for vintage. Keep texture off small text.
- **Rules and ornaments:** rules 0.5–1 pt (hairline) for editorial, 2–4 pt for bold styles. A short rule (24–48 pt long, 2–3 pt thick, accent colour) under or above a headline is a cheap, strong detail. Ornaments (★ ◆ — • ❦) used as separators with 1–2u space each side.
- **Consistent corner radius:** pick one: 0 (Swiss, editorial, brutalism), 4–8 pt (corporate), 12–24 pt (friendly), full pill. Nested radii: inner radius = outer radius − padding.
- **Consistent stroke widths:** icons, illustrations, rules and outlines share 1–2 stroke weights (e.g. 1.5 pt icons, 0.75 pt rules). Icons from one style only (outline vs filled; not mixed).
- **Optical alignment:** shift round shapes, quotes, and letters like "T", "A", "V" slightly past the edge so they look aligned; vertically centre text in a button by cap height, not box height (usually move text down ~5–10% of its size in a pill).
- **Image treatment:** crop tight on the subject (faces fill ≥ 40% of the frame height for portraits); full-bleed or exact grid modules, never floating small; consistent treatment across all images (all duotone, all B/W, or all colour-graded); a solid colour block offset behind a photo (by 2–3u) adds depth.
- **Large vs tiny contrast:** a 120 pt headline next to 8 pt caps labels feels designed; mid-size everything feels generic.
- **Rhythm and repetition:** repeat one motif 3+ times at consistent spacing (e.g. three cards, numbered markers 01/02/03, dots on a timeline). Equal spacing in a repeated series is mandatory.
- **Numbers as design:** big numerals (dates, stats, step numbers) in display weight, with small labels — instant hierarchy and editorial feel.
- **Colour blocks over boxes:** prefer a solid colour field spanning columns or bleeding to the edge over a stroked box floating in the middle.
- **Edge tension:** elements either sit clearly inside the margin or clearly bleed off; never 3–10 pt from an edge (looks like a mistake).

---

## 6. Format playbooks

General one-second test: from arm's length (thumbnail size) the L1 must be readable and the purpose clear. Three-metre test (poster/slide): L1 and L2 readable; date/time/place readable from 1.5–2 m.

### 6.1 Letter flier — 612 × 792 pt (portrait)
- u = 6. Margin 42–48 pt (7–8% of 612). Content width 516–528. Grid: 6 columns, gutter 12 → col ≈ 76 pt.
- Template A (top image): image full-bleed top 0–380 (bleed −9 to 621); eyebrow at y≈410, headline 56–84 pt Bold at y≈430 spanning 6 cols; details block (date/time/place) 16–20 pt Semibold in cols 1–3 at y≈600; description 11–12 pt cols 4–6; footer line (logo, URL, 8–9 pt) baseline at y = 792 − 42.
- Template B (big type): headline 90–140 pt condensed caps, 2–4 lines, top-left at (42, 60); accent shape cut by the right edge; info grid at bottom third.
- Hierarchy order: L1 headline/image → L2 date+time+place → L3 description → L4 contact/logos. Date/time ≥ 18 pt.

### 6.2 A4 — 595 × 842 pt
- Same as Letter; margin 42–48 pt; more vertical room — move info block slightly lower and add 1–2u extra gaps. Grid 6×8 modules: module height ≈ (842 − 96 − 7·12)/8 ≈ 83 pt.

### 6.3 Poster (when the user specifies a large poster in Letter/A4 coordinates)
- Headline ≥ 12% of page height in cap height (≈ 100–180 pt). Body ≥ 12 pt. Max ~40 words of body. Readability from 3 m requires headline ≥ ~80 pt at Letter scale when printed at tabloid; date ≥ 24 pt.

### 6.4 16:9 slide — 960 × 540 pt
- u = 6. Margins 48 (sides) × 40 (top/bottom); safe title area top 40–110. Grid: 12 columns, gutter 18 → col ≈ 55 pt.
- Title 36–44 pt Semibold/Bold left-aligned at (48, 40); body 20–24 pt, ≤ 6 bullets, ≤ 8 words per bullet ideally; footer 11–12 pt at y≈510.
- Layouts: (a) title + one big visual (8 cols) + 4-col text; (b) statement slide: one sentence 48–64 pt across 9–10 cols, vertically at ~0.4H; (c) big number: 120–180 pt numeral + 18–20 pt label; (d) section divider: full-bleed colour, number "02" + title.
- One idea per slide. Readable from the back row: nothing < 18 pt that matters.
- Consistency across a deck: identical title position, margins, colours and footer on every slide.

### 6.5 Square social — 720 × 720 pt (exports 1080 px)
- u = 8. Margin 48–56 (7–8%). Grid 4 columns, gutter 16.
- Headline 56–96 pt, ≤ 7 words; supporting line 22–28 pt; handle/logo 12–14 pt at bottom margin. Text ≤ 20% of copy volume; feed thumbnails shrink to ~300 px — headline must still read.
- Keep critical content out of the outer 5% (crop/rounded previews) and avoid bottom-right corner clutter (UI overlays).
- Carousel: same grid, cover slide = big hook; continuing elements across slide edges reward swiping.

### 6.6 Title page / cover (report, assignment) — Letter or A4
- Asymmetric: title 36–64 pt at ~0.35H left-aligned on column 1 or 2, subtitle 16–20 pt 2–3u below, author/course/date block 10–12 pt at bottom-left margin, a single colour field or rule (e.g. 8 pt accent bar full width at top, or colour block covering the top 40%).
- Classic: centred title at 0.38H, hairline rules above/below, details at 0.85H.

### 6.7 Handout / one-page info sheet
- Margins 48–54 pt; 6-col grid; body 10–11 pt / 14–15 leading; headings 14–18 pt Semibold; callouts on tinted boxes (padding 2–3u, 3 pt left border accent); numbered steps with large numerals; scannable — every section has a heading, every paragraph ≤ 5 lines.

### 6.8 Infographic (tall or poster)
- Single reading path top → bottom or Z-pattern. Title + one-sentence takeaway on top. Sections numbered 01/02/03, each: big number/stat (48–96 pt), label (10–12 caps tracked), one sentence. Consistent icon set and chart styling (one hue + grey for "other"; label data directly instead of legends). Spacing between sections ≥ 2× spacing inside them.

---

## 7. Self-critique checklist (run after viewing the render)

Answer each; fix any "no" before finishing.

1. **Squint/blur test:** blurring the render, can you see exactly one dominant element, then a clear second? If two blobs compete, shrink one.
2. **One-second test:** at thumbnail size, is the purpose (what + when) clear?
3. **Hierarchy count:** ≤ 4 type sizes, ≤ 2 families, ≤ 3 text colours. L1 ≥ 2–3× L2.
4. **Alignment:** ≤ 3 left edges; every element on a column/module edge or deliberately centred on a shared axis. No near-misses (items 1–6 pt off a shared line).
5. **Margins:** all non-bleed content inside the margin; equal margins (or intentionally proportioned). Nothing awkwardly 3–10 pt from the trim.
6. **Spacing consistency:** all gaps from the scale; inside-group gaps ≤ ½ between-group gaps; repeated items equally spaced.
7. **Contrast:** body ≥ 4.5:1 (prefer 7:1), large ≥ 3:1; text over images has a scrim or clean area.
8. **Text quality:** no widows/orphans or single-word last lines in headlines; line length 45–75 chars; caps tracked; curly quotes, en dashes; no typos; no text overflowing or clipped by its box.
9. **Element budget:** could you remove one element and lose nothing? Then remove it. Typical max: 1 image, 1 signature device, 1–2 accent shapes.
10. **Colour discipline:** 60-30-10 respected; accent used ≤ 3 times; no pure black/grey unless the direction calls for it.
11. **Consistency:** one corner radius, one stroke weight family, one icon style, one image treatment.
12. **Generic-look test:** does it look like a default template (centred stack, Calibri headline, clip art, drop-shadowed WordArt, border at page edge, everything same size)? If yes, apply the direction's signature detail and push scale contrast harder.
13. **Overlaps:** intended overlaps are decisive; no accidental collisions of text with shapes or other text.
14. **Purpose check:** is the call to action / key info (date, place, URL) present, correct, and findable in < 3 seconds?
