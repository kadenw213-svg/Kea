// What the organization routes send back (org/*.mjs in KeaS; hub/org/routes.mjs on a KeaS 0.5 Hub).
export type Role = 'owner' | 'admin' | 'manager' | 'member';
export type Answer = 'A' | 'I' | 'N';
/** The fixed roles of KeaS 0.5 by rank: only for telling who's above whom on a server without custom roles. */
export const RANK: Record<Role, number> = { member: 1, manager: 2, admin: 3, owner: 4 };

// ---------- abilities ----------
// A newer server sends each person's abilities (me.abilities, me.scopes) with the organization. A KeaS 0.5 Hub sends
// only the fixed role: then the role's abilities are these (the same lists the newer server starts its Owner, Admin,
// Manager and Member roles with: org/roles.mjs).
const MEMBER_ABILITIES = ['clock.self', 'timeoff.request'];
const MANAGER_ABILITIES = [...MEMBER_ABILITIES, 'people.view', 'people.approve', 'people.verify', 'people.edit', 'people.remove', 'codes.make', 'budgets.view', 'certs.manage', 'classes.manage', 'forms.manage', 'schedule.view', 'schedule.edit', 'schedule.publish', 'swaps.decide', 'policies.manage', 'timecards.view', 'timecards.approve', 'timeoff.decide'];
const ADMIN_ABILITIES = [...MANAGER_ABILITIES, 'people.birthdate', 'roles.assign', 'roles.manage', 'structure.edit', 'settings.edit', 'rates.view', 'rates.assign', 'budgets.costs', 'budgets.edit', 'certs.types'];
export const ROLE_ABILITIES: Record<Role, string[]> = { member: MEMBER_ABILITIES, manager: MANAGER_ABILITIES, admin: ADMIN_ABILITIES, owner: [...ADMIN_ABILITIES] };
/** Abilities about yourself only (a department scope means nothing for them). */
const SELF_ABILITIES = new Set(['clock.self', 'timeoff.request']);
/**
 * Can I do this in this organization? deptId: undefined = anywhere at all, null = for the whole organization, a
 * department id = there (a grant for it or a department above it reaches it; the server sends the reach expanded).
 */
export function can(org: Pick<Org, 'role' | 'memberStatus' | 'abilities' | 'scopes'> | null | undefined, ability: string, deptId?: string | null): boolean {
  if (!org || org.memberStatus !== 'active') return false;
  if (!org.abilities) {
    // (A KeaS 0.5 Hub: the old Owner had everything.)
    if (org.role === 'owner') return true;
    return (ROLE_ABILITIES[org.role] ?? []).includes(ability);
  }
  const s = org.scopes?.[ability] ?? (org.abilities.includes(ability) ? 'org' : undefined);
  if (!s) return false;
  if (s === 'org' || SELF_ABILITIES.has(ability)) return true;
  if (deptId === undefined) return s.length > 0;
  return deptId != null && s.includes(deptId);
}
export const canAny = (org: Parameters<typeof can>[0], list: string[], deptId?: string | null) => list.some((a) => can(org, a, deptId));
/** Custom roles on this server (it sent abilities): roles are edited in People → Roles instead of picked from four. */
export const hasRoles = (org: Pick<Org, 'abilities'>) => Array.isArray(org.abilities);
/** Should I see the controls for changing this person? (The server has the last word: it refuses what I can't do.) */
export function mayChange(org: Org, m: Pick<Member, 'role' | 'you' | 'departmentId'>, ability = 'people.edit') {
  if (m.you || !can(org, ability, m.departmentId)) return false;
  if (org.role === 'owner') return true;
  // (With custom roles the fixed role is only a summary, so anyone but an owner may be below me: the server decides.)
  return RANK[m.role] < RANK[org.role] || (hasRoles(org) && m.role !== 'owner');
}

export interface RoleGrant {
  roleId: string;
  name: string;
  templateKey: string | null;
  /** 'org' or the department ids it's given for. */
  scope: 'org' | string[];
}
export interface OrgRole {
  id: string;
  name: string;
  description: string | null;
  template: boolean;
  templateKey: string | null;
  abilities: string[];
  createdAt: number;
  holders?: number;
}
export interface AbilityInfo {
  id: string;
  label: string;
  self: boolean;
  orgOnly: boolean;
}

