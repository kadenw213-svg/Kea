// Class-site data, trimmed for Claude: D2L's API answers carry every rich-text field twice (Text and Html), long HTML,
// bookkeeping fields (sort orders, tracking ids) and many empty or false flags. Scans read them as plain text with
// their links kept (as [text](address)) and without the rest: about half the size, and of the student's Claude usage,
// with nothing a scan needs left out.

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const absolute = (href, base) => {
  try {
    return base ? new URL(href, base).href : href;
  } catch {
    return href;
  }
};

/** HTML as plain text, keeping each link as [text](address) so scans can still go straight to it. */
function htmlToText(html, base = '') {
  return decode(
    String(html || '')
      .replace(/\r\n?/g, '\n')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
        const text = label.replace(/<[^>]+>/g, '').trim();
        if (/^(javascript:|#|mailto:)/i.test(href)) return text;
        const url = absolute(decode(href), base);
        return text && text !== url ? `[${text}](${url})` : url;
      })
      .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']+)["'][^>]*>/gi, '[image: $1]')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Bookkeeping that never matters to a scan.
const NOISE = new Set(['SortOrder', 'ActivityId', 'CompletionType', 'ActivityType', 'CreatedBy', 'Bookmarked', 'Unread', 'DefaultPath', 'IsAuthorInfoShown', 'IsStartDateShown', 'ShowOnlyInCourseOfferings', 'IsGlobal']);
const isRichText = (v) => v && typeof v === 'object' && !Array.isArray(v) && ('Html' in v || 'Text' in v) && Object.keys(v).every((k) => ['Html', 'Text', 'Type', 'Content'].includes(k));

/**
 * A JSON value without empty fields, false flags or bookkeeping, with D2L's rich-text objects (and HTML strings) as
 * plain text. `base` makes the class site's relative links absolute.
 */
function compact(v, base = '') {
  if (Array.isArray(v)) return v.map((x) => compact(x, base)).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    if (isRichText(v)) {
      const t = v.Html || v.Content ? htmlToText(v.Html || v.Content, base) : String(v.Text || '').trim();
      return t || undefined;
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (NOISE.has(k) || (k === 'Identifier' && 'TopicId' in v)) continue;
      const c = /^(Url|Path)$/.test(k) && typeof x === 'string' && x.startsWith('/') ? absolute(x, base) : compact(x, base);
      if (c === undefined || c === null || c === false || c === '' || (Array.isArray(c) && !c.length) || (typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length)) continue;
      out[k] = c;
    }
    return out;
  }
  if (typeof v === 'string' && /<\/?(p|div|span|a|br|li|table|strong|em)\b/i.test(v)) return htmlToText(v, base) || undefined;
  return v;
}

/** A JSON text trimmed with `compact` (anything that isn't JSON comes back unchanged). */
function compactText(text, base = '') {
  try {
    return JSON.stringify(compact(JSON.parse(String(text).replace(/^while\(1\);/, '')), base));
  } catch {
    return text;
  }
}

module.exports = { htmlToText, compact, compactText };
