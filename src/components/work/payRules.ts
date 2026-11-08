// Pay codes and hosting rules on Kea's side, kept apart from the screens so the tests can run them. The server (the
// org engine's paycodes.mjs) decides everything again: these only keep Kea from offering what it would refuse, and
// from ever showing a code someone wasn't given or a rate someone may not see.
import { can } from './types';
import type { Org } from './types';

/** A pay code as the organization's list sends it (rates only to those who may see them). */
export interface PayCode {
  id: string;
  name: string;
  kind?: string;
  color: string | null;
  active: boolean;
  departmentId: string | null;
  positionId?: string | null;
  rate?: number;
  rateCents?: number;
  holders?: number;
  /** A server that keeps rate history: when the current rate started, and the earlier ones. */
  effectiveFrom?: string | null;
  rateHistory?: RateStep[];
}
export interface RateStep {
  rate?: number;
  rateCents?: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}
/** One of a person's codes (GET members/:aid/pay-codes, or mine in GET me/pay). */
export interface PersonCode {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  default: boolean;
  rate?: number;
  rateCents?: number;
  grantedAt?: number;
}
export interface PayStub {
  id?: string;
  periodStart?: string;
  periodEnd?: string;
  payDate?: string;
  date?: string;
  gross?: number;
  grossCents?: number;
  net?: number;
  netCents?: number;
  hours?: number;
}
/** GET /v1/orgs/:id/me/pay */
export interface MyPay {
  period: { start: string; end: string };
  current: { start: string; end: string };
  codes: PersonCode[];
  defaultCodeId: string | null;
  hours: { codeId: string | null; name: string | null; color: string | null; rateCents: number | null; minutes: number; hours: number; noLongerGiven?: boolean }[];
  totals: { workedMin: number; regularMin: number; overtimeMin: number; doubleTimeMin: number };
  approved: unknown;
  /** Only when the server has them (from payroll). */
  stubs?: PayStub[];
}
export interface PayCodeList {
  codes: PayCode[];
  canManage: boolean;
  canAssign: boolean;
  canSeeRates: boolean;
  hasKey: boolean;
}

/** May I see rates where a code or person belongs? rates.view there, or paycodes.manage for the organization. */
export const seesRates = (org: Org, deptId: string | null = null) => can(org, 'rates.view', deptId) || can(org, 'paycodes.manage', null);
/** May I see the organization's pay codes at all (their names)? The same abilities the server lets list them. */
export const seesCodeList = (org: Org) => ['paycodes.manage', 'paycodes.assign', 'rates.view', 'schedule.edit', 'timecards.approve'].some((a) => can(org, a));

/** Cents from what the server sent (rateCents, or rate in dollars), or null when there's none to show. */
export function centsOf(x: { rate?: number; rateCents?: number } | null | undefined): number | null {
  if (!x) return null;
  if (typeof x.rateCents === 'number' && Number.isFinite(x.rateCents)) return x.rateCents;
  if (typeof x.rate === 'number' && Number.isFinite(x.rate)) return Math.round(x.rate * 100);
  return null;
}
/** "$18.50/h" */
export const rateText = (cents: number) => `${(cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/h`;
/** A code's name, with its rate only when I may see it (my own codes: always) and the server sent it. */
export function codeLabel(c: { name: string; rate?: number; rateCents?: number }, showRate: boolean) {
  const cents = showRate ? centsOf(c) : null;
  return cents == null ? c.name : `${c.name} · ${rateText(cents)}`;
}
/** Takes the rate out of a code when it isn't mine to see, whatever the server sent. */
export function withoutRate<T extends { rate?: number; rateCents?: number }>(c: T): T {
  const { rate: _r, rateCents: _c, ...rest } = c;
  return rest as T;
}

