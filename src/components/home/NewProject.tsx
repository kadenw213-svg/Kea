// Home → Create → Project: make a project (a named folder whose files Claude uses together), or turn a folder you
// already have into one. Then a new document opens in it.
import { useState } from 'react';
import { create } from 'zustand';
import { FolderPlus, FolderInput, ChevronDown, FileText, Sheet, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { saveProject, findProject, type Project } from '../../lib/projects';
import { newFile } from '../../lib/open';
import { toast } from '../../store';
import { MenuButton } from '../Popover';
import { cloudUsable, useKeaCloud } from '../../lib/keaCloud';
import { manageContextFolder } from './ContextFolder';
import { SharedFoldersDialog, useSharedFolders } from './SharedFolders';

const useDialog = create<{ mode: 'new' | 'folder' | null; dir: string; onMade?: (p: Project) => void }>(() => ({ mode: null, dir: '' }));

/**
 * Make a context folder (Home's Ask Claude bar, Kea 0.101): a new one, or an existing folder (`dir`). `onMade` gets the
 * project instead of a new document opening in it.
 */
export function makeContextFolder(onMade: (p: Project) => void, dir?: string) {
  useDialog.setState({ mode: dir ? 'folder' : 'new', dir: dir || '', onMade });
}

async function pick(): Promise<string | null> {
  return api.openFolderDialog().catch(() => null);
}

export function ProjectButton() {
  return (
    <>
      <MenuButton
        button={() => (
          <button className="create-btn">
            <span className="create-ic project">
              <FolderPlus size={17} />
            </span>
            Project <ChevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button className="menu-item" onClick={() => (close(), useDialog.setState({ mode: 'new', dir: '' }))}>
              <FolderPlus size={16} /> New project…
            </button>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                const dir = await pick();
                if (!dir) return;
                const p = await findProject(dir);
                if (p && p.dir === dir) return newFile('doc', dir), toast(`New document in ${p.name}`);
                useDialog.setState({ mode: 'folder', dir });
              }}
            >
              <FolderInput size={16} /> Use a folder as a project…
            </button>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                const dir = await pick();
                if (!dir) return;
                const p = await findProject(dir);
                if (!p) return toast('That folder isn’t a project yet. Choose “Use a folder as a project…” first.');
                newFile('doc', p.dir);
              }}
            >
              <FileText size={16} /> New document in a project…
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (close(), useSharedFolders.setState({ open: true }))}>
              <Users size={16} /> Shared work folders…
            </button>
          </>
        )}
      </MenuButton>
      <SharedFoldersDialog />
    </>
  );
}

/** Rendered once, by Home. */
export function NewProjectDialog() {
  const { mode, dir, onMade } = useDialog();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Project['kind']>('class');
  const [busy, setBusy] = useState(false);
  // Where a new one lives (Kea 0.101.2): Kea cloud unless you choose otherwise (on this PC when Kea cloud isn't set up).
  const cloud = useKeaCloud((s) => s.status);
  const [place, setPlace] = useState<'cloud' | 'pc' | 'choose' | null>(null);
  const where = place ?? (cloudUsable(cloud) ? 'cloud' : 'pc');
  if (!mode) return null;
  const close = () => (useDialog.setState({ mode: null, dir: '', onMade: undefined }), setName(''), setPlace(null));
  const shown = name || (mode === 'folder' ? dir.split(/[\\/]/).pop() || '' : '');
  const go = async (then: 'doc' | 'sheet' | null) => {
    const n = shown.trim();
    if (!n) return;
    setBusy(true);
    try {
      let folder = dir;
      if (mode === 'new') {
        let parent: string | null = null;
        if (where === 'cloud' && cloudUsable(cloud)) parent = `${cloud.root.replace(/[\\/]+$/, '')}\\Context folders`;
        else if (where === 'choose') parent = await pick();
        else {
          const docs = (await api.knownFolders().catch(() => [])).find((k) => k.id === 'documents')?.path;
          parent = docs ? `${docs}\\Kea\\Context folders` : await pick();
        }
        if (!parent) return;
        const sep = parent.includes('\\') ? '\\' : '/';
        const base = `${parent.replace(/[\\/]+$/, '')}${sep}${n.replace(/[<>:"/\\|?*]+/g, '-').trim()}`;
        folder = base;
        for (let i = 2; i < 50 && (await api.fileExists(`${folder}${sep}.kea-project.json`).catch(() => false)); i++) folder = `${base} (${i})`;
      }
      const p = await saveProject({ dir: folder, name: n, kind, exclude: [] });
      toast(onMade ? `${p.name} is ready. Add its files here.` : `${p.name} is a project. Files you make or open in it share it with Claude.`, 'success');
      if (onMade) onMade(p);
      else if (then) newFile(then, p.dir);
      close();
      // A new one starts empty: its files are added in Kea, not in File Explorer.
      if (mode === 'new' && !then) manageContextFolder(p.dir);
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog pe-dialog" role="dialog" aria-label="Project">
        <h2>{onMade ? (mode === 'new' ? 'New context folder' : 'Use this folder for context') : mode === 'new' ? 'New project' : 'Use this folder as a project'}</h2>
        <p>A project is a folder of files Claude can use together: a class’s syllabus, rubrics and earlier papers, or a team’s contact sheet, availability and templates. Ask “using the contact sheet…” or “build on my Essay 1” and Claude reads those files as they are now.</p>
        <label className="field-label">Name</label>
        <input className="input" autoFocus value={shown} placeholder="ENG 102, Front desk team…" onChange={(e) => setName(e.target.value)} />
        <div className="pe-row">
          <div>
            <label className="field-label">For</label>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Project['kind'])}>
              <option value="class">A class</option>
              <option value="work">Work</option>
              <option value="personal">Something else</option>
            </select>
          </div>
        </div>
        {mode === 'new' && (
          <div className="pe-row">
            <div>
              <label className="field-label">Keep it</label>
              <select className="select" value={where} onChange={(e) => setPlace(e.target.value as 'cloud' | 'pc' | 'choose')}>
                <option value="cloud" disabled={!cloudUsable(cloud)}>
                  In Kea cloud{cloudUsable(cloud) ? ' (on all your devices)' : ' (sign in to your Kea account first)'}
                </option>
                <option value="pc">On this PC (Documents › Kea)</option>
                <option value="choose">In a folder I choose…</option>
              </select>
            </div>
          </div>
        )}
        {mode === 'folder' && <p className="muted">{dir}</p>}
        <div className="dialog-actions">
          <button className="btn sm" onClick={close}>
            Cancel
          </button>
          {onMade ? (
            <button className="btn primary sm" disabled={busy || !shown.trim()} onClick={() => go(null)}>
              {mode === 'new' ? 'Make it' : 'Use this folder'}
            </button>
          ) : (
          <>
          <button className="btn sm" disabled={busy || !shown.trim()} onClick={() => go('sheet')}>
            <Sheet size={13} /> {mode === 'new' ? 'Make it, with a spreadsheet' : 'Save, new spreadsheet'}
          </button>
          <button className="btn primary sm" disabled={busy || !shown.trim()} onClick={() => go('doc')}>
            {mode === 'new' ? 'Make it, with a document' : 'Save, new document'}
          </button>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
