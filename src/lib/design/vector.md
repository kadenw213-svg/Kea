# SVG Art Cookbook: rich vector artwork for fliers, posters, slides and docs

How to hand-write SVG that Chromium turns into a high-resolution PNG (`<img src="data:image/svg+xml,...">`) and that looks illustrated and professional, not like a pile of rectangles and circles.

Every snippet below is a complete, self-contained `<svg>`. Most use a demo box of 600×400. When you use one, scale the numbers to the real target box. **Knobs** lists the parameters worth changing.

---

## 0. The core idea in one paragraph

Flat art looks basic because it has **one value per shape**: one colour, one edge, one light level. Professional vector art adds variation at three scales. Big: several overlapping colour fields and gradients. Medium: shading shapes, highlights and shadows on every object. Small: grain, texture, slightly irregular edges. Every recipe here adds one of those layers. A good piece usually stacks 4–7 of them: **base fill → colour fields → main shapes → shading/highlights → detail/ornament → texture → vignette**.

---

## 1. Ground rules (the render contract)

### 1.1 Skeleton

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" width="612" height="792" preserveAspectRatio="xMidYMid slice">
  <defs>
    <!-- gradients, patterns, filters, symbols: ids prefixed per artwork, e.g. "bg1-" -->
  </defs>
  <rect width="612" height="792" fill="#f6f1e7"/>
  <!-- layers, back to front -->
