// The assignment's checklist: what the instructions ask for (length, number of sources, format), read from the brief
// with plain pattern matching (no Claude call), and checked live against the file. Anything Kea can't check by itself
// is a box the student ticks.

export type Req =
  | { id: string; kind: 'min-words'; n: number; text: string }
  | { id: string; kind: 'max-words'; n: number; text: string }
  | { id: string; kind: 'min-sources'; n: number; text: string }
  | { id: string; kind: 'manual'; text: string };

export type DocPart = { label: string; text: string };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
const num = (s: string): number => (/^\d/.test(s) ? parseInt(s.replace(/,/g, ''), 10) : NUMBER_WORDS[s.toLowerCase()] || 0);
const NUM = '(\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)';
/** About how many words fill a typed, double-spaced page. */
export const WORDS_PER_PAGE = 275;

/** The requirements an assignment's text states. Each is stated once, in the order they first appear. */
export function requirementsFrom(text: string): Req[] {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out: Req[] = [];
  const seen = new Set<string>();
  const add = (r: Req) => {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  };
  let m: RegExpExecArray | null;
  // Length in words: "at least 500 words", "500-750 words", "no more than 1,000 words".
  if ((m = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}\\s*words`, 'i').exec(t))) {
    add({ id: 'min-words', kind: 'min-words', n: num(m[1]), text: `At least ${num(m[1]).toLocaleString('en-US')} words` });
    add({ id: 'max-words', kind: 'max-words', n: num(m[2]), text: `No more than ${num(m[2]).toLocaleString('en-US')} words` });
  }
  if ((m = new RegExp(`(?:at least|minimum(?: of)?|no (?:fewer|less) than|min\\.?)\\s*${NUM}\\s*words`, 'i').exec(t))) add({ id: 'min-words', kind: 'min-words', n: num(m[1]), text: `At least ${num(m[1]).toLocaleString('en-US')} words` });
  if ((m = new RegExp(`(?:at most|no more than|maximum(?: of)?|max\\.?|not (?:to )?exceed|under|up to)\\s*${NUM}\\s*words`, 'i').exec(t))) add({ id: 'max-words', kind: 'max-words', n: num(m[1]), text: `No more than ${num(m[1]).toLocaleString('en-US')} words` });
  // Length in pages (a page is about 275 words).
  if (!seen.has('min-words') && (m = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}\\s*pages?`, 'i').exec(t))) {
    const lo = num(m[1]);
    const hi = num(m[2]);
    add({ id: 'min-words', kind: 'min-words', n: Math.round(lo * WORDS_PER_PAGE * 0.9), text: `About ${lo} to ${hi} pages` });
    add({ id: 'max-words', kind: 'max-words', n: Math.round(hi * WORDS_PER_PAGE * 1.1), text: `About ${lo} to ${hi} pages` });
  } else if (!seen.has('min-words') && (m = new RegExp(`${NUM}\\s*(?:-|\\s)?pages?(?:\\s+(?:long|in length|minimum))?`, 'i').exec(t)) && num(m[1]) > 0 && num(m[1]) < 60) {
    add({ id: 'min-words', kind: 'min-words', n: Math.round(num(m[1]) * WORDS_PER_PAGE * 0.85), text: `About ${num(m[1])} page${num(m[1]) === 1 ? '' : 's'}` });
  }
  // Sources: "at least three sources", "5 scholarly references", "a minimum of 4 peer-reviewed sources".
  if ((m = new RegExp(`(?:at least|minimum(?: of)?|no (?:fewer|less) than|use|cite|include|with)?\\s*${NUM}\\s+(?:[a-z-]+\\s+){0,3}(?:sources|references|citations)`, 'i').exec(t)) && num(m[1]) > 0 && num(m[1]) < 40) {
    add({ id: 'min-sources', kind: 'min-sources', n: num(m[1]), text: `At least ${num(m[1])} source${num(m[1]) === 1 ? '' : 's'} in the Works Cited` });
  }
  // Format.
  if ((m = /\b(MLA|APA|Chicago)\b/.exec(t))) add({ id: 'style', kind: 'manual', text: `Format and cite in ${m[1]}` });
  if (/\b(title page|cover page)\b/i.test(t)) add({ id: 'title-page', kind: 'manual', text: 'Include a title page' });
  if (/\b(thesis)\b/i.test(t)) add({ id: 'thesis', kind: 'manual', text: 'A clear thesis' });
  if (/\b(hand|turn|submit|upload)[a-z]*\s+(it\s+)?in\b|\bsubmit\b|\bdropbox\b/i.test(t)) add({ id: 'handin', kind: 'manual', text: 'Hand it in on the class site' });
  return out;
}

const HEAD = /^(works cited|references|bibliography|sources)$/i;

/** Where the Works Cited / References list starts in the file (an index into its parts), or -1. */
function citedAt(parts: DocPart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) if (HEAD.test(parts[i].text.trim())) return i;
  return -1;
}

/** How many words are in the file, not counting the Works Cited list. */
export function wordCount(parts: DocPart[]): number {
  const at = citedAt(parts);
  const body = at < 0 ? parts : parts.slice(0, at);
  return body.reduce((n, p) => n + (p.text.trim() ? p.text.trim().split(/\s+/).length : 0), 0);
}

/** How many entries are in the Works Cited / References list. */
export function sourceCount(parts: DocPart[]): number {
  const at = citedAt(parts);
  return at < 0 ? 0 : parts.slice(at + 1).filter((p) => p.text.trim().length > 12).length;
}

export type Status = { done: boolean; detail: string } | null;

/** Whether the file meets an automatic requirement now (null for a box the student ticks). */
export function check(req: Req, parts: DocPart[]): Status {
  if (req.kind === 'min-words') {
    const n = wordCount(parts);
    return { done: n >= req.n, detail: `${n.toLocaleString('en-US')} of ${req.n.toLocaleString('en-US')} words` };
  }
  if (req.kind === 'max-words') {
    const n = wordCount(parts);
    return { done: n <= req.n, detail: `${n.toLocaleString('en-US')} words (limit ${req.n.toLocaleString('en-US')})` };
  }
  if (req.kind === 'min-sources') {
    const n = sourceCount(parts);
    return { done: n >= req.n, detail: `${n} listed` };
  }
  return null;
}