export interface OrgSettings {
  autoApproveJoins: boolean;
  swapNeedsApproval: boolean;
  budgetWarnPct: number;
  certWarnDays: number[];
  reminders: number[];
  autofill: { useIfNeeded: boolean; hardMaxHours: boolean; allowOvertime: boolean };
  todoKinds: Record<string, boolean>;
  membersSeeSchedule: boolean;
}
export interface Org {
  id: string;
  name: string;
  kind: string;
  tz: string;
  state: string | null;
  workweekStart: number;
  status: 'pending' | 'active' | 'suspended';
  role: Role;
  memberStatus: 'active' | 'pending';
  members: number;
  settings?: OrgSettings;
  /** From GET /v1/orgs/:id on a server with custom roles: what I can do, and where. */
  abilities?: string[];
  scopes?: Record<string, 'org' | string[]>;
  roles?: RoleGrant[];
  /** The KeaS server it's on (null: the Kea account server). */
  server?: { id: string; name: string | null; url?: string } | null;
}
export interface Member {
  id: string;
  name: string;
  role: Role;
  status: string;
  departmentId: string | null;
  title: string | null;
  positionIds: string[];
  joinedAt: number;
  you: boolean;
  /** Their Kea account's email is verified (with Google, or by a manager or the Hub's owner). */
  emailVerified?: boolean;
  /** A Kea supporter (a badge, nothing more). */
  supporter?: boolean;
  /** Only when they share it with coworkers. */
  phone?: string;
  email?: string;
  desiredMin?: number | null;
  desiredMax?: number | null;
  prefs?: string[];
  minor?: boolean | null;
  birthdate?: string | null;
  costRate?: number | null;
  usualWeek?: Record<string, Answer>;
  /** Their roles (for themselves, and for people who can give roles). */
  roles?: RoleGrant[];
}
export interface Department {
  id: string;
  parentId: string | null;
  name: string;
  costCenterId: string | null;
  locationId: string | null;
  sort: number;
}
export interface Position {
  id: string;
  name: string;
  departmentId: string | null;
  tags: string[];
  color: string | null;
  costRate?: number | null;
}
export interface Structure {
  departments: Department[];
  positions: Position[];
  locations: { id: string; name: string; address: string | null }[];
  costCenters: { id: string; code: string; name: string }[];
}
export interface JoinCode {
  code: string;
  role: Role;
  /** On a server with custom roles: the role it gives. */
  roleId?: string | null;
  roleName?: string | null;
  label: string | null;
  departmentId: string | null;
  positionId: string | null;
  needsApproval: boolean;
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
  revoked: boolean;
  usable: boolean;
}
export type Stage = 'ok' | '60' | '30' | '7' | 'expired' | 'missing' | string;
export interface CertType {
  id: string;
  name: string;
  validMonths: number | null;
  positionIds: string[];
  warnDays: number[];
  classIds: string[];
}
export interface Cert {
  id: string;
  accountId: string;
  name?: string;
  typeId: string;
  typeName: string;
  issuedOn: string;
  expiresOn: string | null;
  source: string;
  stage: Stage;
  daysLeft: number | null;
  note: string | null;
}
export interface Session {
  id: string;
  title: string;
  start: string;
  end: string;
  startAt: number;
  location: string | null;
  meetingUrl: string | null;
}
export interface OrgClass {
  id: string;
  title: string;
  description: string;
  meetingUrl: string | null;
  certTypeId: string | null;
  sessions: Session[];
  mine: { dueOn: string | null; completedOn: string | null } | null;
  assigned?: { accountId: string; name: string; dueOn: string | null; completedOn: string | null }[];
}
export interface Need {
  positionId: string;
  count: number;
}
export interface Block {
  id: string;
  weekday?: number;
  start: string;
  end: string;
  label?: string | null;
  need: Need[];
  tags: string[];
}
export interface DateException {
  date: string;
  kind: 'closed' | 'hours' | 'extra';
  note?: string | null;
  blocks?: Block[];
}
export interface CustomQuestion {
  id: string;
  label: string;
  type: 'text' | 'yesno' | 'choice' | 'multi';
  options: string[];
  on: boolean;
}
export interface Questions {
  desiredHours: { on: boolean };
  daysOff: { on: boolean };
  notes: { on: boolean };
  custom: CustomQuestion[];
}
export interface Form {
  id: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'open' | 'closed';
  deadlineAt: number | null;
  blocks: Block[];
  exceptions: DateException[];
  questions: Questions;
  audience: { departments?: string[]; positions?: string[] };
  minorNote: string | null;
  reminders: number[];
  allowChanges: boolean;
  submittedAt?: number | null;
  responses?: number;
  audienceCount?: number;
}
export interface Slot {
  key: string;
  date: string;
  weekday: number;
  blockId: string;
  label: string | null;
  start: string;
  end: string;
  startAt: number;
  endAt: number;
  minutes: number;
  need: Need[];
  tags: string[];
  special: 'hours' | 'extra' | null;
  note: string | null;
}
export interface Response {
  answers: Record<string, Answer>;
  dateNotes: Record<string, string>;
  note: string | null;
  desiredMin: number | null;
  desiredMax: number | null;
  daysOff: string | null;
  extra: Record<string, unknown>;
  submittedAt: number | null;
}
export interface FormView {
  form: Form;
  slots: Slot[];
  response: Response | null;
  prefill: { usual: Record<string, Answer>; last: Record<string, Answer> | null; lastTitle: string | null; desiredMin: number | null; desiredMax: number | null };
  state: { pastDeadline: boolean; canEdit: boolean; changeRequest: boolean; scheduleOut: boolean; lastChange: { id: string; status: string; createdAt: number } | null };
}
export interface Hours {
  available: number;
  ifNeeded: number;
  perWeekAvailable: number;
  perWeekIfNeeded: number;
}
export interface PersonRow extends Response {
  id: string;
  name: string;
  email: string;
  departmentId: string | null;
  positionIds: string[];
  minor: boolean;
  hours: Hours;
  submitted: boolean;
  late: boolean;
  nudgedAt: number | null;
  pendingChange: boolean;
}
export interface MatrixSlot extends Slot {
  needTotal: number;
  available: { id: string; name: string }[];
  ifNeeded: { id: string; name: string }[];
  coverage: number | null;
  notes: { id: string; name: string; note: string }[];
}
export interface Change {
  id: string;
  accountId: string;
  name: string;
  reason: string | null;
  status: string;
  createdAt: number;
  diff: { key: string; from: Answer; to: Answer }[];
}
export interface Shift {
  id: string;
  scheduleId: string | null;
  accountId: string | null;
  name: string | null;
  positionId: string;
  positionName: string | null;
  departmentId: string | null;
  date: string;
  blockId: string | null;
  slotKey: string | null;
  start: string;
  end: string;
  startAt: number;
  endAt: number;
  status: 'draft' | 'published';
  source: string;
  note: string | null;
  forced: boolean;
  swap?: { id: string; status: string } | null;
}
export interface Schedule {
  id: string;
  formId: string | null;
  title: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'published';
  drafts: number;
  published: number;
  publishedAt: number | null;
}
export interface Problem {
  code: string;
  message: string;
  blocking: boolean;
  forceable: boolean;
}
export interface Verdict {
  problems: Problem[];
  blocked: boolean;
  canForce: boolean;
}
export interface BudgetRow {
  id: string;
  departmentId: string;
  departmentName: string;
  periodStart: string;
  periodEnd: string;
  label: string;
  note: string | null;
  current: boolean;
  amount: number;
  scheduled: number;
  published: number;
  worked: number;
  hours: number;
  pct: number | null;
  warn: boolean;
  over: boolean;
}
/** A budget as a manager sees it (the Hub shows labor cost to admins only): the budget, its dates and the hours. */
export type BudgetPlan = Pick<BudgetRow, 'id' | 'departmentId' | 'departmentName' | 'periodStart' | 'periodEnd' | 'label' | 'note' | 'current' | 'amount' | 'hours'>;
export interface SchedPerson {
  id: string;
  name: string;
  positionIds: string[];
  departmentId: string | null;
  desiredMin: number | null;
  desiredMax: number | null;
  minor: boolean;
  submitted: boolean;
  note: string | null;
  prefs: string[];
  hours: number;
  hoursByWeek: Record<string, number>;
}
export interface SchedSlot extends Slot {
  needTotal: number;
  available: string[];
  ifNeeded: string[];
  assigned: string[];
  dateNotes: { id: string; name: string; note: string }[];
}
export interface SchedView {
  schedule: Schedule;
  form: Form | null;
  weeks: string[];
  slots: SchedSlot[];
  shifts: Shift[];
  people: SchedPerson[];
  budget: BudgetRow[];
  draftsWaiting: number;
  autofillDefaults: OrgSettings['autofill'];
}
export interface Draft {
  id: string;
  source: string;
  summary: string | null;
  status: string;
  createdAt: number;
  shifts: (Verdict & { accountId: string; name: string | null; positionId: string; date: string; startAt: number; endAt: number; why?: string | null })[];
}
export interface Swap {
  id: string;
  shiftId: string;
  from: string;
  fromName: string | null;
  to: string | null;
  toName: string | null;
  claimant: string | null;
  claimantName: string | null;
  note: string | null;
  status: 'offered' | 'claimed' | 'approved' | 'denied' | 'cancelled';
  shift: Shift | null;
}
export interface Policy {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  dueOn: string | null;
  ackedAt: number | null;
  acked?: number;
  audienceCount?: number;
}
export interface TodoAction {
  type: 'form' | 'cert' | 'class' | 'swap' | 'ack' | 'formPeople' | 'approvals' | 'schedule' | 'budgets' | 'certs';
  formId?: string;
  typeId?: string;
  classId?: string | null;
  swapId?: string;
  policyId?: string;
  scheduleId?: string;
}
export interface TodoItem {
  key: string;
  kind: string;
  orgId: string;
  orgName: string;
  title: string;
  detail: string;
  dueAt: number | null;
  msLeft: number | null;
  overdue: boolean;
  urgency: number;
  stage?: Stage;
  daysLeft?: number | null;
  nextSession?: Session | null;
  counts?: { joins: number; changes: number; swaps: number };
  action: TodoAction;
  snoozedUntil?: number;
}
