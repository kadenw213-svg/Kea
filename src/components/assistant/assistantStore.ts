import { create } from 'zustand';
import { useLookup, setLookupOpen } from '../lookup/lookupStore';
import { useTabs } from '../../store';
import { fileKey, onFileKeyChange } from '../../lib/assignmentContext';

/** One line in the Assistant panel: what you asked, Claude's answer, its reasoning, or a step it took in the file. */
export interface ChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error';
  text: string;
  /** Tool steps: the tool's name, and what it reported (or why it failed). */
  name?: string;
  result?: string;
  ok?: boolean;
  /** A picture sent with the message (what Claude was shown). */
  image?: string;
  /** Files the student attached to the message. */
  files?: { name: string; thumb?: string }[];
  /** The passage the student highlighted and sent with the message (Ask Claude). */
  focus?: string;
  /** Which model the funnel chose for this message, and why. */
  route?: { tier: 'quick' | 'standard' | 'deep'; model: string; why: string };
}

/** A highlighted passage (or range of cells) sent to the chat with Ask Claude, shown as a chip until it's sent. */
export interface Focus {
  text: string;
  /** Where it is: "cells B2:D9" in a spreadsheet; nothing for document text. */
  where?: string;
}

/** A tab's conversation: the messages as Claude's API holds them, and what the panel shows. */
export interface Chat {
  messages: any[];
  items: ChatItem[];
  busy: boolean;
  reqId?: string;
  usage: { input: number; output: number; cached: number };
  /** On the Claude plan: the Claude Code session this conversation continues, and the route the running turn took. */
  planSession?: string;
  via?: 'plan' | 'api';
  /** The assignment Claude was last given in this conversation (assignmentContext.ts assignmentSig). */
  assignmentSent?: string;
  /** On an API key: the model the last message went to (the funnel can pick another for the next one). */
  lastModel?: string;
}

interface AssistantStore {
  /** Which tabs have the panel open: it belongs to the file it was opened on and comes back with it. */
  openTabs: Record<string, boolean>;
  /** What's typed in each tab's message box but not sent yet. */
  drafts: Record<string, string>;
  /** The passage each tab sent with Ask Claude, waiting to go with the next message. */
  focus: Record<string, Focus | undefined>;
  chats: Record<string, Chat>;
  /** What Claude is doing in each tab right now ("Adding a text box"), for the overlay on the file. */
  activity: Record<string, string | undefined>;
  key: { hasKey: boolean; hint: string } | null;
  set(p: Partial<AssistantStore>): void;
}

const DRAFT_KEY = 'kea.assistant.drafts';
const loadDrafts = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
export const useAssistant = create<AssistantStore>((set) => ({
  openTabs: {},
  drafts: {},
  focus: {},
  chats: {},
  activity: {},
  key: null,
  set: (p) => set(p)
}));

export const emptyChat = (): Chat => ({ messages: [], items: [], busy: false, usage: { input: 0, output: 0, cached: 0 } });
export const chatOf = (tabId: string) => useAssistant.getState().chats[tabId] || emptyChat();
export function patchChat(tabId: string, p: Partial<Chat> | ((c: Chat) => Partial<Chat>)) {
  const s = useAssistant.getState();
  const cur = s.chats[tabId] || emptyChat();
  s.set({ chats: { ...s.chats, [tabId]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } } });
}

export const setActivity = (tabId: string, text: string | undefined) => {
  const s = useAssistant.getState();
  if (s.activity[tabId] !== text) s.set({ activity: { ...s.activity, [tabId]: text } });
};

/** Steps Claude takes to look and plan, not edits: never listed in the chat. */
export const INTERNAL_STEPS = new Set(['design_guide', 'describe_slide', 'describe_pages', 'look', 'read_document', 'check_design', 'read_range', 'measure_picture', 'go_to_slide', 'go_to_page', 'show_in_document', 'measure_loudness', 'kea_list_tabs', 'describe_sheet', 'find_assignment', 'class_search', 'class_read']);