/** The codes I can pick (on my shifts, when clocking in): only the ones I was given and that are turned on. */
export function pickable(my: Pick<MyPay, 'codes'> | null | undefined): PersonCode[] {
  return (my?.codes ?? []).filter((c) => c && c.active !== false);
}
/** The code a picker shows for a shift or punch: its own when it's one of mine, else my default, else none. */
export function pickedCode(codes: PersonCode[], current: string | null | undefined, defaultId?: string | null): string {
  if (current && codes.some((c) => c.id === current)) return current;
  const d = defaultId ?? codes.find((c) => c.default)?.id ?? null;
  return d && codes.some((c) => c.id === d) ? d : '';
}
/** Is a picker worth showing? Only with a choice to make (two codes or more). */
export const hasChoice = (codes: PersonCode[]) => codes.length > 1;
/**
 * The code to clock in with: the one picked, else the shift's when it's one of mine, else my default (the server does
 * the same when none is sent, so null is fine).
 */
export function clockInCode(codes: PersonCode[], picked: string | null | undefined, shiftCode?: string | null): string | null {
  if (picked && codes.some((c) => c.id === picked)) return picked;
  if (shiftCode && codes.some((c) => c.id === shiftCode)) return shiftCode;
  return null;
}
/** Codes a manager may put on someone's shift: that person's own codes, turned on. */
export const shiftChoices = (theirs: PersonCode[] | null | undefined) => (theirs ?? []).filter((c) => c.active !== false);
/** Codes that can still be given to someone: turned on, and not theirs yet. */
export const grantable = (all: PayCode[], theirs: PersonCode[]) => all.filter((c) => c.active && !theirs.some((t) => t.id === c.id));

/** Does the server keep rate history (effective dates)? Then a rate change asks when it starts. */
export const keepsHistory = (list: PayCode[] | null | undefined) => (list ?? []).some((c) => 'effectiveFrom' in c || Array.isArray(c.rateHistory));
/** Pay stubs, when the server sends them; null means show nothing at all. */
export const stubsOf = (my: Pick<MyPay, 'stubs'> | null | undefined) => (Array.isArray(my?.stubs) && my!.stubs!.length ? my!.stubs! : null);
/** A stub's amounts in cents (whichever the server sent). */
export const stubCents = (s: PayStub, k: 'gross' | 'net') => {
  const c = s[`${k}Cents` as 'grossCents' | 'netCents'];
  if (typeof c === 'number') return c;
  const d = s[k];
  return typeof d === 'number' ? Math.round(d * 100) : null;
};

// ---------- hosted organizations and applications ----------
export interface Application {
  id: string;
  kind: 'hosting' | 'creator';
  status: 'pending' | 'approved' | 'declined' | 'denied' | string;
  name?: string | null;
  orgKind?: 'school' | 'employer' | null;
  note?: string | null;
  organization?: string | null;
  createdAt?: number;
  decidedAt?: number | null;
  decisionNote?: string | null;
}
/** My latest application of a kind, or null. */
export function latestApplication(list: Application[] | null | undefined, kind: Application['kind']): Application | null {
  return (list ?? []).filter((a) => a?.kind === kind).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}
/** One plain line about a hosting application. */
export function applicationLine(a: Application): string {
  const what = a.name ? `${a.name}` : 'Your organization';
  if (a.status === 'pending') return `${what}: your application is waiting for review.`;
  if (a.status === 'approved') return `${what} was approved. It’s in your organizations.`;
  return `${what} wasn’t approved${a.decisionNote ? `: ${a.decisionNote}` : '.'} You can apply again.`;
}
/**
 * What an organization's own route answering with an error means for the list: 403 from a suspended organization
 * (it says so), 404 when it's gone from the server. Anything else (offline, a server error): nothing changes.
 */
export function orgGone(e: { status?: number | null; message?: string } | null | undefined): 'suspended' | 'removed' | null {
  if (!e) return null;
  if (e.status === 403 && /suspended/i.test(e.message ?? '')) return 'suspended';
  if (e.status === 404) return 'removed';
  return null;
}
