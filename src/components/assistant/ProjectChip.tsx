// The project the open file belongs to, at the top of the Claude tab: its name and how many files Claude can use, and
// (opened) every file with a switch to leave it out, plus New document / New spreadsheet in the project.
import { useEffect, useState } from 'react';
import { FolderOpen, ChevronDown, ChevronUp, FilePlus2, Sheet as SheetIcon } from 'lucide-react';
import { useProjects, projectOfTab, projectFiles, saveProject, type Project } from '../../lib/projects';
import { newFile } from '../../lib/open';

type F = Awaited<ReturnType<typeof projectFiles>>[number];

export function ProjectChip({ tabId }: { tabId: string }) {
  useProjects((s) => s.version);
  const p = projectOfTab(tabId);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<F[] | null>(null);
  useEffect(() => {
    setFiles(null);
    if (!p) return;
    let live = true;
    projectFiles(p)
      .then((f) => live && setFiles(f))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [p?.dir, p?.exclude.join('|'), open]);
  if (!p) return null;
  const used = (files || []).filter((f) => f.used).length;
  const toggle = async (f: F) => {
    const exclude = f.used ? [...p.exclude, f.rel] : p.exclude.filter((x) => x !== f.rel);
    await saveProject({ ...p, exclude } as Project);
  };
  return (
    <div className={`as-project ${open ? 'open' : ''}`}>
      <button className="as-project-head" onClick={() => setOpen(!open)} title="Claude can read the files in this project when you refer to them">
        <FolderOpen size={13} />
        <span className="as-project-name">{p.name}</span>
        <span className="muted">{files ? `${used} file${used === 1 ? '' : 's'} Claude can use` : '…'}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="as-project-body">
          {(files || []).map((f) => (
            <label key={f.rel} className="as-project-file" title={f.used ? 'Claude may read this file' : 'Left out: Claude won’t read it'}>
              <input type="checkbox" checked={f.used} onChange={() => toggle(f)} />
              <span>{f.rel}</span>
            </label>
          ))}
          {files && !files.length && <div className="muted">No other files in this project yet.</div>}
          <div className="as-project-new">
            <button className="link-btn sm" onClick={() => newFile('doc', p.dir)}>
              <FilePlus2 size={13} /> New document here
            </button>
            <button className="link-btn sm" onClick={() => newFile('sheet', p.dir)}>
              <SheetIcon size={13} /> New spreadsheet here
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
