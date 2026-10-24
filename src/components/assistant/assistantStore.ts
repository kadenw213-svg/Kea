import { create } from 'zustand';
import { useLookup, setLookupOpen } from '../lookup/lookupStore';

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
}

interface AssistantStore {
  open: boolean;
  chats: Record<string, Chat>;
  /** What Claude is doing in each tab right now ("Adding a text box"), for the overlay on the file. */
  activity: Record<string, string | undefined>;
  key: { hasKey: boolean; hint: string } | null;
  set(p: Partial<AssistantStore>): void;
}

const OPEN_KEY = 'kea.assistant.open';
export const useAssistant = create<AssistantStore>((set) => ({
  open: (() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  })(),
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
export const INTERNAL_STEPS = new Set(['design_guide', 'describe_slide', 'describe_pages', 'look', 'read_document', 'check_design', 'read_range', 'measure_picture', 'go_to_slide', 'go_to_page', 'show_in_document', 'measure_loudness', 'kea_list_tabs', 'describe_sheet', 'find_assignment']);

const VERBS: Record<string, string> = { add: 'Adding', set: 'Setting', update: 'Updating', delete: 'Removing', remove: 'Removing', arrange: 'Arranging', replace: 'Rewriting', mark: 'Marking', insert: 'Inserting', format: 'Formatting', place: 'Placing', move: 'Moving', apply: 'Applying', fill: 'Filling', redact: 'Redacting', rotate: 'Rotating', duplicate: 'Duplicating', edit: 'Editing', split: 'Cutting', trim: 'Trimming', select: 'Selecting', crop: 'Cropping', resize: 'Resizing', export: 'Exporting', page: 'Setting up' };
const DOING: Record<string, string> = {
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

/** The Assistant and the Encyclopedia share the right side of the window: opening one closes the other. */
export function setAssistantOpen(open: boolean) {
  useAssistant.getState().set({ open });
  if (open && useLookup.getState().open) setLookupOpen(false);
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {}
}
export const toggleAssistant = () => setAssistantOpen(!useAssistant.getState().open);
useLookup.subscribe((s, prev) => {
  if (s.open && !prev.open && useAssistant.getState().open) setAssistantOpen(false);
});
