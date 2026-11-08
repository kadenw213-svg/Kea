// Work mode: talking to the Hub's org routes, where the screen is, and small date helpers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, JoinedServer } from '../../lib/api';
import { toast } from '../../store';
import type { Org } from './types';
import { useHubStatus } from '../account/hubStore';

export class WorkError extends Error {
  constructor(message: string, public status: number | null, public data: any) {
    super(message);
  }
}
/** GET or POST an org route; throws WorkError with the Hub's message. */
export async function hub<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const r = await api.hubOrg.call<T>(method, path, body);
  if (!r.ok) throw new WorkError(r.error, r.status, r.data);
  return r.value;
}
export const get = <T = any>(path: string) => hub<T>('GET', path);
export const post = <T = any>(path: string, body: unknown = {}) => hub<T>('POST', path, body);
/** POST, toast any error, and tell everything to reload. Returns null on failure. */
export async function act<T = any>(path: string, body: unknown = {}, done?: string): Promise<T | null> {
  try {
    const v = await post<T>(path, body);
    if (done) toast(done);
    bump();
    return v;
  } catch (e: any) {
    toast(e.message, 'error');
    return null;
  }
}

// ---------- shared state ----------
export type Tab = 'schedule' | 'time' | 'availability' | 'certs' | 'org' | 'forms' | 'scheduling' | 'people' | 'training' | 'structure' | 'budgets' | 'settings';
interface WorkState {
  version: number;
  orgs: Org[] | null;
  /** KeaS servers this account joined (offline, or signed out: shown above the organizations). */
  servers: JoinedServer[];
  /** A join link opened from outside Kea, waiting for the Join box. */
  joinLink: string | null;
  orgId: string | null;
  tab: Tab;
  /** What to open inside a tab (a form, a schedule, a swap...). */
  focus: { formId?: string; scheduleId?: string; swapId?: string; view?: string } | null;
  setOrgs(o: Org[], servers?: JoinedServer[]): void;
  go(orgId: string | null, tab?: Tab, focus?: WorkState['focus']): void;
}
/**
 * Something on screen that would lose unsaved work if Work moved elsewhere (an availability form being filled in):
 * asked before go() changes the organization, tab or focus. Resolves true to go on.
 */
let leaveGuard: (() => Promise<boolean>) | null = null;
export function setLeaveGuard(g: (() => Promise<boolean>) | null) {
  leaveGuard = g;
}
export const useWork = create<WorkState>((set) => ({
  version: 0,
  orgs: null,
  servers: [],
  joinLink: null,
  orgId: (() => {
    try {
      return localStorage.getItem('kea.work.org');
    } catch {
      return null;
    }
  })(),
  tab: 'schedule',
  focus: null,
  setOrgs: (orgs, servers) => set((s) => ({ orgs, ...(servers ? { servers } : {}), orgId: s.orgId && orgs.some((o) => o.id === s.orgId) ? s.orgId : orgs[0]?.id ?? null })),
  go: (orgId, tab, focus = null) => {
    const apply = () =>
      set((s) => {
        try {
          if (orgId) localStorage.setItem('kea.work.org', orgId);
        } catch {}
        return { orgId, tab: tab ?? (orgId === s.orgId ? s.tab : 'schedule'), focus };
      });
    if (!leaveGuard) return apply();
    leaveGuard().then((ok) => ok && apply());
  }
}));
/** Something changed on the Hub: everything showing org data reloads. */
export const bump = () => useWork.setState((s) => ({ version: s.version + 1 }));

/** Load a Hub path (null = nothing yet); reloads when the path or anything else changes. */
export function useHub<T>(path: string | null, extraDeps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload(): void; setData(d: T): void } {
  const version = useWork((s) => s.version);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [n, setN] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    get<T>(path)
      .then((v) => {
        if (mine !== seq.current) return;
        setData(v);
        setError(null);
      })
      .catch((e) => mine === seq.current && setError(e.message))
      .finally(() => mine === seq.current && setLoading(false));
  }, [path, version, n, ...extraDeps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload, setData };
}

// ---------- dates and times ----------
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
export const addDays = (s: string, n: number) => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
export const todayIso = () => isoDate(new Date());
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "4:45am", "1pm" */
export function fmtTime(t: string) {
  const h = Number(t.slice(0, 2)),
    m = Number(t.slice(3, 5));
  return `${((h + 11) % 12) + 1}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
export const fmtRange = (b: { start: string; end: string }) => `${fmtTime(b.start)}–${fmtTime(b.end)}`;
/** "Tue, Dec 1" */
export const fmtDay = (s: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) => parseDate(s).toLocaleDateString(undefined, opts);
export const fmtShortDate = (s: string) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
/** A time in the org's zone: "4:45am". */
export function clock(iso: string | number, tz?: string) {
  return new Date(iso)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
    .replace(':00', '')
    .replace(' AM', 'am')
    .replace(' PM', 'pm');
}
/** "Nov 12, 6am": the same time style as everywhere else in Work. */
export const fmtWhen = (ms: number, tz?: string) => `${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: tz })}, ${clock(ms, tz)}`;
/** "Due in 2 days", "Due in 5 hours", "2 days late". */
export function countdown(msLeft: number | null, { due = 'Due', late = 'late' } = {}) {
  if (msLeft == null) return '';
  const a = Math.abs(msLeft);
  const unit = a >= 86400_000 ? [Math.round(a / 86400_000), 'day'] : a >= 3600_000 ? [Math.round(a / 3600_000), 'hour'] : [Math.max(1, Math.round(a / 60_000)), 'minute'];
  const txt = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return msLeft >= 0 ? `${due} in ${txt}` : `${txt} ${late}`;
}
export const hrs = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 10) / 10} h`);
export const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** The next month: { start, end }. */
export function nextMonthRange() {
  const n = new Date();
  const s = new Date(n.getFullYear(), n.getMonth() + 1, 1);
  const e = new Date(n.getFullYear(), n.getMonth() + 2, 0);
  return { start: isoDate(s), end: isoDate(e) };
}
/** The machine's time zone, for a new org. */
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Denver';
/** Hours in a block. */
export function blockHours(b: { start: string; end: string }) {
  const s = Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3, 5));
  const e = Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3, 5));
  return ((e > s ? e - s : e + 1440 - s) / 60);
}

/** This Kea's Hub account id (from the last status, or what Kea saved when offline). */
export function useMyId(): string | null {
  const s = useHubStatus();
  return s?.me?.account.id ?? (s?.cached as { id?: string } | null)?.id ?? null;
}
/** "15–20 h", "up to 30 h", "at least 10 h", or null. */
export function wantText(min: number | null | undefined, max: number | null | undefined) {
  if (min == null && max == null) return null;
  if (min == null) return `up to ${max} h`;
  if (max == null) return `at least ${min} h`;
  return min === max ? `${min} h` : `${min}–${max} h`;
}

// A kea://join link opened from outside Kea (a browser, an email): Work opens with the Join box filled in.
function takeJoinLink(link: string | null) {
  if (!link) return;
  useWork.setState({ joinLink: link });
  import('../../lib/modes').then((m) => m.openWork());
}
try {
  api.work?.pendingJoin().then(takeJoinLink, () => {});
  api.work?.onJoinLink(takeJoinLink);
} catch {}
