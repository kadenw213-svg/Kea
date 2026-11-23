// A Claude tab (Kea 0.101): a full-page chat opened from Home's Ask Claude bar, with an optional context folder (a
// project). It registers as an "editor" with workspace hooks, so both ways of running Claude (the user's plan through
// Claude Code and Kea's MCP, or an API key) give it the same tools: the folder's files and Kea's modules
// (src/lib/workspaceTools.ts).
import { useEffect } from 'react';
import { editorRegistry, useTabs, type Tab } from '../store';
import { workspaceTools, takeHandoff } from '../lib/workspaceTools';
import { setting } from '../lib/settings';
import { useAssistant, chatOf, moveChat, setAssistantOpen } from './assistant/assistantStore';
import { useProjects } from '../lib/projects';
import { AssistantPanel } from './assistant/AssistantPanel';
import { ask } from '../lib/assistant';

/** Open a new Claude tab, optionally about a folder, and send the first message. */
export function openClaudeChat(folder: string | null, first?: string) {
  const p = folder ? useProjects.getState().byDir[folder] : null;
  const name = folder ? `Claude · ${p?.name || folder.split(/[\\/]/).pop()}` : 'Claude';
  const id = useTabs.getState().addTab({ kind: 'claude', name, path: null, data: null, ...(folder ? { folder } : {}) });
  // The page registers its tools when it mounts; the first message waits for that.
  if (first?.trim()) {
    const go = (n = 0) => (editorRegistry.get(id)?.ai ? ask(id, first.trim()) : n < 50 && setTimeout(() => go(n + 1), 60));
    setTimeout(() => go(), 0);
  }
  return id;
}

/**
 * Hand the conversation to the file Claude made or opened (Kea 0.103): when Claude finishes a turn that made or opened
 * a file, the chat moves into that file's sidebar, whole (what was said, what Claude was told, its session), the file
 * takes the chat's context folder (the folder bar shows on it), and this Claude tab closes: it isn't needed any more.
 * A turn that only answered stays here. Off with Settings → Home → "Move the chat into the file Claude makes".
 */
function handOff(chatId: string) {
  if (setting('home.handoff') === false) return;
  const file = takeHandoff(chatId);
  if (!file) return;
  const t = useTabs.getState();
  const chatTab = t.tabs.find((x) => x.id === chatId);
  const fileTab = t.tabs.find((x) => x.id === file);
  if (!chatTab || !fileTab) return;
  const inSplit = !!t.split && [t.split.left, t.split.right].includes(chatId);
  const watching = t.activeId === chatId || t.activeId === file || inSplit;
  if (chatTab.folder && !fileTab.folder) t.updateTab(file, { folder: chatTab.folder });
  moveChat(chatId, file);
  if (inSplit) t.closeSplit();
  t.closeTab(chatId);
  setAssistantOpen(true, file);
  if (watching) useTabs.getState().setActive(file);
}

export function ClaudePage({ tab }: { tab: Tab }) {
  // When a turn ends (busy goes off), hand the chat to the file Claude worked on, if it worked on one.
  useEffect(() => {
    const id = tab.id;
    let was = chatOf(id).busy;
    return useAssistant.subscribe((s) => {
      const busy = !!s.chats[id]?.busy;
      if (was && !busy) setTimeout(() => handOff(id), 50);
      was = busy;
    });
  }, [tab.id]);
  useEffect(() => {
    const id = tab.id;
    editorRegistry.set(id, {
      save: async () => true,
      ai: {
        noun: 'chat',
        workspace: true,
        get tools() {
          return workspaceTools(id);
        },
        getDocument: async () => ({ full: '', sections: [] }),
        context() {
          const t = useTabs.getState().tabs.find((x) => x.id === id);
          const p = t?.folder ? useProjects.getState().byDir[t.folder] : null;
          return t?.folder
            ? `[Kea's Claude page, about the context folder "${p?.name || t.folder.split(/[\\/]/).pop()}" (${t.folder}). Use list_project_files and read_project_file for its files before answering questions about them. Make or change files with Kea's modules: kea_modules, create_file, open_file, editor_tools, use_editor, save_file. To message people, find their addresses (the files, search_contacts) and use draft_message: the person approves before anything is sent.]`
            : `[Kea's Claude page (no context folder). Make or change files with Kea's modules: kea_modules, create_file, open_file, editor_tools, use_editor, save_file. To message people, find their addresses (the files, search_contacts) and use draft_message: the person approves before anything is sent.]`;
        }
      }
    });
    return () => {
      editorRegistry.delete(id);
    };
  }, [tab.id]);
  return (
    <div className="claude-page">
      <AssistantPanel tabId={tab.id} page />
    </div>
  );
}
