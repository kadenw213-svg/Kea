// Leftover placeholders: "[Your name]", "[insert source]", "TODO", "add example here". Claude is told never to leave
// them in the paper (anything the student still has to fill in goes in a margin comment instead); this finds any that
// slip through, so Kea can move them into comments after Claude edits a document.

export interface Placeholder {
  /** The placeholder exactly as it is in the text. */
  quote: string;
  index: number;
}

// Square brackets around an instruction or a field to fill in. Not "[sic]", "[...]", "[1]" or a bracketed word added
// to a quotation ("[the city]"): only brackets that start with a fill-in word.
const FILL_WORDS =
  'your|insert|add|enter|type|fill|put|include|name|student|instructor|professor|teacher|course|class|date|title|source|citation|cite|author|quote|example|evidence|statistic|stat|detail|number|link|url|reference|page|todo|tbd|placeholder|xx+|\\?+|\\.\\.\\.\\s*\\w';
const BRACKETED = new RegExp(`\\[(?:${FILL_WORDS})\\b[^\\]\\n]{0,80}\\]`, 'gi');
const PATTERNS: RegExp[] = [
  BRACKETED,
  /\{\{[^}\n]{1,60}\}\}/g,
  /\b(?:TODO|TBD|FIXME)\b:?[^\n.]{0,60}/g,
  /\b(?:add|insert|include|put)\s+(?:an?\s+|the\s+|your\s+|more\s+)?(?:example|source|citation|quote|quotation|statistic|evidence|detail|transition|conclusion|introduction|name|date)s?\s+here\b/gi,
  /\bX{3,}\b/g,
  /\bLorem ipsum\b[^\n]*/gi
];

/** Every placeholder in the text, in order, without overlaps. */
export function findPlaceholders(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const quote = m[0].trim();
      if (quote) found.push({ quote, index: m.index });
    }
  }
  found.sort((a, b) => a.index - b.index || b.quote.length - a.quote.length);
  const out: Placeholder[] = [];
  let end = -1;
  for (const p of found) {
    if (p.index < end) continue;
    out.push(p);
    end = p.index + p.quote.length;
  }
  return out;
}

/** Placeholders in `after` that weren't in `before` (the ones Claude just added; the student's own stay theirs). */
export function newPlaceholders(before: string, after: string): Placeholder[] {
  const had = new Map<string, number>();
  for (const p of findPlaceholders(before)) had.set(p.quote, (had.get(p.quote) || 0) + 1);
  return findPlaceholders(after).filter((p) => {
    const n = had.get(p.quote) || 0;
    if (n > 0) {
      had.set(p.quote, n - 1);
      return false;
    }
    return true;
  });
}

/** The margin comment that replaces a placeholder: what's still needed there, in plain words. */
export function placeholderComment(p: Placeholder): string {
  const inner = p.quote.replace(/^\[|\]$|^\{\{|\}\}$/g, '').trim();
  return `Still to do: ${inner || p.quote}. Fill this in yourself, or delete it.`;
}