const VERBS: Record<string, string> = { add: 'Adding', set: 'Setting', update: 'Updating', delete: 'Removing', remove: 'Removing', arrange: 'Arranging', replace: 'Rewriting', mark: 'Marking', insert: 'Inserting', format: 'Formatting', place: 'Placing', move: 'Moving', apply: 'Applying', fill: 'Filling', redact: 'Redacting', rotate: 'Rotating', duplicate: 'Duplicating', edit: 'Editing', split: 'Cutting', trim: 'Trimming', select: 'Selecting', crop: 'Cropping', resize: 'Resizing', export: 'Exporting', page: 'Setting up' };
const DOING: Record<string, string> = {
  class_search: 'Searching your classes',
  class_read: 'Reading your class material',
  class_lookup: 'Reading your class site',
  class_lookup_wait: 'Reading your class site',
  class_open: 'Opening it',
  design_guide: 'Planning the design',
  look: 'Checking how it looks',
  read_document: 'Reading the file',
  describe_slide: 'Reading the slide',
  describe_pages: 'Reading the pages',
  check_design: 'Checking the design',
  add_image: 'Placing artwork',
  place_image: 'Placing artwork',
  insert_image: 'Placing artwork',
  add_comment: 'Leaving a comment',
  apply_edits: 'Building'
};
/** "add_text_box" → "Adding text box" (what the overlay says while a step runs). */
export function doing(name = '') {
  if (DOING[name]) return DOING[name];
  const [verb, ...rest] = name.split('_');
  return VERBS[verb] ? `${VERBS[verb]} ${rest.join(' ')}`.trim() : name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Tabs that aren't a file (Home, the school dashboard, the work space): the panel never shows there. */
const NOT_A_FILE = new Set(['home', 'scholar', 'work', 'audit']);
const canHold = (tabId: string) => {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return !!t && !NOT_A_FILE.has(t.kind);
};

/** Is the panel showing right now: open on the tab in front, and that tab is a file. */
export const isAssistantOpen = (s: { openTabs: Record<string, boolean> }, activeId: string) => !!s.openTabs[activeId] && canHold(activeId);
export function useAssistantOpen() {
  const activeId = useTabs((s) => s.activeId);
  useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.kind);
  return useAssistant((s) => isAssistantOpen(s, activeId));
}

/**
 * Open or close the panel on a tab (the one in front unless named). It stays with that file: switching to Home or
 * another document hides it, and it's back when you return. The Assistant and the Encyclopedia share the right side
 * of the window: opening one closes the other.
 */
export function setAssistantOpen(open: boolean, tabId = useTabs.getState().activeId) {
  const s = useAssistant.getState();
  if (!!s.openTabs[tabId] === open) return;
  const openTabs = { ...s.openTabs };
  if (open) openTabs[tabId] = true;
  else delete openTabs[tabId];
  s.set({ openTabs });
  if (open && useLookup.getState().open) setLookupOpen(false);
}
export const toggleAssistant = () => {
  const id = useTabs.getState().activeId;
  if (canHold(id)) setAssistantOpen(!useAssistant.getState().openTabs[id], id);
};
useLookup.subscribe((s, prev) => {
  if (s.open && !prev.open) setAssistantOpen(false);
});

export const focusOf = (tabId: string) => useAssistant.getState().focus[tabId] || null;
export function setFocus(tabId: string, focus: Focus | null) {
  const s = useAssistant.getState();
  s.set({ focus: { ...s.focus, [tabId]: focus || undefined } });
}

/**
 * Ask Claude about a highlighted passage (the selection menu's AI button, or Ctrl+Shift+A): the panel opens on that
 * file with the passage attached as a chip, and the cursor in the message box.
 */
export function askAboutSelection(tabId: string, focus: Focus) {
  if (!focus.text.trim()) return;
  setFocus(tabId, focus);
  setAssistantOpen(true, tabId);
  setTimeout(() => (document.querySelector('.ai-sidebar.assistant textarea') as HTMLTextAreaElement | null)?.focus(), 80);
}

// Drafts are kept by file (its path once saved), so a half-written message is still there when the file is reopened.
let draftFiles: Record<string, string> = loadDrafts();
const saveDrafts = () => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(Object.entries(draftFiles).filter(([f, t]) => !f.startsWith('tab:') && t))));
  } catch {}
};
export const draftOf = (tabId: string) => useAssistant.getState().drafts[tabId] ?? draftFiles[fileKey(tabId)] ?? '';
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function setDraft(tabId: string, text: string) {
  const s = useAssistant.getState();
  s.set({ drafts: { ...s.drafts, [tabId]: text } });
  const k = fileKey(tabId);
  if (text) draftFiles[k] = text;
  else delete draftFiles[k];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDrafts, 400);
}
onFileKeyChange((from, to) => {
  if (draftFiles[from] && !draftFiles[to]) {
    draftFiles = { ...draftFiles, [to]: draftFiles[from] };
    if (from.startsWith('tab:')) delete draftFiles[from];
    saveDrafts();
  }
});
// A closed tab's panel, draft and chat go with it (the draft stays saved by the file's path).
useTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  const gone = prev.tabs.filter((t) => !s.tabs.some((x) => x.id === t.id)).map((t) => t.id);
  if (!gone.length) return;
  const a = useAssistant.getState();
  const openTabs = { ...a.openTabs };
  const drafts = { ...a.drafts };
  for (const id of gone) {
    delete openTabs[id];
    delete drafts[id];
  }
  a.set({ openTabs, drafts });
});
