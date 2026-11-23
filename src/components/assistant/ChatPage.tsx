// The parts of a Claude tab (Kea 0.101) that differ from the sidebar: its title (the context folder) and what it shows
// before the first message. The chat itself is the Claude panel (AssistantPanel with `page`).
import { useTabs } from '../../store';
import { useProjects } from '../../lib/projects';
import { ask } from '../../lib/assistant';
import { Logo } from '../Logo';

function useFolder(tabId: string) {
  const folder = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.folder);
  const project = useProjects((s) => (folder ? s.byDir[folder] : null));
  return { folder, project, name: project?.name || (folder ? folder.split(/[\\/]/).pop() : '') };
}

export function ChatTitle(_: { tabId: string }) {
  return (
    <div className="cp-title">
      <Logo size={18} bare />
      <span>Claude</span>
    </div>
  );
}

function startersFor(kind: string | undefined, hasFolder: boolean): string[] {
  if (kind === 'work') return ['Who hasn’t sent their availability yet?', 'What’s in this folder, in short?', 'Make a sheet that pulls these files together'];
  if (kind === 'class') return ['What’s due next, and what do I need for it?', 'Summarize the syllabus for me', 'Make a study guide from these files'];
  if (hasFolder) return ['What’s in this folder, in short?', 'Find anything that needs my attention', 'Make a document from these files'];
  return ['Write a document with me', 'Make a spreadsheet for me', 'Edit a video with me'];
}

export function ChatEmpty({ tabId }: { tabId: string }) {
  const { folder, project, name } = useFolder(tabId);
  return (
    <div className="cp-empty">
      <h2>{folder ? `Ask about ${name}` : 'What are we working on?'}</h2>
      <p className="muted">
        {folder ? 'Claude reads this folder’s files as they are now, including linked Google Sheets and Docs. ' : ''}
        It can make and edit documents, spreadsheets, slides, PDFs, photos and videos in Kea, opening each beside this chat so you can watch and take over.
      </p>
      <div className="as-starters">
        {startersFor(project?.kind, !!folder).map((s) => (
          <button key={s} className="ai-chip" onClick={() => ask(tabId, s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
