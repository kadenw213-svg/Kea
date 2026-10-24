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
