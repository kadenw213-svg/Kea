// Home's Ask Claude bar (Kea 0.101): one slim line under the greeting. On the left, the context folder (a class, a work
// team, any project folder, or none), which is also where new context folders are made; then the question. Enter opens
// a Claude tab about that folder (src/components/ClaudePage.tsx).
import { useEffect, useState } from 'react';
import { ArrowUp, Briefcase, FolderCog, ChevronDown, Folder, FolderInput, FolderPlus, GraduationCap, Users, X } from 'lucide-react';
import { MenuButton } from '../Popover';
import { api } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { forgetProject, loadProject, rememberProject, type KnownProject } from '../../lib/projects';
import { makeContextFolder } from './NewProject';
import { manageContextFolder } from './ContextFolder';
import { openClaudeChat } from '../ClaudePage';
import { toast } from '../../store';

const NONE: KnownProject[] = []; // (one empty list: a new [] each render would re-render forever)
const KIND_ICON = { class: GraduationCap, work: Briefcase, personal: Folder } as const;

export function AskBar() {
  const known: KnownProject[] = useSettings((s) => (Array.isArray(s.values['projects.known']) ? s.values['projects.known'] : NONE));
  const chosen: string = useSettings((s) => s.values['home.askFolder']) || '';
  const on = useSettings((s) => s.values['home.askBar']) !== false;
  const [text, setText] = useState('');
  const [shared, setShared] = useState<Set<string>>(new Set());
  const current = known.find((k) => k.dir === chosen);
  const choose = (dir: string) => useSettings.getState().set({ 'home.askFolder': dir });

  // Shared work folders (Kea 0.99) are context folders too.
  useEffect(() => {
    api.teamFolders
      ?.here()
      .then((list) => {
        for (const f of list) if (f.root && !f.gone) rememberProject({ dir: f.root, name: `${f.orgName} · ${f.name}`, kind: 'work' });
        setShared(new Set(list.map((f) => f.root)));
      })
      .catch(() => {});
  }, []);

  const useFolder = async () => {
    const dir = await api.openFolderDialog().catch(() => null);
    if (!dir) return;
    const p = await loadProject(dir);
    if (p) {
      rememberProject(p, true);
      choose(p.dir);
    } else makeContextFolder((made) => choose(made.dir), dir);
  };

  const go = async () => {
    const q = text.trim();
    if (!q) return;
    let dir: string | null = current?.dir || null;
    if (dir) {
      const p = await loadProject(dir).catch(() => null);
      if (!p) {
        toast(`${current!.name} isn’t there any more, so Claude will answer without it.`, 'error');
        forgetProject(dir);
        dir = null;
      } else rememberProject(p, true);
    }
    setText('');
    openClaudeChat(dir, q);
  };

  if (!on) return null;
  const Icon = current ? (shared.has(current.dir) ? Users : KIND_ICON[current.kind] || Folder) : Folder;
  return (
    <div className="ask-bar">
      <MenuButton
        title="Context folder: the files Claude uses"
        button={() => (
          <button className={`ask-folder ${current ? 'on' : ''}`}>
            <Icon size={15} />
            <span>{current ? current.name : 'No folder'}</span>
            <ChevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-title">Context folder</div>
            {known.length === 0 && <div className="menu-note">Make a folder for a class, a team or a project, and Claude will use its files: sheets, documents, PDFs and linked Google files.</div>}
            {known.slice(0, 14).map((k) => {
              const I = shared.has(k.dir) ? Users : KIND_ICON[k.kind] || Folder;
              return (
                <button key={k.dir} className={`menu-item ${k.dir === chosen ? 'checked' : ''}`} title={k.dir} onClick={() => (choose(k.dir), close())}>
                  <I size={16} /> <span className="menu-grow">{k.name}</span>
                  <span
                    className="menu-x"
                    title="Remove from this list (the folder stays)"
                    onClick={(e) => {
                      e.stopPropagation();
                      forgetProject(k.dir);
                      if (k.dir === chosen) choose('');
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              );
            })}
            <div className="menu-sep" />
            {current && (
              <button className="menu-item" onClick={() => (close(), manageContextFolder(current.dir))}>
                <FolderCog size={16} /> Files in {current.name}…
              </button>
            )}
            <button className="menu-item" onClick={() => (close(), makeContextFolder((p) => choose(p.dir)))}>
              <FolderPlus size={16} /> New context folder…
            </button>
            <button className="menu-item" onClick={() => (close(), useFolder())}>
              <FolderInput size={16} /> Use a folder I have…
            </button>
            {current && (
              <button className="menu-item" onClick={() => (choose(''), close())}>
                <X size={16} /> No folder
              </button>
            )}
          </>
        )}
      </MenuButton>
      <input
        className="ask-input"
        value={text}
        placeholder="What do you need?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            go();
          }
        }}
      />
      <button className="ask-go" title="Ask (Enter)" disabled={!text.trim()} onClick={go}>
        <ArrowUp size={16} />
      </button>
    </div>
  );
}
