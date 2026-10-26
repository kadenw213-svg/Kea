// Text as the phone's voice should say it: textbook PDFs come with ligatures, letter-spaced and capitalised headings,
// abbreviations and lost superscripts that a voice would otherwise spell out letter by letter or read wrong.

/** Abbreviations a sentence doesn't end at ("Fig. 3", "e.g. water"), and how some are said. */
const ABBREV = /(?:\b(?:Fig|Figs|Eq|Eqs|Ch|Sec|Vol|No|Nos|vs|approx|ca|cf|al|Dr|Mr|Mrs|Ms|St|Jr|Sr|Prof|Inc|Ltd|Co|etc|e\.g|i\.e|p|pp|min|max|avg|est|dept|univ|ed|eds)\.)$/i;
const SAY: [RegExp, string][] = [
  [/\be\.\s?g\.(?=\s|,|$)/gi, 'for example'],
  [/\bi\.\s?e\.(?=\s|,|$)/gi, 'that is'],
  [/\bFigs?\.\s?(?=\d)/g, 'Figure '],
  [/\bEqs?\.\s?(?=\d|\()/g, 'Equation '],
  [/\bCh\.\s?(?=\d)/g, 'Chapter '],
  [/\bSec\.\s?(?=\d)/g, 'Section '],
  [/\bapprox\./gi, 'approximately'],
  [/\bvs\./gi, 'versus'],
  [/\bet al\./gi, 'and colleagues'],
  [/\bpp\.\s?(?=\d)/g, 'pages '],
  [/\bp\.\s?(?=\d)/g, 'page ']
];

/** Whether the text before a full stop ends with an abbreviation (so it isn't the end of a sentence). */
export const endsWithAbbrev = (before: string) => ABBREV.test(before.slice(-12));

/** How a sentence is said: whole words, numbers and symbols as they're meant. */
export function spoken(t: string) {
  let s = t
    // Ligatures (ﬁ ﬂ ﬀ), full-width and compatibility characters as plain letters; soft hyphens and invisible marks out.
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\u2029/g, ' ')
    // Letter-spaced headings ("C H E 1 0 1 1", "C  E  L  L  S") as words, section numbers as numbers ("1. 1" → "1.1").
    .replace(/\b(?:[A-Za-z0-9] {1,3}){2,}[A-Za-z0-9]\b/g, (m) => m.replace(/ +/g, ''))
    .replace(/(\d)\. (\d)/g, '$1.$2')
    .replace(/\s*→\s*/g, ' gives ')
    .replace(/\s*⇌\s*/g, ' is in equilibrium with ')
    .replace(/\s*•\s*/g, '. ')
    // A power of ten loses its raised exponent in the text ("5 × 103"): said as it's meant.
    .replace(/× ?10([−-])?(\d{1,2})\b/g, (_m, minus, d) => `× 10 to the ${minus ? 'minus ' : ''}${d}`);
  for (const [re, to] of SAY) s = s.replace(re, to);
  // A heading in capitals ("THE CELL MEMBRANE") is said as words, not spelled: runs of two or more capitalised words
  // become ordinary case. A lone acronym (DNA, NADPH) stays as it is.
  s = s.replace(/\b[A-Z][A-Z'’-]{2,}(?:\s+[A-Z][A-Z'’-]+)+\b/g, (m) => m.toLowerCase().replace(/(^|\s)([a-z])/g, (_x, sp, c) => sp + c.toUpperCase()));
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** How long to pause after a piece (ms): longer after a heading or the end of a paragraph, none mid-paragraph. */
export function pauseAfter(raw: string) {
  if (/\u2029\s*$/.test(raw)) return 650;
  if (!/[.!?:;"”’)\]]\s*$/.test(raw)) return 500;
  return 0;
}