</svg>
```

- **`xmlns` is mandatory.** Without it an `<img>` data URL renders nothing. Use plain `href` on `<use>`, not `xlink:href` (Chromium supports plain `href`, so you don't need the xlink namespace).
- **viewBox = the target box in points.** For a full US Letter page, `0 0 612 792`. For a 13.33×7.5 in slide, `0 0 960 540`. For a 200×80 pt ornament, `0 0 200 80`. All your numbers then mean "points on the page", so stroke widths and grain size are predictable. The app picks the pixel size, and vectors stay sharp at any size.
- **preserveAspectRatio.** For backgrounds use `xMidYMid slice`: it fills the box and crops any overflow, so there are never empty bars. For ornaments and badges use `xMidYMid meet` (the default): the whole artwork is always visible. For stretchable textures and patterns use `none`, but only when distortion is harmless (noise, stripes). Never use `none` on circles or icons.
- **Bleed.** Background art should extend 2–4% past the viewBox edges (for example, blobs centred off-canvas). Then a `slice` crop or a later resize never shows a hard edge.
- **Size budget: under ~60 KB.** Round coordinates to integers, or 1 decimal place for small art. Reuse geometry with `<use>` and `<pattern>` instead of copying paths. A 200-element confetti field is about 10 KB, which is fine. 2,000 elements is not.
- **Unique ids.** Several SVGs can end up in one document (and possibly one DOM), so prefix every id per artwork (`hero-grain`, `hero-sky`). Never use generic `id="g1"` or `id="grad"`.
- **No external anything.** No `http:` URLs, no `<image>`, no `@import`, no `url()` pointing to files, no web fonts, no `<script>`, no `<foreignObject>`. Internal `<style>` blocks and internal `url(#id)` references are fine. Embedded raster `data:` images technically work but waste the budget. Draw instead.
- **Data-URL encoding.** `#` must reach the browser as `%23` (as in `url(#id)` and `#hex` colours), or the URL is cut off at the `#`. If the app uses `encodeURIComponent` or base64 this is handled. If you emit raw text, use `rgb()` colours or make sure the pipeline encodes.
- **Text.** Art should be **textless**. Headlines and body text go in the app's own text boxes, where they stay editable, searchable and sharp. If a glyph is part of the art (a big "50%" on a sticker or a monogram on a seal), use `font-family="sans-serif"`, `serif` or `monospace` with a bold weight, keep it short, and expect metrics to vary by machine. Better: build letters from paths or strokes.
- **Blend modes** (`mix-blend-mode`, `feBlend`) only blend **inside this SVG**. The image is flattened before it reaches the page, so you cannot multiply art onto a photo or onto text below it.
- **Filter cost.** Filters run per pixel at output resolution. A 612×792 page exported at 4× is about 2450×3170 px, so:
  - Use 1–3 filtered groups per artwork. Apply one filter to a `<g>`, not to 200 separate elements.
  - Keep `feTurbulence numOctaves` ≤ 4. Each octave costs a full pass, and octaves beyond 4 add little visible detail.
  - Prefer `stdDeviation` ≤ ~80 user units. For huge soft glows, use a **radial gradient fading to transparent** instead of blurring a shape. It is free and looks the same.
  - `feDisplacementMap`, `feConvolveMatrix` and lighting filters over a full-page area are the slowest. Restrict them with a filter region (`x/y/width/height`) or apply them to small elements.
  - Very large exports (beyond roughly 8000 px per side) risk filters being dropped or downsampled. If the art must survive that, rely on gradients and geometry.
- **Filter colour space.** Add `color-interpolation-filters="sRGB"` to every `<filter>`. The default (linearRGB) makes matrix and threshold math and blurred colours come out lighter than you planned.

### 1.2 Palette discipline

Pick **one dark, one light, 1–2 mid tones and one accent**, taken from the design's theme colours. Derive shading by moving hue and lightness together, not by adding black: shadows go cooler and more saturated, highlights warmer and lighter. Example for a coral object: base `#f06a5a`, shade `#c94459` (hue shifted toward magenta), highlight `#ffb59a` (shifted toward orange).

---

## 2. Rich backgrounds

### 2.1 "Mesh gradient" from stacked radial gradients

SVG has no real mesh gradients (`<meshgradient>` was never shipped by browsers). Fake one with 3–5 radial gradients, each fading from a colour to **the same colour at opacity 0**, over a pale base.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="mg-a" cx="12%" cy="18%" r="60%"><stop offset="0" stop-color="#ff9a8b"/><stop offset="1" stop-color="#ff9a8b" stop-opacity="0"/></radialGradient>
    <radialGradient id="mg-b" cx="88%" cy="12%" r="55%"><stop offset="0" stop-color="#8ec5ff"/><stop offset="1" stop-color="#8ec5ff" stop-opacity="0"/></radialGradient>
    <radialGradient id="mg-c" cx="72%" cy="95%" r="65%"><stop offset="0" stop-color="#9ff0c0"/><stop offset="1" stop-color="#9ff0c0" stop-opacity="0"/></radialGradient>
    <radialGradient id="mg-d" cx="20%" cy="88%" r="50%"><stop offset="0" stop-color="#ffd88a"/><stop offset="1" stop-color="#ffd88a" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="600" height="400" fill="#f3eefc"/>
  <rect width="600" height="400" fill="url(#mg-a)"/>
  <rect width="600" height="400" fill="url(#mg-b)"/>
  <rect width="600" height="400" fill="url(#mg-c)"/>
  <rect width="600" height="400" fill="url(#mg-d)"/>
</svg>
```

**Knobs:** `cx/cy` (put the centres near corners and edges, so the middle stays calm for text), `r` 40–80%, base colour, number of fields. Add a middle stop (`offset="0.4" stop-opacity="0.6"`) to make a field denser. With `objectBoundingBox` units (the default), the circles stretch into ellipses on wide boxes, which usually looks more natural. Use `gradientUnits="userSpaceOnUse"` with absolute `cx cy r` for true circles.

### 2.2 Blurred gradient blobs (softer, more "aurora")

Organic shapes under a heavy blur give flowing colour that circles cannot.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <filter id="bb-blur" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="55"/>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#101633"/>
  <g filter="url(#bb-blur)">
    <path d="M-40,120 C80,20 220,60 300,140 S470,260 640,180 L640,320 C500,360 360,300 240,330 S40,380 -40,300 Z" fill="#3b4cca" opacity="0.9"/>
    <ellipse cx="430" cy="110" rx="150" ry="80" fill="#c04df9" opacity="0.7"/>
    <ellipse cx="140" cy="300" rx="170" ry="70" fill="#14d4c4" opacity="0.55"/>
    <ellipse cx="520" cy="330" rx="110" ry="60" fill="#ff5f8f" opacity="0.5"/>
  </g>
</svg>
```

**Knobs:** `stdDeviation` (30 gives defined blobs, 80 gives pure haze), blob opacity, number of hues (3 is best). Always enlarge the filter region (`x="-50%" ... width="200%"`), or the blur is cut off in a hard rectangle.

### 2.3 Aurora ribbons

Wide, curved strokes, blurred and screen-blended over a dark sky.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="au-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050a1f"/><stop offset="1" stop-color="#11284a"/></linearGradient>
    <linearGradient id="au-band" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22ffb0" stop-opacity="0"/><stop offset="0.3" stop-color="#22ffb0"/><stop offset="0.7" stop-color="#5ab8ff"/><stop offset="1" stop-color="#b56cff" stop-opacity="0"/></linearGradient>
    <filter id="au-soft" x="-20%" y="-60%" width="140%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="600" height="400" fill="url(#au-sky)"/>
  <g filter="url(#au-soft)" style="mix-blend-mode:screen" fill="none" stroke="url(#au-band)" stroke-linecap="round">
    <path d="M-20,170 C120,90 260,210 380,130 S560,90 620,140" stroke-width="46" opacity="0.8"/>
    <path d="M-20,220 C140,150 280,260 420,190 S560,170 620,200" stroke-width="22" opacity="0.6"/>
  </g>
  <path d="M0,330 C120,310 200,340 300,325 S480,300 600,320 V400 H0 Z" fill="#030716"/>
</svg>
```

**Knobs:** stroke widths, curve control points, blur 10–30, band hues. Add a dark horizon silhouette (the last path) to ground the scene.

### 2.4 Grainy gradient (the modern poster look)

Noise blended into a gradient kills banding and adds a tactile, risograph feel. `fractalNoise` gives soft grain, and `baseFrequency` 0.6–0.9 gives fine grain at page scale. The colour matrix collapses the noise to grey and forces it opaque. Component transfer raises its contrast, soft-light blends it in, and arithmetic composite sets the strength.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="gg-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="0.5" stop-color="#e8467c"/><stop offset="1" stop-color="#5b3cc4"/></linearGradient>
    <filter id="gg-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" stitchTiles="stitch" seed="7" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1" result="mono"/>
      <feComponentTransfer in="mono" result="hard">
        <feFuncR type="linear" slope="2.4" intercept="-0.7"/><feFuncG type="linear" slope="2.4" intercept="-0.7"/><feFuncB type="linear" slope="2.4" intercept="-0.7"/>
      </feComponentTransfer>
      <feBlend in="hard" in2="SourceGraphic" mode="soft-light" result="blend"/>
      <feComposite in="blend" in2="SourceGraphic" operator="arithmetic" k1="0" k2="0.55" k3="0.45" k4="0" result="mix"/>
      <feComposite in="mix" in2="SourceAlpha" operator="in"/>
    </filter>
  </defs>
  <rect width="600" height="400" fill="url(#gg-fill)" filter="url(#gg-grain)"/>
</svg>
```

**Knobs:** `baseFrequency` (0.4 is coarse film grain, 1.2 is a fine sandy texture), `k2` (grain amount, 0.2–0.8, with `k3 = 1 − k2`), slope (contrast), blend mode (`overlay` for punchier grain, `multiply` for darker grit). `seed` changes the pattern deterministically.

**Cheaper alternative:** a separate grey-noise rect over everything at `opacity="0.06"`–`0.12` (see 2.6).

### 2.5 Paper texture

Lighting a low-frequency noise field gives fibrous, uneven paper.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="none">
  <defs>
    <filter id="pp-paper" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="4" seed="3" result="n"/>
      <feDiffuseLighting in="n" lighting-color="#fbf6ea" surfaceScale="1.6" result="lit">
        <feDistantLight azimuth="45" elevation="62"/>
      </feDiffuseLighting>
      <feComposite in="lit" in2="SourceAlpha" operator="in"/>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#f4eddc" filter="url(#pp-paper)"/>
</svg>
```

**Knobs:** `surfaceScale` (0.8 is subtle, 3 is crumpled), `baseFrequency` (0.02 gives mottled card, 0.3 gives fine felt), `elevation` (higher is flatter and lighter), `lighting-color` (tint toward cream, grey or kraft `#d9b98c`). For kraft paper, add a second layer of high-frequency speckle (`baseFrequency="0.9"`) at 5% opacity.

### 2.6 Noise overlay (universal finisher)

Put a separate top layer over any art. It is cheap to tune: just change its opacity.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="none">
  <defs>
    <filter id="no-n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#2d3b55"/>
  <rect width="600" height="400" filter="url(#no-n)" opacity="0.09" style="mix-blend-mode:overlay"/>
</svg>
```

**Knobs:** opacity: 0.04–0.08 on light art, 0.08–0.15 on dark art. Blend mode: `overlay` keeps the hue, `normal` gives a greyer, dustier look. Note that turbulence alpha is itself noisy, so the `feFuncA` table forces it opaque.

### 2.7 Vignette

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="none">
  <defs>
    <radialGradient id="vg-v" cx="50%" cy="48%" r="72%">
      <stop offset="0.55" stop-color="#1a0f08" stop-opacity="0"/>
      <stop offset="1" stop-color="#1a0f08" stop-opacity="0.45"/>
    </radialGradient>
  </defs>
  <rect width="600" height="400" fill="#c8a27a"/>
  <rect width="600" height="400" fill="url(#vg-v)"/>
</svg>
```

**Knobs:** the first stop's offset sets the clear centre (0.4–0.7), the end opacity sets the strength (0.2–0.6). Tint the vignette with the palette's darkest colour, not pure black.

### 2.8 Light leaks and lens glow

Warm, overexposed blooms from a corner, screen-blended.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="ll-a" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(40 30) rotate(25) scale(320 140)">
      <stop offset="0" stop-color="#fff2c4"/><stop offset="0.35" stop-color="#ff9a3c" stop-opacity="0.8"/><stop offset="1" stop-color="#ff3c6e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ll-b" cx="560" cy="380" r="220" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffd0f0" stop-opacity="0.7"/><stop offset="1" stop-color="#a05cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="400" fill="#23202b"/>
  <g style="mix-blend-mode:screen">
    <rect width="600" height="400" fill="url(#ll-a)"/>
    <rect width="600" height="400" fill="url(#ll-b)"/>
  </g>
</svg>
```

**Knobs:** `gradientTransform` rotation and scale (stretched, angled ellipses read as "leaks"), stop colours (amber, magenta, cyan), the corner it comes from. The middle stop at partial opacity creates the hot core plus coloured fringe.

### 2.9 Halftone

**A. Fading dot field (simple, cheap):** a dot pattern masked by a gradient.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <pattern id="hf-dots" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
      <circle cx="7" cy="7" r="3.2" fill="#1f2a5a"/>
    </pattern>
    <linearGradient id="hf-fade" x1="1" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <mask id="hf-m"><rect width="600" height="400" fill="url(#hf-fade)"/></mask>
  </defs>
  <rect width="600" height="400" fill="#f7efe2"/>
  <rect width="600" height="400" fill="url(#hf-dots)" mask="url(#hf-m)" opacity="0.5"/>
</svg>
```

**B. True halftone (dot size follows tone):** soft dots plus a grey "tone" layer added together, then thresholded. Wherever the tone is dark, dots swell and merge. The tone layer can be any greyscale drawing: a ramp, a blurred circle, a silhouette.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="ht-dot" r="71%"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#808080"/></radialGradient>
    <pattern id="ht-cells" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="12" height="12" fill="url(#ht-dot)"/>
    </pattern>
    <radialGradient id="ht-tone" cx="80%" cy="20%" r="90%"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#808080"/></radialGradient>
    <filter id="ht-th" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feComponentTransfer>
        <feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/>
      </feComponentTransfer>
      <feColorMatrix type="matrix" values="0 0 0 0 0.85  0 0 0 0 0.2  0 0 0 0 0.35  -1 0 0 0 1"/>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#fff4e0"/>
  <g filter="url(#ht-th)">
    <rect width="600" height="400" fill="url(#ht-cells)"/>
    <rect width="600" height="400" fill="url(#ht-tone)" style="mix-blend-mode:plus-lighter"/>
  </g>
</svg>
```

How it works: the dot value runs 0 at the cell centre to 0.5 at the corners, and the tone runs 0 (dark) to 0.5 (light). Their sum is below 0.5 inside a circle whose radius shrinks as the tone lightens. The discrete transfer function snaps the result to black or white. The final matrix sets the ink colour in the last column and turns white into transparency (`alpha = 1 − R`). **Knobs:** cell size (8 is fine print, 20 is bold pop-art), the pattern rotation (45° is classic), ink RGB in the last column (0–1 scale), the tone shape.

### 2.10 Line, dot and grid patterns

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <pattern id="pt-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24,0 H0 V24" fill="none" stroke="#2b4c7e" stroke-width="0.6" opacity="0.35"/>
    </pattern>
    <pattern id="pt-major" width="120" height="120" patternUnits="userSpaceOnUse">
      <path d="M120,0 H0 V120" fill="none" stroke="#2b4c7e" stroke-width="1.2" opacity="0.4"/>
    </pattern>
    <pattern id="pt-plus" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M20,16 V24 M16,20 H24" stroke="#e86a3a" stroke-width="1.5" stroke-linecap="round"/>
    </pattern>
  </defs>
  <rect width="600" height="400" fill="#eef3fa"/>
  <rect width="600" height="400" fill="url(#pt-grid)"/>
  <rect width="600" height="400" fill="url(#pt-major)"/>
  <rect x="360" width="240" height="400" fill="url(#pt-plus)"/>
</svg>
```

**Knobs:** tile size, stroke width 0.4–1.5, opacity 0.15–0.4. Use two scales of grid (minor and major) for a blueprint feel. Always use `patternUnits="userSpaceOnUse"` so tiles stay square on any box. Other motifs in the same tile structure: dot `<circle r="1.5">`, cross-hatch (two diagonal lines), triangles, little waves `M0,10 Q5,4 10,10 T20,10`.

### 2.11 Diagonal stripes

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <pattern id="ds-s" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
      <rect width="28" height="28" fill="#ffd23f"/>
      <rect width="11" height="28" fill="#1d1d2c"/>
    </pattern>
  </defs>
  <rect width="600" height="400" fill="url(#ds-s)"/>
</svg>
```

**Knobs:** rotation, tile width, stripe width ratio (11/28 here). For subtle paper ruling, use the same colour family at low contrast (`#f3efe6` with `#ebe5d8`). As a band, apply the pattern only to a clipped strip, such as a "caution tape" edge.

### 2.12 Topographic contour lines

Thresholded noise produces bands, and a 1-unit dilate outline turns band edges into contour lines. All of it is generative and deterministic through `seed`.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <filter id="tp-f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="3" seed="11" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.16  0 0 0 0 0.32  0 0 0 0 0.3  1 0 0 0 0" result="a"/>
      <feComponentTransfer in="a" result="bands">
        <feFuncA type="discrete" tableValues="0 1 0 1 0 1 0 1 0 1 0 1 0 1 0 1 0 1 0 1 0 1 0 1"/>
      </feComponentTransfer>
      <feMorphology in="bands" operator="dilate" radius="1.5" result="fat"/>
      <feComposite in="fat" in2="bands" operator="out"/>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#f1efe6"/>
  <rect width="600" height="400" filter="url(#tp-f)" opacity="0.7"/>
</svg>
```

**Knobs:** `baseFrequency` (0.003 gives broad hills, 0.012 busy terrain), the count of `0 1` pairs (more pairs give denser lines), `radius` (line weight; keep ≥ 1 output pixel, ≈1–2 units at page scale), ink colour in the matrix's last column, `seed`. Use `numOctaves="2"` for smoother, less broken lines. For a hand-drawn alternative, write 5–8 nested smooth closed paths (each a scaled, slightly perturbed copy of a blob from 3.1) and stroke them at 1 pt.

### 2.13 Layered waves

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <rect width="600" height="400" fill="#eaf6ff"/>
  <path d="M0,250 C100,215 180,285 300,250 S500,210 600,245 V400 H0 Z" fill="#9fd3f5"/>
  <path d="M0,290 C120,260 200,325 320,292 S520,262 600,290 V400 H0 Z" fill="#5aaee6"/>
  <path d="M0,330 C90,312 210,362 330,333 S530,305 600,332 V400 H0 Z" fill="#2c7cc4"/>
  <path d="M0,365 C140,350 230,388 360,368 S540,350 600,370 V400 H0 Z" fill="#164f8f"/>
</svg>
```

**Knobs:** stagger the phase of each wave (shift the crests) so the layers never line up. Darken and saturate toward the front. Use `S` after the first `C` so joins stay smooth. Add a thin white stroke (`stroke="#fff" stroke-opacity="0.4"`) on the top edge for a foam highlight.

### 2.14 Sunburst rays (one element)

A circle whose stroke is as wide as its diameter, with dashes measured through `pathLength`, gives perfectly even wedges.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="sb-fade" cx="300" cy="260" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="600" height="400" fill="#f28c28"/>
  <circle cx="300" cy="260" r="250" fill="none" stroke="url(#sb-fade)" stroke-width="500" pathLength="48" stroke-dasharray="1 1"/>
</svg>
```

**Knobs:** `pathLength` = 2 × ray count, the ratio `stroke-dasharray="1.4 0.6"` (wider rays), the centre (off-canvas centres look dynamic), `r` = half the stroke width so the rays reach the centre, the radial fade so rays dissolve outward. Rotate with `transform="rotate(7 300 260)"`.

### 2.15 Confetti (deterministic, hand-placed)

Never use a regular grid. Define 3–4 shapes once, then place them with varied position, rotation, scale and colour. Keep a **density gradient**: busy near the edges and corners, empty in the text zone.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <rect id="cf-r" x="-5" y="-2.5" width="10" height="5" rx="1"/>
    <circle id="cf-c" r="3.5"/>
    <path id="cf-s" d="M-9,0 q3,-5 6,0 t6,0 t6,0" fill="none" stroke-width="2.4" stroke-linecap="round"/>
    <path id="cf-t" d="M0,-5 L4.5,3 H-4.5 Z"/>
  </defs>
  <rect width="600" height="400" fill="#fffaf2"/>
  <g>
    <use href="#cf-r" fill="#ff5d73" transform="translate(32 40) rotate(20)"/>
    <use href="#cf-s" stroke="#3aa6ff" transform="translate(78 22) rotate(-30)"/>
    <use href="#cf-c" fill="#ffc53d" transform="translate(120 58)"/>
    <use href="#cf-t" fill="#5ed39a" transform="translate(54 96) rotate(40) scale(1.2)"/>
    <use href="#cf-r" fill="#7b61ff" transform="translate(160 18) rotate(-55)"/>
    <use href="#cf-c" fill="#ff5d73" transform="translate(18 150) scale(0.7)"/>
    <use href="#cf-s" stroke="#ffc53d" transform="translate(40 210) rotate(75)"/>
    <use href="#cf-r" fill="#3aa6ff" transform="translate(24 300) rotate(110) scale(0.9)"/>
    <use href="#cf-t" fill="#ff5d73" transform="translate(70 360) rotate(-20)"/>
    <use href="#cf-c" fill="#7b61ff" transform="translate(130 380) scale(1.3)"/>
    <use href="#cf-r" fill="#5ed39a" transform="translate(470 30) rotate(65)"/>
    <use href="#cf-s" stroke="#ff5d73" transform="translate(530 64) rotate(15)"/>
    <use href="#cf-c" fill="#3aa6ff" transform="translate(575 20)"/>
    <use href="#cf-t" fill="#ffc53d" transform="translate(560 130) rotate(-70)"/>
    <use href="#cf-r" fill="#ff5d73" transform="translate(585 220) rotate(-15) scale(1.1)"/>
    <use href="#cf-s" stroke="#7b61ff" transform="translate(548 300) rotate(-60)"/>
    <use href="#cf-c" fill="#5ed39a" transform="translate(500 372) scale(0.8)"/>
    <use href="#cf-r" fill="#ffc53d" transform="translate(420 385) rotate(35)"/>
  </g>
</svg>
```

**Knobs:** 15–40 pieces per 600 px width, 4–5 colours from the palette, scale 0.6–1.4. Rotate everything differently and never repeat the same angle twice in a row. For motion, add a few pieces at lower opacity (0.5) to suggest depth.

### 2.16 Bokeh

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="bk-bg" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#2a1a4a"/><stop offset="1" stop-color="#0b0716"/></radialGradient>
    <radialGradient id="bk-disc"><stop offset="0.7" stop-color="#ffd9a0" stop-opacity="0.35"/><stop offset="0.93" stop-color="#ffd9a0" stop-opacity="0.55"/><stop offset="1" stop-color="#ffd9a0" stop-opacity="0"/></radialGradient>
    <filter id="bk-far" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <rect width="600" height="400" fill="url(#bk-bg)"/>
  <g style="mix-blend-mode:screen" fill="url(#bk-disc)">
    <g filter="url(#bk-far)" opacity="0.6">
      <circle cx="90" cy="80" r="40"/><circle cx="510" cy="300" r="55"/><circle cx="380" cy="60" r="30"/><circle cx="200" cy="340" r="45"/>
    </g>
    <circle cx="60" cy="250" r="34"/><circle cx="140" cy="140" r="22"/><circle cx="460" cy="120" r="38"/>
    <circle cx="560" cy="60" r="18"/><circle cx="420" cy="350" r="26"/><circle cx="300" cy="380" r="16"/>
  </g>
</svg>
```

**Knobs:** disc colour (warm amber, or cool cyan for night), the ring stop at 0.93 (the brighter rim is what reads as "lens"), and blur on the far layer only. Size varies 3× between the smallest and largest disc. For a hexagonal aperture, replace the circles with rounded hexagons (3.4).

---

## 3. Shapes with craft

### 3.1 Organic blob (smooth cubic Béziers)

The rule for smooth curves: at every anchor, the incoming and outgoing control points lie **on one straight line through the anchor** (collinear handles). With 4 anchors and handles about 0.55 × the radius long, you get a circle. Perturb the anchors and handle lengths to get a blob.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <linearGradient id="bl-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb199"/><stop offset="1" stop-color="#ff5e8a"/></linearGradient>
  </defs>
  <path d="M300,60 C380,60 450,110 445,195 C440,280 380,340 295,338 C210,336 150,290 155,200 C160,110 220,60 300,60 Z" fill="url(#bl-g)"/>
  <path d="M120,300 C150,250 230,262 238,305 C246,348 196,372 158,360 C120,348 100,330 120,300 Z" fill="#ffd36e" opacity="0.85"/>
</svg>
```

**Knobs:** 4–6 anchors. Handle length 0.4–0.7 of the local radius. Vary each anchor's radius by ±15–25% (more variation looks cartoony, less looks like a lumpy circle). Check collinearity: at an anchor P with incoming control A and outgoing control B, `P − A` and `B − P` should point the same way. Shortcut: use `S` for every segment after the first, which mirrors the previous handle automatically and is always smooth.

### 3.2 Wavy and curved section dividers

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 120" preserveAspectRatio="none">
  <path d="M0,50 C100,95 200,5 300,50 S500,95 600,50 V120 H0 Z" fill="#1e3a5f"/>
  <path d="M0,70 C120,105 220,35 320,70 S520,105 600,72 V120 H0 Z" fill="#2f5d8a" opacity="0.6"/>
</svg>
```

**Knobs:** amplitude (the control-point y offset), wavelength (the anchor spacing), layer count (1–3). Variants: a single swoop `M0,80 Q300,-20 600,80 V120 H0 Z`, a tilt `M0,90 L600,20 V120 H0 Z`, a peak `M0,120 L300,30 L600,120 Z`. `preserveAspectRatio="none"` lets one divider stretch across any width.

### 3.3 Torn paper edge

Irregular zigzag coordinates (never evenly spaced), plus a slight displacement for fibre, plus a soft shadow.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" preserveAspectRatio="none">
  <defs>
    <filter id="tr-f" x="-5%" y="-30%" width="110%" height="160%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="5" result="t"/>
      <feDisplacementMap in="SourceGraphic" in2="t" scale="5" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feDropShadow in="d" dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.25"/>
    </filter>
  </defs>
  <rect width="600" height="200" fill="#2c3e50"/>
  <path filter="url(#tr-f)" fill="#fbf8f1" d="M0,-10 H600 V92 L586,98 L571,90 L560,101 L541,95 L530,104 L512,93 L497,99 L480,91 L466,103 L449,96 L431,100 L418,90 L402,102 L385,95 L371,99 L352,89 L338,101 L321,96 L305,104 L290,92 L272,98 L259,90 L240,103 L226,95 L208,100 L195,91 L178,102 L160,94 L146,99 L129,90 L113,103 L97,96 L80,101 L66,92 L49,99 L33,91 L17,102 L0,95 Z"/>
</svg>
```

**Knobs:** step widths 10–20 with jitter, depth ±5–8, displacement `scale` 3–8. For an exposed paper core, draw a second, slightly lower edge in pure white under the coloured sheet.

### 3.4 Rounded polygons (the stroke trick)

Stroke the polygon in its own fill colour with `stroke-linejoin="round"`. The corner radius equals half the stroke width. The shape grows by that half-width too, so inset the points to compensate.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <polygon points="300,90 395,145 395,255 300,310 205,255 205,145" fill="#4b6cf0" stroke="#4b6cf0" stroke-width="36" stroke-linejoin="round"/>
  <polygon points="470,140 540,260 400,260" fill="#ff8a3d" stroke="#ff8a3d" stroke-width="24" stroke-linejoin="round"/>
</svg>
```

**Knobs:** stroke width = 2 × corner radius. For outline-only rounded shapes, use `fill="none"` with the real stroke and `stroke-linejoin="round"`. For precise radii on rectangles, just use `rect rx`.

### 3.5 Badges and seals: scalloped edge, starburst, rosette

The scallop is another `pathLength` trick: zero-length dashes with round caps produce evenly spaced dots, which merge into bumps around a disc.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <!-- scalloped seal -->
  <g transform="translate(160 200)">
    <circle r="100" fill="#c8102e"/>
    <circle r="100" fill="none" stroke="#c8102e" stroke-width="30" stroke-linecap="round" pathLength="24" stroke-dasharray="0 1"/>
    <circle r="82" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="1.5 4" opacity="0.8"/>
    <circle r="70" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.6"/>
    <path d="M0,-40 L10,-13.8 L38,-12.4 L16.2,5.3 L23.5,32.4 L0,17 L-23.5,32.4 L-16.2,5.3 L-38,-12.4 L-10,-13.8 Z" fill="#fff"/>
  </g>
  <!-- 20-point starburst with inner ring -->
  <polygon points="300,70 317.5,89.4 340.2,76.4 350.8,100.2 376.4,94.8 379.2,120.8 405.2,123.6 399.8,149.2 423.6,159.8 410.6,182.5 430,200 410.6,217.5 423.6,240.2 399.8,250.8 405.2,276.4 379.2,279.2 376.4,305.2 350.8,299.8 340.2,323.6 317.5,310.6 300,330 282.5,310.6 259.8,323.6 249.2,299.8 223.6,305.2 220.8,279.2 194.8,276.4 200.2,250.8 176.4,240.2 189.4,217.5 170,200 189.4,182.5 176.4,159.8 200.2,149.2 194.8,123.6 220.8,120.8 223.6,94.8 249.2,100.2 259.8,76.4 282.5,89.4" fill="#ffc531" stroke="#ffc531" stroke-width="6" stroke-linejoin="round" transform="translate(150 0)"/>
  <circle cx="450" cy="200" r="92" fill="none" stroke="#7a4b00" stroke-width="2.5" opacity="0.5"/>
</svg>
```

Starburst points: for `n` points, outer radius `R`, inner radius `r`, vertex `i` (0…2n−1) is at angle `−90° + i·180°/n` with radius `R` for even `i` and `r` for odd `i`. Compute them once (they are generic). Scale with `transform`.

**Knobs:** scallop count = `pathLength`, scallop size = stroke width. Sharper starburst: lower the inner/outer ratio to 0.75. Rosette: add two notched ribbon tails (3.6) hanging below. Craft details make seals read as "official": a dashed inner ring, a fine double ring, a slight radial gradient (lighter top-left).

### 3.6 Ribbon banner

The band in front, notched tails behind, and dark triangular **folds** that join them.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <polygon points="90,180 170,180 170,240 90,240 110,210" fill="#b3263e"/>
  <polygon points="510,180 430,180 430,240 510,240 490,210" fill="#b3263e"/>
  <polygon points="150,220 170,220 170,240" fill="#6e1022"/>
  <polygon points="450,220 430,220 430,240" fill="#6e1022"/>
  <rect x="150" y="160" width="300" height="60" fill="#e23b55"/>
  <rect x="150" y="160" width="300" height="8" fill="#fff" opacity="0.18"/>
  <rect x="150" y="212" width="300" height="8" fill="#000" opacity="0.12"/>
</svg>
```

**Knobs:** a curved band (top and bottom edges as matching `Q` arcs, e.g. `M150,170 Q300,140 450,170 V230 Q300,200 150,230 Z`), notch depth, the fold colour (about 40% darker). The top highlight and bottom shade strips give the band a gentle cylinder curve. Leave the band empty: the app puts the text box over it.

### 3.7 Arrows with style

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <marker id="ar-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M1,1 L8,5 L1,9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <path d="M90,300 C150,180 260,330 330,210 S450,110 520,150" fill="none" stroke="#2c2c54" stroke-width="5" stroke-linecap="round" marker-end="url(#ar-head)"/>
  <path d="M100,110 C160,80 220,80 270,105" fill="none" stroke="#ff6b4a" stroke-width="4" stroke-linecap="round" stroke-dasharray="0.1 12" marker-end="url(#ar-head)"/>
  <path d="M380,330 L470,330 L470,312 L520,345 L470,378 L470,360 L380,360 Z" fill="#30c48d" stroke="#30c48d" stroke-width="8" stroke-linejoin="round"/>
</svg>
```

**Knobs:** `context-stroke` makes the head inherit the line colour (supported in Chromium). If it ever renders black, hard-code the colour. Dotted trail: `stroke-dasharray="0.1 12"` with round caps. Block arrow: polygon plus the rounded-stroke trick. A hand-drawn arrow is a curved path with a slightly asymmetric open head drawn as two separate short strokes.

### 3.8 Underline swash and tapered brush shape

A taper comes from a **filled crescent** (two curves sharing their end points), not from a stroke.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160">
  <path d="M40,110 C180,70 380,62 560,84 C390,78 200,88 46,122 C38,124 34,114 40,110 Z" fill="#ff5a5f"/>
  <path d="M70,140 C220,118 360,116 520,128" fill="none" stroke="#ff5a5f" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
</svg>
```

**Brush stroke with texture:** anisotropic noise (low frequency along the stroke, high across it) roughens the edges and cuts dry-brush streaks.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200">
  <defs>
    <filter id="br-f" x="-10%" y="-60%" width="120%" height="220%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.35" numOctaves="3" seed="4" result="streak"/>
      <feDisplacementMap in="SourceGraphic" in2="streak" scale="14" xChannelSelector="R" yChannelSelector="G" result="rough"/>
      <feColorMatrix in="streak" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  4 0 0 0 -1.2" result="gaps"/>
      <feComposite in="rough" in2="gaps" operator="in"/>
    </filter>
  </defs>
  <path d="M60,110 C200,80 400,80 540,100" fill="none" stroke="#1b998b" stroke-width="44" stroke-linecap="round" filter="url(#br-f)"/>
</svg>
```

**Knobs:** `baseFrequency="X Y"` (X along the stroke and small, Y across and large; swap them for vertical strokes), displacement `scale` 6–20, the alpha row `4 0 0 0 -1.2` (raise the −1.2 toward −0.8 for fewer gaps). Use behind a heading for a highlighter mark (at 60–80% opacity, light colour).

### 3.9 Hand-drawn wobble lines

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">
  <defs>
    <filter id="wb-f" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="turbulence" baseFrequency="0.03" numOctaves="2" seed="2" result="w"/>
      <feDisplacementMap in="SourceGraphic" in2="w" scale="4" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <g filter="url(#wb-f)" fill="none" stroke="#2a2a2a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="60" y="60" width="200" height="140" rx="10"/>
    <rect x="63" y="57" width="197" height="145" rx="12" stroke-width="1.2" opacity="0.6"/>
    <circle cx="420" cy="130" r="70"/>
    <path d="M60,250 C200,240 380,262 540,248"/>
  </g>
</svg>
```

**Knobs:** `scale` 2–6 (above 8 it looks broken), `baseFrequency` 0.01–0.05. The doubled, slightly offset outline at lower opacity sells "sketched twice". Keep any text outside the filtered group.

---

## 4. Depth and lighting

### 4.1 Soft drop shadow, two layers (contact plus ambient)

Real shadows have a tight dark core and a wide faint spread. One blur looks cheap.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <filter id="sh-2" x="-30%" y="-30%" width="160%" height="180%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#1a2340" flood-opacity="0.25" result="s1"/>
      <feGaussianBlur in="SourceAlpha" stdDeviation="18"/>
      <feOffset dy="16" result="b"/>
      <feFlood flood-color="#1a2340" flood-opacity="0.18"/>
      <feComposite in2="b" operator="in" result="s2"/>
      <feMerge><feMergeNode in="s2"/><feMergeNode in="s1"/></feMerge>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#eef1f7"/>
  <rect x="180" y="100" width="240" height="170" rx="18" fill="#fff" filter="url(#sh-2)"/>
</svg>
```

**Knobs:** tint the shadow with the background's dark hue (never pure black on colour). Ambient blur 12–30 and offset 8–20. The filter region must include the downward offset (here `height="180%"`).

### 4.2 Long shadow (flat-design 45°)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <linearGradient id="ls-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d3b66" stop-opacity="0.45"/><stop offset="1" stop-color="#0d3b66" stop-opacity="0"/></linearGradient>
    <clipPath id="ls-clip"><rect width="600" height="400"/></clipPath>
  </defs>
  <rect width="600" height="400" fill="#1d6fb8"/>
  <g clip-path="url(#ls-clip)">
    <polygon points="230,130 370,130 650,410 650,560 510,560 230,270" fill="url(#ls-g)"/>
  </g>
  <rect x="230" y="130" width="140" height="140" rx="8" fill="#f9c80e"/>
</svg>
```

Build it from the shape's two extreme corners perpendicular to the light, extended along the shadow direction. **Knobs:** the angle (45° is the convention), the fade gradient, length (run it off-canvas).

### 4.3 Inner glow, inner shadow

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <filter id="ig-f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feFlood flood-color="#ffffff" flood-opacity="0.9"/>
      <feComposite in2="SourceAlpha" operator="out"/>
      <feGaussianBlur stdDeviation="10"/>
      <feComposite in2="SourceAlpha" operator="in" result="glow"/>
      <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="glow"/></feMerge>
    </filter>
  </defs>
  <rect width="600" height="400" fill="#251d3a"/>
  <circle cx="300" cy="200" r="120" fill="#7d4cdb" filter="url(#ig-f)"/>
</svg>
```

**Knobs:** use a dark flood plus `<feOffset dx="4" dy="6"/>` after the blur for an **inner shadow** (pressed or engraved look). Blur 4–20.

### 4.4 Highlights and speculars ("glossy object")

Layer, on top of the base fill: a **body gradient** (light top-left to dark bottom-right), a **rim shade** (a darker crescent on the shadow side), a **specular** (a small, sharp white ellipse with a fade) and a **reflected light** (a faint lighter band at the bottom edge, which bounces from the ground).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <radialGradient id="gl-body" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#7fd4ff"/><stop offset="0.6" stop-color="#2a86e0"/><stop offset="1" stop-color="#173f9c"/></radialGradient>
    <linearGradient id="gl-spec" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <radialGradient id="gl-floor"><stop offset="0" stop-color="#0b1d40" stop-opacity="0.35"/><stop offset="1" stop-color="#0b1d40" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="600" height="400" fill="#f1f5fb"/>
  <ellipse cx="300" cy="330" rx="120" ry="18" fill="url(#gl-floor)"/>
  <circle cx="300" cy="200" r="120" fill="url(#gl-body)"/>
  <path d="M300,80 A120,120 0 0 1 300,320 A100,120 0 0 0 300,80 Z" fill="#0b1d60" opacity="0.18"/>
  <ellipse cx="262" cy="128" rx="58" ry="30" fill="url(#gl-spec)" transform="rotate(-25 262 128)"/>
  <circle cx="232" cy="130" r="7" fill="#fff"/>
  <path d="M215,290 Q300,325 385,290" fill="none" stroke="#bfe6ff" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
</svg>
```

**Knobs:** the specular's position follows a single light direction for every object in the scene. Specular size controls the material: tiny and sharp reads as glossy, large and soft as satin. The floor contact shadow is a squashed radial gradient, which is cheaper and nicer than a blur.

### 4.5 Glass panel (faked in a flat image)

There is no backdrop to blur in a flattened image. **But if the background is part of the same SVG,** you can reuse it: clip a blurred copy of the background to the panel shape. That is a true frosted-glass effect. Then add a white tint, a gradient edge stroke and a top sheen.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <g id="gs-bg">
      <rect width="600" height="400" fill="#16123a"/>
      <circle cx="210" cy="150" r="110" fill="#ff5ea8"/>
      <circle cx="420" cy="270" r="130" fill="#3ad2ff"/>
      <circle cx="470" cy="90" r="60" fill="#ffd166"/>
    </g>
    <clipPath id="gs-clip"><rect x="150" y="110" width="300" height="190" rx="22"/></clipPath>
    <filter id="gs-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="16"/></filter>
    <linearGradient id="gs-edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0.4"/></linearGradient>
    <linearGradient id="gs-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.04"/></linearGradient>
  </defs>
  <use href="#gs-bg"/>
  <g clip-path="url(#gs-clip)"><use href="#gs-bg" filter="url(#gs-blur)"/></g>
  <rect x="150" y="110" width="300" height="190" rx="22" fill="url(#gs-sheen)"/>
  <rect x="150" y="110" width="300" height="190" rx="22" fill="#fff" fill-opacity="0.08" stroke="url(#gs-edge)" stroke-width="1.5"/>
</svg>
```

**Knobs:** blur 8–24, white tint 0.05–0.2, edge-stroke opacities. If the panel sits over a photo the SVG cannot see, use the fallback: a solid white fill at 15–25% plus the edge stroke and sheen, which reads as "glass" well enough.

### 4.6 Isometric block

Isometric axes run at ±30°. With a cube edge `s`, the horizontal offset is `s·0.866` and the vertical offset `s·0.5`. Three faces: top (lightest), left (mid), right (darkest).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <polygon points="300,140 386.6,190 300,240 213.4,190" fill="#8be0c9"/>
  <polygon points="213.4,190 300,240 300,340 213.4,290" fill="#3fb39a"/>
  <polygon points="300,240 386.6,190 386.6,290 300,340" fill="#23806f"/>
  <polyline points="213.4,190 300,140 386.6,190" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" opacity="0.6"/>
  <polygon points="300,152 365,190 300,228 235,190" fill="#fff" opacity="0.12"/>
</svg>
```

**Knobs:** face lightness ratio (top 100%, left about 70%, right about 50%), a light-edge highlight along the top ridges, an inset "lid" for a button or tray look. Stack and translate blocks along the iso axes: +x is `(86.6, 50)`, +y is `(−86.6, 50)` and up is `(0, −100)` per unit.

### 4.7 Parallax landscape with atmospheric perspective

Each ridge further back is **lighter, lower in contrast and closer to the sky colour**. Add a haze band between layers.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="ld-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcf9f"/><stop offset="0.6" stop-color="#ffb3a7"/><stop offset="1" stop-color="#e9a0c2"/></linearGradient>
    <linearGradient id="ld-haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd8c8" stop-opacity="0"/><stop offset="1" stop-color="#ffd8c8" stop-opacity="0.6"/></linearGradient>
  </defs>
  <rect width="600" height="400" fill="url(#ld-sky)"/>
  <circle cx="420" cy="170" r="48" fill="#fff4d6"/>
  <path d="M0,220 L60,190 L110,205 L170,160 L230,200 L290,175 L350,205 L420,165 L480,195 L540,170 L600,190 V400 H0 Z" fill="#e7a3b4"/>
  <rect y="180" width="600" height="80" fill="url(#ld-haze)"/>
  <path d="M0,260 C60,240 100,215 150,225 S240,265 300,240 S410,200 470,230 S560,255 600,240 V400 H0 Z" fill="#b97a9c"/>
  <rect y="230" width="600" height="70" fill="url(#ld-haze)" opacity="0.7"/>
  <path d="M0,300 C80,280 140,270 210,290 S330,320 400,295 S520,270 600,290 V400 H0 Z" fill="#7d4f7c"/>
  <path d="M0,345 C100,330 180,335 260,350 S440,365 600,340 V400 H0 Z" fill="#3e2a4f"/>
</svg>
```

**Knobs:** layer count 3–6. Back layers get sharp, jagged polylines (distant peaks), front layers smooth curves. Interpolate each layer's colour from the front colour toward the sky colour. Put small silhouettes (pine triangles, birds) only on the front layer.

---

## 5. Illustration styles

### 5.1 Flat illustration with shading shapes (the trophy)

Flat does not mean unshaded. Use a limited palette (3 tones per material), a **hard-edged shade shape** on one side, a **highlight strip** on the other, and a contact shadow.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <ellipse cx="300" cy="292" rx="85" ry="9" fill="#2b2140" opacity="0.18"/>
  <g fill="none" stroke="#e8a317" stroke-width="12" stroke-linecap="round">
    <path d="M244,112 C196,112 198,176 252,184"/>
    <path d="M356,112 C404,112 402,176 348,184"/>
  </g>
  <path d="M240,90 H360 V150 C360,200 330,225 300,228 C270,225 240,200 240,150 Z" fill="#ffc531"/>
  <path d="M300,90 H360 V150 C360,200 330,225 300,228 Z" fill="#e8a317"/>
  <rect x="256" y="102" width="10" height="72" rx="5" fill="#fff" opacity="0.55"/>
  <rect x="236" y="84" width="128" height="12" rx="6" fill="#ffd866"/>
  <rect x="290" y="226" width="20" height="34" fill="#e8a317"/>
  <rect x="268" y="256" width="64" height="12" rx="3" fill="#ffc531"/>
  <rect x="248" y="266" width="104" height="24" rx="4" fill="#5b3d8a"/>
  <rect x="248" y="266" width="104" height="6" rx="3" fill="#fff" opacity="0.15"/>
  <path d="M300,128 L307,143 L323,144 L311,154 L315,170 L300,161 L285,170 L289,154 L277,144 L293,143 Z" fill="#fff" opacity="0.85"/>
</svg>
```

**The same anatomy works for any object:** cupcake (a trapezoid wrapper with vertical pleat lines in the shade colour, a frosting built from 3 stacked blobs, a cherry circle with a white dot highlight), book (front cover rect, page block as a cream strip with 2–3 thin lines, spine shade), beaker (a flask path, liquid as a clipped copy of the flask filled to a wavy line, bubbles as circle outlines, a glass highlight strip), light bulb (a radial-gradient glow behind it), rocket, plant pot.

### 5.2 Cupcake (composition from primitives)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs><clipPath id="cc-wrap"><path d="M222,222 H378 L360,320 H240 Z"/></clipPath></defs>
  <ellipse cx="300" cy="324" rx="80" ry="8" fill="#3a1f2b" opacity="0.15"/>
  <path d="M222,222 H378 L360,320 H240 Z" fill="#4fb6c2"/>
  <g clip-path="url(#cc-wrap)" stroke="#2f8b97" stroke-width="5">
    <path d="M246,222 L256,320 M270,222 L276,320 M294,222 L296,320 M318,222 L316,320 M342,222 L336,320 M366,222 L356,320"/>
    <rect x="300" y="222" width="80" height="100" fill="#000" opacity="0.1" stroke="none"/>
  </g>
  <path d="M210,226 C200,196 230,178 252,186 C256,160 290,150 306,168 C326,150 362,160 360,188 C388,184 400,214 388,228 Z" fill="#ffb3c7"/>
  <path d="M232,198 C262,214 330,214 374,196 C388,212 380,226 388,228 H210 C204,214 214,200 232,198 Z" fill="#f48aa8"/>
  <path d="M252,186 C256,170 274,162 290,166" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity="0.7"/>
  <path d="M302,150 C306,138 316,130 326,128" fill="none" stroke="#5a8f3e" stroke-width="4" stroke-linecap="round"/>
  <circle cx="300" cy="160" r="16" fill="#e0233d"/>
  <circle cx="294" cy="154" r="4.5" fill="#fff" opacity="0.85"/>
  <g fill="#fff8c2"><rect x="240" y="200" width="9" height="3" rx="1.5" transform="rotate(30 244 201)"/><rect x="330" y="182" width="9" height="3" rx="1.5" transform="rotate(-40 334 183)"/><rect x="286" y="206" width="9" height="3" rx="1.5" transform="rotate(70 290 207)"/><rect x="356" y="210" width="9" height="3" rx="1.5" transform="rotate(10 360 211)"/></g>
</svg>
```

### 5.3 Line art and icon sets (consistency rules)

One stroke width (2 on a 24 grid, or 3 on a 48 grid), one cap and join style (`round`/`round`), one corner radius, the same optical size (circles slightly larger than squares), and 2 px of padding inside the grid. Mix in one accent fill per icon for a "duotone icon" style.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200">
  <g fill="none" stroke="#24305e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(76 76)">
      <rect x="8" y="10" width="32" height="30" rx="5" fill="#ffd166" fill-opacity="0.5"/>
      <path d="M8,19 H40 M16,6 V13 M32,6 V13"/>
      <path d="M16,28 h3 M23,28 h3 M30,28 h3 M16,34 h3"/>
    </g>
    <g transform="translate(276 76)">
      <path d="M24,6 C14,6 9,13 9,20 C9,26 13,29 16,33 V37 H32 V33 C35,29 39,26 39,20 C39,13 34,6 24,6 Z" fill="#ffd166" fill-opacity="0.5"/>
      <path d="M18,42 H30 M24,20 V30 M20,24 L24,20 L28,24"/>
    </g>
    <g transform="translate(476 76)">
      <path d="M8,12 C8,9 10,7 13,7 H35 C38,7 40,9 40,12 V28 C40,31 38,33 35,33 H20 L12,40 V33 H13 C10,33 8,31 8,28 Z" fill="#ffd166" fill-opacity="0.5"/>
      <path d="M16,17 H32 M16,24 H26"/>
    </g>
  </g>
</svg>
```

**Knobs:** grid size, stroke weight (thin at 1.5 is elegant, bold at 3.5 is friendly), accent-fill offset (shift the fill 2 px off the outline for a playful misregistered print look).

### 5.4 Geometric low-poly

Tile the area into triangles from a hand-placed vertex set. Shade each facet by its position relative to a light (lighter toward the top-left) and keep adjacent facets within ±8% lightness of each other.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <g stroke-width="0.5" stroke-linejoin="round">
    <polygon points="0,0 200,0 150,140" fill="#6fa8f5" stroke="#6fa8f5"/>
    <polygon points="0,0 150,140 0,180" fill="#5a98ec" stroke="#5a98ec"/>
    <polygon points="200,0 330,190 150,140" fill="#4f8de6" stroke="#4f8de6"/>
    <polygon points="200,0 420,0 330,190" fill="#5f9bee" stroke="#5f9bee"/>
    <polygon points="420,0 480,120 330,190" fill="#4683dc" stroke="#4683dc"/>
    <polygon points="420,0 600,0 480,120" fill="#3f7bd6" stroke="#3f7bd6"/>
    <polygon points="600,0 600,200 480,120" fill="#3470ca" stroke="#3470ca"/>
    <polygon points="0,180 150,140 230,300" fill="#4a86de" stroke="#4a86de"/>
    <polygon points="150,140 330,190 230,300" fill="#3e79d2" stroke="#3e79d2"/>
    <polygon points="330,190 400,330 230,300" fill="#336cc4" stroke="#336cc4"/>
    <polygon points="330,190 480,120 400,330" fill="#3870cb" stroke="#3870cb"/>
    <polygon points="480,120 600,200 400,330" fill="#2c62b8" stroke="#2c62b8"/>
    <polygon points="600,200 600,400 400,330" fill="#2456a8" stroke="#2456a8"/>
    <polygon points="0,180 230,300 0,400" fill="#3b74cc" stroke="#3b74cc"/>
    <polygon points="0,400 230,300 220,400" fill="#2f66bc" stroke="#2f66bc"/>
    <polygon points="230,300 400,330 220,400" fill="#295daf" stroke="#295daf"/>
    <polygon points="220,400 400,330 600,400" fill="#1f4f9c" stroke="#1f4f9c"/>
  </g>
</svg>
```

The thin same-colour stroke hides anti-aliasing seams between facets. **Knobs:** vertex jitter (avoid a visible grid), palette ramp (2 hues for a sunset low-poly), facet density (finer near the focal area).

### 5.5 Retro sun and synthwave horizon

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="rs-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b0a3a"/><stop offset="1" stop-color="#5a1a6e"/></linearGradient>
    <linearGradient id="rs-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe45e"/><stop offset="0.55" stop-color="#ff7b54"/><stop offset="1" stop-color="#ff2e88"/></linearGradient>
    <mask id="rs-cut">
      <rect width="600" height="400" fill="#fff"/>
      <g fill="#000"><rect y="196" width="600" height="3"/><rect y="212" width="600" height="5"/><rect y="230" width="600" height="7"/><rect y="250" width="600" height="9"/></g>
    </mask>
  </defs>
  <rect width="600" height="400" fill="url(#rs-sky)"/>
  <circle cx="300" cy="200" r="100" fill="url(#rs-sun)" mask="url(#rs-cut)"/>
  <rect y="270" width="600" height="130" fill="#190b2e"/>
  <g stroke="#ff4fd8" stroke-width="1.5" opacity="0.7">
    <path d="M0,270 H600 M0,280 H600 M0,294 H600 M0,314 H600 M0,342 H600 M0,382 H600"/>
    <path d="M300,270 V400 M250,270 L140,400 M200,270 L-20,400 M350,270 L460,400 M400,270 L620,400 M275,270 L220,400 M325,270 L380,400"/>
  </g>
  <path d="M0,270 L70,232 L120,252 L190,214 L260,270 Z M340,270 L420,226 L470,248 L530,218 L600,250 V270 Z" fill="#2b1150"/>
</svg>
```

**Knobs:** the cut bars get thicker toward the bottom. Floor lines are spaced geometrically (each gap about 1.5× the last). Perspective lines all converge on the sun's centre-x at the horizon. Pastel version: cream sky, orange-to-coral sun, sage hills, no grid.

### 5.6 Botanical leaves and florals from Bézier petals

Define one petal or leaf at the origin, then rotate and scale copies with `<use>`. Vary scale and angle slightly per copy so the flower looks grown, not stamped.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs>
    <path id="fl-petal" d="M0,0 C-20,-22 -18,-62 0,-84 C18,-62 20,-22 0,0 Z"/>
    <g id="fl-leaf">
      <path d="M0,0 C25,-30 75,-32 110,0 C75,30 25,28 0,0 Z" fill="#4f9d69"/>
      <path d="M0,0 C25,-30 75,-32 110,0 C75,6 30,4 0,0 Z" fill="#6dbb84"/>
      <path d="M4,0 C40,-3 75,-2 104,0" fill="none" stroke="#2f6e46" stroke-width="2" stroke-linecap="round"/>
      <path d="M30,-1 L42,-14 M55,-1 L68,-15 M78,-1 L88,-11 M38,1 L50,13 M62,1 L74,13" stroke="#2f6e46" stroke-width="1.2" stroke-linecap="round" opacity="0.6"/>
    </g>
  </defs>
  <path d="M300,330 C296,280 304,240 300,205" fill="none" stroke="#3f7f55" stroke-width="5" stroke-linecap="round"/>
  <use href="#fl-leaf" transform="translate(300 290) rotate(-30) scale(0.9)"/>
  <use href="#fl-leaf" transform="translate(300 260) rotate(205) scale(0.75)"/>
  <g transform="translate(300 200)" fill="#ff8fab">
    <use href="#fl-petal" transform="rotate(0)"/><use href="#fl-petal" transform="rotate(45) scale(0.95)"/>
    <use href="#fl-petal" transform="rotate(90)"/><use href="#fl-petal" transform="rotate(135) scale(1.05)"/>
    <use href="#fl-petal" transform="rotate(180) scale(0.97)"/><use href="#fl-petal" transform="rotate(225)"/>
    <use href="#fl-petal" transform="rotate(270) scale(1.03)"/><use href="#fl-petal" transform="rotate(315) scale(0.96)"/>
  </g>
  <g transform="translate(300 200) rotate(22.5) scale(0.6)" fill="#ff5c8a">
    <use href="#fl-petal"/><use href="#fl-petal" transform="rotate(90)"/><use href="#fl-petal" transform="rotate(180)"/><use href="#fl-petal" transform="rotate(270)"/>
  </g>
  <circle cx="300" cy="200" r="16" fill="#ffd23f"/>
  <g fill="#e09b00"><circle cx="294" cy="196" r="2"/><circle cx="304" cy="194" r="2"/><circle cx="306" cy="204" r="2"/><circle cx="296" cy="206" r="2"/></g>
</svg>
```

**Knobs:** petal shape (wider handles give round petals, a notch at the tip `... L4,-80 L0,-74 L-4,-80 ...` gives a daisy), petal count 5–12, layering (a second smaller ring offset by half a step), palette (two tints of one hue plus a contrasting centre). For corner ornaments, arrange 3–5 leaves along a curved stem off the page corner. That makes a classic wedding or invitation frame.

### 5.7 Bauhaus and Memphis compositions

**Bauhaus:** a strict grid of squares, each filled with a quarter-circle, half-circle, circle or stripes, in a primary palette plus cream and black.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <rect width="600" height="400" fill="#f2e8d5"/>
  <path d="M0,200 V0 A200,200 0 0 1 200,200 Z" fill="#e63b2e"/>
  <rect x="200" width="200" height="200" fill="#1f3a93"/>
  <circle cx="300" cy="100" r="70" fill="#f2b705"/>
  <path d="M400,0 H600 V200 A200,200 0 0 1 400,0 Z" fill="#1d1d1d"/>
  <path d="M0,400 V200 H200 A200,200 0 0 1 0,400 Z" fill="#f2b705"/>
  <path d="M200,300 A100,100 0 0 1 400,300 Z" fill="#e63b2e"/>
  <g fill="#1d1d1d"><rect x="200" y="320" width="200" height="12"/><rect x="200" y="348" width="200" height="12"/><rect x="200" y="376" width="200" height="12"/></g>
  <circle cx="500" cy="300" r="100" fill="#1f3a93"/>
  <path d="M500,200 A100,100 0 0 1 500,400 Z" fill="#f2e8d5"/>
</svg>
```

**Memphis:** scattered squiggles, zigzags, dot patches, outlined triangles and half-circles in candy colours, with thick black strokes on a light base. Keep elements at the edges and give each one a different rotation.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <defs><pattern id="mp-dot" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="1.8" fill="#1d1d1d"/></pattern></defs>
  <rect width="600" height="400" fill="#fdf6ec"/>
  <rect x="20" y="20" width="110" height="80" fill="url(#mp-dot)"/>
  <path d="M40,330 q15,-25 30,0 t30,0 t30,0 t30,0" fill="none" stroke="#ff4f8b" stroke-width="7" stroke-linecap="round"/>
  <polyline points="470,40 490,70 510,40 530,70 550,40 570,70" fill="none" stroke="#1d1d1d" stroke-width="5" stroke-linejoin="miter"/>
  <polygon points="520,300 575,380 465,380" fill="none" stroke="#2bb5a6" stroke-width="7" stroke-linejoin="round" transform="rotate(12 520 340)"/>
  <path d="M150,60 A40,40 0 0 1 230,60 Z" fill="#ffc93c" stroke="#1d1d1d" stroke-width="4" transform="rotate(-18 190 60)"/>
  <circle cx="450" cy="200" r="16" fill="#7b5cff"/>
  <rect x="60" y="180" width="34" height="34" fill="#2bb5a6" stroke="#1d1d1d" stroke-width="4" transform="rotate(20 77 197)"/>
  <rect x="400" y="300" width="60" height="60" fill="url(#mp-dot)" transform="rotate(-10 430 330)"/>
</svg>
```

---

## 6. Frames, masks and overlays for images placed by the app

The SVG can't contain the user's photos, so art **frames** them and the app stacks the layers: photo underneath, SVG frame on top (or a tint over it).

### 6.1 Decorative frame with a transparent window

Use `fill-rule="evenodd"`: the outer shape minus the inner window. The hole is transparent in the PNG, so the photo below shows through.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500">
  <path fill-rule="evenodd" fill="#f7f1e3" d="M0,0 H400 V500 H0 Z M60,200 A140,140 0 0 1 340,200 V440 H60 Z"/>
  <path d="M60,200 A140,140 0 0 1 340,200 V440 H60 Z" fill="none" stroke="#b08d57" stroke-width="3"/>
  <path d="M48,200 A152,152 0 0 1 352,200 V452 H48 Z" fill="none" stroke="#b08d57" stroke-width="1"/>
  <g fill="#b08d57"><circle cx="200" cy="38" r="5"/><circle cx="182" cy="42" r="3"/><circle cx="218" cy="42" r="3"/></g>
</svg>
```

**Knobs:** window shape (arch, circle, blob from 3.1, a torn edge from 3.3, a hexagon), double keylines, corner ornaments (leaves from 5.6). **Tell the user or app the window's exact box** (here x 60–340, y 60–440) so the photo can be positioned under it.

### 6.2 Shape-mask cutters

If the app supports SVG as an image mask or crop shape, deliver a single black-on-transparent shape (blob, arch, rounded hexagon, wavy-edged circle) with the same viewBox as the image box. Keep it to one closed path, with no strokes or filters.

### 6.3 Duotone and tint overlays

A real duotone needs the photo's pixels, which the SVG can't reach. Approximate it with a separate **gradient overlay layer** that the app places over the photo at 35–65% opacity (or with a blend mode, if the app has one). Choose dark-to-light hues from the palette.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="none">
  <defs><linearGradient id="dt-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#2a1b6e"/><stop offset="1" stop-color="#ff6f61"/></linearGradient></defs>
  <rect width="600" height="400" fill="url(#dt-g)"/>
</svg>
```

Also useful: a **scrim** (a vertical gradient from transparent to 70% dark at the bottom) so white text over photos stays readable, and a **grain-plus-vignette layer** (2.6 + 2.7) to unify mixed photos.

---

## 7. Composition for art layers

- **Plan the text zone first.** Ask where the headline and body boxes go, and keep that region calm: low contrast, no small detail, no strong edges. Push detail to the **edges and corners**, and frame the text instead of competing with it.
- **The contrast budget.** Text needs contrast (4.5:1 for body, 3:1 for big headlines). Inside the text zone, keep background lightness variation within about ±10% L. A busy art layer under text needs a scrim, a solid panel or reduced opacity.
- **Textures at 4–15% opacity.** Grain 4–8%, paper 8–15% (or full opacity as a base), patterns 10–25%, halftone 20–50% as a decorative corner. If you can see the texture before you notice the design, it is too strong.
- **One focal point.** One large hero shape or illustration, supported by 2–3 secondary elements and small scattered accents. Sizes should step at roughly 1 : 0.6 : 0.35 : 0.15.
- **Palette consistency.** Take colours from the document's theme. Use one accent hue at most for small highlights. Neutrals should be tinted (warm grey `#e9e4dc`, cool grey `#e3e8ef`), never `#808080`.
- **Rhythm without monotony.** Repeat motifs with variation: the same leaf at 4 scales and 3 angles. Use odd counts (3, 5, 7). Avoid symmetry unless the design is formal, such as a certificate or seal.
- **Bleed and crop.** Shapes that run off the edge feel bigger and more dynamic than shapes floating fully inside. Crop large circles and blobs at the corners.
- **Light direction.** Pick one (usually top-left) and use it for every highlight, shadow and specular in the piece.
- **Layer order recipe for a poster background:** base gradient → colour fields (2.1/2.2) → large shapes or landscape → mid-ground accents (waves, rays at 20% opacity) → small details (confetti, dots) at the edges → grain (2.4/2.6) → vignette (2.7).
- **Slide backgrounds** (960×540): detail goes in a band along one edge or one corner, about 25–35% of the area. Leave the middle 60% plain.
- **Ornaments and dividers:** use a wide, short viewBox (for example 600×40), centre the symmetric motif, and fade both ends with a gradient-masked line.

---

## 8. Common mistakes and fixes

| Symptom | Cause | Fix |
|---|---|---|
| Blur or glow cut off in a hard rectangle | The default filter region is the bounding box plus 10% | Set `x="-50%" y="-50%" width="200%" height="200%"` on `<filter>`. For full-canvas textures use `x="0" y="0" width="100%" height="100%"` |
| Shadow clipped at the bottom | Offset falls outside the region | Make `height` big enough for `dy` plus 3× `stdDeviation` |
| Muddy grey middle in a gradient | Fading `#f00` to `transparent` (which is transparent *black*), or interpolating between complementary hues | Fade to the **same colour** at `stop-opacity="0"`. Add a bright middle stop between complements (blue→**violet**→orange, not blue→orange) |
| Grain or threshold looks washed out | Filters default to linearRGB | `color-interpolation-filters="sRGB"` |
| Lumpy or kinked curves | Handles not collinear at anchors, too many anchors, mixing `L` into curves | Fewer anchors, `S`/`T` to mirror handles, check `P−A ∥ B−P` |
| Pattern looks like wallpaper | Perfectly even repetition | Rotate the pattern (`patternTransform`), overlay two patterns of different periods, hand-place scattered elements, mask with a gradient |
| Confetti or bokeh looks fake | Same size, uniform spacing | Spread sizes 3×, use clusters plus gaps, put density near the edges, vary opacity |
| Neon overload | Saturating every colour | One saturated accent and muted supporting tones. Desaturate background layers by 20–40% |
| Text unreadable over the art | Busy detail behind text | Calm zone, scrim, panel, or drop the art to 30–50% opacity |
| Blank image | Missing `xmlns`, unencoded `#`, external URL, XML error (unescaped `&`, unclosed tag) | Check the skeleton, encode, escape `&` as `&amp;` |
| Art distorted on a different box | `preserveAspectRatio="none"` on figurative art | `slice` for backgrounds, `meet` for objects |
| Strokes thick or thin at random | `transform="scale()"` scales stroke widths | Draw at final size, or compensate the stroke width, or `vector-effect="non-scaling-stroke"` |
| Slow or failed render at large size | Big blur, high octaves, stacked full-page filters | Use gradients instead of blur, `numOctaves` ≤ 4, one filtered group, tight filter regions |
| Seams between adjacent shapes | Anti-aliasing at shared edges | Same-colour 0.5 stroke, or overlap shapes by 1 unit |
| Grain size differs between exports | Expected: `baseFrequency` is in user units, so grain scales with the art | Choose the frequency for the viewBox size: about 0.7 for page-sized boxes, about 1.2 for small badges |
| Blend mode "does nothing" to the page | The SVG is flattened into an image | Blend only between layers inside the SVG |
| Duplicate-id clashes | Generic ids across several artworks | Prefix ids per artwork |

### Quick self-check before emitting

1. `xmlns` present, viewBox equals the target box, correct `preserveAspectRatio`.
2. Every id is unique and prefixed, and every `url(#…)` points to an existing id.
3. Every `<filter>` has an explicit region and `sRGB`.
4. There are at least 4 of the 7 layers (base, fields, shapes, shading, detail, texture, vignette).
5. The text zone is calm, and detail sits at the edges.
6. The palette is drawn from the theme, with one accent, tinted neutrals and no grey gradient midpoints.
7. Under 60 KB, at most 3 filtered groups, `numOctaves` ≤ 4.

---

*Sources consulted (paraphrased): CSS-Tricks "Grainy Gradients"; Frontend Masters "Grainy Gradients" (baseFrequency, octaves, sRGB advice); fffuel gggrain (turbulence plus colour-matrix grain); Codrops "SVG Filter Effects: feDisplacementMap"; henry.codes "How to distort text with SVG" (channel selectors, scale tuning); MDN references for feTurbulence, feComponentTransfer, feDiffuseLighting, pattern, marker and pathLength.*
