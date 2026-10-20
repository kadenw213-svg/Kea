// Weekly study PDF template (CLAUDE.md invariant 41).
// Copied next to each week's main.typ by `academic-sync study-pdf-build`,
// so every PDF shares one look. Change the look here, never per PDF.
//
// Usage in main.typ:
//   #import "template.typ": *
//   #show: textbook.with(course: "BIO1112", course-name: "...", title: "...", week: "Oct 19 - 25, 2026")
//
// Text is selectable and never hyphenated or ligatured, so highlighting a
// word in a PDF reader (Kea's Encyclopedia) picks up the whole word.

#let accent = rgb("#1f3a5f")
#let accent-soft = rgb("#eaf0f7")
#let exam-color = rgb("#9a6400")
#let exam-soft = rgb("#fdf5e2")
#let warn-color = rgb("#9b2c2c")
#let warn-soft = rgb("#fbecec")
#let ok-color = rgb("#2f6b3a")
#let ok-soft = rgb("#edf6ee")
#let ink = rgb("#1b1b1b")
#let muted = rgb("#5b6470")
#let rule = rgb("#c9d1db")
#let sans = ("Segoe UI", "Arial", "Libertinus Serif")
#let serif = ("Libertinus Serif",)

// ---- inline pieces -------------------------------------------------------

// A key term where it is first explained. Bold + accent so it is easy to
// spot on a skim; still plain selectable text.
#let term(t) = text(weight: "bold", fill: accent)[#t]

// ---- boxes ---------------------------------------------------------------

#let callout(label, color, soft, body) = block(
  width: 100%,
  fill: soft,
  stroke: (left: 2.5pt + color),
  inset: (left: 12pt, right: 12pt, top: 9pt, bottom: 10pt),
  radius: (right: 3pt),
  breakable: false,
  above: 1.2em,
  below: 1.2em,
)[
  #text(font: sans, size: 8pt, weight: "bold", fill: color, tracking: 0.7pt)[#upper(label)]
  #v(-3pt)
  #body
]

// The one idea a section hinges on.
#let keyidea(body) = callout("Key idea", accent, accent-soft, body)
// What the week's exam/quiz/study guide stresses about this topic.
#let exam(body) = callout("On the exam", exam-color, exam-soft, body)
// A mistake students actually make.
#let pitfall(body) = callout("Common mistake", warn-color, warn-soft, body)
// A worked problem with every step shown.
#let example(title, body) = callout([Worked example · #title], ok-color, ok-soft, body)

// ---- figures -------------------------------------------------------------

// `credit` is required for anything not drawn for this PDF (Wikimedia
// Commons author + license, as printed by `study-pdf-image get`).
// Floats to the top/bottom of a page (placement: auto) so a big figure
// never strands half a page of white space; pass `placement: none` to pin it.
#let fig(path, caption: none, credit: none, width: 82%, placement: auto) = figure(
  image(path, width: width),
  placement: placement,
  caption: if credit == none { caption } else {
    [#caption #text(size: 7.5pt, fill: muted)[Image: #credit]]
  },
)

// ---- this week's work ------------------------------------------------------

// One due item: `when` like "Mon Oct 19, 11:59 pm", `what` its real title.
#let due(when, what, kind: none, body) = block(above: 0.9em, below: 0.9em, breakable: false)[
  #grid(
    columns: (1.25in, 1fr),
    column-gutter: 12pt,
    text(font: sans, size: 9pt, weight: "bold", fill: accent)[#when],
    [
      #text(weight: "bold")[#what]
      #if kind != none [#h(4pt)#text(font: sans, size: 7.5pt, fill: muted, tracking: 0.5pt)[#upper(kind)]]
      #if body != [] [\ #body]
    ],
  )
]

// ---- self-check ------------------------------------------------------------

// Retired: textbooks carry no practice questions or answer keys (the question bank and Quiz me do that). Kept so
// an older source still compiles; it draws nothing.
#let selfcheck(..pairs) = none

// ---- document --------------------------------------------------------------

#let textbook(course: "", course-name: "", title: "", week: "", body) = {
  set document(title: course + " · " + title, author: "Weekly study PDF")
  set page(
    paper: "us-letter",
    margin: (x: 0.95in, top: 0.95in, bottom: 0.9in),
    header: context {
      if counter(page).get().first() > 1 {
        set text(font: sans, size: 7.5pt, fill: muted)
        grid(columns: (auto, 1fr), [*#course*], align(right)[#title])
        v(-5pt)
        line(length: 100%, stroke: 0.4pt + rule)
      }
    },
    footer: context {
      set text(font: sans, size: 7.5pt, fill: muted)
      grid(columns: (1fr, auto), [#week], [#counter(page).display()])
    },
  )
  set text(font: serif, size: 11pt, fill: ink, lang: "en", hyphenate: false, ligatures: false)
  set par(justify: false, leading: 0.7em, spacing: 1.15em)
  set list(indent: 4pt, body-indent: 6pt, spacing: 0.75em)
  set enum(indent: 4pt, body-indent: 6pt, spacing: 0.75em)
  show math.equation.where(block: true): set block(above: 1em, below: 1em)

  show heading: set text(font: sans, fill: accent, hyphenate: false)
  // Each chapter starts a new page; the first level-1 heading (This Week)
  // stays on the cover page.
  show heading.where(level: 1): it => {
    if query(heading.where(level: 1).before(here())).len() > 1 { pagebreak(weak: true) }
    block(width: 100%, below: 1.3em)[
      #text(size: 20pt, weight: "bold")[#it.body]
      #v(-6pt)
      #line(length: 100%, stroke: 1.2pt + accent)
    ]
  }
  show heading.where(level: 2): it => block(above: 1.7em, below: 0.8em)[
    #text(size: 13.5pt, weight: "bold")[#it.body]
  ]
  show heading.where(level: 3): it => block(above: 1.3em, below: 0.6em)[
    #text(size: 11.5pt, weight: "bold", fill: ink)[#it.body]
  ]

  set table(
    stroke: 0.5pt + rule,
    inset: (x: 7pt, y: 5pt),
    fill: (_, y) => if y == 0 { accent-soft },
  )
  show table: set text(size: 9.5pt)
  show table.cell.where(y: 0): set text(font: sans, weight: "bold", size: 8.5pt)
  show figure: set block(above: 1.3em, below: 1.3em, breakable: false)
  set place(clearance: 1.4em)
  show figure.caption: set text(font: sans, size: 8.5pt, fill: muted)
  show link: set text(fill: accent)

  // Cover block + contents on page 1.
  block(width: 100%, fill: accent, inset: (x: 20pt, y: 18pt), radius: 4pt)[
    #set text(font: sans, fill: white)
    #text(size: 8.5pt, tracking: 1.2pt)[#upper(course) · #upper(course-name)]
    #v(6pt)
    #text(size: 22pt, weight: "bold")[#title]
    #v(2pt)
    #text(size: 10pt)[#week]
  ]
  v(6pt)
  text(font: sans, size: 8pt, fill: muted)[
    Study text written by Claude from your course's own chapter outline, objectives, vocabulary
    and this week's schedule. Your textbook and slides are the final word if anything disagrees.
  ]
  v(10pt)
  {
    show outline.entry.where(level: 1): set text(font: sans, weight: "bold", fill: accent)
    show outline.entry.where(level: 1): set block(above: 1em)
    text(font: sans, size: 8.5pt, weight: "bold", fill: muted, tracking: 1pt)[CONTENTS]
    outline(title: none, depth: 2, indent: 1.2em)
  }

  body
}
