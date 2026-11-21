// The project the open file belongs to, at the top of the Claude tab: its name and how many files Claude can use, and
// (opened) every file with a switch to leave it out, plus New document / New spreadsheet in the project.
import { useEffect, useState } from 'react';
import { FolderOpen, ChevronDown, ChevronUp, FilePlus2, Sheet as SheetIcon, Link2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
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
  }, [p?.dir, p?.exclude.join('|'), (p?.links || []).map((l) => l.id).join('|'), open]);
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
          <LinkGoogle p={p} />
          {p.kind === 'work' && <ContactsSwitch p={p} />}
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

/** Add a Google Doc, Sheet or Slides to the project by its link (read live through the Drive connection). */
function LinkGoogle({ p }: { p: Project }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const g = await api.google.linkInfo(link.trim());
      await saveProject({ ...p, links: [...(p.links || []).filter((l) => l.id !== g.id), g] });
      setLink('');
      toast(`Added ${g.name} to ${p.name}`, 'success');
    } catch (err: any) {
      const m = String(err?.message || err);
      toast(/NO_ACCOUNT|Connect Google Drive/.test(m) ? 'Connect Google Drive first (Settings → Google), then add the link again.' : m.replace(/^.*?\[\w+\]\s*/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="as-project-link">
      <input className="input sm" value={link} placeholder="Add a Google Doc or Sheet: paste its link" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && link.trim() && add()} />
      <button className="btn sm" disabled={busy || !link.trim()} onClick={add}>
        <Link2 size={13} /> Add
      </button>
    </div>
  );
}

/** Work projects: let Claude look people up in Google Contacts (read-only, its own connection). */
function ContactsSwitch({ p }: { p: Project }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on && !(await api.contacts.status()).connected) await api.contacts.connect();
      await saveProject({ ...p, contacts: on });
    } catch (err: any) {
      toast(/REFUSED/.test(String(err?.message)) ? 'Google didn’t let Kea read your contacts yet.' : String(err?.message || err).replace(/^.*?\[\w+\]\s*/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="as-project-file" title="Claude can find people’s emails and phone numbers in your Google Contacts (read-only)">
      <input type="checkbox" disabled={busy} checked={!!p.contacts} onChange={(e) => toggle(e.target.checked)} />
      <span>
        <Users size={12} /> Look people up in Google Contacts
      </span>
    </label>
  );
}
