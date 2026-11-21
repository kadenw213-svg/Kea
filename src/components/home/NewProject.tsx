// Home → Create → Project: make a project (a named folder whose files Claude uses together), or turn a folder you
// already have into one. Then a new document opens in it.
import { useState } from 'react';
import { create } from 'zustand';
import { FolderPlus, FolderInput, ChevronDown, FileText, Sheet } from 'lucide-react';
import { api } from '../../lib/api';
import { saveProject, findProject, type Project } from '../../lib/projects';
import { newFile } from '../../lib/open';
import { toast } from '../../store';
import { MenuButton } from '../Popover';

const useDialog = create<{ mode: 'new' | 'folder' | null; dir: string }>(() => ({ mode: null, dir: '' }));

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
          </>
        )}
      </MenuButton>
      <NewProjectDialog />
    </>
  );
}

function NewProjectDialog() {
  const { mode, dir } = useDialog();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Project['kind']>('class');
  const [busy, setBusy] = useState(false);
  if (!mode) return null;
  const close = () => (useDialog.setState({ mode: null, dir: '' }), setName(''));
  const shown = name || (mode === 'folder' ? dir.split(/[\\/]/).pop() || '' : '');
  const go = async (then: 'doc' | 'sheet' | null) => {
    const n = shown.trim();
    if (!n) return;
    setBusy(true);
    try {
      let folder = dir;
      if (mode === 'new') {
        const parent = await pick();
        if (!parent) return;
        folder = `${parent.replace(/[\\/]+$/, '')}${parent.includes('\\') ? '\\' : '/'}${n.replace(/[<>:"/\\|?*]+/g, '-').trim()}`;
      }
      const p = await saveProject({ dir: folder, name: n, kind, exclude: [] });
      toast(`${p.name} is a project. Files you make or open in it share it with Claude.`, 'success');
      if (then) newFile(then, p.dir);
      close();
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog pe-dialog" role="dialog" aria-label="Project">
        <h2>{mode === 'new' ? 'New project' : 'Use this folder as a project'}</h2>
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
        {mode === 'folder' && <p className="muted">{dir}</p>}
        <div className="dialog-actions">
          <button className="btn sm" onClick={close}>
            Cancel
          </button>
          <button className="btn sm" disabled={busy || !shown.trim()} onClick={() => go('sheet')}>
            <Sheet size={13} /> {mode === 'new' ? 'Make it, with a spreadsheet' : 'Save, new spreadsheet'}
          </button>
          <button className="btn primary sm" disabled={busy || !shown.trim()} onClick={() => go('doc')}>
            {mode === 'new' ? 'Choose where, then start a document' : 'Save, new document'}
          </button>
        </div>
      </div>
    </div>
  );
}
