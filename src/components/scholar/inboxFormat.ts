// How Inbox messages look, on the PC and the phone: each kind has its own color and label, and addresses never show
// as pasted text: every link in a message becomes a button.
import type { ScholarInboxItem } from '../../lib/api';

export const INBOX_KINDS: Record<ScholarInboxItem['kind'], { label: string; color: string }> = {
  announcement: { label: 'Announcement', color: '#8ab4f8' },
  grade: { label: 'Graded', color: '#81c995' },
  feedback: { label: 'Feedback', color: '#c58af9' },
  message: { label: 'Message', color: '#fdd663' },
  update: { label: 'Update', color: '#78d9ec' },
  needs_you: { label: 'Needs you', color: '#f28b82' },
  attention: { label: 'Heads up', color: '#fcad70' },
  missed: { label: 'Missed', color: '#f28b82' },
  news: { label: 'Overview', color: '#9aa0a6' }
};
export const kindOf = (i: ScholarInboxItem) => INBOX_KINDS[i.kind] || INBOX_KINDS.news;

const short = (s: string) => (s.length > 34 ? s.slice(0, 32).trimEnd() + '…' : s);

/** A button label for a bare class-site address, from what kind of page it is. */
function labelFor(url: string): string {
  const u = url.toLowerCase();
  if (/\/news\//.test(u)) return 'Announcement';
  if (/discussions/.test(u)) return 'Discussion';
  if (/dropbox|folder_submit/.test(u)) return 'Assignment';
  if (/quiz/.test(u)) return 'Quiz';
  if (/grades/.test(u)) return 'Grades';
  if (/calendar/.test(u)) return 'Calendar';
  if (/\/content\/|viewcontent|quicklink/.test(u)) return 'Course page';
  if (/aleks/.test(u)) return 'ALEKS';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Open link';
  }
}

/**
 * A message's text with its addresses taken out, and the buttons to show: its own links, the [text](address) links
 * inside its text (the text stays, the address becomes a button) and any bare address.
 */
export function inboxParts(i: ScholarInboxItem): { text: string; links: { label: string; url: string }[] } {
  const found: { label: string; url: string }[] = [...(i.links || [])];
  const lines: string[] = [];
  for (const line of String(i.body || '').split('\n')) {
    const bare: string[] = [];
    let l = line
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
        found.push({ label: short(label), url });
        return label;
      })
      .replace(/[(<]?(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])[)>]?/g, (_, url: string) => {
        bare.push(url);
        return '';
      });
    // A line that lost its address: drop what pointed at it ("Submit here:", a trailing dash), or the whole line when
    // nothing else was on it. The button is named after what the line says (else after the kind of page).
    if (bare.length) {
      l = l.replace(/[\s\-–:|]+$/, '').replace(/\s{2,}/g, ' ');
      const name = l.replace(/^[\s\-–•*]+/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').trim();
      for (const url of bare) found.push({ label: bare.length === 1 && /[\p{L}]/u.test(name) && !/^(here|link|submit here)$/i.test(name) ? short(name) : labelFor(url), url });
      if (!/[\p{L}\p{N}]/u.test(l)) continue;
    }
    lines.push(l.replace(/[ \t]+$/, ''));
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (i.url && !found.some((l) => l.url === i.url)) found.push({ label: i.kind === 'announcement' ? 'Open announcement' : i.kind === 'message' ? 'Open message' : 'Open on the class site', url: i.url });
  const seen = new Set<string>();
  return { text, links: found.filter((l) => !seen.has(l.url) && seen.add(l.url)).slice(0, 6) };
}
