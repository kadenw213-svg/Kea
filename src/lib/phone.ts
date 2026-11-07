// Phone numbers as the Kea Hub keeps them (+ and digits, like +17195550101), shown the way people read them.

/** "+17195550101" → "+1 (719) 555-0101". Other countries stay as saved (their grouping differs too much to guess). */
export function formatPhone(n: string | null | undefined): string {
  const s = String(n ?? '').trim();
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+') && d.length === 11 && d.startsWith('1')) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;
}

/** A tel: link for a number the Hub gave (digits and + only, so nothing else can ride along). */
export const telHref = (n: string) => `tel:${String(n).replace(/[^\d+]/g, '')}`;
