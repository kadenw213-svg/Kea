// What the person was doing in Kea, for a bug report or suggestion (Kea 0.101; Settings → Privacy → "Include what I
// was doing with feedback", and a box on each report). Kept only in memory, never written anywhere: the place they're
// in, the kinds of files open, and the last few screens and tools (Claude's and the editors'). Never file names,
// contents, prompts or answers.
import { useTabs } from '../store';

const MAX = 30;
const actions: { text: string; at: number }[] = [];
const tools: { name: string; at: number }[] = [];

export function noteAction(text: string) {
  const t = String(text).slice(0, 80);
  if (actions[actions.length - 1]?.text === t) return;
  actions.push({ text: t, at: Date.now() });
  if (actions.length > MAX) actions.shift();
}
export function noteTool(name: string) {
  tools.push({ name: String(name).replace(/^mcp__kea__/, '').slice(0, 64), at: Date.now() });
  if (tools.length > MAX) tools.shift();
}

// Files opened and closed (their kind only).
let known = new Set<string>(['home']);
useTabs.subscribe((s, prev) => {
  if (s.tabs !== prev.tabs) {
    for (const t of s.tabs) if (!known.has(t.id)) noteAction(`opened ${t.kind === 'claude' ? 'a Claude page' : `a ${t.kind}`}`);
    known = new Set(s.tabs.map((t) => t.id));
  }
  if (s.activeId !== prev.activeId) {
    const t = s.tabs.find((x) => x.id === s.activeId);
    if (t) noteAction(`switched to ${t.kind === 'home' ? 'Home' : t.kind}`);
  }
});

export interface FeedbackContext {
  app: 'kea';
  version?: string;
  place: string;
  editor?: string;
  openKinds: string[];
  recentTools: { name: string; at: number }[];
  recentActions: string[];
  settings?: { theme?: string; backdrop?: string; provider?: string };
  os?: string;
  screen?: string;
}

const PLACES = ['home', 'scholar', 'work', 'audit', 'claude'];
let snap: { ctx: FeedbackContext; at: number } | null = null;

/** Where they are and what they did last. `extra`: version, OS and settings, filled in by the caller. */
export function activityContext(extra: Partial<FeedbackContext> = {}): FeedbackContext {
  const { tabs, activeId } = useTabs.getState();
  const tab = tabs.find((t) => t.id === activeId);
  const scholarView = (window as any).__keaScholar?.useScholar?.getState?.()?.view?.name as string | undefined;
  const place = !tab ? 'home' : tab.kind === 'scholar' ? (scholarView === 'calendar' ? 'calendar' : scholarView === 'inbox' ? 'notifications' : 'school') : tab.kind === 'audit' ? 'work' : PLACES.includes(tab.kind) ? tab.kind : 'editor';
  return {
    app: 'kea',
    place,
    ...(place === 'editor' && tab ? { editor: tab.kind } : {}),
    openKinds: tabs.filter((t) => t.id !== 'home').map((t) => t.kind).slice(0, 20),
    recentTools: tools.slice(-30),
    recentActions: actions.slice(-30).map((a) => `${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${a.text}`),
    screen: `${window.screen.width}x${window.screen.height}`,
    ...extra
  };
}

/** Take the picture before Settings opens over it (the rail's Feedback button). */
export function snapshotActivity() {
  snap = { ctx: activityContext(), at: Date.now() };
}
/** The snapshot if it's recent, else now. */
export function feedbackContext(extra: Partial<FeedbackContext> = {}): FeedbackContext {
  const base = snap && Date.now() - snap.at < 15 * 60_000 ? snap.ctx : activityContext();
  return { ...base, ...extra };
}
