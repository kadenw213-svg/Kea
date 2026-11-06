// Kea Hub classes from the page's side: typed calls to electron/hubClasses.cjs and the shared "My classes" list.
import { create } from 'zustand';
import { api, HubResult, HubStatus } from './api';

export type HubRole = 'instructor' | 'ta' | 'student';
export type BoardShow = 'name' | 'nickname' | 'hidden';
export interface HubClass {
  id: string;
  title: string;
  description: string;
  kind: 'class' | 'general';
  status: 'active' | 'archived';
  meetingUrl: string | null;
  createdAt: number;
  role: HubRole | null;
  board: BoardShow | null;
  nickname: string | null;
  members: number;
  instructors: { name: string; verified: boolean }[];
}
export interface HubSession {
  id: string;
  classId: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  meetingUrl: string | null;
  notes: string | null;
}
export interface HubSetInfo {
  id: string;
  title: string;
  leaderboard: boolean;
  questions: number;
  /** Questions that score now (new, or their review date has come). */
  due: number;
  learned: number;
}
export interface HubMember {
  /** Only instructors see account ids (to remove someone). */
  id?: string;
  /** Null when a student chose to stay hidden (only the instructors see their name). */
  name: string | null;
  role: HubRole;
  joinedAt: number;
  you: boolean;
  /** A Kea supporter (a badge, nothing more). */
  supporter?: boolean;
  /** Only when they share it with classmates. */
  phone?: string;
}
export interface HubInvite {
  code: string;
  role: 'student' | 'ta';
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
  expired: boolean;
}
export interface HubProgress {
  level: number;
  xp: number;
  floor: number;
  next: number;
  today: number;
  streak: number;
}
export interface HubClassDetail {
  class: HubClass;
  progress: HubProgress;
  members: HubMember[];
  sessions: HubSession[];
  sets: HubSetInfo[];
  invites: HubInvite[];
  /** The start of an invite link: add the code. */
  inviteBase: string;
  offline: boolean;
}
export interface HubQuestion {
  id: string;
  q: string;
  choices: string[];
  due: boolean;
  dueAt: number | null;
  box: number;
  /** Instructors only. */
  answer?: number;
  why?: string | null;
}
export interface HubSetFull {
  set: { id: string; classId: string; title: string; leaderboard: boolean };
  questions: HubQuestion[];
}
export interface HubAnswer {
  correct: boolean;
  /**
   * The right choice and why. A leaderboard set leaves them out for a wrong answer while the question still scores
   * (`again`: it comes back to try again), so the answer key can't be collected by answering wrong.
   */
  answer?: number;
  why?: string | null;
  again?: boolean;
  points: number;
  /** The question was due, so it could score. */
  scoring: boolean;
  /** Today's limit was reached, so fewer points (or none) counted. */
  capped: boolean;
  nextDueAt: number;
  box: number;
  progress: HubProgress;
}
export interface HubBoardEntry {
  rank: number;
  name: string;
  points: number;
  you: boolean;
  supporter?: boolean;
}
export interface HubBoard {
  period: 'week' | 'all';
  since: number;
  board: HubBoardEntry[];
  you: HubBoardEntry | null;
  offline: boolean;
}
export interface NewQuestion {
  q: string;
  choices: string[];
  answer: number;
  why?: string;
}
export interface ImportableSet {
  id: string;
  title: string;
  kind: string;
  courseCode: string;
  count: number;
  createdAt: string;
}

const call = <T>(name: string, arg?: object) => api.hubClasses.call(name, arg) as Promise<HubResult<T>>;

export const hubc = {
  classes: () => call<{ classes: HubClass[]; offline: boolean }>('classes'),
  detail: (id: string) => call<HubClassDetail>('class', { id }),
  preview: (text: string) => call<{ code: string; class: Pick<HubClass, 'id' | 'title' | 'description' | 'members' | 'instructors'>; role: 'student' | 'ta'; alreadyMember: boolean }>('preview', { text }),
  join: (code: string) => call<{ class: HubClass; alreadyMember: boolean }>('join', { code }),
  leave: (id: string) => call<{ ok: true }>('leave', { id }),
  setMine: (id: string, board: BoardShow, nickname?: string | null) => call<{ board: BoardShow; nickname: string | null }>('setMine', { id, board, nickname }),
  create: (a: { title: string; description?: string; meetingUrl?: string | null }) => call<{ class: HubClass }>('create', a),
  update: (id: string, patch: Partial<{ title: string; description: string; meetingUrl: string | null; status: 'active' | 'archived' }>) => call<{ class: HubClass }>('update', { id, ...patch }),
  invite: (id: string, opts: { role?: 'student' | 'ta'; maxUses?: number | null; expiresDays?: number | null } = {}) =>
    call<{ code: string; role: string; maxUses: number | null; expiresAt: number | null; link: string }>('invite', { id, ...opts }),
  revoke: (code: string) => call<{ ok: true }>('revoke', { code }),
  removeMember: (id: string, accountId: string) => call<{ ok: true }>('removeMember', { id, accountId }),
  saveSession: (s: { classId: string; id?: string; title: string; start: string; end: string; location?: string | null; meetingUrl?: string | null; notes?: string | null }) =>
    call<{ session: HubSession }>('saveSession', s),
  deleteSession: (id: string) => call<{ ok: true }>('deleteSession', { id }),
  jitsi: (title: string) => call<string>('jitsi', { title }),
  set: (id: string) => call<HubSetFull>('set', { id }),
  createSet: (classId: string, title: string, questions: NewQuestion[], leaderboard = true) => call<{ id: string; count: number }>('createSet', { classId, title, questions, leaderboard }),
  deleteSet: (id: string) => call<{ ok: true }>('deleteSet', { id }),
  answer: (setId: string, questionId: string, choice: number) => call<HubAnswer>('answer', { setId, questionId, choice }),
  leaderboard: (id: string, period: 'week' | 'all') => call<HubBoard>('leaderboard', { id, period }),
  hosting: () => call<{ status: 'none' | 'pending' | 'approved' | 'rejected'; note?: string | null; appliedAt?: number }>('hosting'),
  applyHosting: (reason: string) => call<{ status: string }>('applyHosting', { reason }),
  setBoard: (show: BoardShow, nickname: string | null, everyClass = true) => call<HubStatus>('setBoard', { show, nickname, everyClass }),
  importable: () => call<ImportableSet[]>('importable'),
  importSet: (id: string) => call<{ title: string; questions: NewQuestion[]; skipped: number }>('importSet', { id }),
};

/** "My classes": shared by the School sidebar, the calendar's colors and the class pages. */
interface HubClassesState {
  list: HubClass[];
  offline: boolean;
  loaded: boolean;
  load(): Promise<void>;
}
export const useHubClasses = create<HubClassesState>((set) => ({
  list: [],
  offline: false,
  loaded: false,
  async load() {
    const r = await hubc.classes();
    if (r.ok) set({ list: r.value.classes, offline: r.value.offline, loaded: true });
    // Signed out, or never reached: no Hub classes to show.
    else set({ list: r.status === 401 ? [] : useHubClasses.getState().list, offline: r.status === 0, loaded: true });
  },
}));

/** When the next review is, in words: "tomorrow", "in 3 days", "on Dec 4". */
export function comesBack(at: number, now = Date.now()) {
  const days = Math.round((at - now) / 86400_000);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  return `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
