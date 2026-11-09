// The Kea account's name and optional phone number, shared by Kea on the computer and on the phone: the light check on
// the number (common US ways of writing it, kept as +15551234567), who sees it by default, reading it from the account
// server's answer, and the one-step agreement for a new account. No network, no React: the tests use it as it is.

/** Who sees the phone number until the person changes it: people in organizations they join yes, classmates no. */
export const SHARE_DEFAULTS = Object.freeze({ orgs: true, classmates: false });
export type PhoneShare = { orgs: boolean; classmates: boolean };
export type Profile = { name: string; phone: string | null; phoneShare: PhoneShare };
export type ProfilePatch = { name?: string; phone?: string | null; phoneShare?: Partial<PhoneShare> };

export const PHONE_HINT = 'Like (555) 123-4567, or +44 20 7946 0958 outside the US.';
const BAD_PHONE = `That doesn’t look like a phone number. ${PHONE_HINT}`;

/**
 * A typed phone number, checked lightly and kept the way the account server takes it: "+" and digits.
 *   (555) 123-4567, 555.123.4567, 555 123 4567, 1-555-123-4567, +1 555 123 4567 → +15551234567
 *   +44 20 7946 0958 → +442079460958 (other countries: + and 8 to 15 digits)
 *   ''  → null (no number)
 */
export function normalizePhone(input: string | null | undefined): { ok: true; phone: string | null } | { ok: false; error: string } {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, phone: null };
  // (Only digits, one + in front, and the usual separators.)
  if (!/^\+?[\d\s().\-]+$/.test(raw)) return { ok: false, error: BAD_PHONE };
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    if (d.startsWith('1')) return d.length === 11 && usArea(d.slice(1)) ? { ok: true, phone: `+${d}` } : { ok: false, error: BAD_PHONE };
    return d.length >= 8 && d.length <= 15 && d[0] !== '0' ? { ok: true, phone: `+${d}` } : { ok: false, error: BAD_PHONE };
  }
  if (d.length === 10 && usArea(d)) return { ok: true, phone: `+1${d}` };
  if (d.length === 11 && d.startsWith('1') && usArea(d.slice(1))) return { ok: true, phone: `+${d}` };
  return { ok: false, error: BAD_PHONE };
}
// (A US area code never starts with 0 or 1.)
const usArea = (ten: string) => /^[2-9]\d{9}$/.test(ten);

/** "+15551234567" → "(555) 123-4567"; other countries stay as kept. */
export function showPhone(n: string | null | undefined): string {
  const s = String(n ?? '').trim();
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+') && d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;
}

const VIS: Record<string, PhoneShare> = { nobody: { orgs: false, classmates: false }, orgs: { orgs: true, classmates: false }, classes: { orgs: false, classmates: true }, both: { orgs: true, classmates: true } };
/**
 * The name, phone and who sees it from GET /v1/me: { name, phone, phoneShare } on the Kea account server, or (an older
 * one) account.displayName and account.phone { number, visibility }. Anything missing takes the defaults.
 */
export function profileOf(me: any, fallbackName = ''): Profile {
  const a = me?.account || {};
  const name = typeof me?.name === 'string' ? me.name : typeof a.displayName === 'string' ? a.displayName : fallbackName;
  const phone = me && 'phone' in me && (typeof me.phone === 'string' || me.phone === null) ? me.phone || null : a.phone?.number || null;
  const ps = me?.phoneShare && typeof me.phoneShare === 'object' ? me.phoneShare : (a.phone?.visibility && VIS[a.phone.visibility]) || null;
  return { name: name || fallbackName, phone, phoneShare: shareOf(ps) };
}
export const shareOf = (ps: any): PhoneShare => ({ orgs: typeof ps?.orgs === 'boolean' ? ps.orgs : SHARE_DEFAULTS.orgs, classmates: typeof ps?.classmates === 'boolean' ? ps.classmates : SHARE_DEFAULTS.classmates });

/**
 * What the profile form saves: only what changed from `was` (all of it when `was` is null), checked first.
 * { ok: true, patch } (patch may be empty: nothing changed) or { ok: false, field, error }.
 */
export function profileSave(form: { name: string; phone: string; phoneShare: PhoneShare }, was: Profile | null): { ok: true; patch: ProfilePatch } | { ok: false; field: 'name' | 'phone'; error: string } {
  const name = form.name.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, field: 'name', error: 'Add your name.' };
  if (name.length > 60) return { ok: false, field: 'name', error: 'That name is too long (60 letters at most).' };
  const p = normalizePhone(form.phone);
  if (!p.ok) return { ok: false, field: 'phone', error: p.error };
  const patch: ProfilePatch = {};
  if (!was || name !== was.name) patch.name = name;
  if (!was || p.phone !== was.phone) patch.phone = p.phone;
  const share: Partial<PhoneShare> = {};
  for (const k of ['orgs', 'classmates'] as const) if (!was || form.phoneShare[k] !== was.phoneShare[k]) share[k] = form.phoneShare[k];
  if (Object.keys(share).length) patch.phoneShare = share;
  return { ok: true, patch };
}

/** The plain words after saving: saved, or (the server not answering) saved here and sent once it's back. */
export const savedText = (queued: boolean) => (queued ? 'Saved on this device. It goes to your Kea account once you’re online.' : 'Saved.');

/**
 * The first sign-in for a new email: one "Agree and continue" agrees to every section of the current terms and
 * confirms 13 or older, as the account server asks.
 */
export function oneStepAgreement(terms: { version: number; sections: { id: string }[] }): { age13: true; termsVersion: number; termsSections: string[] } {
  return { age13: true, termsVersion: terms.version, termsSections: terms.sections.map((s) => s.id) };
}
