// A class's paper format, read from its syllabus (and other class documents that say how papers are formatted):
// citation style, font, size, line spacing and margins. New documents linked to the class's assignments start in that
// format, and Claude is told it. Only what the text actually says is taken; nothing is guessed.

const FONTS = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Garamond', 'Helvetica', 'Verdana', 'Courier New', 'Book Antiqua'];

/** { style?: 'mla'|'apa'|'chicago', font?, sizePt?, lineHeight?, margins?, quotes: [where each came from] } from text. */
function formatFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out = { quotes: [] };
  const near = (re) => {
    const m = re.exec(t);
    if (!m) return null;
    out.quotes.push(t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).trim());
    return m;
  };
  // Citation style: named next to a formatting word, the newest edition wins if several are named.
  const styles = [
    ['mla', /\bMLA\b(?:\s*\(?\s*(?:9th|8th|7th)?\s*(?:ed(?:ition)?\.?)?\)?)?\s*(?:format|style|citation|guidelines|documentation|works cited)|(?:format|style|cite|citations?|documentation)[^.]{0,40}\bMLA\b/i],
    ['apa', /\bAPA\b(?:\s*\(?\s*(?:7th|6th)?\s*(?:ed(?:ition)?\.?)?\)?)?\s*(?:format|style|citation|guidelines|documentation|references)|(?:format|style|cite|citations?|documentation)[^.]{0,40}\bAPA\b/i],
    ['chicago', /\b(?:Chicago|Turabian)\b\s*(?:manual\s+of\s+style|format|style|citation|author-date|notes)|(?:format|style|cite|citations?)[^.]{0,40}\b(?:Chicago|Turabian)\b/i]
  ];
  const found = styles.map(([k, re]) => [k, re.exec(t)]).filter(([, m]) => m);
  if (found.length === 1) {
    out.style = found[0][0];
    near(styles.find(([k]) => k === out.style)[1]);
  }
  for (const f of FONTS) {
    const m = near(new RegExp(`\\b${f.replace(/ /g, '\\s+')}\\b`, 'i'));
    if (m) {
      out.font = f === 'Helvetica' ? 'Arial' : f;
      break;
    }
  }
  const size = near(/\b(1[0-4])(?:\s*|-)(?:pt|point|pt\.)\b(?:\s*font)?/i);
  if (size) out.sizePt = Number(size[1]);
  if (near(/\bdouble[\s-]*spac(?:ed|ing|e)\b/i)) out.lineHeight = 2;
  else if (near(/\b1\.5[\s-]*(?:line\s*)?spac(?:ed|ing)\b/i)) out.lineHeight = 1.5;
  else if (near(/\bsingle[\s-]*spac(?:ed|ing|e)\b/i)) out.lineHeight = 1;
  const marg = near(/\b(one|1|1\.0|1\.25|0\.75)[\s-]*(?:inch|in\.?|")\s*margins?\b/i);
  if (marg) out.margins = marg[1] === 'one' ? 1 : Number(marg[1]);
  if (!out.quotes.length) return null;
  return out;
}

/** The format for a class, from its syllabus-like documents (db.syllabusTexts), or null when they don't say. */
function merge(texts) {
  const out = { quotes: [] };
  for (const s of texts) {
    const f = formatFromText(s.text);
    if (!f) continue;
    for (const k of ['style', 'font', 'sizePt', 'lineHeight', 'margins']) if (f[k] != null && out[k] == null) out[k] = f[k];
    out.quotes.push(...f.quotes.map((q) => `${s.title ? `${s.title}: ` : ''}“${q}”`));
  }
  return Object.keys(out).length > 1 ? { ...out, quotes: out.quotes.slice(0, 6) } : null;
}

/** One line for Claude and the student: "MLA, Times New Roman 12 pt, double-spaced, 1-inch margins". */
function describe(f) {
  if (!f) return '';
  const parts = [];
  if (f.style) parts.push(f.style === 'mla' ? 'MLA' : f.style === 'apa' ? 'APA' : 'Chicago');
  if (f.font || f.sizePt) parts.push([f.font, f.sizePt ? `${f.sizePt} pt` : ''].filter(Boolean).join(' '));
  if (f.lineHeight) parts.push(f.lineHeight === 2 ? 'double-spaced' : f.lineHeight === 1.5 ? '1.5-spaced' : 'single-spaced');
  if (f.margins) parts.push(`${f.margins}-inch margins`);
  return parts.join(', ');
}

module.exports = { formatFromText, merge, describe };
