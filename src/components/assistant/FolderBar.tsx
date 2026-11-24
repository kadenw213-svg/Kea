// The folder bar (Kea 0.103): on a file that belongs to a context folder (made by Home's Ask Claude, saved into one,
// or opened from one), one quiet line under the toolbar, like the assignment bar: the folder, how many of its files
// Claude uses, where it lives and who it's shared with, and the way into the chat about it. Its settings (files,
// sharing) open the folder's manager. Hidden with Settings → Claude → "Show the folder bar".
import { useEffect, useState } from 'react';
import { Brain, Briefcase, ChevronDown, Cloud, Folder, FolderCog, FolderOpen, GraduationCap, HardDrive, MessageSquare, Share2, Users, X } from 'lucide-react';
import { MenuButton } from '../Popover';
import { api } from '../../lib/api';
import { useSetting } from '../../lib/settings';
import { projectFiles, projectOfTab, useProjects } from '../../lib/projects';
import { friendlyPath, useKeaCloud } from '../../lib/keaCloud';
import { useTabs } from '../../store';
import { manageContextFolder } from '../home/ContextFolder';
import { setAssistantOpen, useAssistant } from './assistantStore';

const KIND_ICON = { class: GraduationCap, work: Briefcase, personal: Folder } as const;
// Files whose bar was closed for now (until Kea restarts).
const hidden = new Set<string>();

export function FolderBar({ tabId }: { tabId: string }) {
  useProjects((s) => s.version);
  const folder = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.folder);
  const path = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.path);
  const show = useSetting<boolean>('assistant.folderBar') !== false;
  const chatOpen = useAssistant((s) => !!s.openTabs[tabId]);
  useKeaCloud((s) => s.status?.root);
  const [, redraw] = useState(0);
  const p = projectOfTab(tabId);
  const [used, setUsed] = useState<{ used: number; all: number } | null>(null);
  useEffect(() => {
    setUsed(null);
    if (!p) return;
    let live = true;
    projectFiles(p)
      .then((f) => live && setUsed({ used: f.filter((x) => x.used).length, all: f.length }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [p?.dir, p?.exclude.join('|'), (p?.links || []).length, (p?.refs || []).length, folder, path]);
  if (!p || !show || hidden.has(tabId)) return null;
  const Icon = p.shared && !p.shared.personal ? Users : KIND_ICON[p.kind] || Folder;
  const where = friendlyPath(p.dir);
  const cloud = where.startsWith('Kea cloud');
  const s = p.shared;
  const askAbout = () => {
    setAssistantOpen(true, tabId);
    setTimeout(() => (document.querySelector('.ai-sidebar.assistant textarea') as HTMLTextAreaElement | null)?.focus(), 80);
  };
  return (
    <div className="assignment-bar folder-bar" role="region" aria-label="Context folder">
      <MenuButton
        title="This file's context folder"
        button={(o) => (
          <button className={`ab-chip ab-for ${o ? 'open' : ''}`}>
            <Icon size={14} />
            <span className="ab-label">{p.name}</span>
            <ChevronDown size={12} className="ab-caret" />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-title">Context folder</div>
            <button className="menu-item" onClick={() => (close(), manageContextFolder(p.dir))}>
              <FolderCog size={16} /> Files Claude uses…
            </button>
            <button className="menu-item" onClick={() => (close(), manageContextFolder(p.dir, { notes: true }))}>
              <Brain size={16} /> What Claude remembers…
            </button>
            {(!s || s.personal) && (
              <button className="menu-item" onClick={() => (close(), manageContextFolder(p.dir, { share: true }))}>
                <Share2 size={16} /> {s?.personal ? 'Who it’s shared with…' : 'Share…'}
              </button>
            )}
            <button className="menu-item" onClick={() => (close(), api.showInFolder(p.dir).catch(() => {}))}>
              <FolderOpen size={16} /> Show in File Explorer
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (close(), hidden.add(tabId), redraw((n) => n + 1))}>
              <X size={16} /> Hide this bar
            </button>
          </>
        )}
      </MenuButton>
      <button className="ab-chip" title="Choose which of the folder's files Claude reads" onClick={() => manageContextFolder(p.dir)}>
        <FolderCog size={13} />
        {used ? (
          <span>
            {used.used === used.all ? `${used.all} file${used.all === 1 ? '' : 's'}` : `${used.used} of ${used.all} files`}
            <span className="ab-chip-word"> for Claude</span>
          </span>
        ) : (
          <span>Files</span>
        )}
      </button>
      <span className="fb-tag" title={p.dir}>
        {cloud ? <Cloud size={12} /> : <HardDrive size={12} />} {cloud ? 'Kea cloud' : 'This PC'}
      </span>
      {s && (
        <span className="fb-tag" title={s.personal ? 'You shared this folder' : `Shared by ${s.orgName}`}>
          <Users size={12} /> {s.personal ? 'Shared' : s.orgName}
        </span>
      )}
      <span className="ab-grow" />
      {!chatOpen && (
        <button className="ab-main" title="Open the chat about this file and its folder" onClick={askAbout}>
          <MessageSquare size={14} /> Ask about {p.name}
        </button>
      )}
    </div>
  );
}
